// The settings pane (design.md §10, brief C/D): opened by /cache settings and the band's gear, one Select per setting
// applied to the session at once, Save as default through $.store pendingSave and one config.set per module reload.
import { test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  HOUR, MINUTE, OPUS, START, cache, expect, measure, prompt, setConfig, snap, start, turnUsage, world,
} from './world'
import type { World } from './world'

const SURFACES = ['terminal', 'desktop', 'vscode'] as const
type Surface = (typeof SURFACES)[number]
const PANE = { title: 'cache-keeper', isFocused: true, bodyColumns: 42, placement: 'dock', scroll: { offset: 0, bodyRows: 14 }, view: {} } as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} } as const

const pane = ($: Engine, surface: Surface = 'terminal') =>
  $.ui.mount({ plugin: 'cache-keeper', surface, component: 'Pane', requestId: 'cache-keeper', props: PANE })
type Mounted = Awaited<ReturnType<typeof pane>>

const select = async (ui: Mounted, key: string) => {
  const s = await ui.find({ type: 'Select', key })
  return s ? { label: s.props.label as string, value: s.props.value as string, options: s.props.options as { value: string; label: string }[] } : undefined
}
const pick = (ui: Mounted, key: string, value: string) => ui.select({ key, value })
const texts = async (ui: Mounted) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

const ROWS = [
  ['ck-keepFor', 'Keep warm for', '8h', ['off', '2h', '4h', '8h', '12h', 'forever']],
  ['ck-lead', 'Refresh before it expires', '5', ['2', '3', '5', '10', '15']],
  ['ck-minTokens', 'Skip chats smaller than', '30000', ['10000', '30000', '50000', '100000']],
  ['ck-weeklyGuard', 'Stop at weekly usage', '90', ['50', '75', '80', '90', '95', '100']],
  ['ck-upgradeTo1h', '1-hour cache for API keys', 'off', ['off', 'on']],
] as const

test('pane: /cache settings opens it with focus, Escape to close and 12 rows', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await cache($, 'settings')).text).toContain('Settings pane opened')
  expect(w.panes.opened).toEqual([{ id: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 }])
})

test('pane: /cache settings says so when the window has no room for it', async ($, on) => {
  world(on, { paneNotPlaced: true })
  await start($)
  expect((await cache($, 'settings')).text).toContain('no room')
})

test('pane: the terminal band gear opens the same pane', async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Text, {}, 'engine band') as never)
  await start($)
  await prompt($, w, 't1')
  const band = await $.ui.mount({ plugin: 'cache-keeper', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'ck-settings' })
  expect(w.panes.opened).toEqual([{ id: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 }])
})

for (const surface of SURFACES)
  test(`pane: one Select per setting, the footer and the buttons on ${surface}`, async ($, on) => {
    const w = world(on)
    await start($)
    let ui = await pane($, surface)
    for (const [key, label, value, options] of ROWS) {
      const s = await select(ui, key)
      expect(s, key).toEqual({ label, value, options: expect.any(Array) })
      expect(s?.options.map(o => o.value), key).toEqual(options)
    }
    // decluttered: one dim savings line until a rewrite was avoided, no status, totals or $0.00 rows
    const empty = 'No savings yet — they show when you return to a warm cache.'
    expect(await texts(ui)).toEqual([empty])
    // nothing differs from the saved defaults: no Save button (and no "Saved as default" text), Close is there
    expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'ck-close' })).toBeDefined()
    await ui.unmount()
    await prompt($, w, 't1')
    await w.clock.advance(55 * MINUTE)
    ui = await pane($, surface)
    // refreshes that avoided nothing are not "savings": still the one dim line, and never a $ figure
    expect(await texts(ui)).toEqual([empty])
    await ui.unmount()
    // a rewrite avoided: the figure bold, the session dim, still one line
    w.stored.set('allTime', { refreshes: 20, costUsd: 3.7, avoided: 4, grossUsd: 16.1, since: START })
    ui = await pane($, surface)
    expect(await texts(ui)).toEqual(['Saved $12.40', '· this session -$0.08'])
    expect((await ui.find({ type: 'Text', text: 'Saved $12.40' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: '· this session -$0.08' }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })

test('pane: no status line, totals or cold detail (they are in /cache status and /cache stats): the pane is savings, settings, footer', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'off')
  await w.clock.advance(2 * HOUR)
  const ui = await pane($)
  expect((await texts(ui)).some(t => /Cache cold|Warm|This session|All time|API list prices|Without cache-keeper/.test(t))).toBe(false)
  expect((await ui.findAll({ type: 'Select' })).length).toBe(5)
  expect(await ui.find({ key: 'ck-opt-band' })).toBeUndefined() // the band style is /config's alone
  expect((await ui.findAll({ type: 'Text' })).length).toBe(1)
  // the stats carry the breakdown and the footnote
  const stats = (await cache($, 'stats')).text ?? ''
  expect(stats).toContain('rewrites avoided $0.00 − refreshes $0.00')
  expect(stats).toContain('At API list prices. On a Pro/Max plan this is usage, not billing.')
})

