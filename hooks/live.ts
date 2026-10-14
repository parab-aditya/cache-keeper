// The live registry (phase 4): one small file per session in ~/.claude/cache-keeper/live/, written by that session only (so no
// cross-process race: `$.store` is not used for it), read by the user's other sessions to list who is warming and to ask one to stop.
// `<id>.json` is the session's LiveEntry; `<id>.stop.json` is another session's request that it stop. $.fs has no delete, so a file
// stays: a reader skips one that is not warming or is older than STALE_MS (a quit or crashed app stops refreshing anyway).
import type { Elsewhere, LiveEntry, Status } from '../types'
import type { Io } from './io'
import type { Snap } from './keeper'
import { fmtClock, fmtIn, fmtUsd, windowEnd } from './policy'

export const STALE_MS = 12 * 60_000
export const HEARTBEAT_MS = 5 * 60_000
/** A stop request shows as "stopping…" for this long (the target looks on each heartbeat, so a bit over one). */
export const STOPPING_MS = 6 * 60_000

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const liveDir = async (io: Io): Promise<string | undefined> => {
  const home = await io.home()
  return home ? `${home}/.claude/cache-keeper/live` : undefined
}

// ---------------------------------------------------------------------------
// This session's file

export type Ident = { title?: string; cwd?: string }

