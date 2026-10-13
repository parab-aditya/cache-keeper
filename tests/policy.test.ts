// Policy: pure functions, no engine. design.md §5, §6, §9, §11.
import { expect, test } from 'claude-code/testing'
import type { ModelForkResult } from 'claude-code'

import type { Anchor, Chain, Settings } from '../types'
import type { LineInput } from '../hooks/policy'
import {
  DEFAULT_SETTINGS,
  FORK_PROMPT,
  IN_FLIGHT_RECHECK_MS,
  RETRY_DELAYS_MS,
  SAFETY_MS,
  TASK_CAP_MS,
  bandLine,
  coldDetail,
  decide,
  expiresAt,
  fmtClock,
  fmtDate,
  fmtIn,
  fmtMinutes,
  fmtPct,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  keepLabel,
  leadMs,
  limitsOf,
  lineText,
  nextRefreshAt,
  netUsd,
  nextKeep,
  normalizeModel,
  outcomeOf,
  ratesOf,
  readOptions,
  refreshUsd,
  rewriteUsd,
  savingsOf,
  segText,
  stopWhy,
  tierOf,
  totalsText,
  ttlOf,
  ttlWhy,
  windowEnd,
} from '../hooks/policy'
import { capText } from '../hooks/log'

const MIN = 60_000
const HOUR = 3_600_000
const T = 10_000_000
const near = (actual: number, expected: number, eps = 1e-9) => expect(Math.abs(actual - expected) < eps).toBe(true)

const anchor = (o: Partial<Anchor> = {}): Anchor => ({ at: T, model: 'claude-opus-5-5', promptTokens: 400_000, ttl: '1h', ...o })
const chain = (o: Partial<Chain> = {}): Chain => ({ touchAt: T, refreshes: 0, costUsd: 0, ...o })
const settings = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o })
const base = {
  now: T,
  anchor: anchor(),
  chain: chain(),
  settings: settings(),
  turnOpen: false,
  tasksAlive: false,
  limits: null,
  forkInFlight: false,
}

test('FORK_PROMPT is the measured string, byte for byte', () => {
  expect(FORK_PROMPT).toBe(
    '[cache-keeper] Automated prompt-cache refresh from the cache-keeper plugin, not a message from the user. The conversation above is being handled in the main thread: do not continue it, do not call any tools, and do not deliberate. Reply with only the word: ok',
  )
})

test('ttlOf follows the six rules in order', () => {
  const sub = { fiveHour: 9, weekly: 5, overLimit: false, at: 0 }
  const full = { force: '1', envTtl: '1h', setting: '1h', enable1h: '1', authKind: 'bearer' as const, limits: sub }
  expect(ttlWhy(full)).toEqual({ ttl: '5m', why: 'forced-5m' })
  expect(ttlOf({ ...full, force: 'true' })).toBe('5m')
  // 1: FORCE only counts when truthy
  expect(ttlWhy({ ...full, force: '0' })).toEqual({ ttl: '1h', why: 'env' })
  // 2: env TTL beats the setting and the rest, either way
  expect(ttlWhy({ ...full, force: undefined, envTtl: '5m' })).toEqual({ ttl: '5m', why: 'env' })
  // an env value that is not 5m/1h is skipped
  expect(ttlWhy({ ...full, force: undefined, envTtl: 'forever', setting: '5m' })).toEqual({ ttl: '5m', why: 'setting' })
  // 3: promptCacheTtl in settings
  expect(ttlWhy({ authKind: 'api-key', limits: null, setting: '1h' })).toEqual({ ttl: '1h', why: 'setting' })
  // 4: ENABLE_PROMPT_CACHING_1H
  expect(ttlWhy({ authKind: 'api-key', limits: null, enable1h: 'true' })).toEqual({ ttl: '1h', why: 'enable-1h' })
  // 5: subscription = bearer and a five_hour or seven_day window
  expect(ttlWhy({ authKind: 'bearer', limits: sub })).toEqual({ ttl: '1h', why: 'subscription' })
  expect(ttlOf({ authKind: 'bearer', limits: { weekly: 5, overLimit: false, at: 0 } })).toBe('1h')
  expect(ttlOf({ authKind: 'bearer', limits: { fiveHour: 5, overLimit: false, at: 0 } })).toBe('1h')
  // ... unless over a limit
  expect(ttlWhy({ authKind: 'bearer', limits: { ...sub, overLimit: true } })).toEqual({ ttl: '5m', why: 'over-limit' })
  // 6: everything else is 5m: api key, no windows seen, nothing known
  expect(ttlWhy({ authKind: 'api-key', limits: sub })).toEqual({ ttl: '5m', why: 'default' })
  expect(ttlWhy({ authKind: 'bearer', limits: { overLimit: false, at: 0 } })).toEqual({ ttl: '5m', why: 'default' })
  expect(ttlWhy({ authKind: 'bearer', limits: null })).toEqual({ ttl: '5m', why: 'default' })
  expect(ttlWhy({ authKind: null, limits: null })).toEqual({ ttl: '5m', why: 'default' })
})

