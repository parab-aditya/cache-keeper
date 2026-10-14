// cache-keeper /cache command (design.md §13): parsing and short markdown answers.
import type { KeepFor } from '../types'
import { saveRow } from './defaults'
import type { Io } from './io'
import { elsewhereTitle, requestStop, rescan, rowText } from './live'
import { logTail, readAllTime } from './log'
import {
  A,
  bandGeo,
  lineInputOf,
  openSettings,
  refreshNow,
  setSettings,
  snapshot,
  statusLine,
  themeLine,
  toggleWarming,
  ttlExplain,
  warmingOn,
} from './keeper'
import type { Snap } from './keeper'

import {
  KEEP_MS,
  OPTIONS,
  coldDetail,
  expiresAt,
  fmtClock,
  fmtDate,
  fmtIn,
  fmtPct,
  fmtSpan,
  fmtTokens,
  fmtUsd,
  savingsOf,
  totalsText,
  windowEnd,
} from './policy'

export const ARGUMENT_HINT =
  'status | on | off | keep <2h|4h|8h|12h|forever> [--save] | lead <min> [--save] | refresh-now | stats | settings | sessions | stop <n|all> | debug'

const USAGE = [
  'Usage: `/cache <sub>`',
  '- `status` (default), `stats`, `debug`',
  '- `on` / `off`: warm for the saved window / stop warming this session',
  '- `keep <2h|4h|8h|12h|forever> [--save]`, `lead <2-15> [--save]`',
  '- `refresh-now`, `settings`',
  '- `sessions`: your other sessions that are keeping the cache warm; `stop <n|all>` asks them to stop',
].join('\n')

const KEEPS: readonly KeepFor[] = ['2h', '4h', '8h', '12h', 'forever']

/** The session ids `/cache sessions` last printed, in order: `/cache stop <n>` means the n-th of these (matched by id, the list may have moved). */
let printed: string[] = []

const ago = (s: Snap, at: number) => `${fmtIn(s.now - at)} ago`

function details(s: Snap): string {
  const rows: string[] = []
  // The short cold line leaves out when it went cold and why.
  const cold = coldDetail(lineInputOf(s))
  if (cold) rows.push(cold)
  rows.push(`TTL: ${ttlExplain(s)}`)
  if (s.anchor && s.chain) {
    rows.push(
      `Last request: ${ago(s, s.anchor.at)} · ${fmtTokens(s.anchor.promptTokens)} tokens · ${s.anchor.model || 'model unknown'}`,
    )
    const exp = expiresAt(s.chain, s.anchor.ttl)
    rows.push(`Cache expires: ${fmtClock(exp)} (${exp > s.now ? `in ${fmtIn(exp - s.now)}` : 'already cold'})`)
    if (s.status.kind === 'scheduled')
      rows.push(
        `Next refresh: ${fmtClock(s.status.nextAt)} (in ${fmtIn(s.status.nextAt - s.now)}; ${fmtIn(s.settings.leadMin * 60_000)} lead on 1h)`,
      )
    const end = windowEnd(s.anchor, s.settings, s.tasks.length > 0)
    rows.push(
      `Window: ${s.settings.keepFor}${s.tasks.length > 0 ? ' (extended by background tasks)' : ''}` +
        (Number.isFinite(end) ? `, ends ${fmtClock(end)}` : ''),
    )
    rows.push(`Kept this chain: ${s.chain.refreshes}× (${fmtUsd(s.chain.costUsd)})`)
  } else {
    rows.push('No request yet in this conversation.')
  }
  rows.push(`Settings: keep ${s.settings.keepFor}, lead ${s.settings.leadMin}m, min ${fmtTokens(s.settings.minTokens)}, weekly guard ${s.settings.weeklyGuard}%`)
  if (s.tasks.length > 0) rows.push(`Background tasks: ${s.tasks.map(t => `${t.kind} ${t.desc || t.id}`).join('; ')}`)
  if (s.dialog) rows.push(`Waiting on you: ${s.dialog.tool}`)
  if (s.limits) {
    const parts = [
      s.limits.fiveHour !== undefined ? `5h ${fmtPct(s.limits.fiveHour)}` : '',
      s.limits.weekly !== undefined ? `weekly ${fmtPct(s.limits.weekly)}` : '',
    ].filter(Boolean)
    if (parts.length > 0) rows.push(`Limits: ${parts.join(' · ')}`)
  }
  if (s.last) {
    rows.push(
      `Last refresh: ${s.last.result} ${ago(s, s.last.at)}, read ${fmtTokens(s.last.cacheRead)}, ` +
        `${s.last.costUsd === null ? `~${fmtUsd(s.last.estUsd)}` : fmtUsd(s.last.costUsd)}, ${s.last.ms} ms, ${s.last.phase}` +
        (s.last.detail && s.last.result !== 'warmed' ? `, ${s.last.detail}` : ''),
    )
  }
  return rows.map(r => `- ${r}`).join('\n')
}

