// Writes docs/preview.html from the real modules (not copies): the line comes from policy.bandLine (at the tier the
// band's columns pick), the art state from the line's tone, the SVG strings from art.ts (art, toggle, gear, dot, hero and the
// self-ticking countdown), the layout numbers from view.ts.
// Run, from the mod folder: npx -y tsx tools/preview.ts
// Each SVG goes in as an <img> data URI, as the app draws a plain Svg, so the CSS animations run here too (the countdown
// digits tick live). The band is laid out by the rules band.tsx uses: a rounded root with the art in absolute layers, the dot,
// the line (flex 1, shrinks and clips first), then the controls in the flow at the right end (never shrunk). The hover card
// is CSS :hover. The sheets below are the settings sheet: the same header row (switch, drawn close, Save as default when dirty), a blank row, one
// savings line, a blank row, then four settings in two blocks with a blank row between them (two columns at 90+, else one row each), each a label (with an info
// mark) over a drawn control (segmented pill, dot slider, switch). The metrics are the real app's, measured on the real app (see ROW_PX and
// GAP_PX). Hover a setting's label, its mark or its
// control to see its help in place of the savings line (the figures marked "help shown" draw that state). The controls are the real Svg strings, the cells the
// real view.ts ones.
// Node types are not in the plugin's tsconfig, so the node imports below are untyped and `console` is declared here.
// @ts-ignore
import { mkdirSync, writeFileSync } from 'node:fs'
// @ts-ignore
import { fileURLToPath } from 'node:url'
declare const console: { log(...a: unknown[]): void }
import { ART_RIGHT, PALETTE, artLayers, chipSvg, clockFrames, clockSvg, clockWidth, closeSvg, dotSvg, gearSvg, infoSvg, saveSvg, segSvg, sliderSvg, toggleSvg } from '../hooks/art'
import type { ArtState, ArtTheme } from '../hooks/art'
import { bandLine, fmtMinutes, keepLabel, savingsOf, tierOf } from '../hooks/policy'
import type { Line, LineInput, Seg } from '../hooks/policy'
import { CELL_PX, CHIP_CELLS, CONTROL_PX, GEAR_CELLS, GUTTER_CELLS, INLINE_COLUMNS, INLINE_CONTROL_PX, LABEL_CELLS, MARK_CELLS, MARK_PX, SAVE_CELLS, SHEET_TOGGLE_CELLS, STOP_CELLS, TOGGLE_CELLS, TWO_COLUMNS, artStateOf, cellsPx, coldStripFits, segCells, sheetBlocks, sheetModel, sheetRows } from '../hooks/view'
import type { SessionKind, SheetId, SheetRow } from '../hooks/view'
import type { Settings } from '../types'

const IDS: SheetId[] = ['keepFor', 'lead', 'minTokens', 'weeklyGuard', 'api']
const T = 1_700_000_000_000
const MIN = 60_000
const SETTINGS = { keepFor: '8h', leadMin: 5, minTokens: 30_000, weeklyGuard: 90, band: 'full', upgradeTo1h: false } as const
const OFF = { ...SETTINGS, keepFor: 'off' } as const
const base = (o: Partial<LineInput>): LineInput => ({
  now: T + 5 * MIN,
  anchor: { at: T, model: 'claude-opus-5-5', promptTokens: 408_000, ttl: '1h' },
  chain: { touchAt: T, refreshes: 0, costUsd: 0 },
  status: { kind: 'scheduled', nextAt: T + 55 * MIN },
  settings: SETTINGS,
  dialog: null,
  tasks: [],
  limits: null,
  resumed: null,
  ...o,
})

type Row = { label: string; input: LineInput; widths?: number[] }
const COLD = { now: T + 3 * 60 * MIN, status: { kind: 'waiting' } } as const
const KEPT = { chain: { touchAt: T, refreshes: 3, costUsd: 0.2412 } } as const
const WIDE = [760, 480, 320]
const ROWS: Row[] = [
  { label: 'on, scheduled (hover the line for the card)', input: base({ ...KEPT, limits: { weekly: 41, overLimit: false, at: T } }), widths: [1100, 760, 640, 480, 320] },
  { label: 'on, scheduled, waiting on your answer / a background task', input: base({ dialog: { id: 'd', tool: 'AskUserQuestion', since: T }, tasks: [{ id: 'a', kind: 'shell', desc: '', since: T }] }), widths: [1100, 760] },
  { label: 'refreshing', input: base({ status: { kind: 'refreshing', since: T, attempt: 0 } }), widths: WIDE },
  { label: 'retrying', input: base({ status: { kind: 'retrying', nextAt: T + 7 * MIN, attempt: 1, error: 'overloaded 529' } }), widths: WIDE },
  { label: 'off, cache warm', input: base({ settings: OFF, now: T + 18 * MIN }), widths: [760, 640, 480, 320] },
  { label: 'off and cooling (10 minutes or less left): the alert', input: base({ settings: OFF, now: T + 52 * MIN }), widths: [760, 640, 480, 320] },
  { label: 'window ended (done)', input: base({ status: { kind: 'done', code: 'window', at: T }, chain: { touchAt: T + 50 * MIN, refreshes: 1, costUsd: 0.08 }, now: T + 100 * MIN, anchor: { at: T - 7 * 60 * MIN, model: 'claude-opus-5-5', promptTokens: 408_000, ttl: '1h' } }), widths: WIDE },
  { label: 'window ended and cooling', input: base({ status: { kind: 'done', code: 'window', at: T }, chain: { touchAt: T + 50 * MIN, refreshes: 1, costUsd: 0.08 }, now: T + 104 * MIN, anchor: { at: T - 7 * 60 * MIN, model: 'claude-opus-5-5', promptTokens: 408_000, ttl: '1h' } }), widths: [760, 480] },
  { label: 'stopped (weekly guard), cache still warm', input: base({ status: { kind: 'stopped', code: 'weekly-guard', reason: 'weekly 91% ≥ guard 90%', at: T }, limits: { weekly: 91, overLimit: false, at: T }, now: T + 38 * MIN }), widths: WIDE },
  { label: 'cold', input: base({ ...COLD }), widths: [1100, 760, 640, 480, 320] },
  { label: 'cold, once the rate is learned (~1.4% of 5h)', input: base({ ...COLD, pct5h: 1.4 }), widths: [760] },
  { label: 'holding (small context)', input: base({ status: { kind: 'holding', reason: 'small' }, anchor: { at: T, model: 'claude-opus-5-5', promptTokens: 12_000, ttl: '1h' } }), widths: WIDE },
  { label: '5-minute cache, idle', input: base({ status: { kind: 'holding', reason: 'idle-5m' }, anchor: { at: T, model: 'claude-opus-5-5', promptTokens: 408_000, ttl: '5m' }, now: T + 2 * MIN }), widths: WIDE },
]