test('limitsOf reads the windows and flags any at 100', () => {
  expect(limitsOf([{ kind: 'five_hour', percentUsed: 9 }, { kind: 'seven_day', percentUsed: 41.5 }], 7)).toEqual({
    fiveHour: 9, weekly: 41.5, overLimit: false, at: 7,
  })
  expect(limitsOf([], 1)).toEqual({ overLimit: false, at: 1 })
  expect(limitsOf([{ kind: 'seven_day', percentUsed: 100 }], 1).overLimit).toBe(true)
  expect(limitsOf([{ kind: 'spend_limit', percentUsed: 120 }], 1)).toEqual({ overLimit: true, at: 1 })
  expect(limitsOf([{ kind: 'spend_limit', percentUsed: 40 }], 1).overLimit).toBe(false)
})

test('readOptions keeps valid values, defaults the rest', () => {
  expect(readOptions({})).toEqual(DEFAULT_SETTINGS)
  expect(readOptions(undefined)).toEqual(DEFAULT_SETTINGS)
  expect(
    readOptions({ keepFor: '4h', lead: '10', minTokens: '50000', weeklyGuard: '75', band: 'minimal', upgradeTo1h: 'on' }),
  ).toEqual({ keepFor: '4h', leadMin: 10, minTokens: 50_000, weeklyGuard: 75, band: 'minimal', upgradeTo1h: true })
  expect(readOptions({ keepFor: 'off' }).keepFor).toBe('off')
  expect(readOptions({ lead: 10, weeklyGuard: 100 })).toMatchObject({ leadMin: 10, weeklyGuard: 100 })
  expect(readOptions({ keepFor: '3h', lead: '4', minTokens: 'x', weeklyGuard: '101', band: 'huge', upgradeTo1h: 'maybe' })).toEqual(
    DEFAULT_SETTINGS,
  )
})

test('leadMs: 1h clamps the minutes to 2..15, 5m is a fixed 30 s', () => {
  expect(leadMs('1h', 5)).toBe(5 * MIN)
  expect(leadMs('1h', 1)).toBe(2 * MIN)
  expect(leadMs('1h', 0)).toBe(2 * MIN)
  expect(leadMs('1h', 99)).toBe(15 * MIN)
  expect(leadMs('1h', 15)).toBe(15 * MIN)
  expect(leadMs('5m', 5)).toBe(30_000)
  expect(leadMs('5m', 15)).toBe(30_000)
})

test('expiresAt and nextRefreshAt', () => {
  const c = chain({ touchAt: 1000 })
  expect(expiresAt(c, '1h')).toBe(1000 + HOUR)
  expect(expiresAt(c, '5m')).toBe(1000 + 5 * MIN)
  expect(nextRefreshAt(c, '1h', 5)).toBe(1000 + 55 * MIN)
  expect(nextRefreshAt(c, '1h', 15)).toBe(1000 + 45 * MIN)
  expect(nextRefreshAt(c, '5m', 5)).toBe(1000 + 4.5 * MIN)
})

test('windowEnd: off, forever, fixed windows and the 24 h task cap', () => {
  const a = anchor({ at: 100 })
  expect(windowEnd(a, settings({ keepFor: 'off' }), false)).toBe(100)
  expect(windowEnd(a, settings({ keepFor: 'forever' }), false)).toBe(Infinity)
  expect(windowEnd(a, settings({ keepFor: 'forever' }), true)).toBe(Infinity)
  expect(windowEnd(a, settings({ keepFor: '2h' }), false)).toBe(100 + 2 * HOUR)
  expect(windowEnd(a, settings({ keepFor: '8h' }), false)).toBe(100 + 8 * HOUR)
  expect(windowEnd(a, settings({ keepFor: '12h' }), false)).toBe(100 + 12 * HOUR)
  // tasks stretch a short window to 24 h, never shrink a longer one, and `off` stays off... except it is lifted too
  expect(windowEnd(a, settings({ keepFor: '8h' }), true)).toBe(100 + TASK_CAP_MS)
  expect(windowEnd(a, settings({ keepFor: '12h' }), true)).toBe(100 + TASK_CAP_MS)
})

