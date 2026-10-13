// cache-keeper policy: pure functions, no `$`, no engine imports except types (design.md §5, §6, §9, §11).
// The retry-once-then-stop shape of outcomeOf and the "judge by cache read before isAnswered" order are
// adapted from paulbkim-dev/claude-code-cache-warmer (MIT, (c) Paul B. Kim).
import type { ModelForkResult } from 'claude-code'

import type { ArtState } from './art'

import type {
  Anchor,
  BandStyle,
  Chain,
  Dialog,
  KeepFor,
  Limits,
  Resumed,
  Settings,
  Status,
  StopCode,
  Task,
  Ttl,
} from '../types'

// Measured: 1 request, ~91 input, 4 output, read = whole prefix, write 0. Do not change without re-measuring.
export const FORK_PROMPT =
  '[cache-keeper] Automated prompt-cache refresh from the cache-keeper plugin, not a message from the user. The conversation above is being handled in the main thread: do not continue it, do not call any tools, and do not deliberate. Reply with only the word: ok'

export const TTL_MS: Record<Ttl, number> = { '5m': 300_000, '1h': 3_600_000 }
export const KEEP_MS: Record<KeepFor, number> = {
  off: 0,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  forever: Infinity,
}
/** Background tasks extend the window up to 24h from the anchor. */
export const TASK_CAP_MS = 86_400_000
/** 5m sessions: warm only while a turn runs, up to 1h from the anchor. */
export const FIVE_MIN_RUN_CAP_MS = 3_600_000
/** A refresh must start at least 20 s before expiry. */
export const SAFETY_MS = 20_000
export const CLAIM_STALE_MS = 180_000
export const RETRY_DELAYS_MS = [30_000, 90_000, 180_000]
/** Re-check delay while a fork is in flight. */
export const IN_FLIGHT_RECHECK_MS = 15_000

// ---------------------------------------------------------------------------
// Settings (plugin.json userConfig -> Settings)

export const OPTIONS = {
  keepFor: ['off', '2h', '4h', '8h', '12h', 'forever'] as const,
  lead: [2, 3, 5, 10, 15] as const,
  minTokens: [10_000, 30_000, 50_000, 100_000] as const,
  weeklyGuard: [50, 75, 80, 90, 95, 100] as const,
  band: ['full', 'minimal', 'off'] as const,
}

export const DEFAULT_SETTINGS: Settings = {
  keepFor: '8h',
  leadMin: 5,
  minTokens: 30_000,
  weeklyGuard: 90,
  band: 'full',
  upgradeTo1h: false,
}

const pick = <T extends string | number>(value: unknown, allowed: readonly T[], dflt: T): T => {
  const v = typeof value === 'string' && typeof allowed[0] === 'number' ? Number(value) : value
  return allowed.find(a => a === v) ?? dflt
}

/** Validating reader of the plugin's userConfig values; a bad or missing value gives the default. */
export function readOptions(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const o = options ?? {}
  const up = o.upgradeTo1h
  return {
    keepFor: pick<KeepFor>(o.keepFor, OPTIONS.keepFor, DEFAULT_SETTINGS.keepFor),
    leadMin: pick<number>(o.lead, OPTIONS.lead, DEFAULT_SETTINGS.leadMin),
    minTokens: pick<number>(o.minTokens, OPTIONS.minTokens, DEFAULT_SETTINGS.minTokens),
    weeklyGuard: pick<number>(o.weeklyGuard, OPTIONS.weeklyGuard, DEFAULT_SETTINGS.weeklyGuard),
    band: pick<BandStyle>(o.band, OPTIONS.band, DEFAULT_SETTINGS.band),
    upgradeTo1h: up === 'on' || up === true,
  }
}

// ---------------------------------------------------------------------------
// TTL rule (§5)

export type TtlInputs = {
  /** FORCE_PROMPT_CACHING_5M */
  force?: string
  /** CLAUDE_CODE_PROMPT_CACHE_TTL */
  envTtl?: string
  /** promptCacheTtl from the settings */
  setting?: unknown
  /** ENABLE_PROMPT_CACHING_1H */
  enable1h?: string
  authKind: 'bearer' | 'api-key' | null
  limits: Limits | null
}

