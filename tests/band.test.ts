// The band (design.md §9, brief 2b): AbovePrompt mounted on the terminal and the desktop for every state; the copy table, the
// responsive tiers, the one toggle and its click target, the hover card, the self-ticking countdown (no minute redraws on the
// desktop), the cooling alert, and the in-band settings sheet with its savings and the Pane fallback.
import { test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PALETTE } from '../hooks/art'
import type { ArtState } from '../hooks/art'
import { OPTIONS, appearanceOf, fmtClock, savingsOf } from '../hooks/policy'
import type { Settings } from '../types'
import { CELL_PX, CHIP_CELLS, CONTROL_PX, GEAR_CELLS, GUTTER_CELLS, HELP, INLINE_COLUMNS, INLINE_CONTROL_PX, LABEL_CELLS, MARK_CELLS, MARK_PX, NAMES, NBSP_PX, SHEET_TOGGLE_CELLS, STOP_CELLS, TOGGLE_CELLS, TWO_COLUMNS, cellsPx, hitLabel, segCells, sheetBlocks, sheetFits, sheetModel, sheetRows } from '../hooks/view'
import type { SessionKind } from '../hooks/view'
import {
  HOUR, MINUTE, OPUS, START, apiError, cache, expect, measure, prompt, setConfig, snap, start, turnUsage, world,
} from './world'
import type { World } from './world'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
type BandProps = { hasSurvey: boolean; isWorking: boolean; maxRows: number; bodyColumns: number; scroll: { offset: number; bodyRows: number }; view: Record<string, never> }
const PROPS: BandProps = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} }
/** Rows enough for the sheet at any width. */
const TALL = 40

/** The engine's own band, beneath ours. */
const engineBand = (on: Parameters<typeof world>[0]) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine band') as never
  })

const mount = ($: Engine, surface: Surface, extra: Partial<BandProps> = {}) =>
  $.ui.mount({ plugin: 'cache-keeper', surface, component: 'AbovePrompt', props: { ...PROPS, ...extra } })
type Mounted = Awaited<ReturnType<typeof mount>>

type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[]; hover?: unknown }
// A Text's own children (the bold state word, then the rest) read as one run; boxes read as words apart.
const flat = (n: Node | string): string =>
  typeof n === 'string' ? n : n.type === 'Svg' ? String(n.props.alt) : (n.children ?? []).map(flat).filter(Boolean).join(n.type === 'Text' ? '' : ' ')

const buttons = async (ui: Mounted) => (await ui.findAll({ type: 'Button' })).map(b => ({ key: b.key, label: b.props.label as string, hotkey: b.props.hotkey as string | undefined }))
const svgAlts = async (ui: Mounted) => (await ui.findAll({ type: 'Svg' })).map(s => s.props.alt as string)
/** The desktop line as the person reads it: the parts of the line (not the hover card), the countdown image by its label. */
const deskLine = async (ui: Mounted): Promise<string> => {
  const line = (await ui.find({ key: 'ck-line' })) as unknown as Node | undefined
  return line ? flat((line.children ?? [])[0] ?? '') : ''
}
const card = async (ui: Mounted): Promise<string> => {
  const line = (await ui.find({ key: 'ck-line' })) as unknown as Node | undefined
  return line ? flat((line.children ?? [])[1] ?? '') : ''
}

type Scenario = {
  name: string
  art: ArtState
  symbol: string
  /** The line on the terminal (a countdown there is fmtIn's). */
  text: string
  /** The desktop line when its countdown (minutes only) reads differently. */
  desk?: string
  on?: boolean
  options?: Record<string, string>
  world?: Parameters<typeof world>[1]
  setup: ($: Engine, w: World) => Promise<void | (() => Promise<void>)>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'scheduled', art: 'warm', symbol: '●', text: 'Warm · next refresh in 55m',
    setup: ($, w) => prompt($, w, 't1'),
  },
  {
    name: 'refreshing', art: 'refreshing', symbol: '◌', text: 'Refreshing…',
    setup: async ($, w) => {
      await prompt($, w, 't1')
      const release = w.holdFork()
      await w.clock.advance(55 * MINUTE)
      return async () => {
        release()
        await w.clock.settle()
      }
    },
  },
  {
    name: 'retrying', art: 'error', symbol: '◌', text: 'Refresh failed (overloaded) · retrying in 30s', desk: 'Refresh failed (overloaded) · retrying in 1m',
    setup: async ($, w) => {
      await prompt($, w, 't1')
      w.replies.push(apiError('overloaded', 529))
      await w.clock.advance(55 * MINUTE)
    },
  },
  {
    name: 'off, cache warm', art: 'off', symbol: '○', text: 'Auto-refresh off · cache expires in 1h00m', on: false,
    setup: async ($, w) => {
      await prompt($, w, 't1')
      await cache($, 'off')
    },
  },
  {
    name: 'off and cooling (10 minutes or less left)', art: 'cooling', symbol: '◐', text: 'Auto-refresh off · cache expires in 8m', on: false,
    setup: async ($, w) => {
      await prompt($, w, 't1')
      await cache($, 'off')
      await w.clock.advance(52 * MINUTE)
    },
  },
  {
    name: 'cold', art: 'cold', symbol: '❄', text: 'Cache cold · next message rewrites 400k (~$3.20)', on: false,
    setup: async ($, w) => {
      await prompt($, w, 't1')
      await cache($, 'off')
      await w.clock.advance(2 * HOUR)
    },
  },
  {
    name: 'stopped (weekly guard)', art: 'error', symbol: '■', text: 'Stopped: weekly usage hit the 90% guard · cache expires in 1h00m',
    setup: async ($, w) => {
      await prompt($, w, 't1')
      await measure($, w, { fiveHour: 9, weekly: 91 })
    },
  },
  {
    name: 'done', art: 'dim', symbol: '○', text: 'Kept warm for 2h · auto-refresh ended · cache expires in 50m',
    options: { keepFor: '2h' },
    setup: async ($, w) => {
      await prompt($, w, 't1')
      await w.clock.advance(2 * HOUR)
    },
  },
  {
    name: 'holding (small context)', art: 'dim', symbol: '○', text: 'Context 10k is below the 30k minimum · not kept warm',
    setup: ($, w) => prompt($, w, 't1', turnUsage(OPUS, 9_000, 1_000)),
  },
  {
    name: '5m idle', art: 'dim', symbol: '○', text: '5-minute cache · refreshed only while Claude works',
    world: { authKind: 'api-key', rateLimits: [] },
    setup: ($, w) => prompt($, w, 't1'),
  },
]

for (const sc of SCENARIOS)
  test(`band: ${sc.name} on terminal and desktop`, { options: sc.options ?? {} }, async ($, on) => {
    const w = world(on, sc.world)
    engineBand(on)
    await start($)
    const after = await sc.setup($, w)
    const on_ = sc.on ?? true
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: sc.text }), 'terminal text').toBeDefined()
        expect(await ui.find({ type: 'Text', text: sc.symbol }), 'terminal symbol Text').toBeDefined()
      } else {
        expect(await deskLine(ui), 'desktop line').toBe(sc.desk ?? sc.text)
        expect(await ui.find({ type: 'Text', text: sc.symbol }), 'the dot is an Svg on desktop').toBeUndefined()
      }
      // the keep chip (only while warming is on), the toggle and the gear: no Pause, no word on the toggle
      const got = await buttons(ui)
      expect(got.map(b => b.key), surface).toEqual(on_ ? ['ck-keep', 'ck-toggle', 'ck-settings'] : ['ck-toggle', 'ck-settings'])
      if (surface === 'terminal') {
        expect(got.map(b => [b.label, b.hotkey])).toEqual([...(on_ ? [[`keep ${sc.options?.keepFor ?? '8h'}`, 'k']] : []), [on_ ? 'on' : 'off', 'o'], ['settings', 's']])
        expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
      } else {
        // the controls carry no text: blank labels, the drawn switch says on or off in its alt
        for (const b of got) expect(b.label, b.key).toMatch(/^ +$/)
        const alts = await svgAlts(ui)
        expect(alts).toContain(`cache ${sc.art} art`)
        expect(alts).toContain(`cache ${sc.art}`)
        expect(alts).toContain(on_ ? 'Auto-refresh on' : 'Auto-refresh off')
        expect(alts.some(a => a.startsWith('Keep warm for'))).toBe(on_)
        expect(alts).toContain('Settings')
        expect(alts.every(a => a.length > 0)).toBe(true)
        for (const s of await ui.findAll({ type: 'Svg' })) expect(typeof s.props.width === 'number' && typeof s.props.height === 'number', String(s.props.alt)).toBe(true)
        // colours come from the state's palette
        expect((await ui.find({ key: 'ck-band' }))?.props).toMatchObject({ backgroundColor: PALETTE.dark[sc.art].bg, borderColor: PALETTE.dark[sc.art].edge })
      }
      // the engine's own band is always drawn, beneath ours
      const root = (await ui.drawn()) as { children: unknown[] }
      expect(root.children.at(-1) !== undefined && JSON.stringify(root.children.at(-1))).toContain('engine band')
      await ui.unmount()
    }
    await after?.()
  })

test('band: nothing to say before the first request: only the engine band', async ($, on) => {
  world(on)
  engineBand(on)
  await start($)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    expect(await ui.find({ key: 'ck-band' })).toBeUndefined()
    expect(await buttons(ui)).toEqual([])
    await ui.unmount()
  }
})

test('band: a resumed cold session shows the cold line before any request', async ($, on) => {
  world(on)
  engineBand(on)
  await start($)
  await $.classic.SessionStart({ source: 'resume', context_tokens: 408_000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 3.26 } as never)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: 'Cache cold · next message rewrites 408k (~$3.26)' })).toBeDefined()
    await ui.unmount()
  }
})

test('band: a survey leaves the slot to the engine; minimal is one dim line; off is not drawn', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  for (const surface of SURFACES) {
    let ui = await mount($, surface, { hasSurvey: true })
    expect(await ui.find({ text: 'Warm' })).toBeUndefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    expect(await buttons(ui)).toEqual([])
    await ui.unmount()
    ui = await mount($, surface)
    expect(await ui.find({ text: 'Warm' })).toBeDefined()
    await ui.unmount()
  }
  await setConfig($, 'cache-keeper.band', 'minimal')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const line = await ui.find({ type: 'Text', text: '● warm' })
    expect(line, `${surface} minimal line`).toBeDefined()
    expect(line?.props.dimColor).toBe(true)
    expect(await buttons(ui)).toEqual([])
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    expect(await ui.find({ key: 'ck-band' })).toBeUndefined()
    const root = (await ui.drawn()) as { children: unknown[] }
    expect(JSON.stringify(root.children.at(-1))).toContain('engine band')
    await ui.unmount()
  }
  await setConfig($, 'cache-keeper.band', 'off')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: 'Warm' })).toBeUndefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

// ---------------------------------------------------------------------------
// The toggle

test('band: the toggle stops warming for the session and restores the saved default; there is no paused flag', { options: { keepFor: '4h' } }, async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'ck-toggle' })
    let s = await snap($)
    expect(s.settings.keepFor).toBe('off')
    expect(s.status).toMatchObject({ kind: 'stopped', code: 'user-off' })
    expect('paused' in s).toBe(false)
    expect(await ui.find({ key: 'ck-pause' })).toBeUndefined()
    expect(await ui.find({ key: 'ck-keep' })).toBeUndefined()
    if (surface === 'desktop') {
      expect(await deskLine(ui)).toBe('Auto-refresh off · cache expires in 1h00m')
      expect(await svgAlts(ui)).toContain('Auto-refresh off')
    } else {
      expect(await ui.find({ type: 'Text', text: 'Auto-refresh off · cache expires in 1h00m' })).toBeDefined()
      expect((await ui.find({ key: 'ck-toggle' }))?.props.label).toBe('off')
    }
    expect(w.appended).toHaveLength(0) // no notice for the person's own off
    await ui.press({ key: 'ck-toggle' })
    s = await snap($)
    expect(s.settings.keepFor).toBe('4h')
    expect(s.status).toMatchObject({ kind: 'scheduled' })
    if (surface === 'desktop') expect(await svgAlts(ui)).toContain('Auto-refresh on')
    else expect((await ui.find({ key: 'ck-toggle' }))?.props.label).toBe('on')
    await ui.unmount()
  }
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
})