const TERM = {
  dark: { bg: '#0d0d0f', fg: '#d4d4d8', warning: '#ffc107', error: '#ff6b80', ice: '#7cc4ff', ember: '#f39a52', inactive: '#888888' },
  light: { bg: '#ffffff', fg: '#27272a', warning: '#966c1e', error: '#ab2b3f', ice: '#0b6bcb', ember: '#b45309', inactive: '#666666' },
} as const
const termColor = (a: ArtState, theme: ArtTheme): string => {
  const t = TERM[theme]
  return a === 'warm' || a === 'refreshing' ? t.ember : a === 'cooling' ? t.warning : a === 'error' ? t.error : a === 'cold' ? t.ice : t.inactive
}
const SURFACE = { dark: '#1f1e1d', light: '#faf9f5' } as const

const uri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const NOW = 1_234_567
const columnsOf = (px: number) => Math.floor(px / CELL_PX)

/** The app sets the countdown image's font to the band's; a bare <img> in a browser would use a serif, so the preview says it. */
const inBandFont = (svg: string): string => {
  const font = "text{font-family:system-ui,-apple-system,'Segoe UI',sans-serif}"
  return svg.includes('<style>') ? svg.replace('<style>', `<style>${font}`) : svg.replace(/(<svg[^>]*>)/, `$1<style>${font}</style>`)
}

/** A text with a countdown in it, as the band draws it: parts that truncate, the countdown as a ticking image. */
function segHtml(seg: Seg, color: string, dim: string): string {
  const parts: string[] = []
  if (seg.pre) parts.push(`<span class="part" style="color:${color}">${seg.word ? `<b>${esc(seg.word)}</b>${esc(seg.pre.slice(seg.word.length))}` : esc(seg.pre)}</span>`)
  if (seg.ms !== null) {
    const frames = clockFrames(seg.ms, fmtMinutes)
    parts.push(`<img class="clock" alt="${frames[0]?.label ?? ''}" src="${uri(inBandFont(clockSvg(frames, color)))}" width="${clockWidth(frames)}" height="17">`)
  }
  if (seg.post) parts.push(`<span class="part" style="color:${dim}">${esc(seg.post)}</span>`)
  return `<span class="seg">${parts.join('')}</span>`
}

type Ctl = { on: boolean; c: ReturnType<typeof palette>; light: boolean; keep: string | null; open: boolean; dirty?: boolean }
const palette = (art: ArtState, theme: ArtTheme) => PALETTE[theme][art]

/** The drawn controls, as band.tsx draws them: keep chip (shown while on, not in the tiny tier, not while the sheet is open), Save as default (sheet open, session differs), switch, then the gear, or the drawn close mark while the sheet is open. The Svg is exactly the box's cells wide, the click target (blank Button over all of it) outlined by `.hit` under "show click targets". */
function controls(k: Ctl): string {
  const tp = cellsPx(TOGGLE_CELLS)
  const gp = cellsPx(GEAR_CELLS)
  const cp = cellsPx(CHIP_CELLS)
  const chip = k.keep
    ? `<span class="hit" style="width:${CHIP_CELLS * CELL_PX}px"><img alt="Keep warm for ${esc(k.keep)}" src="${uri(inBandFont(chipSvg(k.keep, k.c, cp)))}" width="${cp}" height="18"></span>`
    : ''
  return (
    `<span class="ctl">${chip}${k.open && k.dirty ? `<span class="hit" style="width:${SAVE_CELLS * CELL_PX}px"><img alt="Save as default" src="${uri(inBandFont(saveSvg('Save as default', k.c, cellsPx(SAVE_CELLS))))}" width="${cellsPx(SAVE_CELLS)}" height="18"></span>` : ''}<span class="hit" style="width:${TOGGLE_CELLS * CELL_PX}px"><img alt="Auto-refresh ${k.on ? 'on' : 'off'}" src="${uri(toggleSvg(k.on, k.c, tp))}" width="${tp}" height="16"></span>` +
    (k.open
      ? `<span class="hit" style="width:${GEAR_CELLS * CELL_PX}px"><img alt="Close settings" src="${uri(closeSvg(k.c.text, gp))}" width="${gp}" height="14"></span>`
      : `<span class="hit" style="width:${GEAR_CELLS * CELL_PX}px"><img alt="Settings" src="${uri(gearSvg(k.c.text, gp))}" width="${gp}" height="14"></span>`) +
    '</span>'
  )
}

