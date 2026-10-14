// Phase 4 (0.3.0): the live registry (one file per session), the list of the user's other warming sessions (/cache sessions, the band's
// ember chip, the pane's "Warming elsewhere"), and a Stop that works across sessions (a stop file the target honours before its next fork).
import { test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { emberSvg } from '../hooks/art'
import { fmtClock } from '../hooks/policy'
import { CELL_PX, CHIP_CELLS, ELSEWHERE_CELLS, GEAR_CELLS, TOGGLE_CELLS } from '../hooks/view'
import { HOUR, MINUTE, OPUS, SESSION_ID, START, cache, expect, logLines, prompt, setConfig, snap, start, st, turnUsage, world } from './world'
import type { World } from './world'

const LIVE = '/home/t/.claude/cache-keeper/live'
const OWN = `${LIVE}/${SESSION_ID}.json`
type Entry = Record<string, unknown>
const json = (w: World, path: string) => JSON.parse(w.files.get(path) ?? 'null') as Entry
const own = (w: World) => json(w, OWN)

/** Another session's live file, as it writes it (warming, seen now, a recent mtime unless said). */
const other = (w: World, id: string, over: Entry = {}, mtime = w.clock.now()) => {
  const now = w.clock.now()
  const path = `${LIVE}/${id}.json`
  w.files.set(path, JSON.stringify({ v: 1, sessionId: id, label: id, warming: true, status: 'scheduled', keepFor: '8h', costUsd: 0, seen: now, ...over }))
  w.mtimes.set(path, mtime)
}
const stopFile = (w: World, id: string) => json(w, `${LIVE}/${id}.stop.json`)
const askStop = (w: World, at: number, by = 'x') => w.files.set(`${LIVE}/${SESSION_ID}.stop.json`, JSON.stringify({ at, by }))

// ---------------------------------------------------------------------------
// The registry: this session's own file

test('live: the file holds the session state and no conversation text; it follows the status', async ($, on) => {
  const w = world(on)
  await start($)
  expect(own(w)).toMatchObject({ v: 1, sessionId: SESSION_ID, label: 'w', cwd: '/w', warming: false, status: 'waiting' })
  await prompt($, w, 't1')
  expect(own(w)).toMatchObject({
    v: 1, sessionId: SESSION_ID, label: 'w', cwd: '/w', warming: true, status: 'scheduled', keepFor: '8h',
    nextAt: START + 55 * MINUTE, lastPromptAt: START, windowEnd: START + 8 * HOUR, costUsd: 0, seen: START,
  })
  const keys = ['v', 'sessionId', 'label', 'cwd', 'warming', 'status', 'keepFor', 'windowEnd', 'nextAt', 'lastPromptAt', 'contextTokens', 'costUsd', 'seen']
  expect(Object.keys(own(w)).every(k => keys.includes(k))).toBe(true)
  // a refresh books its spend into the file (the status goes refreshing, then scheduled again)
  await w.clock.advance(56 * MINUTE)
  expect(w.forks).toHaveLength(1)
  expect(own(w)).toMatchObject({ warming: true, status: 'scheduled' })
  expect(own(w).costUsd as number).toBeGreaterThan(0)
  // off: not warming; on: warming again; the session end: not warming for good
  await cache($, 'off')
  expect(own(w)).toMatchObject({ warming: false, keepFor: 'off', status: 'stopped' })
  await cache($, 'on')
  expect(own(w)).toMatchObject({ warming: true, keepFor: '8h' })
  await $.session.end({ reason: 'logout', sessionId: SESSION_ID, resume: {} } as never)
  expect(own(w)).toMatchObject({ warming: false, status: 'stopped' })
  await w.clock.advance(HOUR)
  expect(own(w)).toMatchObject({ warming: false })
})

test('live: the label is the session title, else the folder, else the first 8 characters of the id; a holding or finished session is not warming', async ($, on) => {
  const w = world(on)
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_title: 'Fix the login bug' } as never)
  await prompt($, w, 't1')
  expect(own(w)).toMatchObject({ label: 'Fix the login bug', warming: true })
  // a context under the minimum is held, not warmed
  await cache($, 'keep 2h')
  await prompt($, w, 't2', turnUsage(OPUS, 9_000, 0))
  expect(own(w)).toMatchObject({ status: 'holding', warming: false })
  // the window ends: done, not warming
  await prompt($, w, 't3', turnUsage(OPUS, 399_000, 1_000))
  await w.clock.advance(2 * HOUR + MINUTE)
  expect(own(w)).toMatchObject({ status: 'done', warming: false })
})