async function stats(io: Io, s: Snap): Promise<string> {
  const all = await readAllTime(io)
  const row = (name: string, t: Parameters<typeof totalsText>[0]) => `- ${name}: ${totalsText(t)}`
  const sv = savingsOf(all, s.session)
  return [
    '**cache-keeper stats**',
    `${sv.hero} (${sv.detail}) · ${sv.session}`,
    row('This session', s.session),
    row(`All time (since ${fmtDate(all.since)})`, all),
    sv.note,
  ].join('\n')
}

async function save(io: Io, field: string, value: string): Promise<string | undefined> {
  return saveRow(io, field, value)
}

export async function runCommand(io: Io, args: string): Promise<{ text: string }> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const wantSave = words.includes('--save')
  const [sub = 'status', arg] = words.filter(w => w !== '--save')
  const say = (text: string) => ({ text })
  switch (sub) {
    case 'status': {
      const s = await snapshot(io)
      return say(`**${statusLine(s)}**\n${details(s)}`)
    }
    case 'stats':
      return say(await stats(io, await snapshot(io)))
    // `resume` is `on`, `pause` is `off`: there is one switch.
    case 'on':
    case 'resume': {
      const keepFor = await warmingOn(io)
      return say(`Warming on: ${keepFor === 'forever' ? 'no end' : `${keepFor} after each message`}.`)
    }
    case 'off':
    case 'pause':
      // toggleWarming records the window, so `/cache on` restores it.
      if ((await io.read(A.settings)).keepFor !== 'off') await toggleWarming(io)
      return say('Auto-refresh off for this session. `/cache on` turns it back on.')
    case 'keep': {
      const keepFor = KEEPS.find(k => k === arg)
      if (!keepFor) return say('Usage: `/cache keep <2h|4h|8h|12h|forever> [--save]`')
      await setSettings(io, { keepFor })
      const denied = wantSave ? await save(io, 'keepFor', keepFor) : undefined
      return say(
        `Keeping the cache warm for ${keepFor === 'forever' ? 'as long as the session lives' : fmtSpan(KEEP_MS[keepFor])} after each message` +
          (wantSave ? (denied ? ` (not saved as default: ${denied}).` : ' (saved as default).') : '.'),
      )
    }
    case 'lead': {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 2 || n > 15) return say('Usage: `/cache lead <2-15> [--save]` (minutes before the 1-hour cache expires)')
      await setSettings(io, { leadMin: n })
      const canSave = (OPTIONS.lead as readonly number[]).includes(n)
      const denied = wantSave && canSave ? await save(io, 'lead', String(n)) : undefined
      return say(
        `Refreshing ${n} minutes before expiry` +
          (wantSave
            ? canSave
              ? denied ? ` (not saved as default: ${denied}).` : ' (saved as default).'
              : ` (not saved: the saved default takes one of ${OPTIONS.lead.join(', ')}).`
            : '.'),
      )
    }
    case 'refresh-now':
      return say(`Refresh: ${await refreshNow(io)}`)
    case 'settings': {
      const where = await openSettings(io)
      if (where === 'sheet') return say('Settings opened above the prompt.')
      return say(where === 'pane' ? 'Settings pane opened.' : 'The settings pane has no room here: widen the window, or use `/config` (rows `cache-keeper.*`).')
    }
    case 'sessions': {
      const list = await rescan(io)
      printed = list.map(e => e.sessionId)
      if (list.length === 0) return say('No other session is warming.')
      const now = await io.now()
      return say([
        `**${elsewhereTitle(list.length)}**`,
        ...list.map((e, i) => `${i + 1}. ${rowText(e, now)}`),
        'Stop one: `/cache stop 2` · all: `/cache stop all`',
      ].join('\n'))
    }
    case 'stop': {
      const list = await rescan(io)
      const n = Number(arg)
      if (arg !== 'all' && !(Number.isInteger(n) && n >= 1)) return say('Usage: `/cache stop <n|all>` (numbers are the ones `/cache sessions` printed)')
      if (list.length === 0) return say('No other session is warming.')
      const id = arg === 'all' ? undefined : (printed.length > 0 ? printed : list.map(e => e.sessionId))[n - 1]
      if (arg !== 'all' && id === undefined) return say(`There is no session ${n}: run \`/cache sessions\` to see the list.`)
      const targets = arg === 'all' ? list : list.filter(e => e.sessionId === id)
      const moved = printed.length > 0 && JSON.stringify(printed) !== JSON.stringify(list.map(e => e.sessionId))
      if (targets.length === 0) return say('That session is no longer warming: run `/cache sessions` for the current list.')
      const done = await requestStop(io, targets)
      const lines = done.map(t => `Asked ${t.label} to stop; it stops before its next refresh.`)
      if (done.length < targets.length) lines.push('Could not write the stop request for every session (see the debug log).')
      if (moved && arg !== 'all') lines.push('The list changed since `/cache sessions`: matched by session, not by number.')
      return say(lines.join('\n'))
    }
    case 'debug': {
      const s = await snapshot(io)
      const tail = await logTail(io, 10)
      const dump = JSON.stringify({ ...s, bandGeo: bandGeo() }, null, 1)
      return say(['```json', dump, '```', themeLine(), tail.length > 0 ? '```\n' + tail.join('\n') + '\n```' : 'The log is empty.'].join('\n'))
    }
    default:
      return say(USAGE)
  }
}
