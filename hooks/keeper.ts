// cache-keeper engine glue (design.md §4, §8, §11): atoms, the one refresh timer, refresh(), stop().
// Patterns adapted from paulbkim-dev/claude-code-cache-warmer (MIT, (c) Paul B. Kim): the claim object with a
// finally-clear, schedule() reading state last, re-arming in session.start, the system notice row.
import type { ModelForkResult, Timer } from 'claude-code'

import type {
  Anchor,
  Chain,
  Dialog,
  Elsewhere,
  Limits,
  RefreshRecord,
  KeepFor,
  Resumed,
  Settings,
  Status,
  StopCode,
  Task,
  Totals,
  Ttl,
} from '../types'
import type { Io, KeeperState } from './io'
import { drainSave, keptDefaults, forgetKept } from './defaults'
import { addAllTime, logLine, readLearned, saveLearned } from './log'
import { HEARTBEAT_MS, entryOf, resetLive, stopAskedAt, writeEntry } from './live'
import type { Ident } from './live'
import { sheetFits } from './view'
import type { Learned } from './log'
import {
  CLAIM_STALE_MS,
  COOL_MS,
  coolMs,
  DEFAULT_SETTINGS,
  FORK_PROMPT,
  RETRY_DELAYS_MS,
  SAFETY_MS,
  TTL_MS,
  TTL_WHY_TEXT,
  bandLine,
  decide,
  expiresAt,
  fmtClock,
  fmtIn,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  limitsOf,
  lineText,
  nextRefreshAt,
  outcomeOf,
  readOptions,
  refreshUsd,
  rewriteUsd,
  ttlOf,
  ttlWhy,
  windowEnd,
  appearanceOf,
} from './policy'
import type { Decision, LineInput, TtlInputs } from './policy'

// ---------------------------------------------------------------------------
// State keys ($.state, survives a reload). The atoms themselves are declared in register.tsx: the hooks loader
// only lists state a module reads and writes when its atoms are consts of that file. Never written from a render.

export const A = {
  anchor: 'anchor',
  chain: 'chain',
  status: 'status',
  settings: 'settings',
  turn: 'turn',
  dialog: 'dialog',
  tasks: 'tasks',
  limits: 'limits',
  contextTokens: 'contextTokens',
  costUsd: 'costUsd',
  refreshing: 'refreshing',
  last: 'last',
  session: 'session',
  resumed: 'resumed',
  surface: 'surface',
  light: 'light',
  sheetOpen: 'sheetOpen',
  ttlSet: 'ttlSet',
  elsewhere: 'elsewhere',
  onAt: 'onAt',
} as const

// A status change is the moment this session's live file (live.ts) may be out of date: one place, here.
const put = <K extends keyof KeeperState>(io: Io, key: K, v: KeeperState[K]) =>
  io.update(key, () => v).then(r => {
    if (key === A.status) void publish(io)
    return r
  })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// Module variables (lost on reload, fine)

type Base = { pct: number; cost: number; exact: boolean }

let timer: Timer | undefined
/** The one-off redraws at the cooling threshold and at expiry (the countdown itself ticks in its own image). */
let viewTimer: Timer | undefined
/** The band as last drawn: where a gear press or /cache settings can put the sheet (module variable, lost on reload). */
let seenBand: { desktop: boolean; columns: number; maxRows: number } | null = null
/** Mirrors the state claim for code that must not await. */
let forking = false
let schedChain: Promise<unknown> = Promise.resolve()
let ttlEnv: Omit<TtlInputs, 'limits'> = { authKind: null }
let saved: Settings = DEFAULT_SETTINGS
/** Main-thread requests (turn.step) started and in flight: a fork that overlapped one cannot read its own cost off the ledger. */
const mainSteps = { started: 0, inFlight: 0 }
let learned: Learned = {}
/** `anchor.at` of the last window-end notice: buttons can leave `done` and come back, and the conversation hears it once. */
let noticedAt: number | undefined
const baselines: { five?: Base; week?: Base } = {}
const warned = new Set<string>()
const surfaceSeen = new Set<string>()
/** What the live file says about who this session is (the title from the classic SessionStart, the folder from session.start). */
let ident: Ident = {}
let ended = false
/** The heartbeat of the live file, armed while this session is warming. */
let beat: Timer | undefined
/** Why the user-off stop in flight is happening, when it is another session's request. */
let remoteWhy: string | undefined

export const noteIdentity = (i: Ident): void => {
  ident = { ...ident, ...i }
}

export function resetKeeper(): void {
  ident = {}
  ended = false
  beat?.cancel()
  beat = undefined
  remoteWhy = undefined
  resetLive()
  lastOn = null
  themeAt = undefined
  themeNote = 'theme: not read yet'
  timer?.cancel()
  timer = undefined
  viewTimer?.cancel()
  viewTimer = undefined
  seenBand = null
  forking = false
  schedChain = Promise.resolve()
  ttlEnv = { authKind: null }
  saved = DEFAULT_SETTINGS
  mainSteps.started = 0
  mainSteps.inFlight = 0
  learned = {}
  delete baselines.five
  delete baselines.week
  warned.clear()
  surfaceSeen.clear()
}

const warn = (io: Io, where: string, err: unknown) => {
  if (warned.has(where)) return
  warned.add(where)
  try {
    io.debug(`cache-keeper: ${where}: ${errText(err)}`)
  } catch {
    // nowhere left to say it
  }
}

/** Runs an observer's own part; a throw is logged once and never reaches the engine. */
export async function safely(io: Io, where: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    warn(io, where, err)
  }
}

export const savedSettings = (): Settings => saved
export const learnedRates = (): Learned => learned

// ---------------------------------------------------------------------------
// Snapshot: every piece of state at one moment