test('live: a heartbeat every 5 minutes while warming, none when not', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  expect(own(w).seen).toBe(START)
  await w.clock.advance(4 * MINUTE)
  expect(own(w).seen).toBe(START)
  await w.clock.advance(MINUTE)
  expect(own(w).seen).toBe(START + 5 * MINUTE)
  await w.clock.advance(10 * MINUTE)
  expect(own(w).seen).toBe(START + 15 * MINUTE)
  await cache($, 'off')
  const at = own(w).seen
  await w.clock.advance(30 * MINUTE)
  expect(own(w).seen).toBe(at)
})

test('live: a file that cannot be written never breaks warming', async ($, on) => {
  const w = world(on, { failWrites: true })
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(56 * MINUTE)
  expect(w.forks).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Reading the others

const sessions = async ($: Engine) => (await cache($, 'sessions')).text ?? ''

test('sessions: only other sessions that are warming and fresh count (not stale, not stopped, not this one, not stop requests, not odd files)', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  const now = w.clock.now()
  expect(await sessions($)).toBe('No other session is warming.')
  other(w, 'live-one', { label: 'Live one' })
  other(w, 'not-warming', { warming: false, label: 'Not warming' })
  other(w, 'old-seen', { seen: now - 13 * MINUTE, label: 'Old seen' })
  other(w, 'old-file', { label: 'Old file' }, now - 13 * MINUTE)
  other(w, 'just-in-time', { seen: now - 11 * MINUTE, label: 'Just in time' })
  other(w, 'wrong-version', { v: 2, label: 'Wrong version' })
  w.files.set(`${LIVE}/broken.json`, '{not json')
  w.files.set(`${LIVE}/live-one.stop.json`, JSON.stringify({ at: now, by: 'z' }))
  w.files.set(`${LIVE}/readme.txt`, 'hello')
  // this session's own file says warming and is the newest, yet it is not listed
  expect(own(w).warming).toBe(true)
  const text = await sessions($)
  expect(text).toContain('Warming in 2 other sessions')
  expect(text).toContain('Live one')
  expect(text).toContain('Just in time')
  for (const gone of ['Not warming', 'Old seen', 'Old file', 'Wrong version', 'broken', 'readme', SESSION_ID]) expect(text, gone).not.toContain(gone)
  expect((await st($, 'elsewhere')).map(e => e.sessionId)).toEqual(['live-one', 'just-in-time'])
})

test('sessions: a numbered list, most recent first then by label, with label, folder, state, window, next refresh, idle time and spend; then the hint', async ($, on) => {
  const w = world(on)
  await start($)
  const now = w.clock.now()
  other(w, 'b', { label: 'Beta', seen: now - MINUTE, cwd: '/Users/x/app', windowEnd: now + 5 * HOUR, nextAt: now + 20 * MINUTE, lastPromptAt: now - (3 * HOUR + 10 * MINUTE), costUsd: 0.42 })
  other(w, 'a', { label: 'Alpha', seen: now - MINUTE, status: 'refreshing', costUsd: 1.5 })
  other(w, 'c', { label: 'Gamma', seen: now - 2 * MINUTE, cwd: '/p/Gamma', status: 'retrying' })
  expect(await sessions($)).toBe(
    [
      '**Warming in 3 other sessions**',
      '1. Alpha · refreshing · no end · refreshes $1.50',
      `2. Beta · app · warm · warm until ${fmtClock(now + 5 * HOUR)} · next refresh ${fmtClock(now + 20 * MINUTE)} · idle 3h 10m · refreshes $0.42`,
      '3. Gamma · retrying · no end · refreshes $0.00',
      'Stop one: `/cache stop 2` · all: `/cache stop all`',
    ].join('\n'),
  )
})

// ---------------------------------------------------------------------------
// Asking another session to stop

test('stop: /cache stop <n> writes that session\'s stop file; all writes every one', async ($, on) => {
  const w = world(on)
  await start($)
  const now = w.clock.now()
  other(w, 'a', { label: 'Alpha' })
  other(w, 'b', { label: 'Beta', seen: now - MINUTE })
  await sessions($)
  expect((await cache($, 'stop 2')).text).toBe('Asked Beta to stop; it stops before its next refresh.')
  expect(stopFile(w, 'b')).toEqual({ at: now, by: SESSION_ID })
  expect(w.files.has(`${LIVE}/a.stop.json`)).toBe(false)
  // the list now says the asked session is stopping, until its file says it is not warming
  expect((await st($, 'elsewhere')).map(e => [e.sessionId, e.stopping ?? false])).toEqual([['a', false], ['b', true]])
  expect(await sessions($)).toContain('2. Beta · warm · no end · refreshes $0.00 · stopping…')
  other(w, 'b', { warming: false })
  expect((await sessions($)).startsWith('**Warming in 1 other session**')).toBe(true)
  expect((await cache($, 'stop all')).text).toBe('Asked Alpha to stop; it stops before its next refresh.')
  expect(stopFile(w, 'a')).toEqual({ at: now, by: SESSION_ID })
})

test('stop: bad input, nothing warming, and a list that changed since it was printed', async ($, on) => {
  const w = world(on)
  await start($)
  const now = w.clock.now()
  expect((await cache($, 'stop 1')).text).toBe('No other session is warming.')
  expect((await cache($, 'stop all')).text).toBe('No other session is warming.')
  other(w, 'a', { label: 'Alpha' })
  other(w, 'b', { label: 'Beta', seen: now - MINUTE })
  expect((await cache($, 'stop')).text).toContain('Usage: `/cache stop <n|all>`')
  expect((await cache($, 'stop 0')).text).toContain('Usage')
  expect((await cache($, 'stop x')).text).toContain('Usage')
  await sessions($)
  expect((await cache($, 'stop 3')).text).toContain('There is no session 3')
  // Alpha stops warming between the list and the press: number 2 still means Beta (matched by id, not position), and the answer says the list moved
  other(w, 'a', { warming: false })
  const text = (await cache($, 'stop 2')).text ?? ''
  expect(text).toContain('Asked Beta to stop')
  expect(text).toContain('The list changed since `/cache sessions`')
  expect(w.files.has(`${LIVE}/a.stop.json`)).toBe(false)
  // number 1 was Alpha, which is gone
  expect((await cache($, 'stop 1')).text).toContain('no longer warming')
})

test('stop: /cache stop without a list first numbers the current one; the usage and the hint name both commands', async ($, on) => {
  const w = world(on)
  await start($)
  other(w, 'a', { label: 'Alpha' })
  expect((await cache($, 'stop 1')).text).toBe('Asked Alpha to stop; it stops before its next refresh.')
  const usage = (await cache($, 'nonsense')).text ?? ''
  expect(usage).toContain('sessions')
  expect(usage).toContain('stop <n|all>')
})

// ---------------------------------------------------------------------------
// Being asked to stop

test('handshake: a stop request newer than the last turn-on stops this session before its next fork, like /cache off', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(2 * MINUTE)
  // a new prompt moves the refresh to 57 minutes; the heartbeats are at 5, 10, … 55: the request comes after the 55 and before the fork
  await prompt($, w, 't2')
  await w.clock.advance(54 * MINUTE)
  expect(w.forks).toHaveLength(0)
  askStop(w, w.clock.now())
  await w.clock.advance(3 * MINUTE)
  expect(w.forks).toHaveLength(0)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'user-off', reason: 'stopped from another session' })
  expect((await st($, 'settings')).keepFor).toBe('off')
  expect(logLines(w).filter(l => l.ev === 'stop')).toEqual([expect.objectContaining({ code: 'user-off', reason: 'stopped from another session' })])
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]).toContain('stopped from another session')
  expect(own(w)).toMatchObject({ warming: false, keepFor: 'off' })
  await w.clock.advance(3 * HOUR)
  expect(w.forks).toHaveLength(0)
})