test('probe removed: /cache modal is not a command, nothing asks a question dialog', async ($, on) => {
  const w = world(on)
  await start($)
  const r = (await cache($, 'modal')).text ?? ''
  expect(r).toContain('Usage')
  expect(r).not.toContain('dialog')
  expect(w.panes.opened).toEqual([])
})

test('pane: a Select applies to the session at once and reschedules', async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Text, {}, 'engine band') as never)
  await start($)
  await prompt($, w, 't1')
  const ui = await pane($)

  // lead: the next refresh moves from T+55m to T+50m
  expect((await snap($)).status).toEqual({ kind: 'scheduled', nextAt: START + 55 * MINUTE })
  await pick(ui, 'ck-lead', '10')
  expect((await snap($)).settings.leadMin).toBe(10)
  expect((await snap($)).status).toEqual({ kind: 'scheduled', nextAt: START + 50 * MINUTE })
  expect((await select(ui, 'ck-lead'))?.value).toBe('10')
  await w.clock.advance(50 * MINUTE)
  expect(w.forks).toHaveLength(1)

  // keepFor: a 2h window ends after the refreshes it needs
  await pick(ui, 'ck-keepFor', '2h')
  expect((await snap($)).settings.keepFor).toBe('2h')
  await w.clock.advance(2 * HOUR)
  expect((await snap($)).status).toMatchObject({ kind: 'done' })
  // ... and off is the person's stop
  await prompt($, w, 't2')
  await pick(ui, 'ck-keepFor', 'off')
  expect((await snap($)).status).toMatchObject({ kind: 'stopped', code: 'user-off' })
  await pick(ui, 'ck-keepFor', '8h')
  expect((await snap($)).status).toMatchObject({ kind: 'scheduled' })

  // minTokens: 50k is above this 400k prompt's floor... until it is raised past it
  await pick(ui, 'ck-minTokens', '100000')
  expect((await snap($)).settings.minTokens).toBe(100_000)
  expect((await snap($)).status).toMatchObject({ kind: 'scheduled' })
  await prompt($, w, 't3', turnUsage(OPUS, 49_000, 1_000))
  expect((await snap($)).status).toEqual({ kind: 'holding', reason: 'small' })
  await pick(ui, 'ck-minTokens', '30000')
  expect((await snap($)).status).toMatchObject({ kind: 'scheduled' })

  // weeklyGuard: the guard drops under the weekly figure and the chain stops
  await measure($, w, { fiveHour: 9, weekly: 60 })
  expect((await snap($)).status).toMatchObject({ kind: 'scheduled' })
  await pick(ui, 'ck-weeklyGuard', '50')
  expect((await snap($)).settings.weeklyGuard).toBe(50)
  expect((await snap($)).status).toMatchObject({ kind: 'stopped', code: 'weekly-guard' })
  await pick(ui, 'ck-weeklyGuard', '95')
  expect((await snap($)).status).toMatchObject({ kind: 'scheduled' })

  // band style (a /config row, not in the pane): the band redraws as minimal, then is gone
  const band = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'ck-band' })).toBeDefined()
  await setConfig($, 'cache-keeper.band', 'minimal')
  expect((await snap($)).settings.band).toBe('minimal')
  expect(await band.find({ key: 'ck-band' })).toBeUndefined()
  expect(await band.find({ text: '● warm' })).toBeDefined()
  await setConfig($, 'cache-keeper.band', 'off')
  expect(await band.find({ text: '● warm' })).toBeUndefined()
  expect(await band.find({ text: 'engine band' })).toBeDefined()
  await setConfig($, 'cache-keeper.band', 'full')

  // 1h on API key
  await pick(ui, 'ck-upgradeTo1h', 'on')
  expect((await snap($)).settings.upgradeTo1h).toBe(true)
  expect((await select(ui, 'ck-upgradeTo1h'))?.value).toBe('on')
})