test('band: off then on keeps the window the keep chip chose', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'ck-keep' }) // 8h → 12h
  await ui.press({ key: 'ck-keep' }) // 12h → forever
  expect((await snap($)).settings.keepFor).toBe('forever')
  await ui.press({ key: 'ck-toggle' })
  expect((await snap($)).settings.keepFor).toBe('off')
  await ui.press({ key: 'ck-toggle' })
  expect((await snap($)).settings.keepFor).toBe('forever')
})

test('band: the toggle is on again at 8h when the saved default is off', { options: { keepFor: 'off' } }, async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await mount($, 'terminal')
  expect((await ui.find({ key: 'ck-toggle' }))?.props.label).toBe('off')
  await ui.press({ key: 'ck-toggle' })
  expect((await snap($)).settings.keepFor).toBe('8h')
})

test('band: the window notice is written once however often /cache keep leaves and re-enters done', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'keep 2h')
  await w.clock.advance(2 * HOUR)
  expect((await snap($)).status).toMatchObject({ kind: 'done' })
  expect(w.appended.filter(t => t.includes('window ended'))).toHaveLength(1)
  await cache($, 'keep 4h')
  expect((await snap($)).status.kind).not.toBe('done')
  await cache($, 'keep 2h')
  expect((await snap($)).status).toMatchObject({ kind: 'done' })
  expect(w.appended.filter(t => t.includes('window ended'))).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Layout and click targets (desktop)

test('band: the controls are in the flow at the right end, the line gives way to them: no absolute action layer', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await mount($, 'desktop')
  const band = await ui.find({ key: 'ck-band' })
  expect(band?.props).toMatchObject({ position: 'relative', overflow: 'hidden', borderStyle: 'round' })
  // row: dot, line, controls: the controls last, never shrunk and never taken out of the flow
  const row = (await ui.find({ key: 'ck-row' })) as unknown as Node
  const keys = (row.children as Node[]).map(c => String(c.props.key ?? c.type))
  expect(keys).toEqual(['Box', 'ck-line', 'ck-controls'])
  const controls = await ui.find({ key: 'ck-controls' })
  expect(controls?.props).toMatchObject({ position: 'relative', flexShrink: 0, flexDirection: 'row' })
  expect(controls?.props.position).not.toBe('absolute')
  // an empty absolute child makes the box positioned, so it paints over the art
  expect(controls?.children[0]).toMatchObject({ type: 'Box', props: { position: 'absolute', top: 0, left: 0 } })
  expect(await ui.find({ key: 'ck-actions' })).toBeUndefined()
  // the line is the one that shrinks: first, to nothing, clipped
  const line = await ui.find({ key: 'ck-line' })
  expect(line?.props).toMatchObject({ flexGrow: 1, flexShrink: 1000, minWidth: 0, overflow: 'hidden' })
  expect((await ui.find({ type: 'Text', text: 'Warm · next refresh in' }))?.props.wrap).toBe('truncate')
  // the art stays behind in absolute layers
  for (const k of ['ck-warm-art', 'ck-warm-rim']) expect((await ui.find({ key: k }))?.props.position, k).toBe('absolute')
  await ui.unmount()
})

for (const [id, cells] of [['ck-keep', CHIP_CELLS], ['ck-toggle', TOGGLE_CELLS], ['ck-settings', GEAR_CELLS]] as const)
  test(`band: the ${id === 'ck-toggle' ? 'toggle' : id === 'ck-keep' ? 'keep chip' : 'gear'} is a drawn Svg exactly ${cells} cells wide with a blank Button over all of it, clipped to the box`, async ($, on) => {
    const w = world(on)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    const ui = await mount($, 'desktop')
    const box = (await ui.find({ key: `${id}-box` })) as unknown as Node
    expect(box.props).toMatchObject({ position: 'relative', width: cells, height: 1, flexShrink: 0 }) // a whole row high
    // the Svg is in the flow and exactly the box wide; the Button's layer is later, absolute, over the whole box
    const [svg, layer] = box.children as Node[]
    expect(svg).toMatchObject({ type: 'Svg', props: { width: cellsPx(cells) } })
    expect(cellsPx(cells)).toBeLessThanOrEqual(cells * CELL_PX)
    expect(layer?.props).toMatchObject({ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, overflow: 'hidden', justifyContent: 'center' })
    // the label: no-break spaces (one is ~2.6 px, not a cell), far more than the box needs, so every point of it hits the Button
    const label = (await ui.find({ key: id }))?.props.label as string
    expect(label).toMatch(/^ +$/)
    expect(label.length * NBSP_PX).toBeGreaterThanOrEqual(cellsPx(cells) * 1.5)
    expect(JSON.stringify(layer)).toContain('"plain":true')
    await ui.unmount()
  })

test('band: the hover card is an absolute box over the line, same background, hidden until the pointer is on the line', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE) // one refresh: kept 1x
  const ui = await mount($, 'desktop')
  const line = (await ui.find({ key: 'ck-line' })) as unknown as Node
  expect(line.props.position).toBe('relative') // positioned and keyed (the hover scope) and visible
  const cardBox = (line.children as Node[])[1]!
  expect(cardBox.props).toMatchObject({ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, display: 'none', backgroundColor: PALETTE.dark.warm.bg })
  expect(cardBox.hover).toEqual({ display: 'flex' })
  expect(cardBox.props.key).toBeUndefined() // the scope is the keyed line, which stays visible
  expect(await card(ui)).toBe(`Cache expires ${fmtClock(START + 115 * MINUTE)} · in 1h00m · kept 1× ($0.08)`)
  expect(await deskLine(ui)).toBe('Warm · next refresh in 55m')
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// Responsive tiers

test('band: tiers by columns (40, 55, 70, 90, 120, 200): text never runs under the controls and the controls are always there', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const tiers: [number, string][] = [
    [40, '55m'], [55, '55m'], [59, '55m'], [60, 'Warm · refresh 55m'], [70, 'Warm · refresh 55m'], [89, 'Warm · refresh 55m'],
    [90, 'Warm · next refresh in 55m'], [120, 'Warm · next refresh in 55m'], [200, 'Warm · next refresh in 55m'],
  ]
  for (const [columns, text] of tiers)
    for (const surface of SURFACES) {
      const ui = await mount($, surface, { bodyColumns: columns })
      expect((await buttons(ui)).map(b => b.key), `${surface} ${columns}`).toEqual(columns >= 60 ? ['ck-keep', 'ck-toggle', 'ck-settings'] : ['ck-toggle', 'ck-settings'])
      if (surface === 'desktop') {
        expect(await deskLine(ui), `desktop ${columns}`).toBe(text)
        // the symbol and the controls are always drawn; the line is the box that gives way
        expect(await ui.find({ key: 'ck-controls' })).toBeDefined()
        expect((await svgAlts(ui)).filter(a => a === 'cache warm' || a === 'Auto-refresh on' || a === 'Settings')).toHaveLength(3)
        expect((await ui.find({ key: 'ck-controls' }))?.props.flexShrink).toBe(0)
        expect((await ui.find({ key: 'ck-line' }))?.props.flexShrink).toBe(1000)
      } else {
        // the terminal's countdown is fmtIn's, the same minutes
        expect(await ui.find({ type: 'Text', text }), `terminal ${columns}`).toBeDefined()
      }
      await ui.unmount()
    }
  // the other copy has its tiers too: off, cold, refreshing
  await cache($, 'off')
  const ui = await mount($, 'desktop', { bodyColumns: 70 })
  expect(await deskLine(ui)).toBe('Off · expires 1h00m')
  await ui.unmount()
  const tiny = await mount($, 'desktop', { bodyColumns: 40 })
  expect(await deskLine(tiny)).toBe('off 1h00m')
  await tiny.unmount()
  await w.clock.advance(2 * HOUR)
  for (const [columns, text] of [[40, 'cold'], [70, 'Cold · rewrite 400k ~$3.20'], [120, 'Cache cold · next message rewrites 400k (~$3.20)']] as const) {
    const c = await mount($, 'desktop', { bodyColumns: columns })
    expect(await deskLine(c), `cold ${columns}`).toBe(text)
    await c.unmount()
  }
})

// ---------------------------------------------------------------------------
// Motion, redraws and the cooling alert

test('band: looping art is phase-locked to the clock at each draw', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const delays = async () => {
    const ui = await mount($, 'desktop')
    const out = (await ui.findAll({ type: 'Svg' })).map(s => /calc\(var\(--o,0s\) - ([\d.]+)s\)/.exec(String(s.props.source))?.[1]).filter(Boolean)
    const embers = (await ui.findAll({ type: 'Svg' })).flatMap(s => [...String(s.props.source).matchAll(/animation:up [\d.]+s linear (-[\d.]+)s/g)].map(m => m[1]))
    await ui.unmount()
    return { out, embers }
  }
  const a = await delays()
  expect(a.out.length).toBeGreaterThan(0)
  expect(new Set(a.out)).toEqual(new Set(['1000.000']))
  expect(new Set(a.embers).size).toBeGreaterThan(4)
  await w.clock.advance(60_000)
  const b = await delays()
  expect(new Set(b.out)).toEqual(new Set(['1060.000']))
  expect(b.embers).not.toEqual(a.embers)
})

test('band: the full-width overlays are drawn at the band width, never narrower than 760 px', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  for (const [columns, px] of [[60, 760], [120, 948], [200, 1580]] as const) {
    const ui = await mount($, 'desktop', { bodyColumns: columns })
    const rim = (await ui.findAll({ type: 'Svg' })).find(s => String(s.props.alt).endsWith('rim'))
    expect(rim?.props).toMatchObject({ width: px, height: 37 })
    await ui.unmount()
  }
})

test('band: the desktop is not redrawn each minute (the countdown ticks in its image); the terminal is', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const d = await mount($, 'desktop')
  await w.clock.settle() // records the surface after the draw
  w.invalidations.length = 0
  await w.clock.advance(20 * MINUTE)
  expect(w.invalidations).toEqual([])
  // the image still says what the time is: drawn at +0, its frames carry the minutes
  const clock = (await d.findAll({ type: 'Svg' })).find(s => String(s.props.source).includes('animation:f 1s step-end 1'))
  expect(clock?.props.alt).toBe('55m')
  expect(String(clock?.props.source)).toContain('animation-delay:0s;animation-duration:30s">55m</text>')
  expect(String(clock?.props.source)).toContain('>1m</text>')
  await d.unmount()
})

test('band: a terminal band is redrawn each minute', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const t = await mount($, 'terminal')
  await w.clock.settle()
  w.invalidations.length = 0
  await w.clock.advance(3 * MINUTE)
  expect(w.invalidations.length).toBeGreaterThanOrEqual(3)
  await t.unmount()
})