export type TtlWhy = 'forced-5m' | 'env' | 'setting' | 'enable-1h' | 'subscription' | 'over-limit' | 'default'

const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true'
const isTtl = (v: unknown): v is Ttl => v === '5m' || v === '1h'

export function ttlWhy(x: TtlInputs): { ttl: Ttl; why: TtlWhy } {
  if (truthy(x.force)) return { ttl: '5m', why: 'forced-5m' }
  if (isTtl(x.envTtl)) return { ttl: x.envTtl, why: 'env' }
  if (isTtl(x.setting)) return { ttl: x.setting, why: 'setting' }
  if (truthy(x.enable1h)) return { ttl: '1h', why: 'enable-1h' }
  const l = x.limits
  if (x.authKind === 'bearer' && l && (l.fiveHour !== undefined || l.weekly !== undefined))
    return l.overLimit ? { ttl: '5m', why: 'over-limit' } : { ttl: '1h', why: 'subscription' }
  return { ttl: '5m', why: 'default' }
}

export const ttlOf = (x: TtlInputs): Ttl => ttlWhy(x).ttl

export const TTL_WHY_TEXT: Record<TtlWhy, string> = {
  'forced-5m': 'FORCE_PROMPT_CACHING_5M is set',
  env: 'CLAUDE_CODE_PROMPT_CACHE_TTL is set',
  setting: 'promptCacheTtl in settings',
  'enable-1h': 'ENABLE_PROMPT_CACHING_1H is set',
  subscription: 'subscription session',
  'over-limit': 'subscription over its limit',
  default: 'no subscription seen',
}

/** Rate-limit windows (SessionUsage.rateLimits) to the contract's Limits. */
export function limitsOf(rateLimits: readonly { kind: string; percentUsed: number }[], now: number): Limits {
  const pct = (kind: string) => rateLimits.find(r => r.kind === kind)?.percentUsed
  const fiveHour = pct('five_hour')
  const weekly = pct('seven_day')
  return {
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(weekly !== undefined ? { weekly } : {}),
    overLimit: rateLimits.some(r => r.percentUsed >= 100),
    at: now,
  }
}

// ---------------------------------------------------------------------------
// Schedule math and decide (§6)

/** 1h: clamp(leadMin, 2, 15) minutes; 5m: 30 s fixed. */
export const leadMs = (ttl: Ttl, leadMin: number): number =>
  ttl === '5m' ? 30_000 : Math.min(15, Math.max(2, leadMin)) * 60_000

export const expiresAt = (chain: Chain, ttl: Ttl): number => chain.touchAt + TTL_MS[ttl]

export const nextRefreshAt = (chain: Chain, ttl: Ttl, leadMin: number): number =>
  expiresAt(chain, ttl) - leadMs(ttl, leadMin)

export function windowEnd(anchor: Anchor, s: Settings, tasksAlive: boolean): number {
  if (s.keepFor === 'forever') return Infinity
  const end = anchor.at + KEEP_MS[s.keepFor]
  return tasksAlive ? Math.max(end, anchor.at + TASK_CAP_MS) : end
}

export type Decision =
  | { act: 'refresh' }
  | { act: 'wait'; until: number }
  | { act: 'hold'; reason: 'small' | 'idle-5m' }
  | { act: 'done' }
  | { act: 'stop'; code: StopCode; reason: string; coldSince?: number }

export function decide(x: {
  now: number
  anchor: Anchor | null
  chain: Chain | null
  settings: Settings
  turnOpen: boolean
  tasksAlive: boolean
  limits: Limits | null
  forkInFlight: boolean
}): Decision {
  const { now, anchor, chain, settings: s, limits } = x
  if (s.keepFor === 'off') return { act: 'stop', code: 'user-off', reason: 'off' }
  if (!anchor || !chain) return { act: 'wait', until: Infinity }
  if (anchor.promptTokens < s.minTokens) return { act: 'hold', reason: 'small' }
  if (limits?.weekly !== undefined && limits.weekly >= s.weeklyGuard)
    return { act: 'stop', code: 'weekly-guard', reason: `weekly ${limits.weekly}% ≥ guard ${s.weeklyGuard}%` }
  const exp = expiresAt(chain, anchor.ttl)
  if (now > exp - SAFETY_MS)
    return { act: 'stop', code: 'missed', reason: 'refresh missed: the cache expired before it ran', coldSince: exp }
  if (exp >= windowEnd(anchor, s, x.tasksAlive)) return { act: 'done' }
  if (anchor.ttl === '5m' && !(x.turnOpen && now - anchor.at < FIVE_MIN_RUN_CAP_MS))
    return { act: 'hold', reason: 'idle-5m' }
  if (x.forkInFlight) return { act: 'wait', until: now + IN_FLIGHT_RECHECK_MS }
  const next = nextRefreshAt(chain, anchor.ttl, s.leadMin)
  if (now < next) return { act: 'wait', until: next }
  return { act: 'refresh' }
}