function band(row: Row, widthPx: number, theme: ArtTheme, cols?: number, showCard = false): string {
  const light = theme === 'light'
  const columns = cols ?? columnsOf(widthPx)
  const line = bandLine(row.input, 'full', tierOf(columns))
  if (!line) throw new Error(`no line for ${row.label}`)
  const art = artStateOf(line)
  const c = palette(art, theme)
  const layers = artLayers(art, { light, nowMs: NOW, strip: coldStripFits(columns, Array.from(line.text).length) })
  const imgs = layers
    .map(l => `<img class="${l.anchor}" alt="" src="${uri(l.svg)}" width="${l.anchor === 'full' ? widthPx : l.width}" height="${l.height}">`)
    .join('')
  const on = row.input.settings.keepFor !== 'off'
  const card = line.hover ? `<span class="card${showCard ? ' on' : ''}" style="background:${c.bg}">${segHtml(line.hover, c.text, c.dim)}</span>` : ''
  const t = TERM[theme]
  const info = layers.map(l => `${l.key} ${l.anchor} ${l.svg.length} chars`).join(' · ')
  const keep = on && tierOf(columns) !== 'tiny' ? keepLabel(row.input.settings.keepFor) : null
  const term = `${keep ? `[ keep ${keep} ] ` : ''}[ ${on ? 'on' : 'off'} ] [ settings ]`
  return `<div class="band" style="width:${widthPx}px;background:${c.bg};border-color:${c.edge};color:${c.text};--accent:${c.accent};--edge:${c.edge};--bg:${c.bg}">
${imgs}<div class="row"><img src="${uri(dotSvg(art, light, NOW))}" alt="" width="10" height="10"><span class="line">${segHtml(line, c.text, c.dim)}${card}</span>${controls({ on, c, light, keep, open: false })}</div></div>
<div class="info">${esc(`${art} · ${columns} columns, ${tierOf(columns)} tier · ${info}`)}</div>
<div class="term" style="background:${t.bg};color:${t.fg}"><span style="color:${termColor(art, theme)}">${esc(line.symbol)}</span> ${esc(line.text)} <span class="tb">${esc(term)}</span></div>`
}

/** The app's px for what the sheet is made of, measured on the real app (95 columns = 751 px wide, 7.9 px a
 * column): a text row is 19 px, a blank margin row 9.5 px, a bordered Box pads 8 px above and below its rows (a one-row band is 2 + 16 + 19 = 37 px), the
 * border is 1 px and takes no cell, so the body at 95 columns is 95 - 6 = 89 cells. */
const ROW_PX = 19
const GAP_PX = 9.5

/** One drawn control with its click targets (a `.hit` per segment, laid over it at the same cells the blank Buttons cover). `squash` stretches the Svg to a
 * different height (the 0.1.4 calibration draws the 20 px pills at 17). */
function drawn(svg: string, alt: string, cells: readonly number[], height: number, scale = 1, squash = false): string {
  const total = cells.reduce((a, b) => a + b, 0)
  const px = cellsPx(total)
  const hits = cells.map(n => `<span class="hit seg" style="width:${n * CELL_PX * scale}px"></span>`).join('')
  const src = squash ? svg.replace('<svg ', '<svg preserveAspectRatio="none" ') : svg
  return `<span class="drawn" style="width:${total * CELL_PX * scale}px;height:${ROW_PX * scale}px"><img alt="${esc(alt)}" src="${uri(inBandFont(src))}" width="${px * scale}" height="${height * scale}"><span class="hits">${hits}</span></span>`
}

/** What the sheet is drawn with: the current layout (view.ts), or the 0.1.4 one the calibration redraws to compare with the screenshot. */
type Layout = {
  gutter: number
  seg: (label: string) => number
  stop: number
  /** The pills' and the slider's height in px. */
  ctlPx: number
  /** The sheet's switch: its cells and height. */
  toggle: { cells: number; px: number }
  /** The info mark's px, and the width of its box. */
  markPx: number
  markBox: number
  /** The settings in rows of one or two, with a blank row before each `gap` row. In two columns a setting is a label row over its control row, except `beside`. */
  rows: { ids: SheetId[]; gap: boolean }[]
  beside: (r: SheetRow) => boolean
}
const CURRENT = (kind: SessionKind, two = true): Layout => ({
  gutter: GUTTER_CELLS, seg: segCells, stop: STOP_CELLS, ctlPx: two ? CONTROL_PX : INLINE_CONTROL_PX, toggle: { cells: SHEET_TOGGLE_CELLS, px: two ? CONTROL_PX : INLINE_CONTROL_PX }, markPx: MARK_PX, markBox: MARK_CELLS * CELL_PX,
  rows: sheetBlocks(kind).map((ids, i) => ({ ids, gap: i > 0 })), beside: () => false,
})
const LEGACY: Layout = {
  gutter: 3, seg: l => Math.max(5, [...l].length + 2), stop: 5, ctlPx: 17, toggle: { cells: 4, px: 16 }, markPx: 11, markBox: 11,
  rows: [{ ids: ['keepFor', 'lead'], gap: false }, { ids: ['minTokens', 'weeklyGuard'], gap: false }, { ids: ['api'], gap: false }], beside: r => r.kind === 'toggle',
}