test('band: one redraw when a cache nothing refreshes starts cooling and one when it expires; none while it is kept', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await mount($, 'desktop')
  await w.clock.settle()
  w.invalidations.length = 0
  // kept warm for 3 refreshes: nothing to redraw
  await w.clock.advance(3 * HOUR)
  expect(w.invalidations).toEqual([])
  await ui.unmount()
  // off with the cache warm: cooling at 10 minutes left, cold at expiry
  await prompt($, w, 't2')
  const t2 = w.clock.now() - START
  await cache($, 'off')
  const d = await mount($, 'desktop')
  await w.clock.settle()
  w.invalidations.length = 0
  expect(await svgAlts(d)).toContain('cache off art')
  await d.unmount()
  // (a redraw is the app asking again: a fresh mount is what it draws)
  const look = async () => {
    const m = await mount($, 'desktop')
    const out = [(await svgAlts(m)).find(a => a.endsWith(' art')), await deskLine(m)]
    await m.unmount()
    return out
  }
  await w.clock.advance(49 * MINUTE)
  expect(w.invalidations).toEqual([])
  expect(await look()).toEqual(['cache off art', 'Auto-refresh off · cache expires in 11m'])
  await w.clock.advance(1 * MINUTE)
  expect(w.invalidations).toEqual([t2 + 50 * MINUTE])
  expect(await look()).toEqual(['cache cooling art', 'Auto-refresh off · cache expires in 10m'])
  await w.clock.advance(10 * MINUTE + 1)
  expect(w.invalidations).toEqual([t2 + 50 * MINUTE, t2 + 60 * MINUTE + 1])
  const [art, text] = await look()
  expect(art).toBe('cache cold art')
  expect(text).toContain('Cache cold')
  await w.clock.advance(HOUR)
  expect(w.invalidations).toHaveLength(2)
})

test('band: cooling after a window ends, and an error stop, are alerted in their own colours', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'keep 2h')
  await w.clock.advance(2 * HOUR) // done; the last refresh was at 110m: cache expires at 170m
  let ui = await mount($, 'desktop')
  expect(await svgAlts(ui)).toContain('cache dim art')
  await ui.unmount()
  await w.clock.advance(41 * MINUTE) // 161m: 9 minutes left
  ui = await mount($, 'desktop')
  expect(await svgAlts(ui)).toContain('cache cooling art')
  expect((await ui.find({ key: 'ck-band' }))?.props).toMatchObject({ backgroundColor: PALETTE.dark.cooling.bg, borderColor: PALETTE.dark.cooling.edge })
  expect((await ui.find({ type: 'Text', text: 'Kept warm for 2h · auto-refresh ended · cache expires in' }))?.props.color).toBe(PALETTE.dark.cooling.text)
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// Themes

test('theme: the band follows the app theme (config row `theme`, light when it starts with light)', async ($, on) => {
  const w = world(on, { theme: 'light-daltonized' })
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const bg = async (surface: Surface = 'desktop') => {
    const ui = await mount($, surface)
    const out = (await ui.find({ key: 'ck-band' }))?.props.backgroundColor
    await ui.unmount()
    return out
  }
  expect((await snap($)).light).toBe(true)
  expect(await bg()).toBe(PALETTE.light.warm.bg)
  // a /config change of the theme
  w.theme.value = 'dark'
  await setConfig($, 'theme', 'dark')
  expect((await snap($)).light).toBe(false)
  expect(await bg()).toBe(PALETTE.dark.warm.bg)
  // a change the config hook never saw is picked up by the minute tick
  w.theme.value = 'light'
  await w.clock.advance(30_000)
  expect(await bg()).toBe(PALETTE.dark.warm.bg)
  await w.clock.advance(30_000)
  expect(await bg()).toBe(PALETTE.light.warm.bg)
})

const APP_CONFIG = '/home/t/Library/Application Support/Claude/config.json'

test('theme: appearanceOf: the row first (light, dark), then the app mode, then the OS; a probe that could not run reads as dark; undecided until the OS is asked', () => {
  // an explicit row wins over everything
  expect(appearanceOf({ themeRow: 'light', appMode: 'dark', os: 'Dark' })).toBe('light')
  expect(appearanceOf({ themeRow: 'light-daltonized', os: 'Dark' })).toBe('light')
  expect(appearanceOf({ themeRow: 'light-ansi' })).toBe('light')
  expect(appearanceOf({ themeRow: 'dark', appMode: 'light', os: 'Light' })).toBe('dark')
  expect(appearanceOf({ themeRow: 'dark-ansi' })).toBe('dark')
  // auto, system, absent, anything else: the app's mode when it is light or dark
  for (const themeRow of ['auto', 'system', undefined, null, 42, '', 'sepia']) {
    expect(appearanceOf({ themeRow, appMode: 'light', os: 'Dark' }), String(themeRow)).toBe('light')
    expect(appearanceOf({ themeRow, appMode: 'dark', os: 'Light' }), String(themeRow)).toBe('dark')
  }
  // else the OS: Dark is dark, Light (the key is absent) is light, a probe that could not run is dark
  for (const appMode of [undefined, null, 'system', 'auto', 'x']) {
    expect(appearanceOf({ themeRow: 'auto', appMode, os: 'Dark' }), String(appMode)).toBe('dark')
    expect(appearanceOf({ themeRow: 'auto', appMode, os: 'Light' }), String(appMode)).toBe('light')
    expect(appearanceOf({ themeRow: 'auto', appMode, os: null }), String(appMode)).toBe('dark')
    // not asked yet: undecided
    expect(appearanceOf({ themeRow: 'auto', appMode }), String(appMode)).toBeUndefined()
  }
})

test('theme: under `auto` the desktop app\'s own mode decides, then the OS; an explicit theme row never reads either', async ($, on) => {
  const w = world(on, { theme: 'auto', os: 'Dark' })
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const bg = async () => {
    const ui = await mount($, 'desktop')
    const out = (await ui.find({ key: 'ck-band' }))?.props.backgroundColor
    await ui.unmount()
    return out
  }
  const debug = async () => ((await cache($, 'debug')).text ?? '').split('\n').find(l => l.startsWith('theme:'))
  const set = async (row: string) => {
    w.theme.value = row
    await setConfig($, 'theme', row)
  }
  // no app file: the OS says Dark
  expect(await debug()).toBe('theme: auto · app: - · os: Dark → dark')
  expect(w.probes).toEqual([['defaults', 'read', '-g', 'AppleInterfaceStyle']])
  expect(await bg()).toBe(PALETTE.dark.warm.bg)
  // the OS in light mode: `defaults` exits 1 (no AppleInterfaceStyle)
  w.os.value = 'Light'
  await set('auto')
  expect(await debug()).toBe('theme: auto · app: - · os: Light → light')
  expect((await snap($)).light).toBe(true)
  expect(await bg()).toBe(PALETTE.light.warm.bg)
  // the app's own mode, light or dark, decides without asking the OS
  const probes = w.probes.length
  w.files.set(APP_CONFIG, JSON.stringify({ userThemeMode: 'dark', other: 1 }))
  await set('system')
  expect(await debug()).toBe('theme: system · app: dark · os: - → dark')
  expect(await bg()).toBe(PALETTE.dark.warm.bg)
  w.files.set(APP_CONFIG, JSON.stringify({ userThemeMode: 'light' }))
  await set('auto')
  expect(await debug()).toBe('theme: auto · app: light · os: - → light')
  expect(await bg()).toBe(PALETTE.light.warm.bg)
  expect(w.probes.length).toBe(probes)
  // `system` in the app file is no answer: the OS is asked again; so is a file that is not JSON
  w.os.value = 'Dark'
  w.files.set(APP_CONFIG, JSON.stringify({ userThemeMode: 'system' }))
  await set('auto')
  expect(await debug()).toBe('theme: auto · app: system · os: Dark → dark')
  w.files.set(APP_CONFIG, '{ not json')
  w.os.value = 'Light'
  await set('auto')
  expect(await debug()).toBe('theme: auto · app: - · os: Light → light')
  // a probe that cannot run (not macOS) is dark
  w.files.delete(APP_CONFIG)
  w.os.value = 'cannot-run'
  await set('auto')
  expect(await debug()).toBe('theme: auto · app: - · os: ? → dark')
  expect((await snap($)).light).toBe(false)
  // an explicit row never reads the app file or asks the OS
  w.files.set(APP_CONFIG, JSON.stringify({ userThemeMode: 'dark' }))
  w.os.value = 'Dark'
  const before = w.probes.length
  await set('light')
  expect(await debug()).toBe('theme: light · app: - · os: - → light')
  await set('dark-daltonized')
  expect(await debug()).toBe('theme: dark-daltonized · app: - · os: - → dark')
  expect(w.probes.length).toBe(before)
})

test('theme: a terminal session under `auto` is dark (its background is neither the app\'s mode nor the OS) and never asks either, however often it looks', async ($, on) => {
  const w = world(on, { theme: 'auto', os: 'Light' })
  w.files.set(APP_CONFIG, JSON.stringify({ userThemeMode: 'light' }))
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await mount($, 'terminal')
  await w.clock.advance(1) // the surface is recorded from a clock callback
  await ui.unmount()
  const before = w.probes.length
  await setConfig($, 'theme', 'auto')
  await w.clock.advance(16_000)
  const again = await mount($, 'terminal')
  await w.clock.advance(1)
  await again.unmount()
  expect(((await cache($, 'debug')).text ?? '').split('\n').find(l => l.startsWith('theme:'))).toBe('theme: auto · app: - · os: - → dark')
  expect((await snap($)).light).toBe(false)
  expect(w.probes.length).toBe(before)
})

test('theme: a terminal records its surface even while the band draws nothing, so the probes stop', { options: { band: 'off' } }, async ($, on) => {
  const w = world(on, { theme: 'auto' })
  engineBand(on)
  await start($)
  const ui = await mount($, 'terminal')
  await w.clock.advance(1) // the surface is recorded from a clock callback
  await ui.unmount()
  expect((await snap($)).surface).toBe('terminal')
})

test('theme: a draw looks at the theme at most once per 15 s, off the render; a changed answer writes `light` once and the band redraws', async ($, on) => {
  const w = world(on, { theme: 'auto', os: 'Dark' })
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  expect(w.probes.length).toBe(1) // session.start
  const draw = async () => {
    const ui = await mount($, 'desktop')
    await w.clock.advance(1) // the deferred look runs after the draw
    const bg = (await ui.find({ key: 'ck-band' }))?.props.backgroundColor
    await ui.unmount()
    return bg
  }
  // the OS turns light, but a draw inside the 15 s does not look
  w.os.value = 'Light'
  expect(await draw()).toBe(PALETTE.dark.warm.bg)
  await w.clock.advance(10_000)
  expect(await draw()).toBe(PALETTE.dark.warm.bg)
  expect(w.probes.length).toBe(1)
  // past 15 s a draw looks (the tick every 60 s would too, so stay under it)
  await w.clock.advance(5_000)
  await draw()
  expect(w.probes.length).toBe(2)
  expect((await snap($)).light).toBe(true)
  const redraws = w.invalidations.length
  // the next draw is a new bar: no second look at once, and the same answer later writes nothing (no redraw is asked)
  await draw()
  expect(w.probes.length).toBe(2)
  await w.clock.advance(16_000)
  expect(await draw()).toBe(PALETTE.light.warm.bg)
  expect(w.probes.length).toBe(3)
  expect(w.invalidations.length).toBe(redraws)
  // a look that fails (the probe cannot start) is not an error out of the hook: the band still draws
  w.os.value = 'cannot-run'
  await w.clock.advance(16_000)
  expect(await draw()).toBe(PALETTE.dark.warm.bg)
})

test('theme: terminal colours are theme keys; the ember and the cold ice blue are raw and darker on a light theme', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const color = async () => {
    const ui = await mount($, 'terminal')
    const c = (await ui.find({ type: 'Text', text: '●' }))?.props.color ?? (await ui.find({ type: 'Text', text: '❄' }))?.props.color
    await ui.unmount()
    return c
  }
  expect(await color()).toBe('#f39a52')
  w.theme.value = 'light'
  await setConfig($, 'theme', 'light')
  expect(await color()).toBe('#b45309')
  w.theme.value = 'dark'
  await setConfig($, 'theme', 'dark')
  await cache($, 'off')
  await w.clock.advance(2 * HOUR)
  expect(await color()).toBe('#7cc4ff')
  w.theme.value = 'light'
  await setConfig($, 'theme', 'light')
  expect(await color()).toBe('#0b6bcb')
})