// ---------------------------------------------------------------------------
// Fork outcome (§6)

export type ForkOutcome =
  | { result: 'warmed' }
  | { result: 'cold' }
  | { result: 'retry'; detail: string }
  | { result: 'stop'; code: StopCode; detail: string }

const FATAL = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'cloud_credential_error',
])
const TRANSIENT = new Set(['overloaded', 'server_error', 'unknown'])

export function outcomeOf(reply: ModelForkResult, promptTokens: number, attempt: number): ForkOutcome {
  if (reply.isAnswered === false && reply.reason === 'nothing-to-fork')
    return { result: 'stop', code: 'nothing-to-fork', detail: 'nothing to fork' }
  // A read of at least half the prompt counts before isAnswered: an empty-reply that read still touched the entry.
  if (reply.usage.cache_read_input_tokens >= promptTokens / 2) return { result: 'warmed' }
  if (reply.isAnswered || reply.reason === 'empty-reply') return { result: 'cold' }
  const retry = (detail: string): ForkOutcome =>
    attempt < RETRY_DELAYS_MS.length
      ? { result: 'retry', detail }
      : { result: 'stop', code: 'api-error', detail }
  if (reply.reason === 'aborted')
    return attempt === 0
      ? { result: 'retry', detail: 'aborted' }
      : { result: 'stop', code: 'api-error', detail: 'aborted' }
  const detail = `${reply.error}${reply.status === null ? '' : ` ${reply.status}`}`
  if (reply.status === 429 || reply.error === 'rate_limit') return { result: 'stop', code: 'rate-limited', detail }
  if (FATAL.has(reply.error)) return { result: 'stop', code: 'api-error', detail }
  if (TRANSIENT.has(reply.error) || reply.status === null) return retry(detail)
  return { result: 'stop', code: 'api-error', detail }
}

// ---------------------------------------------------------------------------
// Pricing (docs/research/docs-pricing.md §4, read 2026-10-13, USD per MTok)

export type Rates = { input: number; cacheRead: number; output: number; isGuess: boolean }
type Row = readonly [input: number, cacheRead: number, output: number]

export const PRICES_AS_OF = '2026-10-13'
const PRICES: Record<string, Row> = {
  'claude-fable-5-1': [10, 0.25, 50],
  'claude-fable-5': [10, 1, 50],
  'claude-opus-5-5': [4, 0.2, 20],
  'claude-opus-5': [5, 0.5, 25],
  'claude-opus-4-8': [5, 0.5, 25],
  'claude-opus-4-7': [5, 0.5, 25],
  'claude-opus-4-6': [5, 0.5, 25],
  'claude-opus-4-5': [5, 0.5, 25],
  'claude-opus-4-1': [15, 1.5, 75],
  'claude-opus-4': [15, 1.5, 75],
  'claude-sonnet-5-5': [2, 0.1, 10],
  'claude-sonnet-5': [2, 0.2, 10],
  'claude-sonnet-4-6': [3, 0.3, 15],
  'claude-sonnet-4-5': [3, 0.3, 15],
  'claude-sonnet-4': [3, 0.3, 15],
  'claude-haiku-4-5': [1, 0.1, 5],
  'claude-haiku-3-5': [0.8, 0.08, 4],
}
const HAIKU_55_LOW: Row = [0.1, 0.01, 0.5]
const HAIKU_55_HIGH: Row = [0.5, 0.05, 2.5]
const OPUS_55 = PRICES['claude-opus-5-5'] as Row