test('decide: each branch, in order', () => {
  // 1 off wins over everything, even with no anchor
  expect(decide({ ...base, anchor: null, chain: null, settings: settings({ keepFor: 'off' }) })).toEqual({
    act: 'stop', code: 'user-off', reason: 'off',
  })
  // 2 no anchor or chain: nothing to do until a request
  expect(decide({ ...base, anchor: null, chain: null })).toEqual({ act: 'wait', until: Infinity })
  expect(decide({ ...base, chain: null })).toEqual({ act: 'wait', until: Infinity })
  // 3 (the paused hold is gone: there is one switch, keepFor off)
  // 4 small
  expect(decide({ ...base, anchor: anchor({ promptTokens: 29_999 }) })).toEqual({ act: 'hold', reason: 'small' })
  expect(decide({ ...base, anchor: anchor({ promptTokens: 30_000 }) }).act).toBe('wait')
  // 5 weekly guard, with the reason text
  expect(decide({ ...base, limits: { weekly: 91, overLimit: false, at: 0 } })).toEqual({
    act: 'stop', code: 'weekly-guard', reason: 'weekly 91% ≥ guard 90%',
  })
  expect(decide({ ...base, limits: { weekly: 90, overLimit: false, at: 0 } }).act).toBe('stop')
  expect(decide({ ...base, limits: { weekly: 89.9, overLimit: false, at: 0 } }).act).toBe('wait')
  expect(decide({ ...base, limits: { fiveHour: 99, overLimit: false, at: 0 } }).act).toBe('wait')
  // 6 missed: later than expiry - 20 s; never fork then
  const exp = T + HOUR
  expect(decide({ ...base, now: exp - SAFETY_MS }).act).not.toBe('stop')
  expect(decide({ ...base, now: exp - SAFETY_MS + 1 })).toMatchObject({ act: 'stop', code: 'missed', coldSince: exp })
  expect(decide({ ...base, now: exp + 5 * MIN })).toMatchObject({ act: 'stop', code: 'missed', coldSince: exp })
  // 7 done: the entry outlives the window (8 h window, entry from the last touch)
  expect(decide({ ...base, now: T + 440 * MIN, chain: chain({ touchAt: T + 440 * MIN }) })).toEqual({ act: 'done' })
  expect(decide({ ...base, now: T + 385 * MIN, chain: chain({ touchAt: T + 385 * MIN }) }).act).toBe('wait')
  expect(decide({ ...base, settings: settings({ keepFor: 'forever' }), now: T + 400 * HOUR, chain: chain({ touchAt: T + 400 * HOUR }) }).act).toBe('wait')
  // 8 5m: only while a turn is open and within an hour of the anchor
  const five = { ...base, anchor: anchor({ ttl: '5m' }) }
  expect(decide(five)).toEqual({ act: 'hold', reason: 'idle-5m' })
  expect(decide({ ...five, turnOpen: true })).toEqual({ act: 'wait', until: T + 4.5 * MIN })
  expect(decide({ ...five, turnOpen: true, now: T + HOUR, chain: chain({ touchAt: T + HOUR - 100_000 }) })).toEqual({ act: 'hold', reason: 'idle-5m' })
  expect(decide({ ...five, turnOpen: true, now: T + HOUR - 1, chain: chain({ touchAt: T + HOUR - 1 - 4.5 * MIN }) }).act).toBe('refresh')
  // 9 a fork in flight waits 15 s, before the due time is looked at
  expect(decide({ ...base, forkInFlight: true, now: T + 56 * MIN })).toEqual({ act: 'wait', until: T + 56 * MIN + IN_FLIGHT_RECHECK_MS })
  // 10 not yet due
  expect(decide(base)).toEqual({ act: 'wait', until: T + 55 * MIN })
  expect(decide({ ...base, now: T + 55 * MIN - 1 })).toEqual({ act: 'wait', until: T + 55 * MIN })
  // 11 due
  expect(decide({ ...base, now: T + 55 * MIN })).toEqual({ act: 'refresh' })
  expect(decide({ ...base, now: T + 59 * MIN })).toEqual({ act: 'refresh' })
  // the lead setting moves the due time
  expect(decide({ ...base, settings: settings({ leadMin: 15 }) })).toEqual({ act: 'wait', until: T + 45 * MIN })
  // background tasks stretch the window past 8 h
  const late = { ...base, now: T + 440 * MIN, chain: chain({ touchAt: T + 440 * MIN }) }
  expect(decide({ ...late, tasksAlive: true }).act).toBe('wait')
})

const reply = (read: number): ModelForkResult => ({
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 91, output_tokens: 4, cache_read_input_tokens: read, cache_creation_input_tokens: 0 },
})
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const apiError = (error: string, status: number | null): ModelForkResult =>
  ({ isAnswered: false, reason: 'api-error', status, error, usage: zero }) as ModelForkResult

test('outcomeOf: warmed, cold, empty-reply and the read-before-answered order', () => {
  expect(outcomeOf(reply(400_000), 400_000, 0)).toEqual({ result: 'warmed' })
  expect(outcomeOf(reply(200_000), 400_000, 0)).toEqual({ result: 'warmed' })
  expect(outcomeOf(reply(199_999), 400_000, 0)).toEqual({ result: 'cold' })
  expect(outcomeOf({ isAnswered: false, reason: 'empty-reply', usage: { ...zero, cache_read_input_tokens: 399_000 } }, 400_000, 0)).toEqual({ result: 'warmed' })
  expect(outcomeOf({ isAnswered: false, reason: 'empty-reply', usage: zero }, 400_000, 0)).toEqual({ result: 'cold' })
  expect(outcomeOf({ isAnswered: false, reason: 'nothing-to-fork' }, 400_000, 0)).toMatchObject({ result: 'stop', code: 'nothing-to-fork' })
})