test('pane: a value the session has that the row does not list is shown, and Save leaves it alone', async ($, on) => {
  world(on)
  await start($)
  await cache($, 'lead 7')
  const ui = await pane($)
  const lead = await select(ui, 'ck-lead')
  expect(lead?.value).toBe('7')
  expect(lead?.options.map(o => o.value)).toEqual(['2', '3', '5', '10', '15', '7'])
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined() // 7 cannot be saved: nothing to save
})

test('pane: Save as default appears when the session differs, and Close closes the pane', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await pane($)
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
  await pick(ui, 'ck-keepFor', '4h')
  expect((await ui.find({ key: 'ck-save' }))?.props.label).toBe('Save as default')
  await pick(ui, 'ck-keepFor', '8h')
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
  await ui.press({ key: 'ck-close' })
  expect(w.panes.closed).toEqual(['cache-keeper'])
})

const savedKeys = (w: World) => w.configSets.map(c => `${c.key}=${String(c.value)}`)
const pending = (w: World) => w.stored.get('pendingSave') as Record<string, string> | undefined

test('pane: Save writes every changed field to pendingSave and the first config.set; each reload writes the next', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await pane($)
  await pick(ui, 'ck-keepFor', '4h')
  await pick(ui, 'ck-lead', '10')
  await pick(ui, 'ck-upgradeTo1h', 'on')
  await ui.press({ key: 'ck-save' })
  // the whole set is parked, the first is written (the write reloads the module in a session)
  expect(pending(w)).toEqual({ keepFor: '4h', lead: '10', upgradeTo1h: 'on' })
  expect(savedKeys(w)).toEqual(['cache-keeper.keepFor=4h'])
  expect(w.toasts).toEqual([])
  // the reloaded module's session.start drops what the rows now show and writes the next
  await start($, false)
  expect(pending(w)).toEqual({ lead: '10', upgradeTo1h: 'on' })
  expect(savedKeys(w)).toEqual(['cache-keeper.keepFor=4h', 'cache-keeper.lead=10'])
  await start($, false)
  expect(pending(w)).toEqual({ upgradeTo1h: 'on' })
  expect(savedKeys(w)).toEqual(['cache-keeper.keepFor=4h', 'cache-keeper.lead=10', 'cache-keeper.upgradeTo1h=on'])
  expect(w.toasts).toEqual([])
  await start($, false)
  expect(pending(w)).toEqual({})
  expect(w.toasts).toEqual(['Settings saved'])
  // the session values survive all of it
  expect((await snap($)).settings).toMatchObject({ keepFor: '4h', leadMin: 10, upgradeTo1h: true })
  // nothing pending: a start is quiet
  await start($, false)
  expect(w.toasts).toEqual(['Settings saved'])
  expect(savedKeys(w)).toHaveLength(3)
})

test('pane: a start while nothing is pending writes nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await start($)
  expect(w.configSets).toEqual([])
  expect(w.toasts).toEqual([])
})