test('band: the surface is recorded after the draw, never during it', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  expect((await snap($)).surface).toBeNull()
  const ui = await mount($, 'desktop')
  await w.clock.settle()
  expect((await snap($)).surface).toBe('desktop')
  await ui.unmount()
})

test('band: the cold flakes are drawn only where the strip beside the text is free (not at 40 columns; yes from 55)', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'off')
  await w.clock.advance(2 * HOUR)
  for (const [columns, flakes] of [[40, false], [55, true], [75, true], [96, true], [113, true]] as const) {
    const ui = await mount($, 'desktop', { bodyColumns: columns })
    const art = (await ui.findAll({ type: 'Svg' })).find(s => s.props.alt === 'cache cold art')
    expect(String(art?.props.source).includes('class="gl"'), `${columns} columns`).toBe(flakes)
    expect(String(art?.props.source).includes('class="fr"'), `${columns} frost`).toBe(true)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------------------
// The gear and the settings sheet

const gear = async ($: Engine, w: World, surface: Surface, extra: Partial<BandProps> = {}) => {
  w.panes.opened.length = 0
  const ui = await mount($, surface, extra)
  await ui.press({ key: 'ck-settings' })
  return ui
}

test('gear: on the terminal it opens the pane; on the desktop with no room for the sheet it opens the pane too', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  for (const [surface, extra] of [['terminal', { maxRows: TALL }], ['desktop', { maxRows: 6 }], ['desktop', { maxRows: sheetRows(120) }]] as const) {
    const ui = await gear($, w, surface, extra)
    expect(w.panes.opened, `${surface} ${extra.maxRows}`).toEqual([{ id: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 }])
    expect((await snap($)).sheetOpen).toBe(false)
    expect(await ui.find({ key: 'ck-sheet' })).toBeUndefined()
    await ui.unmount()
  }
})

test('gear: the gear says so when the window has no room for a pane either', async ($, on) => {
  const w = world(on, { paneNotPlaced: true })
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'ck-settings' })
  expect(w.toasts.some(t => t.includes('widen'))).toBe(true)
})

test('sheet: the gear opens a taller panel in the band\'s palette and art: title, the line, the switch, a drawn close, then the rows', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 95 })
  expect(w.panes.opened).toEqual([])
  expect((await snap($)).sheetOpen).toBe(true)
  // still the band's root and palette; the art is the state's, animated behind
  expect((await ui.find({ key: 'ck-band' }))?.props).toMatchObject({ backgroundColor: PALETTE.dark.warm.bg, borderColor: PALETTE.dark.warm.edge, borderStyle: 'round' })
  expect(await svgAlts(ui)).toContain('cache warm art')
  const art = (await ui.findAll({ type: 'Svg' })).find(s => s.props.alt === 'cache warm art')
  expect(String(art?.props.source)).toContain('@keyframes up')
  // the header row: title, the line, the switch and the close mark; the keep chip is hidden (its row is in the body), nothing to save yet
  expect(await ui.find({ type: 'Text', text: 'cache-keeper' })).toBeDefined()
  expect(await deskLine(ui)).toBe('Warm · next refresh in 55m')
  expect(await ui.find({ key: 'ck-keep' })).toBeUndefined()
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
  expect(await ui.find({ key: 'ck-settings' })).toBeUndefined()
  const controls = (await ui.find({ key: 'ck-controls' })) as unknown as Node
  expect((controls.children as Node[]).map(c => String(c.props.key ?? c.type))).toEqual(['Box', 'ck-toggle-box', 'ck-dismiss-box'])
  // the close mark is drawn (an Svg X in the gear's stroke and box), not a text glyph; a plain Button, not role="dismiss", no label to show
  const dismiss = await ui.find({ type: 'Button', key: 'ck-dismiss' })
  expect(dismiss?.props.role).toBeUndefined()
  expect(String(dismiss?.props.label)).toMatch(/^ +$/)
  expect(dismiss?.props.hotkey).toBeUndefined()
  const x = (await ui.findAll({ type: 'Svg' })).find(s => s.props.alt === 'Close settings')
  expect(x?.props.width).toBe(cellsPx(GEAR_CELLS))
  expect(String(x?.props.source)).toContain('stroke-width="1.3"')
  expect(JSON.stringify(await ui.drawn())).not.toContain('✕')
  // the body: four rows, drawn controls only: no Select, no footer, no Close button, no band style, no hotkey on any button
  expect(await ui.findAll({ type: 'Select' })).toEqual([])
  expect(await ui.find({ key: 'ck-footer' })).toBeUndefined()
  expect(await ui.find({ key: 'ck-close' })).toBeUndefined()
  expect(await ui.find({ key: 'ck-opt-band' })).toBeUndefined()
  expect((await buttons(ui)).filter(b => b.hotkey !== undefined)).toEqual([])
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).some(t => /Band style|Close|1h on API key/.test(t))).toBe(false)
  // two columns at 95: a row of two settings, a blank row, a row of two; each setting's label row is above its control row. A subscription's fourth is
  // the weekly guard; the 1-hour switch is not drawn (a subscription already gets the 1-hour cache)
  const grid = (await ui.find({ key: 'ck-settings-grid' })) as unknown as Node
  expect((grid.children as Node[]).map(r => ((r.children as Node[]) ?? []).map(k => String(k.props.key)))).toEqual([
    ['ck-row-keepFor', 'ck-row-lead'], ['ck-row-minTokens', 'ck-row-weeklyGuard'],
  ])
  const labels = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(labels).toEqual(expect.arrayContaining(['Keep warm for', 'Refresh before it expires', 'Skip chats smaller than', 'Stop at weekly usage']))
  expect(labels).not.toContain('1-hour cache for API keys')
  expect(await ui.find({ key: 'ck-api-toggle' })).toBeUndefined()
  // the switch in the header
  await ui.press({ key: 'ck-toggle' })
  expect((await snap($)).settings.keepFor).toBe('off')
  expect(await svgAlts(ui)).toContain('cache off art')
  await ui.press({ key: 'ck-toggle' })
  // the weekly figure is nowhere in the band's line
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/weekly \d/)
  await ui.unmount()
})

test('sheet: closes with the drawn close mark; the gear is the close mark while it is open; Escape is not an event the band gets', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: TALL })
  for (let i = 0; i < 2; i++) {
    expect((await snap($)).sheetOpen, `open before close ${i}`).toBe(true)
    expect(await ui.find({ key: 'ck-sheet' })).toBeDefined()
    await ui.press({ key: 'ck-dismiss' })
    expect((await snap($)).sheetOpen, `close ${i}`).toBe(false)
    expect(await ui.find({ key: 'ck-sheet' }), `close ${i}`).toBeUndefined()
    expect(await ui.find({ key: 'ck-settings' }), `close ${i}: the gear is back`).toBeDefined()
    await ui.press({ key: 'ck-settings' }) // reopen
  }
  // the gear pressed again (when it is drawn) closes too
  expect(w.panes.opened).toEqual([])
  await ui.unmount()
})

test('sheet: /cache settings opens the sheet when the last band drawn has room, else the pane', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  // no band drawn yet: the pane
  expect((await cache($, 'settings')).text).toContain('Settings pane opened')
  expect(w.panes.opened).toHaveLength(1)
  await prompt($, w, 't1')
  const ui = await mount($, 'desktop', { maxRows: TALL })
  w.panes.opened.length = 0
  expect((await cache($, 'settings')).text).toContain('Settings opened above the prompt')
  expect((await snap($)).sheetOpen).toBe(true)
  expect(w.panes.opened).toEqual([])
  await ui.unmount()
})

test('sheet: one savings line, never several $0.00 rows: the dim empty line until a rewrite is avoided, then bold figure and dim session', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: 95 })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const line = async () => (await ui.find({ key: 'ck-savings' })) as unknown as Node
  const noSvgHero = async () => expect((await svgAlts(ui)).filter(a => /^(Saved|Spent)/.test(a))).toEqual([])
  // nothing yet: one dim line, in the dim colour; no $ figure anywhere in the sheet
  const empty = 'No savings yet — they show when you return to a warm cache.'
  expect(await texts()).toContain(empty)
  expect((await ui.find({ type: 'Text', text: empty }))?.props.color).toBe(PALETTE.dark.warm.dim)
  expect(flat(await line())).toBe(empty)
  expect((await texts()).filter(t => t.includes('$'))).toEqual([])
  await noSvgHero()
  // two refreshes, no rewrite avoided: still nothing saved, said once
  await w.clock.advance(2 * HOUR)
  expect(flat(await line())).toBe(empty)
  // the next request finds the cache warm after more than an hour: a rewrite of 399k avoided
  await prompt($, w, 't2', turnUsage(OPUS, 399_000, 1_000))
  const bold = await ui.find({ type: 'Text', text: 'Saved $3.03' })
  expect(bold?.props).toMatchObject({ bold: true, color: PALETTE.dark.warm.accent })
  expect((await ui.find({ type: 'Text', text: '· this session $3.03' }))?.props.color).toBe(PALETTE.dark.warm.dim)
  expect(flat(await line())).toBe('Saved $3.03 · this session $3.03')
  expect(await texts()).not.toContain(empty)
  // the sum and the footnote are not in the sheet (they are in /cache stats)
  expect((await texts()).some(t => /Without cache-keeper|rewrites avoided|API list prices/.test(t))).toBe(false)
  // overall carries on past this session's totals
  w.stored.set('allTime', { refreshes: 20, costUsd: 3.7, avoided: 4, grossUsd: 16.1, since: START })
  await w.clock.advance(1) // any redraw
  await ui.press({ key: 'ck-toggle' })
  await ui.press({ key: 'ck-toggle' })
  expect(flat(await line())).toBe('Saved $12.40 · this session $3.03')
  await ui.unmount()
})

const stopKeys = {
  keepFor: ['2h', '4h', '8h', '12h', 'forever'],
  minTokens: ['10000', '30000', '50000', '100000'],
  weeklyGuard: ['75', '80', '90', '95', '100'],
} as const
const SETTING_OF = { keepFor: 'keepFor', minTokens: 'minTokens', weeklyGuard: 'weeklyGuard' } as const

test('sheet: every segment and every slider stop is one blank Button that sets its value at once', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: 95 })
  for (const id of ['keepFor', 'minTokens', 'weeklyGuard'] as const)
    for (const v of stopKeys[id]) {
      await ui.press({ key: `ck-seg-${id}-${v}` })
      expect((await snap($)).settings[SETTING_OF[id]], `${id} ${v}`).toBe(id === 'keepFor' ? v : Number(v))
    }
  for (const n of [2, 3, 10, 15, 5]) {
    await ui.press({ key: `ck-dot-lead-${n}` })
    expect((await snap($)).settings.leadMin, `lead ${n}`).toBe(n)
  }
  // a stop is the selected one afterwards: the drawn Svg says so
  const alt = async (k: string) => String((await ui.find({ key: `${k}-box` }) as unknown as Node).children?.map(c => (c as Node).props.alt).filter(Boolean)[0])
  expect(await alt('ck-seg-keepFor')).toContain('∞ selected')
  await ui.press({ key: 'ck-seg-keepFor-4h' })
  expect(await alt('ck-seg-keepFor')).toContain('4h selected')
  // a press reschedules: the 4h window and lead 10 move the next refresh
  await ui.press({ key: 'ck-dot-lead-10' })
  expect((await snap($)).status).toEqual({ kind: 'scheduled', nextAt: START + 50 * MINUTE })
  await ui.unmount()
})