test('outcomeOf: api errors stop, retry up to three times, abort retries once', () => {
  expect(outcomeOf(apiError('rate_limit', 429), 1, 0)).toEqual({ result: 'stop', code: 'rate-limited', detail: 'rate_limit 429' })
  expect(outcomeOf(apiError('overloaded', 429), 1, 0)).toMatchObject({ result: 'stop', code: 'rate-limited' })
  expect(outcomeOf(apiError('rate_limit', null), 1, 0)).toMatchObject({ result: 'stop', code: 'rate-limited' })
  for (const e of ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'invalid_request', 'model_not_found', 'cloud_credential_error'])
    expect(outcomeOf(apiError(e, 400), 1, 0)).toEqual({ result: 'stop', code: 'api-error', detail: `${e} 400` })
  expect(outcomeOf(apiError('overloaded', 529), 1, 0)).toEqual({ result: 'retry', detail: 'overloaded 529' })
  expect(outcomeOf(apiError('server_error', 500), 1, 2)).toEqual({ result: 'retry', detail: 'server_error 500' })
  expect(outcomeOf(apiError('unknown', null), 1, 1)).toEqual({ result: 'retry', detail: 'unknown' })
  // a null status is a dropped connection: retried whatever the kind is
  expect(outcomeOf(apiError('max_output_tokens', null), 1, 0)).toMatchObject({ result: 'retry' })
  expect(outcomeOf(apiError('max_output_tokens', 400), 1, 0)).toMatchObject({ result: 'stop', code: 'api-error' })
  // the fourth failure stops
  expect(RETRY_DELAYS_MS).toEqual([30_000, 90_000, 180_000])
  expect(outcomeOf(apiError('overloaded', 529), 1, 3)).toEqual({ result: 'stop', code: 'api-error', detail: 'overloaded 529' })
  expect(outcomeOf({ isAnswered: false, reason: 'aborted', usage: zero }, 1, 0)).toEqual({ result: 'retry', detail: 'aborted' })
  expect(outcomeOf({ isAnswered: false, reason: 'aborted', usage: zero }, 1, 1)).toEqual({ result: 'stop', code: 'api-error', detail: 'aborted' })
})

test('pricing: id normalisation, Haiku 5.5 tiers, unknown models', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5', 'claude-gateway/claude-opus-5-5', 'claude-opus-5-5-20261001', 'Claude-Opus-5-5-latest'])
    expect(ratesOf(id)).toEqual({ input: 4, cacheRead: 0.2, output: 20, isGuess: false })
  expect(normalizeModel('anthropic/claude-sonnet-4-5-20250929[1m]')).toBe('claude-sonnet-4-5')
  expect(ratesOf('claude-sonnet-5-5')).toEqual({ input: 2, cacheRead: 0.1, output: 10, isGuess: false })
  expect(ratesOf('claude-sonnet-5')).toMatchObject({ input: 2, cacheRead: 0.2 })
  expect(ratesOf('claude-fable-5-1')).toMatchObject({ input: 10, cacheRead: 0.25, output: 50 })
  expect(ratesOf('claude-fable-5')).toMatchObject({ cacheRead: 1 })
  expect(ratesOf('claude-opus-5')).toMatchObject({ input: 5, cacheRead: 0.5, output: 25 })
  expect(ratesOf('claude-opus-4-1-20250805')).toMatchObject({ input: 15, cacheRead: 1.5, output: 75 })
  expect(ratesOf('claude-opus-4-20250514')).toMatchObject({ input: 15 })
  expect(ratesOf('claude-haiku-4-5')).toMatchObject({ input: 1, cacheRead: 0.1, output: 5 })
  expect(ratesOf('claude-haiku-5-5', 100_000)).toEqual({ input: 0.1, cacheRead: 0.01, output: 0.5, isGuess: false })
  expect(ratesOf('claude-haiku-5-5', 100_001)).toEqual({ input: 0.5, cacheRead: 0.05, output: 2.5, isGuess: false })
  expect(ratesOf('claude-haiku-5-5')).toMatchObject({ input: 0.1 })
  for (const id of ['', 'gpt-9', 'claude-opus-9-9']) expect(ratesOf(id)).toEqual({ input: 4, cacheRead: 0.2, output: 20, isGuess: true })
})

test('refreshUsd and rewriteUsd', () => {
  // 399,651 read + 91 in + 4 out = the engine's $0.0804 per refresh (phase0-findings)
  near(refreshUsd('claude-opus-5-5', 399_651), 0.0804, 1e-4)
  near(refreshUsd('claude-sonnet-5-5', 1_000_000), (1_000_000 * 0.1 + 91 * 2 + 5 * 10) / 1e6)
  near(rewriteUsd('claude-opus-5-5', 400_000, '1h'), 3.2, 1e-4)
  near(rewriteUsd('claude-opus-5-5', 400_000, '5m'), 2, 1e-4)
  near(rewriteUsd('claude-haiku-5-5', 200_000, '1h'), 0.2, 1e-4)
  near(rewriteUsd('claude-haiku-5-5', 50_000, '5m'), (50_000 * 0.1 * 1.25) / 1e6)
})