export type Snap = {
  now: number
  anchor: Anchor | null
  chain: Chain | null
  status: Status
  settings: Settings
  turn: { id: string; since: number } | null
  dialog: Dialog | null
  tasks: Task[]
  limits: Limits | null
  contextTokens: number | null
  costUsd: number | null
  refreshing: { claimAt: number } | null
  last: RefreshRecord | null
  session: Totals
  resumed: Resumed | null
  surface: 'terminal' | 'desktop' | null
  light: boolean
  sheetOpen: boolean
  elsewhere: Elsewhere[]
  /** When warming was last turned on in this session (the keep chip, /cache on, a setting); state, so a reload keeps it. */
  onAt: number | null
}

export async function snapshot(io: Io): Promise<Snap> {
  const [now, anchor, chain, status, settings, turn, dialog, tasks, limits] = await Promise.all([
    io.now(),
    io.read(A.anchor),
    io.read(A.chain),
    io.read(A.status),
    io.read(A.settings),
    io.read(A.turn),
    io.read(A.dialog),
    io.read(A.tasks),
    io.read(A.limits),
  ])
  const [contextTokens, costUsd, refreshing, last, session, resumed, surface, light, sheetOpen, elsewhere, onAt] = await Promise.all([
    io.read(A.contextTokens),
    io.read(A.costUsd),
    io.read(A.refreshing),
    io.read(A.last),
    io.read(A.session),
    io.read(A.resumed),
    io.read(A.surface),
    io.read(A.light),
    io.read(A.sheetOpen),
    io.read(A.elsewhere),
    io.read(A.onAt),
  ])
  return {
    now, anchor, chain, status, settings, turn, dialog, tasks, limits,
    contextTokens, costUsd, refreshing, last, session, resumed, surface, light, sheetOpen, elsewhere, onAt,
  }
}

const inFlight = (s: Snap) =>
  forking || (s.refreshing !== null && s.now - s.refreshing.claimAt < CLAIM_STALE_MS)

const ttlInputs = (limits: Limits | null): TtlInputs => ({ ...ttlEnv, limits })

/** Why the TTL is what it is, for /cache status. */
export const ttlExplain = (s: Snap): string => {
  const w = ttlWhy(ttlInputs(s.limits))
  return `${s.anchor?.ttl ?? w.ttl} (${TTL_WHY_TEXT[w.why]})`
}

export const lineInputOf = (s: Snap): LineInput => {
  const per = learned.usdPerPoint5h
  const pct5h =
    per && s.anchor ? rewriteUsd(s.anchor.model, s.anchor.promptTokens, s.anchor.ttl) / per : undefined
  return {
    now: s.now, anchor: s.anchor, chain: s.chain, status: s.status, settings: s.settings,
    dialog: s.dialog, tasks: s.tasks, limits: s.limits, resumed: s.resumed,
    ...(pct5h !== undefined ? { pct5h } : {}),
  }
}

export const statusLine = (s: Snap): string => {
  const l = bandLine(lineInputOf(s))
  return l ? lineText(l) : 'No cache to keep yet (no request in this conversation).'
}

// ---------------------------------------------------------------------------
// Usage: context, cost, limits, plus the learned plan-percent rates (§6)

async function learn(io: Io, limits: Limits, cost: number | null): Promise<void> {
  if (cost === null) return
  let changed = false
  const step = (k: 'five' | 'week', pct: number | undefined, field: keyof Learned) => {
    if (pct === undefined) {
      delete baselines[k]
      return
    }
    const b = baselines[k]
    if (!b || pct < b.pct) {
      // First reading, or the window reset: the next rise is only a partial point, so it re-bases without learning.
      baselines[k] = { pct, cost, exact: false }
      return
    }
    if (pct === b.pct) return
    if (b.exact && cost > b.cost) {
      const rate = (cost - b.cost) / (pct - b.pct)
      const prev = learned[field]
      learned = { ...learned, [field]: prev ? 0.3 * rate + 0.7 * prev : rate }
      changed = true
    }
    baselines[k] = { pct, cost, exact: true }
  }
  step('five', limits.fiveHour, 'usdPerPoint5h')
  step('week', limits.weekly, 'usdPerPointWeek')
  if (changed) void saveLearned(io, learned)
}

/** Writes context, cost and limits to state. Returns the limits as they were before. */
async function ingest(
  io: Io,
  now: number,
  rateLimits: readonly { kind: string; percentUsed: number }[],
  tokens: number | undefined,
  cost: number | undefined,
): Promise<{ before: Limits | null; limits: Limits }> {
  const limits = limitsOf(rateLimits, now)
  const before = await io.read(A.limits)
  await Promise.all([
    put(io, A.limits, limits),
    put(io, A.contextTokens, tokens ?? null),
    put(io, A.costUsd, cost ?? null),
  ])
  await learn(io, limits, cost ?? null)
  return { before, limits }
}

async function readUsage(io: Io) {
  try {
    const u = await io.usage()
    const now = await io.now()
    const { limits } = await ingest(io, now, u.rateLimits, u.context.tokens, u.cost?.usd)
    return { costUsd: u.cost?.usd ?? null, limits }
  } catch (err) {
    warn(io, 'session.usage', err)
    return undefined
  }
}

export async function onMeasure(
  io: Io,
  e: { context: { tokens?: number }; rateLimits: readonly { kind: string; percentUsed: number }[]; cost?: { usd: number } },
): Promise<void> {
  const s = await snapshot(io)
  const { before, limits } = await ingest(io, s.now, e.rateLimits, e.context.tokens, e.cost?.usd)
  const guard = s.settings.weeklyGuard
  const crossed = ((before?.weekly ?? -1) >= guard) !== ((limits.weekly ?? -1) >= guard)
  if (before?.overLimit !== limits.overLimit || crossed) await schedule(io)
}

// ---------------------------------------------------------------------------
// Session start and settings

/** Environment values register.tsx reads with literal names (the loader lists them). */
export type StartEnv = { force?: string; envTtl?: string; enable1h?: string }