test('sheet: an API-key session gets the 1-hour switch in the weekly guard\'s place (no weekly plan usage on a key), and the switch applies it', async ($, on) => {
  const w = world(on, { authKind: 'api-key', rateLimits: [] })
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: 95 })
  expect(await ui.find({ key: 'ck-seg-weeklyGuard-box' })).toBeUndefined()
  const labels = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(labels).toContain('1-hour cache for API keys')
  expect(labels).not.toContain('Stop at weekly usage')
  const alt = async (k: string) => String((await ui.find({ key: `${k}-box` }) as unknown as Node).children?.map(c => (c as Node).props.alt).filter(Boolean)[0])
  expect((await snap($)).settings.upgradeTo1h).toBe(false)
  expect(await alt('ck-api-toggle')).toContain('off')
  // the switch: one Svg 20 px tall in a box of SHEET_TOGGLE_CELLS, one blank Button over all of it, in the setting's hover group
  const box = (await ui.find({ key: 'ck-api-toggle-box' })) as unknown as Node
  expect(box.props).toMatchObject({ width: SHEET_TOGGLE_CELLS, height: 1 })
  expect((box.children as Node[])[0]?.props).toMatchObject({ width: cellsPx(SHEET_TOGGLE_CELLS), height: CONTROL_PX })
  expect(drawnHeight((box.children as Node[])[0] as Node)).toBe(CONTROL_PX)
  expect(cellsPx(SHEET_TOGGLE_CELLS)).toBeGreaterThanOrEqual((28 * CONTROL_PX) / 16) // the 28-wide pill, scaled to 20 px tall, fits its box
  await ui.press({ key: 'ck-api-toggle' })
  expect((await snap($)).settings.upgradeTo1h).toBe(true)
  expect(await alt('ck-api-toggle')).toContain('on')
  expect(w.envSets).toContainEqual(['CLAUDE_CODE_PROMPT_CACHE_TTL', '1h'])
  await ui.press({ key: 'ck-api-toggle' })
  expect((await snap($)).settings.upgradeTo1h).toBe(false)
  expect(w.envSets.at(-1)).toEqual(['CLAUDE_CODE_PROMPT_CACHE_TTL', undefined]) // the variable the mod set goes away again
  await ui.unmount()
})

test('sheet: Save as default is in the header, only while the session differs from the saved defaults, and saves', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: 95 })
  const header = async () => (((await ui.find({ key: 'ck-controls' })) as unknown as Node).children as Node[]).map(c => String(c.props.key ?? c.type))
  expect(await header()).toEqual(['Box', 'ck-toggle-box', 'ck-dismiss-box'])
  await ui.press({ key: 'ck-seg-keepFor-4h' })
  expect(await header()).toEqual(['Box', 'ck-save-box', 'ck-toggle-box', 'ck-dismiss-box'])
  expect(await svgAlts(ui)).toContain('Save as default')
  const save = await ui.find({ type: 'Button', key: 'ck-save' })
  expect(save?.props.hotkey).toBeUndefined()
  expect(save?.props.variant).toBeUndefined()
  await ui.press({ key: 'ck-seg-keepFor-8h' })
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined()
  // an unsaved change shows it; pressing saves (the batching is the pane's: one pendingSave, the first config.set)
  await ui.press({ key: 'ck-dot-lead-10' })
  await ui.press({ key: 'ck-seg-weeklyGuard-95' })
  await ui.press({ key: 'ck-save' })
  expect(w.stored.get('pendingSave')).toEqual({ lead: '10', weeklyGuard: '95' })
  expect(w.configSets.map(c => `${c.key}=${String(c.value)}`)).toEqual(['cache-keeper.lead=10'])
  // a value the stops do not list (lead 7) cannot be saved: nothing to save
  await ui.unmount()
})

test('sheet: a value outside the stops selects the nearest and names the exact value (beside the slider, after the label); Off selects none', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'lead 7')
  const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: 95 })
  const alt = async (k: string) => String((await ui.find({ key: `${k}-box` }) as unknown as Node).children?.map(c => (c as Node).props.alt).filter(Boolean)[0])
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(await alt('ck-dots-lead')).toContain('5 selected')
  expect(await texts()).toContain('7 min')
  expect(await ui.find({ key: 'ck-save' })).toBeUndefined() // 7 cannot be saved
  await ui.press({ key: 'ck-dot-lead-10' })
  expect(await texts()).toContain('10 min')
  expect(await texts()).not.toContain('7 min')
  // the weekly guard has a 50 in /config only: the nearest stop (75) is selected and the label says 50%
  await setConfig($, 'cache-keeper.weeklyGuard', '50')
  expect(await alt('ck-seg-weeklyGuard')).toContain('75% selected')
  expect(await texts()).toContain('Stop at weekly usage · 50%')
  await ui.press({ key: 'ck-seg-weeklyGuard-80' })
  expect(await texts()).toContain('Stop at weekly usage')
  expect(await texts()).not.toContain('Stop at weekly usage · 50%')
  // off: no segment selected, the label says why; a stop turns it on again
  await ui.press({ key: 'ck-toggle' })
  expect(await alt('ck-seg-keepFor')).toContain('none selected')
  expect(await texts()).toContain('Keep warm for · off')
  await ui.press({ key: 'ck-seg-keepFor-8h' })
  expect((await snap($)).settings.keepFor).toBe('8h')
  expect(await alt('ck-seg-keepFor')).toContain('8h selected')
  await ui.unmount()
})

test('sheet: each segment and stop is covered exactly by its blank Button: one Box per entry, as many cells as the drawing gives it, a label far wider than the Box', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: 95 })
  const layer = async (id: string) => {
    const wrap = (await ui.find({ key: `${id}-box` })) as unknown as Node
    const kids = wrap.children as Node[]
    return { wrap, svg: kids[0] as Node, cells: ((kids[1] as Node).children as Node[]) }
  }
  const cellsOf = (labels: string[]) => labels.map(l => Math.max(6, [...l].length + 4))
  const expectRow = async (id: string, keys: string[], widths: number[]) => {
    const { wrap, svg, cells } = await layer(id)
    const total = widths.reduce((a, b) => a + b, 0)
    // the wrapper, the layer's cells and the Svg are one width: the sum of the cells
    expect(wrap.props.width, `${id} wrapper cells`).toBe(total)
    expect(wrap.props.height).toBe(1)
    expect(svg.props.width, `${id} svg px`).toBe(cellsPx(total))
    expect(cells.map(c => c.props.width), `${id} segment cells`).toEqual(widths)
    expect(cells.map(c => c.props.overflow), id).toEqual(widths.map(() => 'hidden'))
    // the layer is absolute over the whole wrapper
    const lay = (wrap.children as Node[])[1] as Node
    expect(lay.props).toMatchObject({ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 })
    // one blank Button per entry, key and a no-break label wider (x1.6) than its own Box, so the Box clips it and covers all of it
    const btns = cells.map(c => ((((c.children as Node[])[0] as Node).children as Node[])[0] as Node))
    expect(btns.map(b => b.props.key), id).toEqual(keys)
    btns.forEach((b, i) => {
      expect(b.type).toBe('Button')
      expect(b.props.plain).toBe(true)
      expect(String(b.props.label), `${keys[i]} label`).toMatch(/^ +$/)
      expect(String(b.props.label).length * NBSP_PX, keys[i]).toBeGreaterThanOrEqual((widths[i] as number) * CELL_PX * 1.6)
    })
    return String(svg.props.source)
  }
  const keepL = ['2h', '4h', '8h', '12h', '∞']
  const k = await expectRow('ck-seg-keepFor', stopKeys.keepFor.map(v => `ck-seg-keepFor-${v}`), cellsOf(keepL))
  for (const l of keepL) expect(k).toContain(`>${l}</text>`)
  expect(cellsOf(keepL)).toEqual([6, 6, 6, 7, 6])
  const t = await expectRow('ck-seg-minTokens', stopKeys.minTokens.map(v => `ck-seg-minTokens-${v}`), cellsOf(['10k', '30k', '50k', '100k']))
  expect(t).toContain('>100k</text>')
  expect(cellsOf(['10k', '30k', '50k', '100k'])).toEqual([7, 7, 7, 8])
  await expectRow('ck-seg-weeklyGuard', stopKeys.weeklyGuard.map(v => `ck-seg-weeklyGuard-${v}`), cellsOf(['75%', '80%', '90%', '95%', '100%']))
  expect(cellsOf(['75%', '80%', '90%', '95%', '100%'])).toEqual([7, 7, 7, 7, 8])
  // the slider: five equal slices, one Button each
  const s = await expectRow('ck-dots-lead', [2, 3, 5, 10, 15].map(n => `ck-dot-lead-${n}`), [6, 6, 6, 6, 6])
  expect((s.match(/<circle/g) ?? []).length).toBe(4 + 3) // four dots and the selected stop's glow, ring and centre
  // every drawn control is 20 px tall (the pills, the slider), in a one-row wrapper
  for (const id of ['ck-seg-keepFor', 'ck-seg-minTokens', 'ck-seg-weeklyGuard', 'ck-dots-lead']) {
    const svg = (await layer(id)).svg
    expect(svg.props.height, id).toBe(CONTROL_PX)
    expect(drawnHeight(svg), `${id} drawn`).toBe(svg.props.height) // what art.ts draws is what the box declares
  }
  // a segment's x edges in the drawing are its cells' share of the Svg: the selected pill of 8h spans cells 12..18 of 31
  const sel = await layer('ck-seg-keepFor')
  const px = cellsPx(31)
  const m = /<rect x="([\d.]+)" y="2.5" width="([\d.]+)"/.exec(String(sel.svg.props.source))
  expect(Math.abs(Number(m?.[1]) - ((12 / 31) * px + 2.5))).toBeLessThan(0.11)
  expect(Math.abs(Number(m?.[2]) - ((6 / 31) * px - 5))).toBeLessThan(0.11)
  await ui.unmount()
})

/** The height the drawing itself declares (`<svg … height="N"`), against the Svg element's `height` prop. */
const drawnHeight = (svg: Node): number => Number(/height="(\d+)"/.exec(String(svg.props.source))?.[1])
const svgsOf = (n: Node | string, out: Node[] = []): Node[] => {
  if (typeof n === 'string') return out
  if (n.type === 'Svg') out.push(n)
  for (const k of n.children ?? []) svgsOf(k, out)
  return out
}

/** The rows a drawn tree takes: Text, Select and Button one each, a column adds its children and gaps, a row is its tallest, a border is 2. */
const rowsOf = (n: Node | string): number => {
  if (typeof n === 'string') return 0
  const p = n.props
  // an Svg's height is pixels, and a Box's absolute children take no rows
  if (n.type === 'Svg' || p.position === 'absolute') return 0
  if (typeof p.height === 'number') return p.height + (typeof p.marginTop === 'number' ? p.marginTop : 0)
  const kids = (n.children ?? []).filter((c): c is Node => typeof c !== 'string')
  const inFlow = kids.map(rowsOf).filter(r => r > 0)
  const gap = typeof p.gap === 'number' ? p.gap : 0
  const own =
    n.type === 'Text' || n.type === 'Select' || n.type === 'Button' ? 1
    : p.flexDirection === 'column' ? inFlow.reduce((a, b) => a + b, 0) + gap * Math.max(0, inFlow.length - 1)
    : Math.max(0, ...inFlow)
  return own + (typeof p.marginTop === 'number' ? p.marginTop : 0) + (p.borderStyle ? 2 : 0)
}