test('handshake: the heartbeat finds a request even when no refresh is due', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(MINUTE)
  askStop(w, w.clock.now())
  expect((await st($, 'settings')).keepFor).toBe('8h')
  await w.clock.advance(5 * MINUTE)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'user-off' })
  expect(w.forks).toHaveLength(0)
  expect(w.appended).toHaveLength(1)
})

test('handshake: a request older than the last turn-on is ignored, so turning warming back on wins', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(MINUTE)
  askStop(w, w.clock.now())
  await w.clock.advance(MINUTE)
  // the person turns it off and on again before the target looks: the request is older than that
  await cache($, 'off')
  await cache($, 'on')
  await w.clock.advance(10 * MINUTE)
  expect((await st($, 'settings')).keepFor).toBe('8h')
  await w.clock.advance(50 * MINUTE)
  expect(w.forks).toHaveLength(1)
  expect(w.appended).toHaveLength(0)
  // a request after the turn-on is honoured
  askStop(w, w.clock.now())
  await w.clock.advance(5 * MINUTE)
  expect((await st($, 'settings')).keepFor).toBe('off')
})

test('handshake: /cache on after a remote stop restores the window the session had, and that request is then old', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'keep 4h')
  askStop(w, w.clock.now() + 1)
  await w.clock.advance(5 * MINUTE)
  expect((await st($, 'settings')).keepFor).toBe('off')
  expect((await cache($, 'on')).text).toContain('4h')
  expect((await st($, 'settings')).keepFor).toBe('4h')
  await w.clock.advance(20 * MINUTE)
  expect((await st($, 'settings')).keepFor).toBe('4h')
  expect(await st($, 'status')).toMatchObject({ kind: 'scheduled' })
  expect(own(w)).toMatchObject({ warming: true, keepFor: '4h' })
  await w.clock.advance(HOUR)
  expect(w.forks).toHaveLength(1)
})