export async function start(io: Io, options: Readonly<Record<string, unknown>>, env: StartEnv): Promise<void> {
  // Saved defaults a /config row refused (see defaults.ts) sit over the manifest options.
  const defaults = readOptions({ ...options, ...(await keptDefaults(io)) })
  saved = defaults
  ended = false
  const settings = await io.settings().catch(err => {
    warn(io, 'settings.read', err)
    return {} as Record<string, unknown>
  })
  const authKind = await io.authKind().catch(err => {
    warn(io, 'session.authorize', err)
    return null
  })
  ttlEnv = {
    ...(env.force !== undefined ? { force: env.force } : {}),
    ...(env.envTtl !== undefined ? { envTtl: env.envTtl } : {}),
    setting: settings.promptCacheTtl,
    ...(env.enable1h !== undefined ? { enable1h: env.enable1h } : {}),
    authKind,
  }
  const now = await io.now()
  // The session's settings come from the options only the first time (session.since marks it); a reload keeps
  // what the session changed.
  if ((await io.read(A.session)).since === 0) {
    await put(io, A.settings, defaults)
    await io.update(A.session, t => ({ ...t, since: now }))
  }
  const claim = await io.read(A.refreshing)
  if (claim && now - claim.claimAt >= CLAIM_STALE_MS) {
    await put(io, A.refreshing, null)
    await logLine(io, 'claim-stale', { claimAt: claim.claimAt })
  }
  const u = await readUsage(io)
  learned = await readLearned(io)
  await applyUpgrade(io, await io.read(A.settings), u?.limits ?? null)
  await schedule(io)
  await refreshTheme(io)
  // A "Save as default" that is still writing: each config.set reloads this module, which lands here again.
  await drainSave(io, defaults, false)
}

/** When the theme was last looked at, and what it said (`/cache debug`): module variables, lost on a reload. */
let themeAt: number | undefined
let themeNote = 'theme: not read yet'
/** The render path looks at the theme no more often than this. */
export const THEME_EVERY_MS = 15_000
const APP_CONFIG = 'Library/Application Support/Claude/config.json'

/**
 * The app's appearance into state (`light`), so the band redraws when it changes: the `theme` row, else (a terminal: dark), else the desktop app's `userThemeMode`, else
 * the OS (policy.appearanceOf). The app's file and the OS are read only when the row leaves it open; a read that fails is skipped.
 */
export async function refreshTheme(io: Io): Promise<void> {
  try {
    themeAt = await io.now()
    const themeRow = (await io.configRows()).find(r => r.key === 'theme')?.value
    let appMode: string | null | undefined
    let os: 'Dark' | 'Light' | null | undefined
    let how = appearanceOf({ themeRow })
    // A terminal's background is neither the desktop app's mode nor the OS appearance: `auto` stays dark there (0.1.4), no probes.
    if (how === undefined && (await io.read(A.surface)) === 'terminal') how = 'dark'
    if (how === undefined) {
      appMode = await io.home().then(async h => (h ? (JSON.parse(await io.fsRead(`${h}/${APP_CONFIG}`)) as { userThemeMode?: unknown }).userThemeMode : undefined)).then(v => (typeof v === 'string' ? v : null), () => null)
      how = appearanceOf({ themeRow, appMode })
    }
    if (how === undefined) {
      os = await io.run(['defaults', 'read', '-g', 'AppleInterfaceStyle']).then(r => (r.exitCode === 0 && r.stdout.trim() === 'Dark' ? 'Dark' : 'Light'), () => null)
      how = appearanceOf({ themeRow, appMode, os })
    }
    themeNote = `theme: ${typeof themeRow === 'string' ? themeRow : '-'} · app: ${appMode ?? '-'} · os: ${os === undefined ? '-' : (os ?? '?')} → ${how}`
    if ((await io.read(A.light)) !== (how === 'light')) await put(io, A.light, how === 'light')
  } catch (err) {
    warn(io, 'config.list', err)
  }
}

/** From a draw: a look at the theme, at most once per THEME_EVERY_MS, off the render (the write redraws; a draw never awaits it). */
export const themeSoon = (io: Io): void =>
  void io.after(0, () =>
    void safely(io, 'theme', async () => {
      const now = await io.now()
      if (themeAt === undefined || now - themeAt >= THEME_EVERY_MS) await refreshTheme(io)
    }),
  )

/** `/cache debug`: how the palette was decided, last time. */
export const themeLine = (): string => themeNote

/** What the session pays by: an API key (the 1-hour cache is its switch, there is no weekly plan usage), else a subscription. */
export const sessionKind = (): 'subscription' | 'api-key' => (ttlEnv.authKind === 'api-key' ? 'api-key' : 'subscription')

/** upgradeTo1h: an API-key session with no TTL override asks for the 1h cache (applies from its next request). */
async function applyUpgrade(io: Io, s: Settings, limits: Limits | null): Promise<void> {
  if (s.upgradeTo1h && ttlWhy(ttlInputs(limits)).why === 'default' && ttlEnv.authKind === 'api-key') {
    await io.setTtlEnv('1h')
    ttlEnv = { ...ttlEnv, envTtl: '1h' }
    await put(io, A.ttlSet, true)
  }
}

export async function setSettings(io: Io, patch: Partial<Settings>): Promise<void> {
  const wasOff = (await io.read(A.settings)).keepFor === 'off'
  const next = await io.update(A.settings, s => ({ ...s, ...patch }))
  if (wasOff && next.keepFor !== 'off') await put(io, A.onAt, await io.now())
  if (patch.upgradeTo1h) await applyUpgrade(io, next, await io.read(A.limits))
  // Off again: take back the variable the mod set (never one the user set).
  else if (patch.upgradeTo1h === false && (await io.read(A.ttlSet))) {
    await io.setTtlEnv(undefined)
    delete ttlEnv.envTtl
    await put(io, A.ttlSet, false)
  }
  await schedule(io)
}

/** `/cache on` and the band's On: back to the saved window (8h when the saved default is off). */
// The window the session had when the switch went off, so On restores what the keep chip chose (lost on a reload: then the saved one).
let lastOn: KeepFor | null = null