const oneLine = (t: string | undefined) => (t ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60)
const folderOf = (cwd: string | undefined) => (cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
/** The session title when known (the desktop sidebar's, else the SessionStart one), else the working folder's name, else the first 8 characters of the id. Never prompt text. */
export const labelOf = (sessionId: string, id: Ident): string => oneLine(id.title) || oneLine(folderOf(id.cwd)) || sessionId.slice(0, 8)

export function entryOf(s: Snap, warming: boolean, sessionId: string, id: Ident): LiveEntry {
  const end = s.anchor ? windowEnd(s.anchor, s.settings, s.tasks.length > 0) : undefined
  return {
    v: 1,
    sessionId,
    label: labelOf(sessionId, id),
    ...(id.cwd ? { cwd: id.cwd } : {}),
    warming,
    status: s.status.kind,
    keepFor: s.settings.keepFor,
    ...(end !== undefined && Number.isFinite(end) ? { windowEnd: end } : {}),
    ...(s.status.kind === 'scheduled' || s.status.kind === 'retrying' ? { nextAt: s.status.nextAt } : {}),
    ...(s.anchor ? { lastPromptAt: s.anchor.at } : {}),
    ...(s.contextTokens !== null ? { contextTokens: s.contextTokens } : {}),
    costUsd: s.session.costUsd,
    seen: s.now,
  }
}

// The desktop app's sidebar title: each desktop session has a file claude-code-sessions/<account>/<org>/local_<id>.json holding its
// `cliSessionId` and its `title` (renames included). Found once among the newest files, then re-read at most once a minute.
const DESKTOP_SESSIONS = 'Library/Application Support/Claude/claude-code-sessions'
export const TITLE_EVERY_MS = 60_000
let titleFile: { sid: string; path: string } | undefined
let titleAt = -Infinity
let lastTitle: string | undefined

const titleOf = (text: string, sid: string): string | undefined => {
  const d = JSON.parse(text) as { cliSessionId?: unknown; title?: unknown }
  return d.cliSessionId === sid && typeof d.title === 'string' && d.title.trim() ? d.title : undefined
}

/** This desktop session's title as the sidebar shows it; undefined when not found (a terminal session, another OS). Never throws. */
export async function desktopTitle(io: Io): Promise<string | undefined> {
  const now = await io.now()
  if (now - titleAt < TITLE_EVERY_MS) return lastTitle
  titleAt = now
  try {
    const [home, sid] = await Promise.all([io.home(), io.sessionId()])
    if (home === undefined) return lastTitle
    if (titleFile?.sid === sid) return (lastTitle = titleOf(await io.fsRead(titleFile.path), sid) ?? lastTitle)
    // A /clear gives the same desktop session a new id: look again.
    titleFile = undefined
    const root = `${home}/${DESKTOP_SESSIONS}`
    const files: { path: string; mtimeMs: number }[] = []
    for (const a of await io.fsList(root).catch(() => []))
      if (a.kind === 'dir')
        for (const o of await io.fsList(`${root}/${a.name}`))
          if (o.kind === 'dir')
            for (const f of await io.fsList(`${root}/${a.name}/${o.name}`))
              if (/^local_[\w-]+\.json$/.test(f.name)) files.push({ path: `${root}/${a.name}/${o.name}/${f.name}`, mtimeMs: f.mtimeMs })
    // ponytail: only the 8 newest are read (the app rewrites a session's file as it is used); a miss tries again a minute later.
    for (const f of files.sort((x, y) => y.mtimeMs - x.mtimeMs).slice(0, 8)) {
      const title = titleOf(await io.fsRead(f.path), sid)
      if (title === undefined) continue
      titleFile = { sid, path: f.path }
      return (lastTitle = title)
    }
  } catch (err) {
    io.debug(`cache-keeper: desktop title failed: ${errText(err)}`)
  }
  return lastTitle
}

let writeChain: Promise<unknown> = Promise.resolve()
let lastSig = ''
let lastAt = 0
let failShown = false
let drawn = false

/** Forget in-memory state (a fresh load, or a test). */
export function resetLive(): void {
  writeChain = Promise.resolve()
  lastSig = ''
  lastAt = 0
  failShown = false
  drawn = false
  asked.clear()
  titleFile = undefined
  titleAt = -Infinity
  lastTitle = undefined
}

/** A band or pane has been drawn: the minute scan starts to matter. True the first time. */
export const noteDrawn = (): boolean => {
  const first = !drawn
  drawn = true
  return first
}
export const isDrawn = (): boolean => drawn

/**
 * Writes this session's file, one write at a time like logLine; never throws. `build` runs when the write's turn comes, so the file
 * holds the latest state. A write that changes nothing (but `seen`) is skipped unless `force` (the heartbeat) or a heartbeat is due.
 */
export function writeEntry(io: Io, build: () => Promise<LiveEntry>, force = false): Promise<void> {
  const run = async () => {
    const dir = await liveDir(io)
    if (dir === undefined) return
    const entry = await build()
    const { seen, ...rest } = entry
    const sig = JSON.stringify(rest)
    if (!force && sig === lastSig && seen - lastAt < HEARTBEAT_MS) return
    await io.fsWrite(`${dir}/${entry.sessionId}.json`, JSON.stringify(entry))
    lastSig = sig
    lastAt = seen
  }
  const done = writeChain.then(run).catch(err => {
    if (failShown) return
    failShown = true
    io.debug(`cache-keeper: live write failed: ${errText(err)}`)
  })
  writeChain = done
  return done as Promise<void>
}

// ---------------------------------------------------------------------------
// Reading the others

/** Most recent first, then by label. */
const byRecent = (a: Elsewhere, b: Elsewhere) => b.seen - a.seen || a.label.localeCompare(b.label)

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Sessions asked to stop, and when: their row says "stopping…" until their file says they stopped (or STOPPING_MS passes). */
const asked = new Map<string, number>()

/** The other sessions that are warming now, as their files say. Never throws; an unreadable or odd file is skipped. */
export async function scan(io: Io): Promise<Elsewhere[]> {
  try {
    const dir = await liveDir(io)
    if (dir === undefined) return []
    const [now, own] = await Promise.all([io.now(), io.sessionId()])
    const files = await io.fsList(dir).catch(() => [])
    const out: Elsewhere[] = []
    for (const f of files) {
      // `<id>.json` only: a stop request has a second dot, and the id becomes part of a path.
      const id = /^([\w-]+)\.json$/.exec(f.name)?.[1]
      if (id === undefined || id === own || now - f.mtimeMs >= STALE_MS) continue
      try {
        const e = JSON.parse(await io.fsRead(`${dir}/${f.name}`)) as Partial<LiveEntry>
        const seen = num(e.seen)
        if (e.v !== 1 || e.warming !== true || seen === undefined || now - seen >= STALE_MS) continue
        const at = asked.get(id)
        const [windowEnd_, nextAt, lastPromptAt] = [num(e.windowEnd), num(e.nextAt), num(e.lastPromptAt)]
        out.push({
          sessionId: id,
          label: oneLine(typeof e.label === 'string' ? e.label : '') || id.slice(0, 8),
          ...(typeof e.cwd === 'string' ? { cwd: e.cwd } : {}),
          status: e.status ?? 'waiting',
          ...(windowEnd_ !== undefined ? { windowEnd: windowEnd_ } : {}),
          ...(nextAt !== undefined ? { nextAt } : {}),
          ...(lastPromptAt !== undefined ? { lastPromptAt } : {}),
          costUsd: num(e.costUsd) ?? 0,
          seen,
          ...(at !== undefined && now - at < STOPPING_MS ? { stopping: true } : {}),
        })
      } catch {
        // half-written or not ours: skip
      }
    }
    return out.sort(byRecent)
  } catch (err) {
    io.debug(`cache-keeper: live scan failed: ${errText(err)}`)
    return []
  }
}

/** Scans and puts the list in the `elsewhere` atom, only when it changed (a write redraws the band and the pane). Returns the list. */
export async function rescan(io: Io): Promise<Elsewhere[]> {
  const list = await scan(io)
  if (JSON.stringify(list) !== JSON.stringify(await io.read('elsewhere'))) await io.update('elsewhere', () => list)
  return list
}

// ---------------------------------------------------------------------------
// Stop requests

/** Asks each of `targets` to stop: writes `<id>.stop.json` (this session is its only writer at that moment). Returns the ones written. */
export async function requestStop(io: Io, targets: readonly Elsewhere[]): Promise<Elsewhere[]> {
  const dir = await liveDir(io)
  if (dir === undefined) return []
  const [now, by] = await Promise.all([io.now(), io.sessionId()])
  const done: Elsewhere[] = []
  for (const t of targets) {
    try {
      await io.fsWrite(`${dir}/${t.sessionId}.stop.json`, JSON.stringify({ at: now, by }))
      asked.set(t.sessionId, now)
      done.push(t)
    } catch (err) {
      io.debug(`cache-keeper: stop request failed: ${errText(err)}`)
    }
  }
  await rescan(io)
  return done
}

/** When another session last asked this one to stop; undefined when nobody did (or the file is unreadable). */
export async function stopAskedAt(io: Io): Promise<number | undefined> {
  try {
    const dir = await liveDir(io)
    if (dir === undefined) return undefined
    const path = `${dir}/${await io.sessionId()}.stop.json`
    if (!(await io.fsExists(path))) return undefined
    return num((JSON.parse(await io.fsRead(path)) as { at?: unknown }).at)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Rows (the /cache sessions list and the pane)

const STATUS_WORD: Record<Status['kind'], string> = {
  scheduled: 'warm', waiting: 'warm', refreshing: 'refreshing', retrying: 'retrying', holding: 'holding', done: 'done', stopped: 'stopped',
}

/** `3h10m` as `3h 10m`. */
const spaced = (ms: number) => fmtIn(ms).replace(/^(\d+h)(\d)/, '$1 $2')

/** One session as a line: label, folder, state, how long it is kept, the next refresh, how long since its last prompt, what its refreshes cost. */
export function rowText(e: Elsewhere, now: number): string {
  const folder = folderOf(e.cwd)
  return [
    e.label,
    folder !== '' && folder !== e.label ? folder : '',
    STATUS_WORD[e.status],
    e.windowEnd !== undefined ? `warm until ${fmtClock(e.windowEnd)}` : 'no end',
    e.nextAt !== undefined ? `next refresh ${fmtClock(e.nextAt)}` : '',
    e.lastPromptAt !== undefined ? `idle ${spaced(now - e.lastPromptAt)}` : '',
    `refreshes ${fmtUsd(e.costUsd)}`,
    e.stopping ? 'stopping…' : '',
  ].filter(Boolean).join(' · ')
}

export const elsewhereTitle = (n: number): string => `Warming in ${n} other session${n === 1 ? '' : 's'}`
