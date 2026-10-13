// "Save as default" (design.md §10, brief C): the session's settings written to the /config rows.
// Every `$.config.set` reloads the module, so the fields go one at a time: the whole set is parked in
// `$.store` `pendingSave` (row name -> option string), the first is written, and each `session.start` after
// the reload drops what is now reflected and writes the next. A row that refuses (`deny`) keeps its value in
// `$.store` `savedDefaults`, merged over the manifest options at `session.start` (HeyCubit/effortless pattern, MIT).
import type { Settings } from '../types'
import type { Io } from './io'
import { OPTIONS } from './policy'

type Field = keyof Settings
/** Settings field -> the userConfig row (`cache-keeper.<row>`). */
const ROW: Record<Field, string> = {
  keepFor: 'keepFor', leadMin: 'lead', minTokens: 'minTokens', weeklyGuard: 'weeklyGuard', band: 'band', upgradeTo1h: 'upgradeTo1h',
}
const FIELDS = Object.keys(ROW) as Field[]
const asOption = (f: Field, s: Settings): string => (f === 'upgradeTo1h' ? (s.upgradeTo1h ? 'on' : 'off') : String(s[f]))

/** The rows whose session value differs from the saved default and fits the row's options (`/cache lead 7` does not). */
export function changes(session: Settings, saved: Settings): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of FIELDS) {
    if (asOption(f, session) === asOption(f, saved)) continue
    if (f === 'leadMin' && !(OPTIONS.lead as readonly number[]).includes(session.leadMin)) continue
    out[ROW[f]] = asOption(f, session)
  }
  return out
}

const PENDING = 'pendingSave'
const KEPT = 'savedDefaults'

const getRec = async (io: Io, key: string): Promise<Record<string, string>> => {
  const v = await io.storeGet(key).catch(() => undefined)
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
}
const setRec = (io: Io, key: string, rec: Record<string, string>) => io.storeSet(key, rec)

/** Values a /config row refused, to merge over the manifest options. */
export const keptDefaults = (io: Io) => getRec(io, KEPT)

/**
 * Writes one row. Our own `$.config.set` is not seen by this plugin's hooks (so `onConfigSet` never clears a value
 * kept for the row): drop it before the write (a reload may follow at once) and put it back if the row refuses.
 */
export async function saveRow(io: Io, row: string, value: string): Promise<string | undefined> {
  const kept = await getRec(io, KEPT)
  const had = kept[row]
  if (had !== undefined) {
    delete kept[row]
    await setRec(io, KEPT, kept)
  }
  const deny = await io.saveConfig(`cache-keeper.${row}`, value)
  if (deny !== undefined && had !== undefined) await setRec(io, KEPT, { ...(await getRec(io, KEPT)), [row]: had })
  return deny
}

/** A row the person changed in /config wins over a value we kept for it. */
export async function forgetKept(io: Io, row: string): Promise<void> {
  const kept = await getRec(io, KEPT)
  if (row in kept) {
    delete kept[row]
    await setRec(io, KEPT, kept)
  }
}

/** How long to wait for the reload a write brings before concluding there is none. */
const RELOAD_WAIT_MS = 2500

/**
 * Writes the next pending row. `defaults` are the saved defaults this copy of the module runs with: a row they (or
 * the /config list) already show is done. Resolves after the write; a reload then carries on from `session.start`.
 * `again` is the look after the wait for a reload: the row written before, if it still does not show, was refused.
 */
export async function drainSave(io: Io, defaults: Settings, again: boolean): Promise<void> {
  let pending = await getRec(io, PENDING)
  const asked = Object.entries(pending)[0]
  if (!asked) return
  const rows = await io.configRows().catch(() => [])
  const mine = new Map(FIELDS.map(f => [ROW[f], asOption(f, defaults)]))
  const reflected = (k: string, v: string) =>
    mine.get(k) === v || rows.some(r => r.key === `cache-keeper.${k}` && String(r.value) === v)
  pending = Object.fromEntries(Object.entries(pending).filter(([k, v]) => !reflected(k, v)))
  const kept = await getRec(io, KEPT)
  const refused: string[] = []
  if (again && asked[0] in pending) {
    kept[asked[0]] = asked[1]
    delete pending[asked[0]]
    refused.push('the row did not take the value')
  }
  for (let first = Object.entries(pending)[0]; first; first = Object.entries(pending)[0]) {
    const [k, v] = first
    await setRec(io, PENDING, pending)
    // A value kept for this row would beat the one being written (merged over the options): drop it before the write.
    const had = k in kept
    delete kept[k]
    if (had) await setRec(io, KEPT, kept)
    const deny = await io.saveConfig(`cache-keeper.${k}`, v)
    if (deny === undefined) {
      // Written: the module reloads and its session.start drains the rest; if no reload comes, look again.
      if (refused.length > 0) await setRec(io, KEPT, kept)
      io.after(RELOAD_WAIT_MS, () => void drainSave(io, defaults, true))
      return
    }
    kept[k] = v
    refused.push(deny)
    delete pending[k]
  }
  await setRec(io, PENDING, {})
  if (refused.length > 0) await setRec(io, KEPT, kept)
  io.toast(refused.length > 0 ? `Settings saved in cache-keeper (the /config row refused: ${refused[0]})` : 'Settings saved')
}

/** The Save as default press: park every savable difference, then start writing. */
export async function saveAsDefault(io: Io, session: Settings, saved: Settings): Promise<void> {
  const ch = changes(session, saved)
  if (Object.keys(ch).length === 0) return
  await setRec(io, PENDING, ch)
  await drainSave(io, saved, false)
}