/** A sheet row's control, from view.sheetModel's row: the same cells and Svg strings band.tsx and sheet.tsx draw. */
function control(r: SheetRow, c: ReturnType<typeof palette>, scale = 1, L: Layout = CURRENT('subscription')): string {
  const squash = L === LEGACY
  if (r.kind === 'toggle') return drawn(toggleSvg(r.on, c, cellsPx(L.toggle.cells), L.toggle.px), `${r.label}, ${r.on ? 'on' : 'off'}`, [L.toggle.cells], L.toggle.px, scale)
  const dots = r.kind === 'dots'
  const cells = r.stops.map(s => (dots ? L.stop : L.seg(s.label)))
  const px = cellsPx(cells.reduce((a, b) => a + b, 0))
  return drawn(dots ? sliderSvg(r.stops.length, r.selected, c, px, squash ? 20 : L.ctlPx) : segSvg(r.stops.map(s => s.label), cells, r.selected, c, px, squash ? 20 : L.ctlPx), r.label, cells, L.ctlPx, scale, squash)
}

type Totals = { refreshes: number; costUsd: number; avoided: number; grossUsd: number }
type SheetOpts = { input: LineInput; all: Totals; session: Totals; dirty: boolean; settings?: Partial<Settings>; tip?: SheetId; kind?: SessionKind; legacy?: boolean }

/** The settings sheet: the band's own row as the header (title, line, Save as default when dirty, switch, drawn close), a blank row, the savings line, a blank row, the settings (two columns at 90+, else one row each: the label column, then the control). Every setting's help is in the page, hidden, shown by :hover on its label or control or, as `tip`, drawn shown (the label then in the accent, as in the real sheet). */
function sheet(columns: number, theme: ArtTheme, o: SheetOpts): string {
  const widthPx = Math.round(columns * CELL_PX)
  const light = theme === 'light'
  const kind = o.kind ?? 'subscription'
  const L = o.legacy ? LEGACY : CURRENT(kind, columns >= TWO_COLUMNS)
  const line = bandLine(o.input, 'full', tierOf(columns)) as Line
  const art = artStateOf(line)
  const c = palette(art, theme)
  const right = artLayers(art, { light, nowMs: NOW, fadeDown: true }).filter(l => l.anchor === 'right')[0]!
  const on = o.input.settings.keepFor !== 'off'
  const sv = savingsOf(o.all, o.session)
  const settings = { ...o.input.settings, ...(o.settings ?? {}) }
  const rows = [...sheetModel(settings, 'subscription'), ...sheetModel(settings, 'api-key').filter(r => r.id === 'api')]
  const two = columns >= TWO_COLUMNS
  // As sheet.tsx: inline the label is a fixed-width column whose padding is the space before the control, so it is part of what lights the help; the help shows
  // while the pointer is on a label, its mark or a control, not the whole half-width column.
  const label = (r: SheetRow) => {
    const beside = !two || L.beside(r)
    const w = two ? '' : `width:${LABEL_CELLS * CELL_PX}px;flex:0 0 auto;`
    return `<span class="lab${o.tip === r.id ? ' lit' : ''}" data-id="${r.id}" style="color:${c.text};${w}${beside ? `padding-right:${CELL_PX}px;` : ''}box-sizing:border-box"><span class="t">${esc(r.label)}</span><span class="mark hit" style="width:${L.markBox}px"><img alt="About ${esc(r.name)}: ${esc(r.help)}" src="${uri(infoSvg(c.dim))}" width="${L.markPx}" height="${L.markPx}"></span></span>`
  }
  const ctl = (r: SheetRow) => `<span class="ctl2" data-id="${r.id}">${control(r, c, 1, L)}${r.value ? `<span style="color:${c.text}">${esc(r.value)}</span>` : ''}</span>`
  const setting = (r: SheetRow, second: boolean) => {
    const beside = !two || L.beside(r)
    return `<div class="set${two ? '' : ' flow'}" data-id="${r.id}" style="${two && second ? `margin-left:${L.gutter * CELL_PX}px` : ''}">${beside ? `<div class="line1 beside">${label(r)}${ctl(r)}</div>` : `<div class="line1">${label(r)}</div><div class="line1">${ctl(r)}</div>`}</div>`
  }
  const grid = L.rows
    .map(row => `<div class="prow${two ? '' : ' col'}"${row.gap ? ` style="margin-top:${GAP_PX}px"` : ''}>${row.ids.map((id, i) => setting(rows.find(r => r.id === id) as SheetRow, i > 0)).join('')}${two && row.ids.length === 1 ? `<div class="set" style="margin-left:${L.gutter * CELL_PX}px"></div>` : ''}</div>`)
    .join('')
  const tips = rows
    .filter(r => L.rows.some(x => x.ids.includes(r.id)))
    .map(r => `<div class="tip${o.tip === r.id ? ' show' : ''}" data-id="${r.id}" style="background:${c.bg};color:${c.text};height:${ROW_PX + GAP_PX}px"><span${columns >= TWO_COLUMNS ? '' : ' class="one"'}>${esc(r.help)}</span></div>`)
    .join('')
  const savings = sv.has
    ? `<div class="sv1"><b style="color:${c.accent}">${esc(sv.hero)}</b><span style="color:${c.dim}">· ${esc(sv.session)}</span></div>`
    : `<div class="sv1"><span style="color:${c.dim}">${esc(sv.empty)}</span></div>`
  const rowsDrawn = o.legacy ? 11 : sheetRows(columns)
  const sheetEl = `<div class="band sheet" style="width:${widthPx}px;background:${c.bg};border-color:${c.edge};color:${c.text};--accent:${c.accent};--edge:${c.edge};--bg:${c.bg}">
<img class="right top" alt="" src="${uri(right.svg)}" width="${right.width}" height="${right.height}">
<div class="row"><img src="${uri(dotSvg(art, light, NOW))}" alt="" width="10" height="10"><b class="title" style="color:${c.accent}">cache-keeper</b><span class="line">${segHtml(line, c.text, c.dim)}</span>${controls({ on, c, light, keep: null, open: true, dirty: o.dirty })}</div>
<div class="body">
${savings}
<div class="settings">${grid}</div>
${tips}
</div></div>`
  const note = o.legacy ? '0.1.4 layout redrawn (5 settings, 17 px pills, 3-cell gutter; the controls are the 20 px drawings squeezed to 17)' : `${rowsDrawn} rows (needs ${rowsDrawn + 1}; the slot has 12) · ${kind}`
  return `<div class="shell ${theme}" style="width:${widthPx + 18}px">${sheetEl}</div>
<div class="info">${esc(`sheet · ${columns} columns · ${note} · ${art} art${o.tip ? ` · help shown: ${o.tip}` : ''}`)}</div>`
}

