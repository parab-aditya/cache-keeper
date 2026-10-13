// cache-keeper log (design.md §11): a JSONL file per session, and the $.store totals.
// $.fs has no append, so the text stays in memory and is written whole, one write at a time
// (serialized chain adapted from paulbkim-dev/claude-code-cache-warmer, MIT, (c) Paul B. Kim).
import type { Totals } from '../types'
import type { Io } from './io'

export const MAX_LOG_CHARS = 2_000_000

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

let logChain: Promise<unknown> = Promise.resolve()
let logText: string | null = null
let logPath = ''
let storeChain: Promise<unknown> = Promise.resolve()
let failShown = false

/** Forget in-memory state (a fresh load, or a test). */
export function resetLog(): void {
  logChain = Promise.resolve()
  storeChain = Promise.resolve()
  logText = null
  logPath = ''
  failShown = false
}

const fail = (io: Io, what: string, err: unknown) => {
  if (failShown) return
  failShown = true
  io.debug(`cache-keeper: ${what} failed: ${errText(err)}`)
}

/** Over `max` characters: drop the oldest half of the lines. */
export function capText(text: string, max = MAX_LOG_CHARS): string {
  if (text.length <= max) return text
  const lines = text.split('\n').filter(Boolean)
  return `${lines.slice(lines.length >> 1).join('\n')}\n`
}

export async function logPathOf(io: Io): Promise<string | undefined> {
  const home = await io.home()
  return home ? `${home}/.claude/cache-keeper/${await io.sessionId()}.jsonl` : undefined
}

/** Appends one JSON line; never throws; resolves once written. */
export function logLine(io: Io, ev: string, fields: Record<string, unknown> = {}): Promise<void> {
  const run = async () => {
    const path = await logPathOf(io)
    if (path === undefined) return
    const t = await io.now()
    const line = JSON.stringify({ t, iso: new Date(t).toISOString(), ev, ...fields })
    if (logText === null || logPath !== path) {
      logText = (await io.fsExists(path)) ? await io.fsRead(path) : ''
      logPath = path
    }
    logText = capText(`${logText}${line}\n`)
    await io.fsWrite(path, logText)
  }
  const done = logChain.then(run).catch(err => fail(io, 'log write', err))
  logChain = done
  return done as Promise<void>
}

/** The last `n` lines of this session's log, oldest first. */
export async function logTail(io: Io, n: number): Promise<string[]> {
  await logChain
  try {
    const path = await logPathOf(io)
    if (path === undefined || !(await io.fsExists(path))) return []
    return (await io.fsRead(path)).split('\n').filter(Boolean).slice(-n)
  } catch (err) {
    fail(io, 'log read', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// $.store: all-time totals and the learned plan-percent rates, each read-modify-write through one chain.

const emptyTotals = (since: number): Totals => ({ refreshes: 0, costUsd: 0, avoided: 0, grossUsd: 0, since })
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export async function readAllTime(io: Io): Promise<Totals> {
  const v = (await io.storeGet('allTime')) as (Partial<Totals> & { savedUsd?: number }) | undefined
  if (typeof v !== 'object' || v === null) return emptyTotals(await io.now())
  const costUsd = num(v.costUsd)
  return {
    refreshes: num(v.refreshes),
    costUsd,
    avoided: num(v.avoided),
    // Totals written before grossUsd had a net `savedUsd`: carry it over as gross = net + cost, so the net stays what it was.
    grossUsd: v.grossUsd !== undefined ? num(v.grossUsd) : num(v.savedUsd) + costUsd,
    since: num(v.since) || (await io.now()),
  }
}

/** Adds `delta` to the all-time totals. Never throws. */
export function addAllTime(io: Io, delta: Partial<Omit<Totals, 'since'>>): Promise<void> {
  const run = async () => {
    const t = await readAllTime(io)
    await io.storeSet('allTime', {
      ...t,
      refreshes: t.refreshes + (delta.refreshes ?? 0),
      costUsd: t.costUsd + (delta.costUsd ?? 0),
      avoided: t.avoided + (delta.avoided ?? 0),
      grossUsd: t.grossUsd + (delta.grossUsd ?? 0),
    })
  }
  const done = storeChain.then(run).catch(err => fail(io, 'all-time save', err))
  storeChain = done
  return done as Promise<void>
}

export type Learned = { usdPerPoint5h?: number; usdPerPointWeek?: number }

export async function readLearned(io: Io): Promise<Learned> {
  try {
    const v = (await io.storeGet('learned')) as Learned | undefined
    if (typeof v !== 'object' || v === null) return {}
    return {
      ...(num(v.usdPerPoint5h) > 0 ? { usdPerPoint5h: num(v.usdPerPoint5h) } : {}),
      ...(num(v.usdPerPointWeek) > 0 ? { usdPerPointWeek: num(v.usdPerPointWeek) } : {}),
    }
  } catch (err) {
    fail(io, 'learned read', err)
    return {}
  }
}

export function saveLearned(io: Io, learned: Learned): Promise<void> {
  const done = storeChain.then(() => io.storeSet('learned', learned)).catch(err => fail(io, 'learned save', err))
  storeChain = done
  return done as Promise<void>
}