export async function warmingOn(io: Io): Promise<KeepFor> {
  const keepFor = lastOn ?? (saved.keepFor === 'off' ? '8h' : saved.keepFor)
  lastOn = null
  await setSettings(io, { keepFor })
  return keepFor
}

/** The band's switch: off stops warming for the session; on goes back to the saved window. */
export async function toggleWarming(io: Io): Promise<void> {
  const cur = (await io.read(A.settings)).keepFor
  if (cur === 'off') return void (await warmingOn(io))
  lastOn = cur
  await setSettings(io, { keepFor: 'off' })
}

/** Remembers the band as drawn, so the gear and /cache settings know whether the sheet fits. */
export const noteBand = (b: { desktop: boolean; columns: number; maxRows: number }): void => {
  seenBand = b
}

export const bandGeo = () => seenBand

export const setSheet = (io: Io, open: boolean): Promise<unknown> => put(io, A.sheetOpen, open)

/**
 * Opens the settings where they fit: the in-band sheet when the band is drawn on the desktop in full style with the rows
 * for it (`geo` is the band the press came from, else the last one drawn), else the Pane. Returns where, or 'none' when
 * the Pane has no room either.
 */
export async function openSettings(io: Io, geo?: { desktop: boolean; columns: number; maxRows: number }): Promise<'sheet' | 'pane' | 'none'> {
  const g = geo ?? seenBand
  if (g?.desktop && (await io.read(A.settings)).band === 'full' && sheetFits(g.maxRows, g.columns)) {
    await setSheet(io, true)
    return 'sheet'
  }
  return (await io.openPane()) ? 'pane' : 'none'
}

export async function setSurface(io: Io, surface: 'terminal' | 'desktop'): Promise<void> {
  if (surfaceSeen.has(surface)) return
  surfaceSeen.add(surface)
  await put(io, A.surface, surface)
}

// ---------------------------------------------------------------------------
// Scheduler: the only place that arms the timer

/** Stops that hold until the next main request; user-off and weekly-guard are re-decided every time. */
const REEVALUATED = new Set<StopCode>(['user-off', 'weekly-guard'])

export function schedule(io: Io): Promise<void> {
  const run = schedChain.then(() => scheduleNow(io)).then(() => armView(io)).then(() => publish(io)).catch(err => warn(io, 'schedule', err))
  schedChain = run
  return run as Promise<void>
}

/** This session is keeping its cache warm: on, with a chain to keep, and refreshes planned or running (a held or finished one is not). The band's warm look, and what the live file calls `warming`. */
export const isKept = (s: Snap): boolean =>
  s.settings.keepFor !== 'off' && s.anchor !== null && s.chain !== null && (s.status.kind === 'scheduled' || s.status.kind === 'waiting' || s.status.kind === 'refreshing' || s.status.kind === 'retrying')

/**
 * Writes this session's live file from the state as it is when the write's turn comes, and keeps the heartbeat (a write each
 * HEARTBEAT_MS, which also looks for a stop request) armed exactly while the session is warming. Never throws.
 */
export const publish = (io: Io, force = false): Promise<void> =>
  writeEntry(
    io,
    async () => {
      const s = await snapshot(io)
      const warming = !ended && isKept(s)
      if (!warming) {
        beat?.cancel()
        beat = undefined
      } else if (!beat) {
        beat = io.after(HEARTBEAT_MS, () => {
          beat = undefined
          void safely(io, 'heartbeat', async () => {
            await checkRemoteStop(io)
            await publish(io, true)
          })
        })
      }
      return entryOf(s, warming, await io.sessionId(), ident)
    },
    force,
  )

/** Another session asked this one to stop after it last turned warming on. */
async function remoteStopDue(io: Io): Promise<boolean> {
  const at = await stopAskedAt(io)
  return at !== undefined && at > ((await io.read(A.onAt)) ?? (await io.read(A.session)).since)
}

/**
 * Stops exactly like `/cache off` (so `/cache on` restores the window), as another session asked: logs the stop with its reason and
 * says so once in the conversation. True when it stopped. Checked right before every fork and on each heartbeat.
 */
export async function checkRemoteStop(io: Io): Promise<boolean> {
  if (!(await remoteStopDue(io))) return false
  const cur = (await io.read(A.settings)).keepFor
  if (cur === 'off') return false
  lastOn = cur
  remoteWhy = 'stopped from another session'
  try {
    await setSettings(io, { keepFor: 'off' })
  } finally {
    remoteWhy = undefined
  }
  await notice(io, await snapshot(io), 'stopped from another session')
  return true
}

/**
 * The band redraws only when its state changes, so the moments its look changes with no state change get one redraw each:
 * the cache starting to cool (10 minutes left, when nothing is refreshing it) and its expiry. The countdown digits tick
 * in their own image and need none.
 */
async function armView(io: Io): Promise<void> {
  viewTimer?.cancel()
  viewTimer = undefined
  const s = await snapshot(io)
  if (!s.anchor || !s.chain) return
  const exp = expiresAt(s.chain, s.anchor.ttl)
  const kept = isKept(s)
  // +1 ms: the band is cold only after the expiry, not at it.
  const at = (kept ? [exp + 1] : [exp - coolMs(s.anchor.ttl), exp + 1]).find(t => t > s.now)
  if (at === undefined) return
  viewTimer = io.after(at - s.now, () => {
    io.invalidate()
    void armView(io)
  })
}

const putStatus = async (io: Io, current: Status, next: Status) => {
  if (!same(current, next)) await put(io, A.status, next)
}