test('handshake: a manual /cache refresh-now checks the request first, too', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  askStop(w, w.clock.now() + 1)
  expect((await cache($, 'refresh-now')).text).toContain('Stopped from another session')
  expect(w.forks).toHaveLength(0)
})

test('handshake: an unreadable request file is not a request', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  w.files.set(`${LIVE}/${SESSION_ID}.stop.json`, '{broken')
  await w.clock.advance(56 * MINUTE)
  expect(w.forks).toHaveLength(1)
  expect((await st($, 'settings')).keepFor).toBe('8h')
})

// ---------------------------------------------------------------------------
// The band: the ember chip

type BandProps = { hasSurvey: boolean; isWorking: boolean; maxRows: number; bodyColumns: number; scroll: { offset: number; bodyRows: number }; view: Record<string, never> }
const PROPS: BandProps = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} }
const mount = ($: Engine, surface: 'terminal' | 'desktop', extra: Partial<BandProps> = {}) =>
  $.ui.mount({ plugin: 'cache-keeper', surface, component: 'AbovePrompt', props: { ...PROPS, ...extra } })
const engineBand = (on: Parameters<typeof world>[0]) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Text, {}, 'engine band') as never)
type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }

test('band: the ember chip is hidden with no other session warming and shown from one, on both surfaces', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  let desk = await mount($, 'desktop')
  let term = await mount($, 'terminal')
  expect(await desk.find({ key: 'ck-elsewhere' })).toBeUndefined()
  expect(await term.find({ key: 'ck-elsewhere' })).toBeUndefined()
  other(w, 'a')
  await sessions($)
  const chip = await desk.find({ type: 'Button', key: 'ck-elsewhere' })
  expect(chip).toBeDefined()
  const alt = async (n: number) => (await desk.findAll({ type: 'Svg' })).map(s => s.props.alt).includes(`Warming in ${n} other session${n === 1 ? '' : 's'}`)
  expect(await alt(1)).toBe(true)
  expect(await term.find({ type: 'Text', text: '+1 warming elsewhere' })).toBeDefined()
  other(w, 'b')
  await sessions($)
  expect(await alt(2)).toBe(true)
  expect(await term.find({ type: 'Text', text: '+2 warming elsewhere' })).toBeDefined()
  // the chip is the ember's, in any state of this band; the flame animates and its count is the text
  const svg = String((await desk.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('Warming in'))?.props.source)
  expect(svg).toContain('animation')
  expect(svg).toContain('>2</text>')
  // gone again when the others stop
  other(w, 'a', { warming: false })
  other(w, 'b', { warming: false })
  await sessions($)
  expect(await desk.find({ key: 'ck-elsewhere' })).toBeUndefined()
  expect(await term.find({ key: 'ck-elsewhere' })).toBeUndefined()
  await desk.unmount()
  await term.unmount()
})