test('formatters', () => {
  expect(fmtTokens(408_000)).toBe('408k')
  expect(fmtTokens(12_345)).toBe('12k')
  expect(fmtTokens(1_234)).toBe('1.2k')
  expect(fmtTokens(812)).toBe('812')
  expect(fmtTokens(1_250_000)).toBe('1.3M')
  expect(fmtUsd(0.0804)).toBe('$0.08')
  expect(fmtUsd(3.256)).toBe('$3.26')
  expect(fmtUsd(0)).toBe('$0.00')
  expect(fmtUsd(0.003)).toBe('<$0.01')
  expect(fmtUsd(250.4)).toBe('$250')
  expect(fmtIn(41 * MIN)).toBe('41m')
  expect(fmtIn(65 * MIN)).toBe('1h05m')
  expect(fmtIn(120 * MIN)).toBe('2h00m')
  expect(fmtIn(45_000)).toBe('45s')
  expect(fmtIn(0)).toBe('0s')
  expect(fmtIn(-5)).toBe('0s')
  expect(fmtIn(59_600)).toBe('1m')
  expect(fmtIn(7 * HOUR + 52 * MIN)).toBe('7h52m')
  const at = new Date(2026, 9, 13, 14, 5).getTime()
  expect(fmtClock(at)).toBe('2:05 PM')
  expect(fmtClock(new Date(2026, 9, 13, 6, 0).getTime())).toBe('6:00 AM')
  expect(fmtClock(new Date(2026, 9, 13, 0, 7).getTime())).toBe('12:07 AM')
  expect(fmtClock(new Date(2026, 9, 13, 12, 30).getTime())).toBe('12:30 PM')
  expect(fmtClock(new Date(2026, 9, 13, 11, 59).getTime())).toBe('11:59 AM')
  expect(fmtClock(new Date(2026, 9, 13, 23, 59).getTime())).toBe('11:59 PM')
  // the date is local too: 00:30 on the 1st is still the 1st (toISOString would say the day before east of UTC)
  expect(fmtDate(new Date(2026, 9, 1, 0, 30).getTime())).toBe('2026-10-01')
  expect(fmtDate(new Date(2026, 0, 31, 23, 30).getTime())).toBe('2026-01-31')
  expect(fmtPct(41)).toBe('41%')
  expect(fmtPct(23.54)).toBe('23.5%')
  expect(fmtSpan(8 * HOUR)).toBe('8h')
  expect(fmtSpan(90 * MIN)).toBe('1h30m')
})