async function scheduleNow(io: Io): Promise<void> {
  const s = await snapshot(io)
  const { now, status } = s
  timer?.cancel()
  timer = undefined
  if (status.kind === 'stopped' && !REEVALUATED.has(status.code)) return
  const flying = inFlight(s)
  const d = decide({
    now, anchor: s.anchor, chain: s.chain, settings: s.settings,
    turnOpen: s.turn !== null, tasksAlive: s.tasks.length > 0, limits: s.limits, forkInFlight: flying,
  })
  const wasPlanned = status.kind === 'scheduled' || status.kind === 'retrying' || status.kind === 'refreshing'
  const recheck = (until: number) => {
    timer = io.after(Math.max(0, until - now), () => void schedule(io))
  }
  switch (d.act) {
    case 'refresh':
      if (status.kind === 'retrying') {
        // The backoff owns the clock: a stale chain must not turn into an immediate fork.
        const retry = status
        timer = io.after(Math.max(0, retry.nextAt - now), () => void refresh(io, retry.attempt, 'retry', retry.nextAt))
        return
      }
      if (s.anchor && s.chain) void refresh(io, 0, 'due', nextRefreshAt(s.chain, s.anchor.ttl, s.settings.leadMin))
      return
    case 'wait':
      if (!Number.isFinite(d.until)) {
        await putStatus(io, status, { kind: 'waiting' })
        return
      }
      if (!flying && s.anchor && s.chain)
        await putStatus(io, status, { kind: 'scheduled', nextAt: nextRefreshAt(s.chain, s.anchor.ttl, s.settings.leadMin) })
      recheck(d.until)
      return
    case 'hold':
      await putStatus(io, status, { kind: 'holding', reason: d.reason })
      if (d.reason === 'idle-5m' && s.anchor && s.chain) {
        const next = nextRefreshAt(s.chain, s.anchor.ttl, s.settings.leadMin)
        if (next > now) recheck(next)
      }
      return
    case 'done':
      await finishWindow(io, s)
      return
    case 'stop':
      // A refresh that was never planned (a 5m session, a held one) simply lapses; only a planned one is "missed".
      if (d.code === 'missed' && !wasPlanned) {
        // Re-decided stops (user-off, weekly-guard) must not outlive their cause: the cache just lapsed.
        if (status.kind === 'stopped') await putStatus(io, status, { kind: 'waiting' })
        return
      }
      await stop(io, d.code, d.code === 'user-off' && remoteWhy ? remoteWhy : d.reason, d.coldSince)
      return
  }
}

async function finishWindow(io: Io, s: Snap): Promise<void> {
  if (s.status.kind === 'done' || !s.anchor || !s.chain) return
  await put(io, A.status, { kind: 'done', code: 'window', at: s.now })
  const exp = expiresAt(s.chain, s.anchor.ttl)
  const span = fmtSpan(windowEnd(s.anchor, s.settings, s.tasks.length > 0) - s.anchor.at)
  await logLine(io, 'stop', { code: 'window', ...summary(s) })
  if (noticedAt === s.anchor.at) return
  noticedAt = s.anchor.at
  await notice(io, s, `window ended (${span}) · cache expires ${fmtClock(exp)}`)
}

// ---------------------------------------------------------------------------
// Stop and the transcript notice

const summary = (s: Snap) => ({
  refreshes: s.chain?.refreshes ?? 0,
  costUsd: s.chain?.costUsd ?? 0,
  keptMs:
    s.anchor && s.chain ? Math.max(0, Math.min(s.now, expiresAt(s.chain, s.anchor.ttl)) - s.anchor.at) : 0,
})

const NO_NOTICE = new Set<StopCode>(['compacted', 'cleared', 'session-ended', 'nothing-to-fork', 'user-off'])

async function notice(io: Io, s: Snap, tail: string): Promise<void> {
  const k = summary(s)
  const text =
    `cache-keeper · kept warm ${fmtIn(k.keptMs)} · ${k.refreshes} refresh${k.refreshes === 1 ? '' : 'es'}` +
    ` · ${fmtUsd(k.costUsd)} · ${tail}`
  try {
    await io.append(text)
  } catch (err) {
    warn(io, 'session.append', err)
  }
}

export async function stop(
  io: Io,
  code: StopCode,
  reason: string,
  coldSince?: number,
  forget = false,
): Promise<void> {
  timer?.cancel()
  timer = undefined
  const s = await snapshot(io)
  const again = s.status.kind === 'stopped' && s.status.code === code
  if (!again) {
    await put(io, A.status, {
      kind: 'stopped', code, reason, at: s.now, ...(coldSince !== undefined ? { coldSince } : {}),
    })
    await logLine(io, 'stop', { code, reason, ...summary(s) })
  }
  if (forget) await Promise.all([put(io, A.anchor, null), put(io, A.chain, null)])
  if (!again && !NO_NOTICE.has(code)) await notice(io, s, `stopped: ${reason}`)
}

// ---------------------------------------------------------------------------
// Refresh