/** What a node takes in the flow, ignoring any declared height: a Text, Svg or Button is one row, a column adds its children, a row is its tallest, absolute Boxes take none. */
const contentRows = (n: Node | string): number => {
  if (typeof n === 'string' || n.props.position === 'absolute') return 0
  if (n.type === 'Text' || n.type === 'Svg' || n.type === 'Button' || n.type === 'Select') return 1
  const kids = (n.children ?? []).map(contentRows)
  return n.props.flexDirection === 'column' ? kids.reduce((a, b) => a + b, 0) : Math.max(0, ...kids)
}

const BASE: Settings = { keepFor: '8h', leadMin: 5, minTokens: 30_000, weeklyGuard: 90, band: 'full', upgradeTo1h: false }
/** Every setting value a person can reach: /config's options, /cache keep and /cache lead 2..15. */
const REACHABLE: Settings[] = [
  ...OPTIONS.keepFor.map(keepFor => ({ ...BASE, keepFor })),
  ...OPTIONS.weeklyGuard.map(weeklyGuard => ({ ...BASE, weeklyGuard })),
  ...OPTIONS.minTokens.map(minTokens => ({ ...BASE, minTokens })),
  ...Array.from({ length: 14 }, (_, i) => ({ ...BASE, leadMin: i + 2 })),
  { ...BASE, upgradeTo1h: true },
]
const cellsOf1 = (s: string): number => [...s].length

test('sheet: INLINE_COLUMNS and the label column come from the real strings: no reachable label truncates, the widest control and its value fit beside it', () => {
  const rows = REACHABLE.flatMap(s => [...sheetModel(s, 'subscription'), ...sheetModel(s, 'api-key')])
  const widestLabel = Math.max(...rows.map(r => cellsOf1(r.label)))
  expect(rows.map(r => r.label)).toContain('Stop at weekly usage · 50%')
  expect(widestLabel).toBe(26)
  // the label's text, a gap, the info mark and a gap of padding: the label Box's width inline
  expect(LABEL_CELLS).toBe(widestLabel + 1 + MARK_CELLS + 1)
  // a control with its value (the slider's `15 min` after a gap), in cells
  const control = (r: ReturnType<typeof sheetModel>[number]) =>
    (r.kind === 'toggle' ? SHEET_TOGGLE_CELLS : r.kind === 'dots' ? r.stops.length * STOP_CELLS : r.stops.reduce((a, s) => a + segCells(s.label), 0)) + (r.value ? 1 + cellsOf1(r.value) : 0)
  const widest = Math.max(...rows.map(control))
  expect(rows.find(r => r.value === '15 min' && control(r) === widest)).toBeDefined() // the slider with 15 min is the widest
  expect(widest).toBe(37) // 5 stops of 6, a gap, `15 min`; the weekly guard is 36
  // body = columns - 8 (border 2, band padding 2, sheet padding 4)
  expect(INLINE_COLUMNS).toBe(8 + LABEL_CELLS + widest)
  expect(INLINE_COLUMNS).toBe(75)
  expect(LABEL_CELLS).toBe(30)
  // two columns: each half of the body is (body - gutter) / 2 cells; the widest control fits it (and a label with its mark), from 87 columns, so 90 fits
  const twoMin = 8 + 2 * widest + GUTTER_CELLS
  expect(twoMin).toBe(87)
  expect(TWO_COLUMNS).toBeGreaterThanOrEqual(twoMin)
  expect((TWO_COLUMNS - 8 - GUTTER_CELLS) / 2).toBeGreaterThanOrEqual(widest)
  expect(widestLabel + 1 + MARK_CELLS).toBeLessThanOrEqual((TWO_COLUMNS - 8 - GUTTER_CELLS) / 2)
  expect(TWO_COLUMNS).toBeGreaterThan(INLINE_COLUMNS)
  // the savings line is one truncated row: its empty sentence fits the narrowest body too
  const zero = { refreshes: 0, costUsd: 0, avoided: 0, grossUsd: 0 }
  expect([...savingsOf(zero, zero).empty].length).toBeLessThanOrEqual(INLINE_COLUMNS - 8)
  // (a help is one line: inline it is truncated, see the hover-help test)
})

const KINDS: readonly SessionKind[] = ['subscription', 'api-key']
/** The palette the sheet draws in: a subscription's session is warm, an API-key session (5-minute cache, idle) dim. */
const paletteOf = (kind: SessionKind) => PALETTE.dark[kind === 'api-key' ? 'dim' : 'warm']
const worldOf = (on: Parameters<typeof world>[0], kind: SessionKind) => world(on, kind === 'api-key' ? { authKind: 'api-key', rateLimits: [] } : {})

for (const kind of KINDS)
  test(`sheet (${kind}): 11 rows in both layouts, from INLINE_COLUMNS up; the drawn tree is exactly the rows sheetRows counts; a blank row between the two blocks of settings`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    for (const c of [INLINE_COLUMNS, 79, 80, 89, 90, 95, 120, 200]) expect(sheetRows(c), `${c}`).toBe(11)
    // 12 rows hold it (it drops a taller tree whole), 11 do not; the columns are INLINE_COLUMNS and up
    for (let c = 40; c <= 200; c++) expect(sheetFits(12, c), `${c}`).toBe(c >= INLINE_COLUMNS)
    expect(sheetFits(11, 120)).toBe(false)
    expect(sheetFits(Infinity, 120)).toBe(false)
    for (const avoided of [false, true]) {
      if (avoided) w.stored.set('allTime', { refreshes: 20, costUsd: 3.7, avoided: 4, grossUsd: 16.1, since: START })
      for (const columns of [INLINE_COLUMNS, 79, 80, 89, 90, 95, 120, 200]) {
        const two = columns >= TWO_COLUMNS
        const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: columns })
        const band = (await ui.find({ key: 'ck-band' })) as unknown as Node
        expect(rowsOf(band), `${columns} columns, avoided ${avoided}`).toBe(sheetRows(columns))
        // header 1, blank 1 (the savings row's margin), savings 1, blank 1 (the grid's margin), then the settings: two blocks of two with a blank row between
        const sheet = (await ui.find({ key: 'ck-sheet' })) as unknown as Node
        expect(rowsOf(sheet)).toBe(sheetRows(columns) - 3)
        expect(((await ui.find({ key: 'ck-savings' })) as unknown as Node).props.marginTop).toBe(1)
        const grid = (await ui.find({ key: 'ck-settings-grid' })) as unknown as Node
        expect(grid.props.marginTop).toBe(1)
        const blocks = grid.children as Node[]
        expect(blocks.map(b => String(b.props.key))).toEqual(['ck-block-0', 'ck-block-1'])
        expect(blocks.map(b => b.props.marginTop)).toEqual([undefined, 1])
        expect(blocks.map(b => b.props.flexDirection)).toEqual(two ? ['row', 'row'] : ['column', 'column'])
        expect(blocks.map(b => (b.children as Node[]).map(k => String(k.props.key))), `${columns}`).toEqual(sheetBlocks(kind).map(ids => ids.map(id => `ck-row-${id}`)))
        expect(sheet.props).toMatchObject({ paddingX: 2, position: 'relative' })
        // no gap on any column that would add rows
        expect(sheet.props.gap).toBeUndefined()
        expect(grid.props.gap).toBeUndefined()
        // a setting is a label row over a control row (2 rows) in two columns, else one row with the label beside the control. The declared height
        // holds what is in the flow (it is not what sets the count).
        let settings = 0
        for (const r of await ui.findAll({ type: 'Box' }))
          if (String(r.key).startsWith('ck-row-')) {
            settings++
            const declared = two ? 2 : 1
            expect(r.props.height, `${columns} ${r.key}`).toBe(declared)
            expect(contentRows(r as unknown as Node), `${columns} ${r.key} in-flow rows`).toBeLessThanOrEqual(declared)
          }
        expect(settings).toBe(4)
        await ui.press({ key: 'ck-dismiss' })
        await ui.unmount()
      }
    }
  })

/** The drawn tree's node with this key (find's own node has no hover; the drawn tree has it). */
const drawnByKey = (n: Node | string, key: string): Node | undefined => {
  if (typeof n === 'string') return undefined
  if (n.props?.key === key) return n
  for (const k of n.children ?? []) {
    const f = drawnByKey(k, key)
    if (f) return f
  }
  return undefined
}
const HELP_OF = (id: keyof typeof HELP): string => HELP[id]
const IDS = ['keepFor', 'lead', 'minTokens', 'weeklyGuard', 'api'] as const
/** The settings a session kind's sheet draws, in reading order. */
const idsOf = (kind: SessionKind): readonly (typeof IDS)[number][] => sheetBlocks(kind).flat()
const NAMES_OF = { keepFor: 'Keep warm for', lead: 'Refresh before it expires', minTokens: 'Skip chats smaller than', weeklyGuard: 'Stop at weekly usage', api: '1-hour cache for API keys' } as const
const HELPS = {
  keepFor: 'How long your chat stays ready after your last message. ∞: no end.',
  lead: 'Minutes before expiry to refresh. More leaves room for retries.',
  minTokens: 'Small chats are cheap to reload, so they are not kept warm.',
  weeklyGuard: 'Refreshing stops when your weekly plan usage reaches this level.',
  api: 'API-key sessions cache for 5 minutes by default. Turn on to ask for the 1-hour cache.',
} as const

test('sheetModel and sheetBlocks: four settings, the fourth the weekly guard on a subscription and the 1-hour switch on an API key; unknown is a subscription', () => {
  const ids = (kind?: SessionKind) => (kind ? sheetModel(BASE, kind) : sheetModel(BASE)).map(r => r.id)
  expect(ids('subscription')).toEqual(['keepFor', 'lead', 'minTokens', 'weeklyGuard'])
  expect(ids('api-key')).toEqual(['keepFor', 'lead', 'minTokens', 'api'])
  expect(ids()).toEqual(ids('subscription'))
  expect(sheetBlocks('subscription')).toEqual([['keepFor', 'lead'], ['minTokens', 'weeklyGuard']])
  expect(sheetBlocks('api-key')).toEqual([['keepFor', 'lead'], ['minTokens', 'api']])
  // the model's order is the blocks' order
  for (const kind of KINDS) expect(sheetModel(BASE, kind).map(r => r.id)).toEqual(sheetBlocks(kind).flat())
})

for (const kind of KINDS)
  test(`sheet (${kind}): two columns at ${TWO_COLUMNS}+ columns, each half the body with a ${GUTTER_CELLS}-cell gutter; one row per setting from INLINE_COLUMNS to 89`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    const keys = async (n: Node) => ((n.children as Node[]) ?? []).map(k => String(k.props.key))
    for (const columns of [90, 95, 120]) {
      const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: columns })
      const grid = (await ui.find({ key: 'ck-settings-grid' })) as unknown as Node
      const blocks = grid.children as Node[]
      expect(await Promise.all(blocks.map(keys)), `${columns}`).toEqual(sheetBlocks(kind).map(b => b.map(id => `ck-row-${id}`)))
      for (const block of blocks) {
        const [left, right] = block.children as [Node, Node]
        expect(block.props.flexDirection).toBe('row')
        expect(left.props).toMatchObject({ flexGrow: 1, width: 0 })
        expect(left.props.marginLeft).toBeUndefined()
        expect(right.props).toMatchObject({ flexGrow: 1, width: 0, marginLeft: GUTTER_CELLS })
      }
      // the slider's value sits beside it, in its control row
      const ctl = (await ui.find({ key: 'ck-control-lead' })) as unknown as Node
      expect(((ctl.children as Node[])[1] as Node).children).toEqual(['5 min'])
      await ui.press({ key: 'ck-dismiss' })
      await ui.unmount()
    }
    for (const columns of [INLINE_COLUMNS, 89]) {
      const ui = await gear($, w, 'desktop', { maxRows: TALL, bodyColumns: columns })
      const grid = (await ui.find({ key: 'ck-settings-grid' })) as unknown as Node
      const blocks = grid.children as Node[]
      expect(blocks.map(b => b.props.flexDirection)).toEqual(['column', 'column'])
      expect(await Promise.all(blocks.map(keys)), `${columns}`).toEqual(sheetBlocks(kind).map(b => b.map(id => `ck-row-${id}`)))
      await ui.press({ key: 'ck-dismiss' })
      await ui.unmount()
    }
  })