/** The two controls alone, large (3x), for review: the segmented pill at each of its selections and the slider at each of its stops, with click targets. */
function controlsLarge(theme: ArtTheme): string {
  const c = palette('warm', theme)
  const all = sheetModel(SETTINGS)
  const seg = all[0] as Extract<SheetRow, { kind: 'seg' }>
  const dots = all[1] as Extract<SheetRow, { kind: 'dots' }>
  const tok = all[2] as Extract<SheetRow, { kind: 'seg' }>
  const one = (r: SheetRow, i: number) => control({ ...r, selected: i } as SheetRow, c, 3)
  return `<figure class="${theme}" style="background:${SURFACE[theme]};padding:18px 22px;--accent:${c.accent};--edge:${c.edge};--bg:${c.bg};display:flex;flex-direction:column;gap:14px;background-image:linear-gradient(${c.bg},${c.bg});background-clip:content-box">
<figcaption style="color:${theme === 'dark' ? '#9a9a9f' : '#6b6b70'}">${theme} · warm · 3x</figcaption>
${[0, 2, 4].map(i => `<div>${one(seg, i)}</div>`).join('')}
<div>${one(tok, 3)}</div>
${[0, 2, 4].map(i => `<div>${one(dots, i)}</div>`).join('')}
</figure>`
}