export type RefreshHow = 'due' | 'retry' | 'now'

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** Returns a one-line account of what happened (used by /cache refresh-now). */
export async function refresh(
  io: Io,
  attempt: number,
  how: RefreshHow,
  dueAt?: number,
): Promise<string> {
  // Before the claim and the fork: a stop another session asked for is honoured first, so no refresh forks after one it could have seen.
  if (await checkRemoteStop(io)) return 'Stopped from another session.'
  const s = await snapshot(io)
  if (inFlight(s)) return 'A refresh is already running.'
  const { anchor, chain } = s
  const d: Decision = decide({
    now: s.now, anchor, chain, settings: s.settings,
    turnOpen: s.turn !== null, tasksAlive: s.tasks.length > 0, limits: s.limits, forkInFlight: false,
  })
  const next = anchor && chain ? nextRefreshAt(chain, anchor.ttl, s.settings.leadMin) : 0
  const ok =
    d.act === 'refresh' ||
    (how !== 'due' && d.act === 'wait' && d.until === next) ||
    (how === 'now' && (d.act === 'done' || (d.act === 'hold' && d.reason === 'idle-5m')))
  if (!ok || !anchor || !chain) {
    if (how === 'now') {
      if (d.act === 'wait' && !Number.isFinite(d.until)) return 'Nothing to refresh yet: no request has been made in this conversation.'
      if (d.act === 'stop') return `Not refreshing: ${d.reason}.`
      if (d.act === 'hold') return 'Not refreshing: the context is below the minimum.'
      return 'Not refreshing now.'
    }
    await schedule(io)
    return 'rescheduled'
  }
  // From here to the claim there is no await: two timers cannot both pass the check above.
  forking = true
  const stepsAtStart = { started: mainSteps.started, inFlight: mainSteps.inFlight }
  const dueTime = dueAt ?? s.now
  let line = ''
  let retrying = false
  try {
    await put(io, A.refreshing, { claimAt: s.now })
    await put(io, A.status, { kind: 'refreshing', since: s.now, attempt })
    const before = await readUsage(io)
    const t0 = await io.now()
    const phase: RefreshRecord['phase'] = s.dialog ? 'dialog' : s.turn ? 'turn' : s.tasks.length > 0 ? 'tasks' : 'idle'
    let reply: ModelForkResult
    try {
      reply = await io.fork(FORK_PROMPT)
    } catch (err) {
      reply = { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: ZERO }
      warn(io, 'model.fork', err)
    }
    const t1 = await io.now()
    const after = await readUsage(io)
    const ledger =
      before?.costUsd != null && after?.costUsd != null ? Math.max(0, after.costUsd - before.costUsd) : null
    const out = outcomeOf(reply, anchor.promptTokens, attempt)
    const usage = 'usage' in reply ? reply.usage : ZERO
    const estUsd = refreshUsd(anchor.model, anchor.promptTokens)
    // The ledger also took any main request that ran beside the fork (it re-anchored, or is still in flight):
    // then, or when the rise is far beyond one refresh, book the estimate and record no cost.
    const overlapped =
      stepsAtStart.inFlight > 0 || mainSteps.started !== stepsAtStart.started || mainSteps.inFlight > 0 ||
      (await io.read(A.anchor))?.at !== anchor.at
    const delta = ledger !== null && (overlapped || ledger > 3 * estUsd) ? null : ledger
    const result: RefreshRecord['result'] =
      out.result === 'warmed' ? 'warmed' : out.result === 'cold' ? 'cold' : 'failed'
    const detail =
      out.result === 'retry' || out.result === 'stop'
        ? out.detail
        : 'isAnswered' in reply && reply.isAnswered
          ? 'answered'
          : 'reason' in reply
            ? reply.reason
            : undefined
    const w = (v: number | undefined, k: 'weeklyBefore' | 'weeklyAfter' | 'fiveHourBefore' | 'fiveHourAfter') =>
      v === undefined ? {} : { [k]: v }
    const record: RefreshRecord = {
      at: t0, ms: t1 - t0, lateMs: Math.max(0, t0 - dueTime), attempt, phase, result,
      ...(detail !== undefined ? { detail } : {}),
      promptTokens: anchor.promptTokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      input: usage.input_tokens,
      output: usage.output_tokens,
      costUsd: delta,
      estUsd,
      ...w(before?.limits.weekly, 'weeklyBefore'),
      ...w(after?.limits.weekly, 'weeklyAfter'),
      ...w(before?.limits.fiveHour, 'fiveHourBefore'),
      ...w(after?.limits.fiveHour, 'fiveHourAfter'),
    }
    await put(io, A.last, record)
    await logLine(io, 'refresh', { ...record })
    const spent = delta ?? (result === 'failed' ? 0 : estUsd)
    if (result !== 'failed' || spent > 0) {
      const n = result === 'failed' ? 0 : 1
      await io.update(A.session, t => ({ ...t, refreshes: t.refreshes + n, costUsd: t.costUsd + spent }))
      await addAllTime(io, { refreshes: n, costUsd: spent })
    }
    line = `${result}${detail && result !== 'warmed' ? ` (${detail})` : ''}: read ${fmtTokens(record.cacheRead)}, ${fmtUsd(spent)}`

    // Judge against the state as it is now: a main request may have landed while the fork ran.
    const cur = await snapshot(io)
    const sameAnchor = cur.anchor?.at === anchor.at
    if (sameAnchor && cur.chain) {
      if (out.result === 'warmed' || out.result === 'cold') {
        // max(): a main request that started during the fork already touched the entry later than t0.
        const touchAt = Math.max(cur.chain.touchAt, t0)
        const warmed = out.result === 'warmed'
        await put(io, A.chain, {
          touchAt,
          refreshes: cur.chain.refreshes + (warmed ? 1 : 0),
          costUsd: cur.chain.costUsd + (warmed ? spent : 0),
        })
      }
      if (out.result === 'cold') {
        await stop(io, 'cold', 'cache was already cold at the refresh: the prompt changed (rewind, MCP, upgrade) or the TTL is shorter than expected')
      } else if (out.result === 'stop') {
        await stop(io, out.code, `${out.detail}`)
      } else if (out.result === 'retry') {
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] as number
        const now = await io.now()
        if (now + delay < expiresAt(cur.chain, anchor.ttl) - SAFETY_MS) {
          retrying = true
          const status: Status = { kind: 'retrying', nextAt: now + delay, attempt: attempt + 1, error: out.detail }
          await put(io, A.status, status)
          timer?.cancel()
          timer = io.after(delay, () => void refresh(io, attempt + 1, 'retry', now + delay))
        } else {
          await stop(io, 'api-error', `${out.detail}; no time left to retry`)
        }
      }
    }
  } catch (err) {
    warn(io, 'refresh', err)
    line = `refresh failed: ${errText(err)}`
  } finally {
    forking = false
    await put(io, A.refreshing, null).catch(err => warn(io, 'refreshing', err))
  }
  if (!retrying) await schedule(io)
  return line
}

export const refreshNow = (io: Io): Promise<string> => refresh(io, 0, 'now')

// ---------------------------------------------------------------------------
// Main request: anchor, chain, avoided rewrites