test('band: the chip counts ten and more as 9+, and is drawn in the light palette on a light theme', async () => {
  expect(emberSvg(12, false, 47, 0)).toContain('>9+</text>')
  expect(emberSvg(3, true, 47, 0)).toContain('#b04f08')
  expect(emberSvg(3, false, 47, 0)).toContain('#f39a52')
})

test('band: the chip never overlaps the toggle, keep chip and gear: the controls are in the flow, the state text gives way (75, 90, 95 columns)', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  other(w, 'a')
  other(w, 'b')
  await sessions($)
  for (const columns of [75, 90, 95]) {
    const ui = await mount($, 'desktop', { bodyColumns: columns })
    const controls = (await ui.find({ key: 'ck-controls' })) as unknown as Node
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(keys, `${columns}`).toEqual(['ck-elsewhere', 'ck-keep', 'ck-toggle', 'ck-settings'])
    expect(controls.props.flexShrink, `${columns}`).toBe(0)
    expect((await ui.find({ key: 'ck-line' }))?.props.flexShrink, `${columns}`).toBe(1000)
    // widths in cells: the controls and the gaps between them leave room for the dot, the paddings and a few words of the line
    const widths = [ELSEWHERE_CELLS, CHIP_CELLS, TOGGLE_CELLS, GEAR_CELLS]
    const used = widths.reduce((a, b) => a + b, 0) + (widths.length - 1)
    const left = columns - 2 - 2 - 2 - used // border, band padding, the dot and its gap
    expect(left, `${columns}`).toBeGreaterThanOrEqual(10)
    expect(used * CELL_PX).toBeLessThan(columns * CELL_PX)
    await ui.unmount()
  }
  // the order on the desktop is the chip, then the keep chip, then toggle and gear
  const ui = await mount($, 'desktop', { bodyColumns: 90 })
  const hits = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).filter(a => /^(Warming|Keep warm|Auto-refresh|Settings)/.test(a))
  expect(hits).toEqual(['Warming in 2 other sessions', 'Keep warm for 8h', 'Auto-refresh on', 'Settings'])
  await ui.unmount()
})

test('band: on the terminal the state text truncates before the suffix (tiny: just +2); the minimal style adds it to its line', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  other(w, 'a')
  other(w, 'b')
  await sessions($)
  const wide = await mount($, 'terminal', { bodyColumns: 120 })
  const suffix = (await wide.find({ type: 'Text', text: '+2 warming elsewhere' })) as unknown as Node
  expect(suffix.props.dimColor).toBe(true)
  const row = (await wide.find({ key: 'ck-elsewhere' })) as unknown as Node
  expect(row.props.flexShrink).toBe(0)
  await wide.unmount()
  const tiny = await mount($, 'terminal', { bodyColumns: 50 })
  expect(await tiny.find({ type: 'Text', text: '+2' })).toBeDefined()
  expect(await tiny.find({ type: 'Text', text: '+2 warming elsewhere' })).toBeUndefined()
  await tiny.unmount()
  await setConfig($, 'cache-keeper.band', 'minimal')
  const min = await mount($, 'terminal')
  expect(await min.find({ type: 'Text', text: '● warm · +2 warming elsewhere' })).toBeDefined()
  await min.unmount()
})

test('band: pressing the chip opens the list in the pane', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  other(w, 'a')
  await sessions($)
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'ck-elsewhere' })
  expect(w.panes.opened).toEqual([{ id: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 }])
  await ui.unmount()
})