test('pane: if no reload follows a write, the next field is written after a short wait', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await pane($)
  await pick(ui, 'ck-keepFor', '4h')
  await pick(ui, 'ck-minTokens', '50000')
  await ui.press({ key: 'ck-save' })
  expect(savedKeys(w)).toEqual(['cache-keeper.keepFor=4h'])
  await w.clock.advance(2000)
  expect(savedKeys(w)).toHaveLength(1)
  await w.clock.advance(1000)
  expect(savedKeys(w)).toEqual(['cache-keeper.keepFor=4h', 'cache-keeper.minTokens=50000'])
  await w.clock.advance(3000)
  expect(pending(w)).toEqual({})
  expect(w.toasts).toEqual(['Settings saved'])
})

test('pane: a denied config.set keeps the values in savedDefaults, which win over the options', async ($, on) => {
  const w = world(on, { denyConfig: 'managed by policy' })
  await start($)
  let ui = await pane($)
  await pick(ui, 'ck-keepFor', '4h')
  await pick(ui, 'ck-minTokens', '50000')
  await ui.press({ key: 'ck-save' })
  expect(w.configSets).toEqual([])
  expect(pending(w)).toEqual({})
  expect(w.stored.get('savedDefaults')).toEqual({ keepFor: '4h', minTokens: '50000' })
  expect(w.toasts).toEqual(['Settings saved in cache-keeper (the /config row refused: managed by policy)'])
  // the next start merges them over the options: they are the saved defaults now, so nothing differs and /cache on returns to 4h
  await start($)
  await ui.unmount()
  ui = await pane($)
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
  await cache($, 'off')
  expect((await cache($, 'on')).text).toContain('4h')
  // a row the person then changes in /config wins over a value kept for it
  w.configDeny.reason = undefined
  await setConfig($, 'cache-keeper.keepFor', '12h')
  expect(w.stored.get('savedDefaults')).toEqual({ minTokens: '50000' })
})

test('pane: a write that goes through clears the value kept for its row (our own config.set is not seen by our hooks)', async ($, on) => {
  const w = world(on)
  w.stored.set('savedDefaults', { keepFor: '4h', minTokens: '50000' })
  await start($)
  const ui = await pane($)
  await pick(ui, 'ck-keepFor', '12h')
  await ui.press({ key: 'ck-save' })
  expect(savedKeys(w)).toEqual(['cache-keeper.keepFor=12h'])
  expect(w.stored.get('savedDefaults')).toEqual({ minTokens: '50000' })
  // a refused write leaves what was kept
  w.configDeny.reason = 'managed by policy'
  await pick(ui, 'ck-minTokens', '30000')
  await ui.press({ key: 'ck-save' })
  expect(w.stored.get('savedDefaults')).toMatchObject({ minTokens: '30000' })
  // /cache keep --save is the same write
  w.configDeny.reason = undefined
  w.stored.set('savedDefaults', { keepFor: '4h' })
  await cache($, 'keep 12h --save')
  expect(w.stored.get('savedDefaults')).toEqual({})
  w.configDeny.reason = 'managed by policy'
  w.stored.set('savedDefaults', { keepFor: '4h' })
  await cache($, 'keep 2h --save')
  expect(w.stored.get('savedDefaults')).toEqual({ keepFor: '4h' })
})

test('pane: kept defaults also seed the session settings at its first start', { options: { keepFor: '2h' } }, async ($, on) => {
  const w = world(on)
  w.stored.set('savedDefaults', { keepFor: '12h', band: 'minimal' })
  await start($)
  expect((await snap($)).settings).toMatchObject({ keepFor: '12h', band: 'minimal', leadMin: 5 })
})

test('pane: a field that is already the saved default is not written again', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await pane($)
  await pick(ui, 'ck-lead', '10')
  await pick(ui, 'ck-lead', '5')
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
  await pick(ui, 'ck-lead', '3')
  w.stored.set('pendingSave', { lead: '3', minTokens: '50000' })
  // a leftover from an earlier save: lead 3 is already shown by the row, minTokens is next
  w.configSets.push({ key: 'cache-keeper.lead', value: '3' })
  await start($)
  expect(savedKeys(w)).toEqual(['cache-keeper.lead=3', 'cache-keeper.minTokens=50000'])
  await start($)
  expect(pending(w)).toEqual({})
})