/** `claude-opus-5-5[1m]`, `anthropic/claude-opus-5-5-20260101`, `claude-gateway/...` -> `claude-opus-5-5`. */
export const normalizeModel = (model: string): string =>
  model
    .trim()
    .toLowerCase()
    .replace(/^(anthropic|claude-gateway)\//, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-(\d{8}|latest)$/, '')

/** Unknown models price as Opus 5.5 with `isGuess`. Haiku 5.5 tiers by prompt length (input + read + write). */
export function ratesOf(model: string, promptTokens = 0): Rates {
  const id = normalizeModel(model)
  const row = id === 'claude-haiku-5-5' ? (promptTokens > 100_000 ? HAIKU_55_HIGH : HAIKU_55_LOW) : PRICES[id]
  const [input, cacheRead, output] = row ?? OPUS_55
  return { input, cacheRead, output, isGuess: row === undefined }
}

/** One refresh: read x tokens + 91 input + 5 output (the measured shape of a FORK_PROMPT request). */
export function refreshUsd(model: string, promptTokens: number): number {
  const r = ratesOf(model, promptTokens)
  return (promptTokens * r.cacheRead + 91 * r.input + 5 * r.output) / 1_000_000
}

/** What the next request pays to write the prefix again: tokens x input x (1h ? 2 : 1.25). */
export function rewriteUsd(model: string, promptTokens: number, ttl: Ttl): number {
  const r = ratesOf(model, promptTokens)
  return (promptTokens * r.input * (ttl === '1h' ? 2 : 1.25)) / 1_000_000
}

// ---------------------------------------------------------------------------
// Formatting

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${Math.round(n / 100) / 10}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n / 100_000) / 10}M`
}

export function fmtUsd(v: number): string {
  if (v < 0) return v > -0.005 ? '$0.00' : `-${fmtUsd(-v)}`
  if (v > 0 && v < 0.005) return '<$0.01'
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`
}