for (const kind of KINDS)
  test(`sheet (${kind}): the inline tier: a fixed label column (label, info mark) then the control, one row per setting, the controls at one x, presses set values`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    for (const columns of [INLINE_COLUMNS, 80, 89]) {
      const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: columns })
      const tree = (await ui.drawn()) as unknown as Node
      for (const id of idsOf(kind)) {
        const row = drawnByKey(tree, `ck-row-${id}`) as Node
        expect(row.props.height, `${columns} ${id}`).toBe(1)
        const inner = (row.children as Node[])[0] as Node
        // one row: the label Box then the control Box, nothing else between them
        expect(inner.props, `${columns} ${id}`).toMatchObject({ flexDirection: 'row', height: 1 })
        expect((inner.children as Node[]).map(k => String(k.props.key)), `${columns} ${id}`).toEqual([`ck-label-${id}`, `ck-control-${id}`])
        // every label Box is the same width, so every control starts at one x; the room after the label is the label's own padding (no gap, no margin between)
        const label = (inner.children as Node[])[0] as Node
        expect(label.props, `${columns} ${id}`).toMatchObject({ width: LABEL_CELLS, flexShrink: 0, paddingRight: 1 })
        expect(inner.props.gap, `${columns} ${id}`).toBeUndefined()
        expect(((inner.children as Node[])[1] as Node).props.marginLeft, `${columns} ${id}`).toBeUndefined()
        // the info mark is drawn and carries the help; the label is in the text colour
        const mark = (await ui.findAll({ type: 'Svg' })).find(x => String(x.props.alt).startsWith(`About ${NAMES_OF[id]}`))
        expect(mark?.props, `${columns} ${id}`).toMatchObject({ width: MARK_PX, height: MARK_PX })
        expect((await ui.find({ type: 'Text', text: NAMES_OF[id] }))?.props, id).toMatchObject({ color: paletteOf(kind).text })
      }
      // the hover help is as in two columns: one hidden absolute Box per setting with the scope the label and control share
      for (const id of idsOf(kind)) {
        const scope = `ck-tip-${id}`
        expect(drawnByKey(tree, scope)?.hover, `${columns} ${id}`).toEqual({ scope, display: 'flex' })
        expect(flat(drawnByKey(tree, scope) as Node), `${columns} ${id}`).toBe(HELPS[id])
        expect(drawnByKey(tree, `ck-label-${id}`)?.hover, `${columns} ${id} label`).toEqual({ scope })
        expect(drawnByKey(tree, `ck-control-${id}`)?.hover, `${columns} ${id} control`).toEqual({ scope })
      }
      // the help is one truncated line (a second line would be cut through by the blank row under the savings row); the mark's alt carries all of it
      for (const id of idsOf(kind)) expect(((drawnByKey(tree, `ck-tip-${id}`) as Node).children as Node[])[0]?.props.wrap, `${columns} ${id}`).toBe('truncate')
      // the settings sit in ~19 px rows with no blank row between: the controls are drawn 2 px shorter than the row, so stacked ones never touch
      for (const id of idsOf(kind)) {
        const svg = svgsOf(drawnByKey(tree, `ck-control-${id}`) as Node)[0] as Node
        expect(svg.props.height, `${columns} ${id}`).toBe(INLINE_CONTROL_PX)
        expect(INLINE_CONTROL_PX, `${columns} ${id}`).toBeLessThanOrEqual(19 - 2)
        expect(drawnHeight(svg), `${columns} ${id} drawn`).toBe(INLINE_CONTROL_PX)
      }
      // presses still set the values
      await ui.press({ key: 'ck-seg-keepFor-12h' })
      await ui.press({ key: 'ck-dot-lead-10' })
      await ui.press({ key: kind === 'api-key' ? 'ck-api-toggle' : 'ck-seg-weeklyGuard-95' })
      expect((await snap($)).settings, `${columns}`).toMatchObject({ keepFor: '12h', leadMin: 10, ...(kind === 'api-key' ? { upgradeTo1h: true } : { weeklyGuard: 95 }) })
      if (kind === 'api-key') await ui.press({ key: 'ck-api-toggle' })
      await ui.press({ key: 'ck-dismiss' })
      await ui.unmount()
    }
  })

for (const kind of KINDS)
  test(`sheet (${kind}): every setting has its label in the text colour (normal weight) and a drawn info mark whose alt carries the help; the label turns accent with its group`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    for (const columns of [95, 80]) {
      const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: columns })
      const tree = (await ui.drawn()) as unknown as Node
      for (const id of idsOf(kind)) {
        const text = await ui.find({ type: 'Text', text: NAMES_OF[id] })
        expect(text?.props, id).toMatchObject({ color: paletteOf(kind).text })
        expect(text?.props.bold, id).toBeUndefined()
        expect(text?.props.dimColor, id).toBeUndefined()
        // the hover affordance: the label Text takes the accent while the group is lit
        const labelText = (drawnByKey(tree, `ck-label-${id}`) as Node).children?.flatMap(k => (typeof k === 'string' ? [] : (k.children ?? []))).find(k => typeof k !== 'string' && k.type === 'Text') as Node
        expect(labelText.hover, `${columns} ${id}`).toEqual({ scope: `ck-tip-${id}`, color: paletteOf(kind).accent })
        // the info mark: alt = `About <name>: <help>`, 13 px
        const mark = (await ui.findAll({ type: 'Svg' })).find(x => String(x.props.alt).startsWith('About ') && String(x.props.alt).includes(NAMES_OF[id]))
        expect(mark?.props.alt, id).toBe(`About ${NAMES_OF[id]}: ${HELPS[id]}`)
        expect(mark?.props, id).toMatchObject({ width: MARK_PX, height: MARK_PX })
        expect(MARK_PX).toBe(13)
        expect(String(mark?.props.source), id).toContain('<circle')
        expect(String(mark?.props.source), id).toContain(`stroke="${paletteOf(kind).dim}"`)
      }
      expect((await ui.findAll({ type: 'Svg' })).filter(x => /^About /.test(String(x.props.alt))).length).toBe(4)
      await ui.press({ key: 'ck-dismiss' })
      await ui.unmount()
    }
  })

test('sheet: no gap inside a setting: where a label and control sit side by side (inline) the space between is the label Box\'s own padding (a scoped member); in two columns the label is a row above', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const inline = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 80 })
  const row = (drawnByKey((await inline.drawn()) as unknown as Node, 'ck-row-weeklyGuard') as Node).children?.[0] as Node
  expect(row.props.gap).toBeUndefined()
  expect((row.children as Node[]).map(k => String(k.props.key))).toEqual(['ck-label-weeklyGuard', 'ck-control-weeklyGuard'])
  const label = (row.children as Node[])[0] as Node
  expect(label.props.paddingRight).toBe(1)
  expect(label.hover).toEqual({ scope: 'ck-tip-weeklyGuard' })
  await inline.press({ key: 'ck-dismiss' })
  await inline.unmount()
  const two = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 95 })
  const unit = (drawnByKey((await two.drawn()) as unknown as Node, 'ck-row-weeklyGuard') as Node).children?.[0] as Node
  expect(unit.props).toMatchObject({ flexDirection: 'column', height: 2 })
  expect(((unit.children as Node[]).map(r => ((r.children as Node[])[0] as Node).props.key))).toEqual(['ck-label-weeklyGuard', 'ck-control-weeklyGuard'])
  await two.unmount()
})

for (const kind of KINDS)
  test(`sheet (${kind}): no captions: inside the sheet (not the hidden help) every Text is a label, the slider's value, the savings line or a blank hit target`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    const empty = 'No savings yet — they show when you return to a warm cache.'
    const allowed = new Set<string>([...REACHABLE.flatMap(s => sheetModel(s, kind)).flatMap(r => [r.label, r.value]).filter(Boolean), ...Object.values(NAMES), empty])
    const savings = /^(Saved \$\d+(\.\d\d)?|· this session -?\$\d+(\.\d\d)?)$/
    const blank = /^\s+$/ // the info mark's hit Text (no-break spaces)
    const collect = (n: Node | string, out: string[] = []): string[] => {
      if (typeof n === 'string' || String(n.props?.key).startsWith('ck-tip-')) return out
      if (n.type === 'Text') out.push(flat(n))
      for (const k of n.children ?? []) collect(k, out)
      return out
    }
    for (const avoided of [false, true]) {
      if (avoided) w.stored.set('allTime', { refreshes: 20, costUsd: 3.7, avoided: 4, grossUsd: 16.1, since: START })
      for (const columns of [95, 90, 80, INLINE_COLUMNS]) {
        const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: columns })
        const strings = collect(drawnByKey((await ui.drawn()) as unknown as Node, 'ck-sheet') as Node)
        expect(strings.filter(t => !blank.test(t)).length, `${columns}`).toBeGreaterThanOrEqual(5)
        for (const t of strings) expect(allowed.has(t) || savings.test(t) || blank.test(t), `${columns}: "${t}"`).toBe(true)
        await ui.press({ key: 'ck-dismiss' })
        await ui.unmount()
      }
    }
  })

for (const kind of KINDS)
  test(`sheet (${kind}): hover help: a hidden absolute Box per setting over the savings line, revealed by the scope its label and control share; the copy is exact`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 95 })
    const tree = (await ui.drawn()) as unknown as Node
    const sheet = drawnByKey(tree, 'ck-sheet') as Node
    const kids = sheet.children as Node[]
    expect(String(kids[0]?.props.key)).toBe('ck-savings')
    const bg = paletteOf(kind).bg
    for (const id of idsOf(kind)) {
      const scope = `ck-tip-${id}`
      const tip = drawnByKey(tree, scope) as Node
      // a direct child of the sheet, hidden, absolute over the savings row (row 1 of the sheet) and the blank row under it, painted in the panel background
      expect(kids.map(k => String(k.props.key)), id).toContain(scope)
      expect(tip.props, id).toMatchObject({ position: 'absolute', top: 1, left: 2, right: 2, height: 2, display: 'none', backgroundColor: bg, overflow: 'hidden' })
      expect(tip.hover, id).toEqual({ scope, display: 'flex' })
      // the copy, exactly, in the text colour (no name in front: with it most helps would wrap to a second line)
      expect(flat(tip), id).toBe(HELPS[id])
      expect(((tip.children as Node[])[0] as Node).props, id).toMatchObject({ color: paletteOf(kind).text })
      // the label and the control carry the same scope
      expect(drawnByKey(tree, `ck-label-${id}`)?.hover, `${id} label`).toEqual({ scope })
      expect(drawnByKey(tree, `ck-control-${id}`)?.hover, `${id} control`).toEqual({ scope })
    }
    // nothing else reveals them and only the drawn settings' exist
    expect(kids.filter(k => String(k.props.position) === 'absolute').length).toBe(4)
    expect(idsOf(kind).length).toBe(4)
    await ui.unmount()
  })

/** Every node under `n` with the chain of its ancestors (nearest last). */
const walk = (n: Node | string, up: Node[] = [], out: { node: Node; up: Node[] }[] = []): { node: Node; up: Node[] }[] => {
  if (typeof n === 'string') return out
  out.push({ node: n, up })
  for (const k of n.children ?? []) walk(k, [...up, n], out)
  return out
}