export type StepCtx = { at: number; prevTouch: number | null; hadLimits: boolean; ttlAtStart: Ttl }

/** Before a main request: it is a cache touch; returns what stepEnd needs, or undefined for a subagent. */
export async function stepStart(io: Io, e: { agentId?: string }): Promise<StepCtx | undefined> {
  if (e.agentId !== undefined) return undefined
  try {
    const at = await io.now()
    const s = await snapshot(io)
    const ctx: StepCtx = {
      at, prevTouch: s.chain?.touchAt ?? null,
      hadLimits: s.limits?.fiveHour !== undefined || s.limits?.weekly !== undefined,
      ttlAtStart: ttlOf(ttlInputs(s.limits)),
    }
    if (s.chain) await io.update(A.chain, c => (c ? { ...c, touchAt: at } : c))
    await schedule(io)
    mainSteps.started++
    mainSteps.inFlight++
    return ctx
  } catch (err) {
    warn(io, 'turn.step', err)
    return undefined
  }
}

/** After a main request. `usage` is the step result's usage (null when no response arrived). */
export async function stepEnd(
  io: Io,
  ctx: StepCtx | undefined,
  usage: { model: string; input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null,
): Promise<void> {
  if (!ctx) return
  mainSteps.inFlight--
  try {
    if (!usage) {
      // No response: the entry was not touched, so give back the touch taken at the start.
      if (ctx.prevTouch !== null)
        await io.update(A.chain, c => (c && c.touchAt === ctx.at ? { ...c, touchAt: ctx.prevTouch as number } : c))
      await schedule(io)
      return
    }
    const read_ = usage.cache_read_input_tokens
    const promptTokens = usage.input_tokens + read_ + usage.cache_creation_input_tokens
    const s = await snapshot(io)
    if (
      s.anchor && s.chain && s.chain.refreshes > 0 &&
      ctx.at - s.anchor.at > TTL_MS[s.anchor.ttl] &&
      read_ >= s.anchor.promptTokens / 2
    ) {
      // What the rewrite this request did not pay would have cost; the refreshes' own spend is booked as it happens.
      const gross = rewriteUsd(usage.model, read_, s.anchor.ttl)
      await io.update(A.session, t => ({ ...t, avoided: t.avoided + 1, grossUsd: t.grossUsd + gross }))
      await addAllTime(io, { avoided: 1, grossUsd: gross })
      await logLine(io, 'avoided', { grossUsd: gross, savedUsd: gross - s.chain.costUsd, refreshes: s.chain.refreshes, costUsd: s.chain.costUsd, cacheRead: read_ })
    }
    // A subscription's windows only show after its first response: look again so the TTL guess has them.
    let ttl = ctx.ttlAtStart
    if (!ctx.hadLimits && ttlEnv.authKind === 'bearer') {
      const u = await readUsage(io)
      if (u) ttl = ttlOf(ttlInputs(u.limits))
    }
    await Promise.all([
      put(io, A.anchor, { at: ctx.at, model: usage.model, promptTokens, ttl }),
      put(io, A.chain, { touchAt: ctx.at, refreshes: 0, costUsd: 0 }),
      put(io, A.resumed, null),
    ])
    // A re-decided stop stays put: resetting it would announce the same stop again after every request.
    const keep = s.status.kind === 'refreshing' || (s.status.kind === 'stopped' && REEVALUATED.has(s.status.code))
    if (!keep) await put(io, A.status, { kind: 'waiting' })
    await schedule(io)
  } catch (err) {
    warn(io, 'turn.step', err)
  }
}

// ---------------------------------------------------------------------------
// Turn, dialog, tasks

export async function onTurnStart(io: Io, e: { turnId: string }): Promise<void> {
  const since = await io.now()
  await put(io, A.turn, { id: e.turnId, since })
  // A permission prompt never outlives its turn: one a turn.complete missed (an abort) clears here.
  const d = await io.read(A.dialog)
  if (d?.tool.startsWith('permission:')) await put(io, A.dialog, null)
  await schedule(io)
}

export async function onTurnComplete(io: Io, e: { agentId?: string }): Promise<void> {
  if (e.agentId !== undefined) return
  await put(io, A.turn, null)
  const d = await io.read(A.dialog)
  if (d?.tool.startsWith('permission:')) await put(io, A.dialog, null)
  await schedule(io)
}

const DIALOG_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
export const isDialogTool = (tool: string) => DIALOG_TOOLS.has(tool)

export async function dialogOpen(io: Io, e: { tool: string; tool_use_id: string }): Promise<void> {
  const since = await io.now()
  await put(io, A.dialog, { id: e.tool_use_id, tool: e.tool, since })
}

/** The call resolved: its own dialog closes, and so does a permission prompt shown for this tool. */
export async function dialogClose(io: Io, e: { tool: string; tool_use_id: string }): Promise<void> {
  const d = await io.read(A.dialog)
  if (d && (d.id === e.tool_use_id || d.tool === `permission:${e.tool}`)) await put(io, A.dialog, null)
}

export async function onPermission(io: Io, e: { tool_name: string; agent_id?: string }): Promise<void> {
  // A subagent's or a fork's prompt is not a question to the person at the main prompt.
  if (e.agent_id !== undefined) return
  const since = await io.now()
  await put(io, A.dialog, { id: `perm-${since}`, tool: `permission:${e.tool_name}`, since })
}

/** The whole tool.call hook: observes a main-thread call, returns what `next` returned. */
export async function onToolCall<R extends { deny?: unknown; result?: unknown }>(
  io: Io,
  e: { tool: string; tool_use_id: string; agentId?: string },
  input: Record<string, unknown>,
  next: () => Promise<R>,
): Promise<R> {
  // A fork's tool attempt carries an agentId: it is denied and must not touch task or dialog state.
  if (e.agentId !== undefined) return next()
  if (isDialogTool(e.tool)) await safely(io, 'tool.call', () => dialogOpen(io, e))
  try {
    const r = await next()
    await safely(io, 'tool.call', () => onToolDone(io, e, input, r))
    return r
  } finally {
    await safely(io, 'tool.call', () => dialogClose(io, e))
  }
}

const asString = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** After a main-thread tool call returned: Bash/Monitor/Agent that started background work, TaskStop that ended it. */
export async function onToolDone(
  io: Io,
  e: { tool: string },
  input: Record<string, unknown>,
  r: { deny?: unknown; result?: unknown },
): Promise<void> {
  if (r.deny !== undefined || typeof r.result !== 'object' || r.result === null) return
  const res = r.result as Record<string, unknown>
  const now = await io.now()
  const desc = cut(asString(input.description) ?? asString(input.command) ?? '', 80)
  let add: Task | undefined
  let gone: string | undefined
  if (e.tool === 'Bash' && input.run_in_background === true) {
    const id = asString(res.backgroundTaskId)
    if (id) add = { id, kind: 'shell', desc, since: now }
  } else if (e.tool === 'Monitor') {
    const id = asString(res.taskId)
    if (id) add = { id, kind: 'monitor', desc, since: now }
  } else if (e.tool === 'Agent' && res.status === 'async_launched') {
    const id = asString(res.agentId)
    if (id) add = { id, kind: 'agent', desc, since: now }
  } else if (e.tool === 'TaskStop') {
    gone = asString(res.task_id) ?? asString(input.task_id) ?? asString(input.shell_id)
  }
  if (!add && !gone) return
  const before = await io.read(A.tasks)
  const after = add
    ? before.some(t => t.id === add.id) ? before : [...before, add]
    : before.filter(t => t.id !== gone)
  if (after.length === before.length) return
  await put(io, A.tasks, after)
  await schedule(io)
}

const removeTasks = async (io: Io, gone: (t: Task) => boolean): Promise<void> => {
  const before = await io.read(A.tasks)
  const after = before.filter(t => !gone(t))
  if (after.length === before.length) return
  await put(io, A.tasks, after)
  await schedule(io)
}

export async function onPromptSubmit(io: Io, e: { origin: { kind: string }; text: string }): Promise<void> {
  if (e.origin.kind !== 'task-notification') return
  const ids = new Set([...e.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => (m[1] ?? '').trim()))
  if (ids.size > 0) await removeTasks(io, t => ids.has(t.id))
}

const kindOf = (type: string): Task['kind'] => (type === 'shell' ? 'shell' : type === 'monitor' ? 'monitor' : 'agent')

/** The list at a main turn end is authoritative: ours it still names stay, ones it names that we missed are added. */
export async function onClassicStop(
  io: Io,
  e: { background_tasks?: readonly { id: string; type: string; description: string }[] },
): Promise<void> {
  if (e.background_tasks === undefined) return
  const live = e.background_tasks
  const before = await io.read(A.tasks)
  const now = await io.now()
  const kept = before.filter(t => live.some(l => l.id === t.id))
  const added = live
    .filter(l => !before.some(t => t.id === l.id))
    .map((l): Task => ({ id: l.id, kind: kindOf(l.type), desc: cut(l.description, 80), since: now }))
  const after = [...kept, ...added]
  if (same(after.map(t => t.id), before.map(t => t.id))) return
  await put(io, A.tasks, after)
  await schedule(io)
}

export const onSubagentStop = (io: Io, e: { agent_id: string }): Promise<void> =>
  removeTasks(io, t => t.id === e.agent_id)

// ---------------------------------------------------------------------------
// Lifecycle

export async function onClassicSessionStart(
  io: Io,
  e: { source: string; session_title?: string; context_tokens?: number; estimated_cache_write_usd?: number; prompt_cache_likely_expired?: boolean },
): Promise<void> {
  if (e.session_title) noteIdentity({ title: e.session_title })
  if (e.source === 'resume' || e.source === 'fork') {
    await put(io, A.resumed, {
      tokens: e.context_tokens ?? 0,
      ...(e.estimated_cache_write_usd !== undefined ? { estUsd: e.estimated_cache_write_usd } : {}),
      cold: e.prompt_cache_likely_expired === true,
    })
  } else if (e.source === 'clear' || e.source === 'compact') {
    timer?.cancel()
    timer = undefined
    await Promise.all([put(io, A.anchor, null), put(io, A.chain, null), put(io, A.status, { kind: 'waiting' })])
    await schedule(io)
  }
}

export const onCompact = (io: Io) => stop(io, 'compacted', 'conversation compacted', undefined, true)
export async function onSessionEnd(io: Io, reason: string): Promise<void> {
  // Ended before the stop: the live file says warming:false whatever the state is when its write comes. A clear is not the end: the session goes on.
  ended = reason !== 'clear'
  await (reason === 'clear'
    ? stop(io, 'cleared', 'conversation cleared', undefined, true)
    : stop(io, 'session-ended', 'session ended', undefined, true))
  await publish(io, true)
}
export const onModelSwitch = (io: Io) => stop(io, 'model-switched', 'model switched', undefined, true)

/** A `/config` row of ours changed from the menu: apply it to the session (a reload reseeds nothing). */
export async function onConfigSet(io: Io, key: string, value: unknown): Promise<void> {
  const field = key.replace(/^cache-keeper\./, '')
  const o = readOptions({ [field]: value })
  const patch: Partial<Settings> | undefined =
    field === 'keepFor' ? { keepFor: o.keepFor }
    : field === 'lead' ? { leadMin: o.leadMin }
    : field === 'minTokens' ? { minTokens: o.minTokens }
    : field === 'weeklyGuard' ? { weeklyGuard: o.weeklyGuard }
    : field === 'band' ? { band: o.band }
    : field === 'upgradeTo1h' ? { upgradeTo1h: o.upgradeTo1h }
    : undefined
  if (patch) {
    await forgetKept(io, field)
    await setSettings(io, patch)
  }
}