test('capText drops the oldest half of the lines past the cap', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`)
  const text = `${lines.join('\n')}\n`
  expect(capText(text, 1_000_000)).toBe(text)
  expect(capText(text, 20)).toBe(`${lines.slice(5).join('\n')}\n`)
})

// ---------------------------------------------------------------------------
// The band line (brief 2b copy table)

const input = (o: Record<string, unknown> = {}) =>
  ({
    now: T + 5 * MIN,
    anchor: anchor(),
    chain: chain(),
    status: { kind: 'scheduled', nextAt: T + 55 * MIN } as const,
    settings: settings(),
    dialog: null,
    tasks: [],
    limits: null,
    resumed: null,
    ...o,
  }) as Parameters<typeof bandLine>[0]

type Tier = 'full' | 'short' | 'tiny'
const line = (o: Record<string, unknown> = {}, style: 'full' | 'minimal' = 'full', tier: Tier = 'full') => {
  const l = bandLine(input(o), style, tier)
  return l ? lineText(l) : null
}
const tone = (o: Record<string, unknown> = {}) => bandLine(input(o))?.tone

test('bandLine: warm states, full tier', () => {
  expect(line()).toBe('● Warm · next refresh in 50m')
  // the weekly figure is never in the band; kept 3x is in the hover card
  const kept = { chain: chain({ refreshes: 3, costUsd: 0.2412 }), limits: { weekly: 41, overLimit: false, at: 0 } }
  expect(line(kept)).toBe('● Warm · next refresh in 50m')
  expect(line(kept)).not.toContain('41')
  expect(line({ dialog: { id: 'd', tool: 'AskUserQuestion', since: 0 } })).toBe('● Warm · next refresh in 50m · waiting on your answer')
  expect(line({ tasks: [{ id: 'a', kind: 'shell', desc: '', since: 0 }] })).toBe('● Warm · next refresh in 50m · 1 background task')
  expect(line({ tasks: [{ id: 'a', kind: 'shell', desc: '', since: 0 }, { id: 'b', kind: 'agent', desc: '', since: 0 }] })).toContain('2 background tasks')
  expect(line({ status: { kind: 'refreshing', since: T, attempt: 0 } })).toBe('◌ Refreshing…')
  expect(line({ status: { kind: 'retrying', nextAt: T + 6 * MIN, attempt: 1, error: 'overloaded 529' } })).toBe('◌ Refresh failed (overloaded) · retrying in 1m')
  // a request just landed (waiting with an anchor): the same line, the refresh time from the chain
  expect(line({ status: { kind: 'waiting' } })).toBe('● Warm · next refresh in 50m')
  expect(tone()).toBe('warm')
  expect(tone({ status: { kind: 'refreshing', since: T, attempt: 0 } })).toBe('refreshing')
  expect(tone({ status: { kind: 'retrying', nextAt: T + 6 * MIN, attempt: 1, error: 'overloaded' } })).toBe('error')
})

test('bandLine: the hover card says when the cache expires, in how long and what was kept', () => {
  const l = bandLine(input({ chain: chain({ refreshes: 3, costUsd: 0.2412 }), now: T + 5 * MIN }))
  expect(l?.hover && segText(l.hover)).toBe(`Cache expires ${fmtClock(T + HOUR)} · in 55m · kept 3× ($0.24)`)
  expect(l?.hover?.ms).toBe(55 * MIN)
  expect(bandLine(input())?.hover).toMatchObject({ post: '' })
  // a cold cache has nothing to expire
  expect(bandLine(input({ now: T + 2 * HOUR }))?.hover).toBeNull()
  expect(bandLine(input({ anchor: null, chain: null, status: { kind: 'waiting' }, resumed: { tokens: 1, cold: true } }))?.hover).toBeNull()
})

test('bandLine: off, cooling, done, stopped, holding', () => {
  const off = { ...DEFAULT_SETTINGS, keepFor: 'off' } as const
  expect(line({ settings: off, now: T + 18 * MIN })).toBe('○ Auto-refresh off · cache expires in 42m')
  expect(tone({ settings: off, now: T + 18 * MIN })).toBe('off')
  // cooling: 10 minutes or less left (the threshold itself counts), the same text
  expect(line({ settings: off, now: T + 50 * MIN })).toBe('◐ Auto-refresh off · cache expires in 10m')
  expect(tone({ settings: off, now: T + 50 * MIN })).toBe('cooling')
  expect(tone({ settings: off, now: T + 50 * MIN - 1 })).toBe('off')
  expect(line({ settings: off, anchor: null, chain: null, status: { kind: 'waiting' } })).toBe('○ Auto-refresh off')
  expect(line({ settings: off, now: T + 2 * HOUR })).toContain('Cache cold') // cold wins over off
  const exp = new Date(2026, 9, 13, 6, 10).getTime()
  const done = { status: { kind: 'done', code: 'window', at: 0 }, chain: chain({ touchAt: exp - HOUR }), anchor: anchor({ at: exp - 8 * HOUR - HOUR }), now: exp - 40 * MIN } as const
  expect(line(done)).toBe('○ Kept warm for 8h · auto-refresh ended · cache expires in 40m')
  expect(tone(done)).toBe('dim')
  expect(tone({ ...done, now: exp - 9 * MIN })).toBe('cooling')
  const guard = { status: { kind: 'stopped', code: 'weekly-guard', reason: 'weekly 91% ≥ guard 90%', at: 0 }, now: T + 38 * MIN } as const
  expect(line(guard)).toBe('■ Stopped: weekly usage hit the 90% guard · cache expires in 22m')
  expect(tone(guard)).toBe('error')
  expect(tone({ ...guard, status: { ...guard.status, code: 'model-switched' } })).toBe('dim')
  expect(tone({ ...guard, status: { ...guard.status, code: 'model-switched' }, now: T + 55 * MIN })).toBe('cooling')
  expect(line({ status: { kind: 'holding', reason: 'small' }, anchor: anchor({ promptTokens: 12_000 }) })).toBe('○ Context 12k is below the 30k minimum · not kept warm')
  expect(line({ status: { kind: 'holding', reason: 'idle-5m' }, anchor: anchor({ ttl: '5m' }), now: T + 2 * MIN })).toBe('○ 5-minute cache · refreshed only while Claude works')
  expect(tone({ status: { kind: 'holding', reason: 'idle-5m' }, anchor: anchor({ ttl: '5m' }), now: T + 2 * MIN })).toBe('dim')
  expect(stopWhy('rate-limited', DEFAULT_SETTINGS)).toBe('rate-limited')
  expect(stopWhy('api-error', DEFAULT_SETTINGS)).toBe('API error')
  expect(stopWhy('model-switched', DEFAULT_SETTINGS)).toBe('model switched')
})

test('bandLine: cold, missed, resumed, nothing to say', () => {
  const since = fmtClock(T + HOUR)
  // the short line: when it went cold and why live in coldDetail (/cache status, the pane)
  const cold = '❄ Cache cold · next message rewrites 400k (~$3.20)'
  expect(line({ now: T + 2 * HOUR, status: { kind: 'done', code: 'window', at: 0 } })).toBe(cold)
  expect(line({ now: T + 2 * HOUR })).toBe(cold) // a scheduled refresh that never ran counts as cold too
  expect(tone({ now: T + 2 * HOUR })).toBe('cold')
  const missed = { now: T + 2 * HOUR, status: { kind: 'stopped', code: 'missed', reason: 'x', at: 0, coldSince: T + HOUR } } as const
  expect(line(missed)).toBe(cold)
  expect(coldDetail(input(missed))).toBe(`Refresh missed while asleep · cache cold since ${since}`)
  expect(coldDetail(input({ now: T + 2 * HOUR }))).toBe(`Cache cold since ${since}`)
  expect(coldDetail(input({}))).toBeNull()
  expect(coldDetail(input({ now: T + 2 * HOUR, status: { kind: 'refreshing', since: 0, attempt: 0 } }))).toBeNull()
  expect(line({ now: T + 2 * HOUR, pct5h: 1.4 })).toBe(`${cold} · ~1.4% of 5h`)
  expect(line({ now: T + 2 * HOUR, status: { kind: 'refreshing', since: 0, attempt: 0 } })).toBe('◌ Refreshing…')
  expect(line({ anchor: null, chain: null, status: { kind: 'waiting' } })).toBeNull()
  expect(line({ anchor: null, chain: null, status: { kind: 'waiting' }, resumed: { tokens: 408_000, cold: false } })).toBeNull()
  expect(line({ anchor: null, chain: null, status: { kind: 'waiting' }, resumed: { tokens: 408_000, estUsd: 3.26, cold: true } })).toBe(
    '❄ Cache cold · next message rewrites 408k (~$3.26)',
  )
  expect(coldDetail(input({ anchor: null, chain: null, status: { kind: 'waiting' }, resumed: { tokens: 408_000, cold: true } }))).toContain('Resumed session')
})

test('bandLine: an anchor without a chain (or a chain without an anchor) counts as no anchor', () => {
  // left behind by another version of the code: it used to print "expires " with nothing after it
  expect(line({ chain: null, status: { kind: 'waiting' } })).toBeNull()
  expect(line({ anchor: null, status: { kind: 'scheduled', nextAt: T + HOUR } })).toBeNull()
  expect(line({ chain: null, status: { kind: 'scheduled', nextAt: T + HOUR } })).toBeNull()
  expect(line({ chain: null, status: { kind: 'waiting' }, resumed: { tokens: 408_000, estUsd: 3.26, cold: true } })).toBe('❄ Cache cold · next message rewrites 408k (~$3.26)')
  expect(coldDetail(input({ chain: null, now: T + 5 * HOUR }))).toBeNull()
  // decide waits for a request instead of acting on half a pair
  const base = { now: T, settings: DEFAULT_SETTINGS, turnOpen: false, tasksAlive: false, limits: null, forkInFlight: false }
  expect(decide({ ...base, anchor: anchor(), chain: null })).toEqual({ act: 'wait', until: Infinity })
  expect(decide({ ...base, anchor: null, chain: { touchAt: T, refreshes: 0, costUsd: 0 } })).toEqual({ act: 'wait', until: Infinity })
})

test('bandLine: the three tiers (full, short, tiny) and the columns that pick them', () => {
  expect([89, 90, 60, 59, 0, 200].map(tierOf)).toEqual(['short', 'full', 'short', 'tiny', 'tiny', 'full'])
  const off = { ...DEFAULT_SETTINGS, keepFor: 'off' } as const
  const rows: [Record<string, unknown>, string, string, string][] = [
    [{}, 'Warm · next refresh in 50m', 'Warm · refresh 50m', '50m'],
    [{ settings: off, now: T + 18 * MIN }, 'Auto-refresh off · cache expires in 42m', 'Off · expires 42m', 'off 42m'],
    [{ now: T + 2 * HOUR }, 'Cache cold · next message rewrites 400k (~$3.20)', 'Cold · rewrite 400k ~$3.20', 'cold'],
    [{ status: { kind: 'refreshing', since: 0, attempt: 0 } }, 'Refreshing…', 'Refreshing…', 'refresh'],
    [{ status: { kind: 'retrying', nextAt: T + 6 * MIN, attempt: 1, error: 'overloaded 529' } }, 'Refresh failed (overloaded) · retrying in 1m', 'Failed · retry 1m', 'retry 1m'],
    [{ status: { kind: 'holding', reason: 'small' }, anchor: anchor({ promptTokens: 12_000 }) }, 'Context 12k is below the 30k minimum · not kept warm', 'Context 12k · not kept', 'not kept'],
  ]
  for (const [o, full, short, tiny] of rows) {
    expect(bandLine(input(o), 'full', 'full')?.text).toBe(full)
    expect(bandLine(input(o), 'full', 'short')?.text).toBe(short)
    expect(bandLine(input(o), 'full', 'tiny')?.text).toBe(tiny)
    // the tone does not depend on the tier
    expect(bandLine(input(o), 'full', 'tiny')?.tone).toBe(bandLine(input(o), 'full', 'full')?.tone)
  }
  // the suffixes belong to the full tier
  const busy = { dialog: { id: 'd', tool: 'AskUserQuestion', since: 0 }, tasks: [{ id: 'a', kind: 'shell', desc: '', since: 0 }] }
  expect(bandLine(input(busy), 'full', 'short')?.text).toBe('Warm · refresh 50m')
  // the countdown is its own part: the desktop draws it as a ticking image
  expect(bandLine(input(), 'full', 'full')).toMatchObject({ pre: 'Warm · next refresh in', ms: 50 * MIN, post: '' })
  expect(bandLine(input(), 'full', 'tiny')).toMatchObject({ pre: '', ms: 50 * MIN })
  expect(bandLine(input({ now: T + 2 * HOUR }), 'full', 'full')).toMatchObject({ ms: null })
})

test('bandLine: minimal style', () => {
  expect(line({}, 'minimal')).toBe('● warm')
  expect(line({ now: T + 2 * HOUR }, 'minimal')).toBe('❄ cold')
  expect(line({ settings: { ...DEFAULT_SETTINGS, keepFor: 'off' } }, 'minimal')).toBe('○ off')
  expect(line({ status: { kind: 'refreshing', since: 0, attempt: 0 } }, 'minimal')).toBe('◌ refreshing')
  expect(line({ anchor: null, chain: null, status: { kind: 'waiting' } }, 'minimal')).toBeNull()
})

test('fmtMinutes labels a minute countdown: whole minutes, hours, and now under half a minute', () => {
  expect([0, 29_999, 30_000, 59_000, 60_000, 50 * MIN, 59 * MIN + 31_000, 65 * MIN].map(fmtMinutes)).toEqual(['now', 'now', '1m', '1m', '1m', '50m', '1h00m', '1h05m'])
})

test('savings: net is the rewrites avoided minus every refresh, shown honestly when negative', () => {
  const t = { refreshes: 9, costUsd: 3.7, avoided: 2, grossUsd: 16.1 }
  near(netUsd(t), 12.4)
  const s = savingsOf(t, { refreshes: 3, costUsd: 0.8, avoided: 1, grossUsd: 4 })
  expect(s).toMatchObject({ has: true, hero: 'Saved $12.40', session: 'this session $3.20', detail: 'rewrites avoided $16.10 − refreshes $3.70' })
  expect(s.note).toBe('At API list prices. On a Pro/Max plan this is usage, not billing.')
  // nothing avoided yet: one dim line says so; the cost so far, spent not saved
  const early = savingsOf({ refreshes: 6, costUsd: 0.48, avoided: 0, grossUsd: 0 }, { refreshes: 6, costUsd: 0.48, avoided: 0, grossUsd: 0 })
  expect(early).toMatchObject({ has: false, hero: 'Spent $0.48 so far', empty: 'No savings yet — they show when you return to a warm cache.', session: 'this session -$0.48' })
  expect(savingsOf({ refreshes: 0, costUsd: 0, avoided: 0, grossUsd: 0 }, { refreshes: 0, costUsd: 0, avoided: 0, grossUsd: 0 })).toMatchObject({ has: false, hero: 'Saved $0.00' })
  expect(totalsText(t)).toBe('9 refreshes · 2 rewrites avoided (would have cost $16.10) · refreshes cost $3.70 · saved $12.40')
  expect(totalsText({ refreshes: 1, costUsd: 0.08, avoided: 0, grossUsd: 0 })).toBe('1 refresh · 0 rewrites avoided (would have cost $0.00) · refreshes cost $0.08 · net cost $0.08')
  expect(fmtUsd(-0.3)).toBe('-$0.30')
})

test('keep cycle: 2h, 4h, 8h, 12h, no end, 2h; off starts at 2h; no end is drawn as the infinity sign', () => {
  expect((['2h', '4h', '8h', '12h', 'forever'] as const).map(nextKeep)).toEqual(['4h', '8h', '12h', 'forever', '2h'])
  expect(nextKeep('off')).toBe('2h')
  expect((['2h', '8h', 'forever'] as const).map(keepLabel)).toEqual(['2h', '8h', '∞'])
})

test('bandLine: the state word is the bold part, a prefix of the text', () => {
  const words = (x: Partial<LineInput>, tier: Tier = 'full') => {
    const l = bandLine(input(x), 'full', tier)
    expect(l?.text.startsWith(l?.word ?? ''), String(l?.text)).toBe(true)
    return l?.word
  }
  expect(words({})).toBe('Warm')
  expect(words({}, 'short')).toBe('Warm')
  expect(words({}, 'tiny')).toBeUndefined() // the countdown alone
  expect(words({ now: T + 2 * HOUR })).toBe('Cache cold')
  expect(words({ now: T + 2 * HOUR }, 'short')).toBe('Cold')
  expect(words({ settings: { ...DEFAULT_SETTINGS, keepFor: 'off' } })).toBe('Auto-refresh off')
  expect(words({ status: { kind: 'refreshing', since: 0, attempt: 0 } })).toBe('Refreshing')
  expect(words({ status: { kind: 'stopped', code: 'weekly-guard', reason: '', at: T } })).toBe('Stopped')
  expect(words({ status: { kind: 'done', code: 'window', at: T }, now: T + 30 * MIN })).toBe('Kept warm for 8h')
  expect(bandLine(input(), 'minimal', 'full')?.word).toBeUndefined()
})