function build(): string {
  const bands = ROWS.map(row => {
    const widths = row.widths ?? [760]
    return `<section><h2><b>${esc(row.label)}</b></h2>${widths
      .map(w => `<div class="pair">${(['dark', 'light'] as const)
        .map(th => `<figure class="${th}" style="background:${SURFACE[th]};width:${w + 26}px"><figcaption style="color:${th === 'dark' ? '#9a9a9f' : '#6b6b70'}">${th} · ${w}px</figcaption>${band(row, w, th)}</figure>`)
        .join('')}</div>`)
      .join('')}</section>`
  }).join('\n')
  const early = { refreshes: 6, costUsd: 0.48, avoided: 0, grossUsd: 0 }
  const full = { refreshes: 84, costUsd: 3.7, avoided: 5, grossUsd: 16.1 }
  const sess = { refreshes: 21, costUsd: 0.8, avoided: 1, grossUsd: 4 }
  // An API-key session: the 5-minute cache, idle (the dim art); the 1-hour switch is the fourth setting.
  const apiInput = base({ status: { kind: 'holding', reason: 'idle-5m' }, anchor: { at: T, model: 'claude-opus-5-5', promptTokens: 408_000, ttl: '5m' }, now: T + 2 * MIN })
  type Def = SheetOpts & { label: string; cols: number }
  const sub = (label: string, cols: number, o: Partial<SheetOpts> = {}): Def => ({ label, cols, input: base({ ...KEPT }), all: full, session: sess, dirty: false, ...o })
  const key = (label: string, cols: number, o: Partial<SheetOpts> = {}): Def => ({ label, cols, input: apiInput, all: early, session: early, dirty: false, kind: 'api-key', ...o })
  const sheetDefs: Def[] = [
    sub('95 columns (the desktop band as measured on the app), a subscription session, sample savings: Keep warm for · Refresh before it expires · Skip chats smaller than · Stop at weekly usage. Hover a label, its ⓘ or a control for its help', 95),
    sub('95 columns, no savings yet (the one dim sentence), an unsaved change: Save as default shown, 12h selected', 95, { input: base({ now: T + 1 * MIN }), all: early, session: early, dirty: true, settings: { keepFor: '12h' } }),
    key('95 columns, an API-key session: the 1-hour cache switch takes the weekly guard\'s place (there is no weekly plan usage on a key)', 95),
    key('95 columns, an API-key session with the 1-hour cache turned on', 95, { settings: { upgradeTo1h: true }, dirty: true }),
    sub('95 columns, a value the stops do not list: /cache lead 7 selects the nearest (5) and the slider says 7 min; guard 50 selects 75 and the label says 50%', 95, { settings: { leadMin: 7, weeklyGuard: 50 } }),
    sub('95 columns with auto-refresh off (off and cooling: the alert colours): no segment is selected, the label says off, the switch is off', 95, { input: base({ settings: OFF, now: T + 52 * MIN }), dirty: true }),
    sub('90 columns (the narrowest two-column width), the same 11 rows', TWO_COLUMNS),
  ]
  const tips: Def[] = (['keepFor', 'lead', 'minTokens', 'weeklyGuard'] as const)
    .map(tip => sub(`help shown for ${tip} (the pointer is on that setting's label, ⓘ or control; the help replaces the savings line, the label turns accent)`, 95, { tip }))
    .concat([key('help shown for the 1-hour cache switch (API-key session)', 95, { tip: 'api' })])
  // The inline tier: from INLINE_COLUMNS to 89, one row per setting (the label column, then the control), still 11 rows, a blank row between the two pairs.
  const inline: Def[] = [
    sub('80 columns (the inline tier: one row per setting), sample savings', 80),
    sub('80 columns, help shown for the slider (the label turns accent; the pointer is on its label, ⓘ or control). The help here is one truncated line (a second line would be cut through by the blank row); the full text is the info mark alt text', 80, { tip: 'lead' }),
    key('80 columns, an API-key session', 80),
    sub(`${INLINE_COLUMNS} columns (INLINE_COLUMNS, the narrowest the sheet is drawn)`, INLINE_COLUMNS),
    sub(`${INLINE_COLUMNS} columns, the widest content: a 15 min lead (the slider's value) and a weekly guard of 50 (the label says Stop at weekly usage · 50%)`, INLINE_COLUMNS, { dirty: true, settings: { leadMin: 15, weeklyGuard: 50 } }),
    sub(`${INLINE_COLUMNS} columns, help shown for the longest help (keep warm for: one line, truncated)`, INLINE_COLUMNS, { tip: 'keepFor' }),
  ]
  const figure = (th: ArtTheme, w: number, cap: string, body: string) => `<figure class="${th}" style="background:${SURFACE[th]};width:${w + 26}px"><figcaption style="color:${th === 'dark' ? '#9a9a9f' : '#6b6b70'}">${cap}</figcaption>${body}</figure>`
  const sheets = [...sheetDefs, ...tips, ...inline]
    .map(d => `<section><h2><b>${esc(d.label)}</b></h2><div class="pair">${(['dark', 'light'] as const)
      .map(th => figure(th, Math.round(d.cols * CELL_PX), `${th} · ${d.cols} columns`, sheet(d.cols, th, d)))
      .join('')}</div></section>`)
    .join('\n')
  // The band line with its hover card shown (the pointer on the line).
  const cardRow: Row = { label: 'on, scheduled', input: base({ ...KEPT, limits: { weekly: 41, overLimit: false, at: T } }) }
  const cards = `<section><h2><b>the band line with its hover card shown (the pointer on the line): 95 columns, in both palettes</b></h2><div class="pair">${(['dark', 'light'] as const)
    .map(th => { const w = Math.round(95 * CELL_PX); return figure(th, w, `${th} · 95 columns · card shown`, band(cardRow, w, th, 95, true)) })
    .join('')}</div></section>`
  const below = `<section><h2><b>below ${INLINE_COLUMNS} columns (or a slot under ${sheetRows(INLINE_COLUMNS) + 1} rows): no sheet, the Pane opens</b></h2><p style="margin:0 0 12px;color:#9a9a9f;max-width:96ch">The gear opens the settings Pane (one Select per setting) instead. A sheet that is open when the band narrows below ${INLINE_COLUMNS} columns, or the slot loses rows, closes and opens the Pane in its place (once). The sheet is never drawn there: it would not fit its 11 rows or the label column and the widest control.</p></section>`
  const large = `<section><h2><b>the segmented control and the dot slider alone, 3x</b> (each selection of the pill; the slider at its first, middle and last stop; the click targets, one per segment or stop, are outlined under "show click targets")</h2><div class="pair">${(['dark', 'light'] as const).map(controlsLarge).join('')}</div></section>`
  const keepRow: Row = { label: 'on, scheduled', input: base({ ...KEPT }) }
  const keeps = [95, 60, 40]
    .map(cols => ({ cols, row: keepRow }))
    .concat([{ cols: 95, row: { label: 'off: the chip is hidden', input: base({ settings: OFF, now: T + 18 * MIN }) } }])
    .map(({ cols, row }) => `<section><h2><b>keep chip, ${cols} columns${cols < 60 ? ' (tiny tier: hidden)' : ''} · ${esc(row.label)}</b></h2><div class="pair">${(['dark', 'light'] as const)
      .map(th => { const w = Math.round(cols * CELL_PX); return `<figure class="${th}" style="background:${SURFACE[th]};width:${w + 26}px"><figcaption style="color:${th === 'dark' ? '#9a9a9f' : '#6b6b70'}">${th} · ${cols} columns</figcaption>${band(row, w, th, cols)}</figure>` })
      .join('')}</div></section>`)
    .join('\n')
  const toggles = (['dark', 'light'] as const)
    .map(th => {
      const c = palette('warm', th)
      return `<figure class="${th}" style="background:${SURFACE[th]};padding:14px 18px;display:inline-flex;gap:24px;align-items:center"><span class="hit" style="width:${TOGGLE_CELLS * CELL_PX}px"><img alt="on" src="${uri(toggleSvg(true, c, cellsPx(TOGGLE_CELLS)))}" width="${cellsPx(TOGGLE_CELLS)}" height="16"></span><span style="color:${th === 'dark' ? '#9a9a9f' : '#6b6b70'}">on</span><span class="hit" style="width:${TOGGLE_CELLS * CELL_PX}px"><img alt="off" src="${uri(toggleSvg(false, c, cellsPx(TOGGLE_CELLS)))}" width="${cellsPx(TOGGLE_CELLS)}" height="16"></span><span style="color:${th === 'dark' ? '#9a9a9f' : '#6b6b70'}">off (${th})</span></figure>`
    })
    .join(' ')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cache-keeper band preview</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:24px 16px 64px;background:#131315;color:#d8d8dc;font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
h1{font-size:18px;margin:0 0 4px}
p.lead{margin:0 0 14px;color:#9a9a9f;max-width:96ch}
p.lead code{color:#c9c9ce}
label.opt{display:inline-block;margin:0 0 18px;color:#c9c9ce;cursor:pointer}
section{margin:0 0 22px}
h2{font-size:13px;font-weight:500;margin:0 0 8px;color:#9a9a9f}h2 b{color:#e4e4e8}
.pair{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 12px}
figure{margin:0;padding:12px;border-radius:10px;max-width:100%;box-sizing:border-box;border:1px solid rgba(128,128,128,.25);overflow:hidden}
figcaption{font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.band{position:relative;box-sizing:border-box;max-width:100%;height:37px;border:1px solid;border-radius:8px;overflow:hidden;font:13px/19px system-ui,-apple-system,Segoe UI,sans-serif;font-weight:400}
.band img{display:block}
.band .right{position:absolute;right:0;top:50%;transform:translateY(-50%);width:${ART_RIGHT.width}px;height:${ART_RIGHT.height}px}
.band .right.top{top:-1px;transform:none}
.band .full{position:absolute;inset:0;height:100%}
.row{position:relative;display:flex;align-items:center;gap:${CELL_PX}px;padding:0 ${CELL_PX}px;height:35px}
.row>img{flex:0 0 auto}
/* The line is the box that gives way: flex 1, min-width 0, clipped; its parts truncate, the countdown image never does. */
.line{position:relative;flex:1 1 0;min-width:0;display:flex;align-items:center;overflow:hidden;white-space:nowrap}
.seg{display:flex;align-items:center;gap:${CELL_PX}px;min-width:0;flex:0 1000 auto;overflow:hidden}
.part{min-width:0;overflow:hidden;text-overflow:ellipsis;flex:0 1000 auto}
.clock{flex:0 0 auto}
/* The hover card: an absolute box over the line, same background, shown while the pointer is on the line. */
.card{position:absolute;inset:0;display:none;align-items:center}
.line:hover .card,.card.on{display:flex}
.ctl{flex:0 0 auto;display:flex;align-items:center;gap:${CELL_PX}px}
.hit{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:19px}
body.targets .hit{outline:1px dashed #ff3b9a;background:rgba(255,59,154,.12)}
.band.sheet{box-sizing:border-box;height:auto;padding:8px ${CELL_PX}px}
.shell{position:relative}
.note{margin:0 0 10px;color:#9a9a9f;max-width:110ch}
figure.cal{padding:12px}
.band.sheet .row{height:${ROW_PX}px;padding:0}
.title{font-weight:600}
.body{position:relative;padding:0 ${2 * CELL_PX}px;display:flex;flex-direction:column}
.sv1{display:flex;gap:${CELL_PX}px;height:${ROW_PX}px;margin-top:${GAP_PX}px;align-items:center;white-space:nowrap;overflow:hidden}
.sv1 span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.settings{margin-top:${GAP_PX}px;display:flex;flex-direction:column}
.prow{display:flex}
.prow.col{flex-direction:column}
.set{flex:1 1 0;min-width:0;display:flex;flex-direction:column}
.set.flow{flex:0 0 auto}
.line1{display:flex;align-items:center;height:${ROW_PX}px;white-space:nowrap}
.lab.lit .t,${IDS.map(id => `.body:has(.lab[data-id="${id}"]:hover,.ctl2[data-id="${id}"]:hover) .lab[data-id="${id}"] .t`).join(',')}{color:var(--accent)}
.lab{display:flex;align-items:center;gap:${CELL_PX}px;min-width:0}
.lab .t{overflow:hidden;text-overflow:ellipsis}
.lab img{flex:0 0 auto}
.lab .mark{flex:0 0 auto;justify-content:flex-start}
.ctl2{display:flex;align-items:center;gap:${CELL_PX}px;flex:0 0 auto}
/* The help: hidden, in the panel's background over the savings row and the blank row under it (19 + 9.5 px; a second line is clipped, a narrow body only); shown by the pointer on its label or control (or drawn shown), the label then in the accent. */
.tip{position:absolute;display:none;top:${GAP_PX}px;left:${2 * CELL_PX}px;right:${2 * CELL_PX}px;overflow:hidden;white-space:normal;align-items:flex-start;font-weight:500}
.tip .one{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.tip.show,${IDS.map(id => `.body:has(.lab[data-id="${id}"]:hover,.ctl2[data-id="${id}"]:hover) .tip[data-id="${id}"]`).join(',')}{display:flex}
.drawn{position:relative;display:inline-flex;align-items:center;flex:0 0 auto}
.drawn img{display:block}
.hits{position:absolute;inset:0;display:flex;justify-content:center;overflow:hidden}
.hits .hit.seg{height:100%;flex:0 0 auto}
body.targets .hits .hit{outline:1px dashed #ff3b9a;outline-offset:-1px;background:rgba(255,59,154,.12)}
.info{margin:6px 0 8px;font:10.5px/1.3 ui-monospace,Menlo,monospace;opacity:.5}
.term{padding:6px 10px;border-radius:6px;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb{opacity:.7}
.dark .info{color:#cfcfd4}.light .info{color:#333}
</style></head><body>
<h1>cache-keeper band preview</h1>
<p class="lead">Generated by <code>cache-keeper/tools/preview.ts</code> from the real modules: the text is <code>policy.bandLine</code>'s at the tier its columns pick (90+ full, 60-89 short, under 60 tiny), the art state is the line's tone, the layout numbers are <code>view.ts</code>'s, and the SVG strings are <code>art.ts</code>'s (as <code>&lt;img&gt;</code>, like the app's plain Svg), so the CSS motion is live and the countdown digits tick by themselves. Bands are 37 px high, radius 8, 1 px edge; the right art sits in a 64 px box centred on the band and clipped by it. The line gives way (clips and truncates) before the controls, which are in the flow at the right end. Hover the line for the expiry card. Under each band, the terminal row. Warm: soft heat glow and rising embers; refreshing: a golden flare every 1.6 s; off: still grey with a faint ember; cooling: a 2 s amber-red pulse; error: a rose 3 s pulse; cold: the ice; dim: still.</p>
<label class="opt"><input type="checkbox" onchange="document.body.classList.toggle('targets',this.checked)"> show click targets (the box each blank Button covers)</label>
${sheets}
${cards}
<h2><b>The switch</b> (28x16 pill, no text; a blank Button covers its whole ${TOGGLE_CELLS}-cell box)</h2>
<p>${toggles}</p>
${keeps}
${bands}
${below}
${large}
</body></html>
`
}

/** The page tools/record-gifs.mjs films (npm run is not needed: `npx -y tsx tools/preview.ts --capture`): the same band and sheet art as above,
 * one slide at a time, dark or light, each slide set by window.show(name, i) so its animation starts from the top. */
function captureHtml(): string {
  const w = Math.round(95 * CELL_PX)
  const only = (h: string) => h.split('\n<div class="info">')[0] as string
  const slide = (th: ArtTheme, body: string, cap: string) =>
    `<div class="stage" style="background:${SURFACE[th]};width:${w + 36}px">${body}<div class="cap" style="color:${th === 'dark' ? '#9a9a9f' : '#6b6b70'}">${esc(cap)}</div></div>`
  const states: [string, Partial<LineInput>][] = [
    ['Warm: the cache is alive and the next refresh is counting down', { ...KEPT, limits: { weekly: 41, overLimit: false, at: T } }],
    ['Refreshing: a tiny refresh is being sent now', { status: { kind: 'refreshing', since: T, attempt: 0 } }],
    ['Cooling: auto-refresh is off and the cache is about to expire', { settings: OFF, now: T + 52 * MIN }],
    ['Cold: the cache expired, the next message pays to rebuild it', { ...COLD }],
  ]
  const full = { refreshes: 84, costUsd: 3.7, avoided: 5, grossUsd: 16.1 }
  const sess = { refreshes: 21, costUsd: 0.8, avoided: 1, grossUsd: 4 }
  const sheetOf = (th: ArtTheme) => slide(th, only(sheet(95, th, { input: base({ ...KEPT }), all: full, session: sess, dirty: false })), 'Settings: hover a label, its i or its control for the help')
  const slides = {
    states: states.map(([cap, o]) => slide('dark', only(band({ label: '', input: base(o) }, w, 'dark', 95)), cap)),
    settings: [sheetOf('dark'), sheetOf('light')],
  }
  // The preview's own stylesheet, so the slides are drawn by exactly its rules.
  const css = (build().match(/<style>[\s\S]*?<\/style>/) as RegExpMatchArray)[0]
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>cache-keeper capture</title>${css}
<style>body{margin:0;padding:0;background:#000}.stage{box-sizing:border-box;padding:18px 18px 12px}.cap{margin-top:12px;font:12.5px/1.2 system-ui,-apple-system,Segoe UI,sans-serif}.info{display:none}</style></head>
<body><div id="root"></div>
<script>const S=${JSON.stringify(slides)};window.show=(n,i)=>{document.getElementById('root').innerHTML=S[n][i]}</script>
</body></html>
`
}

declare const process: { argv: string[] }
const capture = process.argv.includes('--capture')
const here = (f: string) => fileURLToPath(new URL(f, (import.meta as unknown as { url: string }).url))
const out = here(capture ? '../docs/capture.html' : '../docs/preview.html')
const html = capture ? captureHtml() : build()
mkdirSync(here('../docs'), { recursive: true })
writeFileSync(out, html)
console.log(`wrote ${out} (${html.length} chars)`)