for (const kind of KINDS)
  test(`sheet (${kind}): hover reaches every part of a setting: each Text and Button in its label and control carries its scope, and no drawn Svg lacks a scoped element laid over its box`, async ($, on) => {
    const w = worldOf(on, kind)
    engineBand(on)
    await start($)
    await prompt($, w, 't1')
    for (const columns of [95, INLINE_COLUMNS]) {
      const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: columns })
      const tree = (await ui.drawn()) as unknown as Node
      for (const id of idsOf(kind)) {
        const scope = `ck-tip-${id}`
        for (const part of ['label', 'control']) {
          const root = drawnByKey(tree, `ck-${part}-${id}`) as Node
          const all = walk(root)
          const leaves = all.filter(x => x.node.type === 'Text' || x.node.type === 'Button')
          expect(leaves.length, `${columns} ${id} ${part}`).toBeGreaterThan(0)
          for (const { node } of leaves) expect(node.hover, `${columns} ${id} ${part} ${node.type} ${String(node.props?.key ?? '')}`).toMatchObject({ scope })
          // an Svg is an image and never a pointer target: its parent holds an absolute layer over the same box with a scoped Text or Button in it
          for (const { node, up } of all.filter(x => x.node.type === 'Svg')) {
            const parent = up[up.length - 1] as Node
            const layer = (parent.children as Node[]).find(k => typeof k !== 'string' && k.props?.position === 'absolute' && k.props.top === 0 && k.props.bottom === 0 && k.props.left === 0 && k.props.right === 0)
            expect(layer, `${columns} ${id} ${part} ${String(node.props?.alt).slice(0, 20)}`).toBeDefined()
            expect(walk(layer as Node).filter(x => (x.node.type === 'Text' || x.node.type === 'Button') && (x.node.hover as { scope?: string } | undefined)?.scope === scope).length).toBeGreaterThan(0)
          }
        }
        // the info mark's overlay is a blank Text, not a Button (no focus, no press), as wide as the mark's hit label and clipped to the mark's box
        const mark = drawnByKey(tree, `ck-mark-${id}`) as Node
        expect(mark.props).toMatchObject({ position: 'relative', width: MARK_CELLS, height: 1 })
        const overlay = walk(mark).find(x => x.node.type === 'Text') as { node: Node }
        expect(flat(overlay.node)).toBe(hitLabel(MARK_PX))
        expect(walk(mark).some(x => x.node.type === 'Button')).toBe(false)
      }
      await ui.press({ key: 'ck-dismiss' })
      await ui.unmount()
    }
  })

test('sheet: the help is in plain words, one setting each', async () => {
  for (const id of IDS) expect(HELP_OF(id)).toBe(HELPS[id])
})

test('sheet: at 95 columns it is 11 rows and opens in the 12 rows the desktop band has; a slot or a width too small for it gets the pane', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  expect(sheetRows(95)).toBe(11)
  expect(sheetFits(12, 95)).toBe(true)
  expect(sheetFits(12, 80)).toBe(true) // inline: also 11 rows
  const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 95 })
  expect((await snap($)).sheetOpen).toBe(true)
  expect(w.panes.opened).toEqual([])
  expect(await ui.find({ key: 'ck-sheet' })).toBeDefined()
  await ui.unmount()
  // 12 rows hold it at INLINE_COLUMNS and up (it drops a taller tree whole), 11 do not; under INLINE_COLUMNS the controls do not fit
  for (const [maxRows, columns, sheet] of [
    [12, INLINE_COLUMNS - 1, false], [12, 56, false], [12, 55, false], [12, INLINE_COLUMNS, true], [12, 80, true], [12, 89, true], [12, 90, true],
    [11, 95, false], [11, INLINE_COLUMNS, false], [sheetRows(95), 95, false], [sheetRows(95) + 1, 95, true], [16, 80, true], [40, INLINE_COLUMNS - 1, false],
  ] as const) {
    // a mount in a slot with no room closes any open sheet after its draw
    const reset = await mount($, 'desktop', { maxRows: 1 })
    await w.clock.settle()
    await reset.unmount()
    w.panes.opened.length = 0
    const c = await gear($, w, 'desktop', { maxRows, bodyColumns: columns })
    expect((await snap($)).sheetOpen, `${maxRows} rows at ${columns}`).toBe(sheet)
    expect(w.panes.opened.length > 0, `${maxRows} rows at ${columns}: pane`).toBe(!sheet)
    if (sheet) await c.press({ key: 'ck-dismiss' })
    await c.unmount()
    await w.clock.settle()
  }
})

test('sheet: a slot that shrinks under an open sheet draws the band, closes the sheet and opens the pane in its place, once', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  // the band narrowed below INLINE_COLUMNS, and a slot that lost a row, and one that lost almost all of them
  for (const [maxRows, bodyColumns] of [[12, INLINE_COLUMNS - 1], [11, 95], [4, 120]] as const) {
    const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 95 })
    expect((await snap($)).sheetOpen, `${maxRows}x${bodyColumns}`).toBe(true)
    expect(w.panes.opened).toEqual([])
    await ui.unmount()
    // the same state drawn in the smaller slot: the band is drawn (not the sheet), and after the draw the sheet is closed and the pane asked for
    const small = await mount($, 'desktop', { maxRows, bodyColumns })
    expect(await small.find({ key: 'ck-sheet' })).toBeUndefined()
    expect(await small.find({ key: 'ck-band' })).toBeDefined()
    // another draw before the deferred close runs must not open a second pane
    const again = await mount($, 'desktop', { maxRows, bodyColumns })
    await w.clock.settle()
    expect((await snap($)).sheetOpen, `${maxRows}x${bodyColumns}`).toBe(false)
    expect(w.panes.opened, `${maxRows}x${bodyColumns}`).toEqual([{ id: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 }])
    // and later draws find the sheet closed: no second request
    await w.clock.advance(MINUTE)
    expect(w.panes.opened.length).toBe(1)
    await again.unmount()
    await small.unmount()
  }
})

test('sheet: closing because it no longer fits says so when the pane has no room either, and does not loop', async ($, on) => {
  const w = world(on, { paneNotPlaced: true })
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const ui = await gear($, w, 'desktop', { maxRows: 12, bodyColumns: 95 })
  expect((await snap($)).sheetOpen).toBe(true)
  await ui.unmount()
  const small = await mount($, 'desktop', { maxRows: 12, bodyColumns: INLINE_COLUMNS - 1 })
  await w.clock.settle()
  expect((await snap($)).sheetOpen).toBe(false)
  expect(w.toasts.filter(t => t.includes('widen')).length).toBe(1)
  await w.clock.advance(MINUTE)
  expect(w.toasts.filter(t => t.includes('widen')).length).toBe(1)
  await small.unmount()
})

test('sheet: the terminal never draws it', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const d = await gear($, w, 'desktop', { maxRows: TALL })
  expect((await snap($)).sheetOpen).toBe(true)
  const t = await mount($, 'terminal', { maxRows: TALL })
  expect(await t.find({ key: 'ck-sheet' })).toBeUndefined()
  expect((await buttons(t)).map(b => b.key)).toEqual(['ck-keep', 'ck-toggle', 'ck-settings'])
  await t.unmount()
  await d.unmount()
})

// ---------------------------------------------------------------------------
// The keep chip and the bold state word

test('keep chip: cycles 2h, 4h, 8h, 12h, no end and round, on the desktop (a drawn pill) and the terminal ([keep 8h]); it is the session window', { options: { keepFor: '2h' } }, async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const d = await mount($, 'desktop')
  const t = await mount($, 'terminal')
  const shown = async () => ({
    chip: (await svgAlts(d)).find(a => a.startsWith('Keep warm for')),
    term: (await buttons(t)).find(b => b.key === 'ck-keep')?.label,
  })
  expect(await shown()).toEqual({ chip: 'Keep warm for 2h', term: 'keep 2h' })
  for (const [next, chip, term] of [['4h', 'Keep warm for 4h', 'keep 4h'], ['8h', 'Keep warm for 8h', 'keep 8h'], ['12h', 'Keep warm for 12h', 'keep 12h'], ['forever', 'Keep warm for no end', 'keep ∞'], ['2h', 'Keep warm for 2h', 'keep 2h']] as const) {
    await d.press({ key: 'ck-keep' })
    expect((await snap($)).settings.keepFor).toBe(next)
    expect(await shown()).toEqual({ chip, term })
  }
  // the drawn chip shows the symbol for no end
  await t.press({ key: 'ck-keep' })
  await t.press({ key: 'ck-keep' })
  await t.press({ key: 'ck-keep' })
  await t.press({ key: 'ck-keep' })
  expect((await snap($)).settings.keepFor).toBe('forever')
  expect((await d.findAll({ type: 'Svg' })).some(s => String(s.props.source).includes('>∞</text>'))).toBe(true)
  // the hotkey is k
  expect((await buttons(t)).find(b => b.key === 'ck-keep')?.hotkey).toBe('k')
  // a new window reschedules: 2h window, the anchor 0 -> done after 2h
  await t.press({ key: 'ck-keep' })
  expect((await snap($)).settings.keepFor).toBe('2h')
  await d.unmount()
  await t.unmount()
})

test('keep chip: hidden while auto-refresh is off, and in the tiny tier (under 60 columns); never in the minimal style', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  for (const surface of SURFACES) {
    const wide = await mount($, surface, { bodyColumns: 60 })
    expect(await wide.find({ key: 'ck-keep' }), `${surface} 60`).toBeDefined()
    await wide.unmount()
    const tiny = await mount($, surface, { bodyColumns: 59 })
    expect(await tiny.find({ key: 'ck-keep' }), `${surface} 59`).toBeUndefined()
    expect(await tiny.find({ key: 'ck-toggle' })).toBeDefined()
    await tiny.unmount()
  }
  await cache($, 'off')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'ck-keep' }), `${surface} off`).toBeUndefined()
    await ui.unmount()
  }
  await cache($, 'on')
  await setConfig($, 'cache-keeper.band', 'minimal')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'ck-keep' }), `${surface} minimal`).toBeUndefined()
    await ui.unmount()
  }
})

test('keep chip: is hidden while the sheet is open (its row is the first of the body); the header is switch, close', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const closed = await mount($, 'desktop', { maxRows: 12, bodyColumns: 95 })
  expect(await closed.find({ key: 'ck-keep' })).toBeDefined()
  await closed.press({ key: 'ck-settings' })
  expect(await closed.find({ key: 'ck-keep' })).toBeUndefined()
  const controls = (await closed.find({ key: 'ck-controls' })) as unknown as Node
  expect((controls.children as Node[]).map(c => String(c.props.key ?? c.type))).toEqual(['Box', 'ck-toggle-box', 'ck-dismiss-box'])
  await closed.press({ key: 'ck-dismiss' })
  expect(await closed.find({ key: 'ck-keep' })).toBeDefined()
  await closed.unmount()
})

test('band: the state word is drawn bold, the rest in normal weight', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await start($)
  await prompt($, w, 't1')
  const boldWord = async (ui: Mounted) => (await ui.findAll({ type: 'Text' })).filter(t => t.props.bold === true).map(t => t.text)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await boldWord(ui), surface).toEqual(['Warm'])
    const line = (await ui.findAll({ type: 'Text' })).find(t => t.text.startsWith('Warm ·'))
    expect(line?.props.bold, 'the whole line is not bold').toBeUndefined()
    await ui.unmount()
  }
  await cache($, 'off')
  const off = await mount($, 'desktop')
  expect(await boldWord(off)).toEqual(['Auto-refresh off'])
  await off.unmount()
  // tiny: the countdown alone, nothing to bold
  await cache($, 'on')
  const tiny = await mount($, 'desktop', { bodyColumns: 40 })
  expect(await boldWord(tiny)).toEqual([])
  await tiny.unmount()
  await cache($, 'off')
  await w.clock.advance(2 * HOUR)
  const cold = await mount($, 'desktop')
  expect(await boldWord(cold)).toEqual(['Cache cold'])
  await cold.unmount()
})
