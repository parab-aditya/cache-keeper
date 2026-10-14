// cache-keeper band (design.md §9, brief 2b). The structure of the desktop band is HeyCubit/effortless's (MIT, (c) 2026
// HeyCubit): a rounded root with absolute art layers, a dot, the line, and the controls; a custom control is a drawn Svg
// with a blank Button laid over it. The controls are in the flow at the right end and the line gives way to them (it
// truncates), so text never runs under a control. The ui.render hook itself lives in register.tsx (the loader follows `$`
// and `on` only inside that file); this file builds the model and the tree.
import type { Elements, RenderElement } from 'claude-code'

import type { KeepFor } from '../types'
import { PALETTE, artLayers, chipSvg, clockFrames, clockSvg, closeSvg, dotSvg, emberSvg, gearSvg, saveSvg, toggleSvg } from './art'
import type { ArtColors, ArtState } from './art'
import { hit } from './hit'
import type { Io } from './io'
import { A, lineInputOf, openSettings, safely, setSettings, setSheet, snapshot, themeSoon, toggleWarming } from './keeper'
import { paneActions, paneModel } from './pane'
import type { PaneModel } from './pane'
import { elsewhereTitle } from './live'
import { bandLine, fmtMinutes, keepLabel, lineText, nextKeep, tierOf } from './policy'
import type { Line, Seg, Tier } from './policy'
import { sheetBody } from './sheet'
import type { SheetActions } from './sheet'
import { CELL_PX, CHIP_CELLS, ELSEWHERE_CELLS, GEAR_CELLS, SAVE_CELLS, TOGGLE_CELLS, artStateOf, cellsPx, coldStripFits, sheetFits } from './view'
import type { ButtonKey } from './view'

export type BandModel = {
  /** Null when there is nothing to say (no request yet): only an open sheet is drawn then. */
  line: Line | null
  minimal: boolean
  art: ArtState
  light: boolean
  /** `$.clock.now()` at this render: the phase every looping animation is locked to. */
  nowMs: number
  /** Warming is on (the toggle is right). */
  on: boolean
  /** The session's window: what the keep chip shows (it is hidden while warming is off). */
  keepFor: KeepFor
  tier: Tier
  /** How many of the user's other sessions are warming (the ember chip shows it; 0 hides the chip). */
  elsewhere: number
  /** The settings sheet is open (desktop, full style, room for it): its body's model. */
  sheet: PaneModel | null
}

/** Where a band is drawn: what a gear press needs to decide between the sheet and the Pane. */
export type Geo = { desktop: boolean; columns: number; maxRows: number }

/** What to draw, or null when the band is off, a survey owns the slot, or there is nothing to say. */
export async function bandModel(io: Io, hasSurvey: boolean, geo: Geo): Promise<BandModel | null> {
  const s = await snapshot(io)
  if (s.settings.band === 'off' || hasSurvey) return null
  themeSoon(io)
  const tier = tierOf(geo.columns)
  const line = bandLine(lineInputOf(s), s.settings.band, tier)
  const open = s.sheetOpen && geo.desktop && s.settings.band === 'full'
  const fits = sheetFits(geo.maxRows, geo.columns)
  // A sheet the slot has shrunk below drops the whole tree: draw the band, then close the sheet and open the Pane in its place, after the draw.
  // The state read-and-clear makes it once per close, however many draws queued one.
  if (open && !fits) void io.after(0, () => void safely(io, 'sheet.close', () => closeToPane(io)))
  if (!line && !(open && fits)) return null
  return {
    line,
    minimal: s.settings.band === 'minimal',
    art: line ? artStateOf(line) : 'dim',
    light: s.light,
    nowMs: s.now,
    on: s.settings.keepFor !== 'off',
    keepFor: s.settings.keepFor,
    tier,
    elsewhere: s.elsewhere.length,
    sheet: open && fits ? await paneModel(io) : null,
  }
}

/** Closes the open sheet and opens the Pane in its place (once: a second call finds the sheet already closed). */
async function closeToPane(io: Io): Promise<void> {
  let was = false
  await io.update(A.sheetOpen, v => ((was = v), false))
  if (was && !(await io.openPane())) io.toast('cache-keeper: widen the window to see the settings')
}

/** A button press: writes state (never during a render), then the scheduler looks again. */
export const pressButton = (io: Io, key: ButtonKey, geo: Geo): Promise<void> =>
  safely(io, `band.${key}`, async () => {
    if (key === 'toggle') return toggleWarming(io)
    // The chip opens the list: the Pane's "Warming elsewhere" section.
    if (key === 'elsewhere') return void ((await io.openPane()) || io.toast('cache-keeper: widen the window to see the other sessions'))
    if (key === 'keep') {
      const { keepFor } = await io.read(A.settings)
      // Off has no window to cycle: the chip is hidden then; a stale press does nothing.
      return keepFor === 'off' ? undefined : setSettings(io, { keepFor: nextKeep(keepFor) })
    }
    // The gear again closes the sheet.
    if (await io.read(A.sheetOpen)) return void (await setSheet(io, false))
    if ((await openSettings(io, geo)) === 'none') io.toast('cache-keeper: widen the window to see the settings')
  })