/** '45s' | '41m' | '1h05m' */
export function fmtIn(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Local date, '2026-10-13'. */
export function fmtDate(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local time of day on a 12-hour clock (the user's choice): '2:05 PM', '6:00 AM'. */
export function fmtClock(at: number): string {
  const d = new Date(at)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

/** '41%', '23.5%' */
export const fmtPct = (n: number): string => `${Math.round(n * 10) / 10}%`

/** '8h' for whole hours, else fmtIn. */
export const fmtSpan = (ms: number): string => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : fmtIn(ms))

/** The label a minute-granular countdown shows for `ms` left: '50m', '1h05m', 'now' under half a minute. */
export function fmtMinutes(ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60_000)
  if (m < 1) return ms >= 30_000 ? '1m' : 'now'
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// ---------------------------------------------------------------------------
// Savings (brief 2b §4): what the refreshes avoided against what they cost, at API list prices.

export type Money = { refreshes: number; costUsd: number; avoided: number; grossUsd: number }

/** Rewrites avoided minus every refresh's spend: negative until the first avoided rewrite has paid for the refreshes. */
export const netUsd = (t: Money): number => t.grossUsd - t.costUsd

export type Savings = {
  /** Something was avoided: the sheet and the pane show `hero` and `session`; otherwise the one dim `empty` line. */
  has: boolean
  /** `Saved $12.40`, or `Spent $0.48 so far` while the refreshes have not paid for themselves. */
  hero: string
  /** `this session $3.20` */
  session: string
  /** The dim line shown instead of the figures until a rewrite has been avoided. */
  empty: string
  /** The sum behind the hero (for /cache stats). */
  detail: string
  note: string
}

const plural0 = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One totals row for /cache stats and the pane: the three numbers (rewrites avoided, refreshes' cost, net) and the counts. */
export const totalsText = (t: Money): string => {
  const net = netUsd(t)
  return (
    `${plural0(t.refreshes, 'refresh', 'refreshes')} · ${plural0(t.avoided, 'rewrite')} avoided (would have cost ${fmtUsd(t.grossUsd)}) · ` +
    `refreshes cost ${fmtUsd(t.costUsd)} · ${net >= 0 ? `saved ${fmtUsd(net)}` : `net cost ${fmtUsd(-net)}`}`
  )
}

export const SAVINGS_NOTE = 'At API list prices. On a Pro/Max plan this is usage, not billing.'

export function savingsOf(all: Money, session: Money): Savings {
  const net = netUsd(all)
  return {
    has: all.avoided > 0,
    hero: net >= 0 ? `Saved ${fmtUsd(net)}` : `Spent ${fmtUsd(-net)} so far`,
    session: `this session ${fmtUsd(netUsd(session))}`,
    empty: 'No savings yet — they show when you return to a warm cache.',
    detail: `rewrites avoided ${fmtUsd(all.grossUsd)} − refreshes ${fmtUsd(all.costUsd)}`,
    note: SAVINGS_NOTE,
  }
}

/** The window the band's chip cycles through: 2h, 4h, 8h, 12h, no end, and round again (from `off` it starts at 2h). */
export const KEEP_CYCLE = ['2h', '4h', '8h', '12h', 'forever'] as const
export const nextKeep = (k: KeepFor): KeepFor => KEEP_CYCLE[(KEEP_CYCLE.findIndex(v => v === k) + 1) % KEEP_CYCLE.length] as KeepFor
export const keepLabel = (k: KeepFor): string => (k === 'forever' ? '∞' : k)

// ---------------------------------------------------------------------------
// Band line (brief 2b §2 copy table), shared by the band and /cache status

/** What a line's tone is called is what its art is called (art.ts). */
export type LineTone = ArtState
/** How much text the band has room for: from its columns, 90+ full, 60-89 short, under 60 tiny (symbol and controls only). */
export type Tier = 'full' | 'short' | 'tiny'
export const tierOf = (columns: number): Tier => (columns >= 90 ? 'full' : columns >= 60 ? 'short' : 'tiny')

/** A text with an optional countdown in it: `pre` `ms` `post`. The desktop draws the countdown as a self-ticking image.
 * `word` is the state word (a prefix of `pre`, or empty) that the band draws bold. */
export type Seg = { pre: string; ms: number | null; post: string; word?: string }
export const segText = (s: Seg, fmt: (ms: number) => string = fmtIn): string =>
  [s.pre, s.ms === null ? '' : fmt(s.ms), s.post].filter(Boolean).join(' ')

/** `text` is the whole line flat (the terminal, /cache status); `hover` the desktop's card over the line, or null. */
export type Line = Seg & { symbol: string; tone: LineTone; text: string; hover: Seg | null }

/** The cache with this long left is "cooling": the band warns. */
export const COOL_MS = 600_000
/** The cooling alert window: 10 min, or a third of a shorter TTL. */
export const coolMs = (ttl: Ttl): number => Math.min(COOL_MS, TTL_MS[ttl] / 3)

export type LineInput = {
  now: number
  anchor: Anchor | null
  chain: Chain | null
  status: Status
  settings: Settings
  dialog: Dialog | null
  tasks: readonly Task[]
  limits: Limits | null
  resumed: Resumed | null
  /** Learned estimate of one rewrite as a percent of the 5-hour window, when known. */
  pct5h?: number
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** An anchor and a chain only mean something together: a value another version of the code wrote can leave just one. */
const paired = (x: LineInput): { anchor: Anchor; chain: Chain } | null => (x.anchor && x.chain ? { anchor: x.anchor, chain: x.chain } : null)

/** Cold now? When it went cold and whether a missed refresh (the Mac slept) is why; `since` is null for a resumed session. */
function coldInfo(x: LineInput): { since: number | null; missed: boolean } | null {
  const p = paired(x)
  const { status } = x
  if (!p) return status.kind !== 'stopped' && x.resumed?.cold ? { since: null, missed: false } : null
  const exp = expiresAt(p.chain, p.anchor.ttl)
  if (x.now <= exp || status.kind === 'refreshing') return null
  const stopped = status.kind === 'stopped'
  return { since: stopped && status.coldSince !== undefined ? status.coldSince : exp, missed: stopped && status.code === 'missed' }
}

/** The detail the short cold line leaves out (when it went cold, why), for /cache status and the pane; null when not cold. */
export function coldDetail(x: LineInput): string | null {
  const c = coldInfo(x)
  if (!c) return null
  if (c.since === null) return 'Resumed session: its cache had already expired'
  return `${c.missed ? 'Refresh missed while asleep · c' : 'C'}ache cold since ${fmtClock(c.since)}`
}

/** Stops that are an error or a guard (the band is rose); the rest the person or the conversation caused (dim). */
const ERROR_STOPS = new Set<StopCode>(['weekly-guard', 'rate-limited', 'api-error', 'missed', 'cold', 'nothing-to-fork'])

/** The short reason a stop gets in the band. */
export function stopWhy(code: StopCode, s: Settings): string {
  switch (code) {
    case 'weekly-guard': return `weekly usage hit the ${s.weeklyGuard}% guard`
    case 'rate-limited': return 'rate-limited'
    case 'api-error': return 'API error'
    case 'missed': return 'refresh missed'
    case 'cold': return 'prompt changed'
    case 'model-switched': return 'model switched'
    case 'compacted': return 'conversation compacted'
    case 'cleared': return 'conversation cleared'
    case 'session-ended': return 'session ended'
    case 'nothing-to-fork': return 'nothing to refresh'
    case 'window': return 'window ended'
    case 'user-off': return 'off'
  }
}

const OFF_WORDS = ['Auto-refresh off', 'Off', 'off']
const STOP_WORDS = ['Stopped', 'stopped']

const seg = (pre: string, ms: number | null = null, post = ''): Seg => ({ pre, ms, post })

/** The state word of a segment: the longest of `words` that `pre` starts with (none for the minimal style or a countdown-only text). */
const withWord = (s: Seg, words: readonly string[]): Seg => {
  const word = words.filter(w => s.pre.startsWith(w)).sort((a, b) => b.length - a.length)[0]
  return word ? { ...s, word } : s
}

/**
 * The one-line state, or null when there is nothing to say (no anchor, not resumed cold). `tier` picks how much text
 * (see `tierOf`); `minimal` is the one dim word-only line of the minimal band style (no countdown: nothing redraws it each minute on the desktop). The weekly figure is
 * never in it (it is in /cache status and the settings sheet).
 */
export function bandLine(x: LineInput, style: 'full' | 'minimal' = 'full', tier: Tier = 'full'): Line | null {
  const { now, status, settings } = x
  const p = paired(x)
  const anchor = p?.anchor
  const chain = p?.chain
  const exp = p ? expiresAt(p.chain, p.anchor.ttl) : null
  const warmLeft = exp !== null && exp > now ? exp - now : null
  const cooling = warmLeft !== null && p !== null && warmLeft <= coolMs(p.anchor.ttl)
  const min = style === 'minimal'
  const pick = (full: Seg, short: Seg, tiny: Seg): Seg => (tier === 'full' ? full : tier === 'short' ? short : tiny)
  const hover: Seg | null =
    warmLeft !== null && chain
      ? seg(`Cache expires ${fmtClock(exp as number)} · in`, warmLeft, chain.refreshes > 0 ? `· kept ${chain.refreshes}× (${fmtUsd(chain.costUsd)})` : '')
      : null
  const out = (symbol: string, tone: LineTone, full: Seg, short: Seg, tiny: Seg, minimal: string, words: readonly string[]): Line => {
    const s = min ? seg(minimal) : withWord(pick(full, short, tiny), words)
    return { symbol, tone, ...s, text: segText(s), hover }
  }

  if (coldInfo(x)) {
    const tokens = anchor?.promptTokens ?? x.resumed?.tokens ?? 0
    const usd = anchor ? rewriteUsd(anchor.model, tokens, anchor.ttl) : (x.resumed?.estUsd ?? rewriteUsd('', tokens, '1h'))
    const pct = x.pct5h !== undefined ? ` · ~${fmtPct(x.pct5h)} of 5h` : ''
    return out('❄', 'cold',
      seg(`Cache cold · next message rewrites ${fmtTokens(tokens)} (~${fmtUsd(usd)})${pct}`),
      seg(`Cold · rewrite ${fmtTokens(tokens)} ~${fmtUsd(usd)}`), seg('cold'), 'cold', ['Cache cold', 'Cold', 'cold'])
  }
  if (settings.keepFor === 'off') {
    const tone: LineTone = cooling ? 'cooling' : 'off'
    return warmLeft !== null
      ? out(cooling ? '◐' : '○', tone, seg('Auto-refresh off · cache expires in', warmLeft), seg('Off · expires', warmLeft), seg('off', warmLeft), 'off', OFF_WORDS)
      : out('○', tone, seg('Auto-refresh off'), seg('Off'), seg('off'), 'off', OFF_WORDS)
  }
  if (!anchor && status.kind !== 'stopped') return null
  switch (status.kind) {
    case 'refreshing':
      return out('◌', 'refreshing', seg('Refreshing…'), seg('Refreshing…'), seg('refresh'), 'refreshing', ['Refreshing', 'refresh'])
    case 'retrying': {
      const why = status.error.split(' ')[0] ?? status.error
      const ms = Math.max(0, status.nextAt - now)
      return out('◌', 'error', seg(`Refresh failed (${why}) · retrying in`, ms), seg('Failed · retry', ms), seg('retry', ms), 'retrying', ['Refresh failed', 'Failed', 'retry'])
    }
    case 'holding':
      if (status.reason === 'idle-5m')
        return out('○', 'dim', seg('5-minute cache · refreshed only while Claude works'), seg('5m cache · refreshed while working'), seg('5m cache'), '5m cache', ['5-minute cache', '5m cache'])
      return out('○', 'dim',
        seg(`Context ${fmtTokens(anchor?.promptTokens ?? 0)} is below the ${fmtTokens(settings.minTokens)} minimum · not kept warm`),
        seg(`Context ${fmtTokens(anchor?.promptTokens ?? 0)} · not kept`), seg('not kept'), 'not kept', [`Context ${fmtTokens(anchor?.promptTokens ?? 0)}`, 'not kept'])
    case 'done': {
      const span = anchor ? fmtSpan(windowEnd(anchor, settings, x.tasks.length > 0) - anchor.at) : ''
      const tone: LineTone = cooling ? 'cooling' : 'dim'
      const doneWords = [`Kept warm for ${span}`, 'Done', 'done']
      return warmLeft !== null
        ? out(cooling ? '◐' : '○', tone, seg(`Kept warm for ${span} · auto-refresh ended · cache expires in`, warmLeft), seg('Done · expires', warmLeft), seg('done', warmLeft), 'done', doneWords)
        : out('○', tone, seg(`Kept warm for ${span} · auto-refresh ended`), seg('Done'), seg('done'), 'done', doneWords)
    }
    case 'stopped': {
      const why = stopWhy(status.code, settings)
      const tone: LineTone = ERROR_STOPS.has(status.code) ? 'error' : cooling ? 'cooling' : 'dim'
      return warmLeft !== null
        ? out('■', tone, seg(`Stopped: ${why} · cache expires in`, warmLeft), seg('Stopped · expires', warmLeft), seg('stopped', warmLeft), 'stopped', STOP_WORDS)
        : out('■', tone, seg(`Stopped: ${why}`), seg('Stopped'), seg('stopped'), 'stopped', STOP_WORDS)
    }
    default: {
      // scheduled, or waiting with an anchor (a main request just landed)
      if (!anchor || !chain) return null
      const next = (status.kind === 'scheduled' ? status.nextAt : nextRefreshAt(chain, anchor.ttl, settings.leadMin)) - now
      const extra = [x.dialog ? '· waiting on your answer' : '', x.tasks.length > 0 ? `· ${plural(x.tasks.length, 'background task')}` : ''].filter(Boolean).join(' ')
      return out('●', 'warm', seg('Warm · next refresh in', next, extra), seg('Warm · refresh', next), seg('', next), 'warm', ['Warm'])
    }
  }
}

export const lineText = (l: Line): string => `${l.symbol} ${l.text}`

/**
 * Which palette the band wears. The config row `theme` decides when it says light or dark; under `auto` (or anything else) the desktop
 * app's own mode (`userThemeMode`) does when it is light or dark; else the OS (`defaults read -g AppleInterfaceStyle`: Dark, or Light
 * when the key is absent). A probe that could not run (`os: null`) reads as dark. `undefined`: not decided yet, `os` has not been asked.
 */
export function appearanceOf(i: { themeRow: unknown; appMode?: string | null; os?: 'Dark' | 'Light' | null }): 'light' | 'dark' | undefined {
  const row = typeof i.themeRow === 'string' ? i.themeRow : ''
  if (row.startsWith('light')) return 'light'
  if (row.startsWith('dark')) return 'dark'
  if (i.appMode === 'light' || i.appMode === 'dark') return i.appMode
  return i.os === undefined ? undefined : i.os === 'Light' ? 'light' : 'dark'
}