test('band: the minute scan updates the chip while a band is drawn, and does not look before one is', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  other(w, 'a')
  await w.clock.advance(2 * MINUTE)
  // nothing was drawn yet: nobody looked
  expect((await snap($)).elsewhere).toEqual([])
  const ui = await mount($, 'desktop')
  await w.clock.settle()
  expect((await snap($)).elsewhere.map(e => e.sessionId)).toEqual(['a'])
  expect(await ui.find({ key: 'ck-elsewhere' })).toBeDefined()
  other(w, 'b')
  await w.clock.advance(MINUTE)
  expect((await snap($)).elsewhere.map(e => e.sessionId).sort()).toEqual(['a', 'b'])
  // a session that stops being heard from drops out 12 minutes after its last write (a: written at START; b at START + 2 min, so still listed)
  await w.clock.advance(9 * MINUTE)
  expect((await snap($)).elsewhere.map(e => e.sessionId)).toEqual(['b'])
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// The pane: Warming elsewhere

const PANE = { title: 'cache-keeper', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 14 }, view: {} } as const
const pane = ($: Engine, surface: 'terminal' | 'desktop' | 'vscode') =>
  $.ui.mount({ plugin: 'cache-keeper', surface, component: 'Pane', requestId: 'cache-keeper', props: PANE })
const texts = async (ui: Awaited<ReturnType<typeof pane>>) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

for (const surface of ['terminal', 'desktop', 'vscode'] as const)
  test(`pane: Warming elsewhere lists the sessions with a Stop each; Stop all from two; a press shows stopping… until the file says it stopped (${surface})`, async ($, on) => {
    const w = world(on)
    await start($)
    const now = w.clock.now()
    let ui = await pane($, surface)
    expect(await texts(ui)).not.toContain('Warming in 2 other sessions')
    expect(await ui.find({ key: 'ck-stop-all' })).toBeUndefined()
    await ui.unmount()
    other(w, 'a', { label: 'Alpha' })
    ui = await pane($, surface)
    await w.clock.settle()
    expect(await texts(ui)).toContain('Warming in 1 other session')
    expect(await ui.find({ type: 'Button', key: 'ck-stop-a' })).toBeDefined()
    expect(await ui.find({ key: 'ck-stop-all' })).toBeUndefined()
    other(w, 'b', { label: 'Beta', seen: now - MINUTE })
    await w.clock.advance(MINUTE)
    expect(await texts(ui)).toContain('Warming in 2 other sessions')
    expect(await ui.find({ type: 'Button', key: 'ck-stop-all' })).toBeDefined()
    expect((await texts(ui)).filter(t => /^(Alpha|Beta) · /.test(t))).toHaveLength(2)
    await ui.press({ key: 'ck-stop-b' })
    await w.clock.settle()
    expect(stopFile(w, 'b')).toEqual({ at: START + MINUTE, by: SESSION_ID })
    expect(stopFile(w, 'a')).toBeNull()
    // Beta's row says stopping… and has no Stop button; Alpha keeps hers; Stop all is still there for the one left to ask
    expect((await texts(ui)).some(t => t.startsWith('Beta · ') && t.endsWith('stopping…'))).toBe(true)
    expect(await ui.find({ key: 'ck-stop-b' })).toBeUndefined()
    expect(await ui.find({ key: 'ck-stop-a' })).toBeDefined()
    await ui.press({ key: 'ck-stop-all' })
    await w.clock.settle()
    expect(stopFile(w, 'a')).not.toBeNull()
    // Beta reports it stopped: its row goes
    other(w, 'b', { warming: false })
    await w.clock.advance(MINUTE)
    expect((await texts(ui)).filter(t => t.startsWith('Beta'))).toHaveLength(0)
    await ui.unmount()
  })

test('pane: at most five rows, the rest named in a line pointing to /cache sessions', async ($, on) => {
  const w = world(on)
  await start($)
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) other(w, id, { label: `S-${id}` })
  await sessions($)
  const ui = await pane($, 'terminal')
  expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('ck-stop-') && b.key !== 'ck-stop-all')).toHaveLength(5)
  expect(await texts(ui)).toContain('+2 more: /cache sessions')
  await ui.unmount()
})