/** What the sheet's own controls do (the pane's, with Close shutting the sheet). */
export const sheetActions = (io: Io): SheetActions => paneActions(io, () => setSheet(io, false))

type Press = (key: ButtonKey) => void

/** Terminal colours are theme keys (they follow the person's theme); the ember and the cold ice blue are raw, darker on a light theme. */
const termColor = (art: ArtState, light: boolean): string =>
  art === 'warm' || art === 'refreshing' ? (light ? '#b45309' : '#f39a52')
  : art === 'cooling' ? 'warning'
  : art === 'error' ? 'error'
  : art === 'cold' ? (light ? '#0b6bcb' : '#7cc4ff')
  : 'inactive'

type Desktop = Elements['desktop']

/** A countdown as a self-ticking image (no redraw), in the band's text colour. */
function clock(ui: Desktop, ms: number, color: string) {
  const { Box, Svg } = ui
  const frames = clockFrames(ms, fmtMinutes)
  const svg = clockSvg(frames, color)
  const w = /^<svg[^>]* width="(\d+)"/.exec(svg)?.[1]
  return (
    <Box flexShrink={0}>
      <Svg source={svg} alt={frames[0]?.label ?? ''} width={Number(w)} height={17} />
    </Box>
  )
}

/** A text with a countdown in it, in a row that gives way from the right: each part truncates, the countdown never does. */
function segRow(ui: Desktop, seg: Seg, color: string, dim: string) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1000} minWidth={0} overflow="hidden">
      {seg.pre ? (
        <Box flexShrink={1000} minWidth={0}>
          <Text color={color} wrap="truncate">
            {seg.word ? <Text bold>{seg.word}</Text> : null}
            {seg.word ? seg.pre.slice(seg.word.length) : seg.pre}
          </Text>
        </Box>
      ) : null}
      {seg.ms !== null ? clock(ui, seg.ms, color) : null}
      {seg.post ? (
        <Box flexShrink={1000} minWidth={0}>
          <Text color={dim} wrap="truncate">
            {seg.post}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

function desktop(ui: Desktop, columns: number, m: BandModel, press: Press, close: () => void, inner: RenderElement, sheetAct: SheetActions) {
  const { Box, Text, Svg } = ui
  const c: ArtColors = PALETTE[m.light ? 'light' : 'dark'][m.art]
  const line = m.line
  // The full-width overlays are drawn at the band's width: the app scales an Svg down to its box but never up.
  const fullWidth = Math.max(760, Math.round(columns * CELL_PX))
  const open = m.sheet !== null
  const gearPx = cellsPx(GEAR_CELLS)
  // The keep chip is the window: hidden while warming is off (there is no window then), in the tiny tier (no room) and while the sheet is
  // open (its first row is the window then).
  const showKeep = m.on && m.tier !== 'tiny' && !open
  // Beside it, a flame and a count while other sessions are warming (hidden at none and while the sheet is open, like the keep chip). Ember whatever this band's tone.
  const showElsewhere = m.elsewhere > 0 && !open
  const layers = artLayers(m.art, { light: m.light, nowMs: m.nowMs, strip: coldStripFits(columns, Array.from(line?.text ?? '').length), fadeDown: open })
  return (
    <Box flexDirection="column">
      <Box
        key="ck-band"
        position="relative"
        flexDirection="column"
        paddingX={1}
        overflow="hidden"
        borderStyle="round"
        backgroundColor={c.bg}
        borderColor={c.edge}
      >
        {/* Art stays behind in absolute layers; the sheet has no full-width overlay (it is taller than the 37 px they are drawn for). */}
        {layers
          .filter(l => l.anchor === 'right' || !open)
          .map(l =>
            l.anchor === 'right' ? (
              // Taller than the band and clipped by it, so the art reaches every edge on the right.
              <Box key={l.key} position="absolute" top={-1} right={0} {...(open ? {} : { bottom: -1 })}>
                <Svg source={l.svg} alt={`cache ${m.art} art`} width={l.width} height={l.height} />
              </Box>
            ) : (
              <Box key={l.key} position="absolute" top={0} left={0} right={0} bottom={0}>
                <Svg source={l.svg} alt={`cache ${m.art} rim`} width={fullWidth} height={l.height} />
              </Box>
            ),
          )}
        <Box key="ck-row" flexDirection="row" gap={1} alignItems="center">
          <Box flexShrink={0}>
            <Svg source={dotSvg(m.art, m.light, m.nowMs)} alt={`cache ${m.art}`} width={10} height={10} />
          </Box>
          {open ? (
            <Box flexShrink={0}>
              <Text color={c.accent} bold>
                cache-keeper
              </Text>
            </Box>
          ) : null}
          {/* The line and, over it, the card the pointer reveals (an absolute child painted over the line, same background). */}
          <Box key="ck-line" position="relative" flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1000} minWidth={0} overflow="hidden">
            {line ? segRow(ui, line, c.text, c.dim) : null}
            {line?.hover ? (
              <Box
                position="absolute"
                top={0}
                bottom={0}
                left={0}
                right={0}
                flexDirection="row"
                alignItems="center"
                backgroundColor={c.bg}
                display="none"
                hover={{ display: 'flex' }}
              >
                {segRow(ui, line.hover, c.text, c.dim)}
              </Box>
            ) : null}
          </Box>
          {/* The controls are in the flow, as wide as they are: the line above gives way to them. A positioned box paints over the art. */}
          <Box key="ck-controls" position="relative" flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
            <Box position="absolute" top={0} left={0} />
            {showElsewhere ? hit(ui, { id: 'ck-elsewhere', cells: ELSEWHERE_CELLS, svg: emberSvg(m.elsewhere, m.light, cellsPx(ELSEWHERE_CELLS), m.nowMs), alt: elsewhereTitle(m.elsewhere), height: 18, onPress: () => press('elsewhere') }) : null}
            {showKeep ? hit(ui, { id: 'ck-keep', cells: CHIP_CELLS, svg: chipSvg(keepLabel(m.keepFor), c, cellsPx(CHIP_CELLS)), alt: `Keep warm for ${m.keepFor === 'forever' ? 'no end' : m.keepFor}`, height: 18, onPress: () => press('keep') }) : null}
            {m.sheet?.dirty ? hit(ui, { id: 'ck-save', cells: SAVE_CELLS, svg: saveSvg('Save as default', c, cellsPx(SAVE_CELLS)), alt: 'Save as default', height: 18, onPress: sheetAct.save }) : null}
            {hit(ui, { id: 'ck-toggle', cells: TOGGLE_CELLS, svg: toggleSvg(m.on, c, cellsPx(TOGGLE_CELLS)), alt: m.on ? 'Auto-refresh on' : 'Auto-refresh off', height: 16, onPress: () => press('toggle') })}
            {open
              ? // Drawn in the gear's stroke and box, not a text glyph; a plain Button, not role="dismiss": the app may draw its own close control at the band's edge for that.
                hit(ui, { id: 'ck-dismiss', cells: GEAR_CELLS, svg: closeSvg(c.text, gearPx), alt: 'Close settings', height: 14, onPress: close })
              : hit(ui, { id: 'ck-settings', cells: GEAR_CELLS, svg: gearSvg(c.text, gearPx), alt: 'Settings', height: 14, onPress: () => press('settings') })}
          </Box>
        </Box>
        {m.sheet ? sheetBody(ui, columns, m.sheet, c, sheetAct) : null}
      </Box>
      {inner}
    </Box>
  )
}

function terminal(ui: Elements['terminal'], m: BandModel, press: Press, inner: RenderElement) {
  const { Box, Text, Button } = ui
  if (!m.line) return inner
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={termColor(m.art, m.light)}>{m.line.symbol}</Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor={m.art === 'dim' || m.art === 'off'} wrap="truncate">
            {m.line.word ? <Text bold>{m.line.word}</Text> : null}
            {m.line.word ? m.line.text.slice(m.line.word.length) : m.line.text}
          </Text>
        </Box>
        {m.elsewhere > 0 ? (
          <Box key="ck-elsewhere" flexShrink={0}>
            <Text dimColor wrap="truncate">{m.tier === 'tiny' ? `+${m.elsewhere}` : `+${m.elsewhere} warming elsewhere`}</Text>
          </Box>
        ) : null}
        {m.on && m.tier !== 'tiny' ? <Button key="ck-keep" label={`keep ${keepLabel(m.keepFor)}`} hotkey="k" onPress={() => press('keep')} /> : null}
        <Button key="ck-toggle" label={m.on ? 'on' : 'off'} hotkey="o" onPress={() => press('toggle')} />
        <Button key="ck-settings" label="settings" hotkey="s" onPress={() => press('settings')} />
      </Box>
      {inner}
    </Box>
  )
}

/** The surface and its element table together: a terminal table also has an `Svg` (an empty fragment), so the surface decides, not the table. */
export type BandUi = { surface: 'desktop'; ui: Elements['desktop'] } | { surface: 'terminal'; ui: Elements['terminal'] }

/** The band above the engine's own tree: art, line and controls on desktop (or the sheet); one row on the terminal; one dim line when minimal. */
export function bandTree(
  target: BandUi,
  columns: number,
  m: BandModel,
  press: Press,
  close: () => void,
  sheetAct: SheetActions,
  inner: RenderElement,
) {
  if (m.minimal && m.line) {
    const { Box, Text } = target.ui
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">
          {m.elsewhere > 0 ? `${lineText(m.line)} · +${m.elsewhere} warming elsewhere` : lineText(m.line)}
        </Text>
        {inner}
      </Box>
    )
  }
  return target.surface === 'desktop' ? desktop(target.ui, columns, m, press, close, inner, sheetAct) : terminal(target.ui, m, press, inner)
}

