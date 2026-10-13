// The settings sheet (brief 2b §4, 2c §2, 2d, 2e, 2f): when the gear is pressed on the desktop, the band becomes a taller rounded panel in the
// same palette and art. band.tsx draws the panel and its header row (title, line, Save as default when the session differs, the
// switch, a drawn close); this file draws the body below it: a blank row, the savings line, a blank row, then four settings in two blocks with a blank row
// between them (view.sheetBlocks: the weekly guard on a subscription, the 1-hour switch on an API key). In two columns (90+) a block is a row of two settings,
// each a label row above its control row; inline a block is two rows, the label column then the control. A label, a drawn info mark, a control in one
// drawn-control vocabulary (the segmented pill, the dot slider, the switch), each a drawn Svg with blank Buttons over it (hit.tsx); an Svg is never a
// pointer target, so every Text and Button of a setting (and a blank Text over the mark) names the setting's hover scope itself. Hovering a setting shows its
// help in place of the savings line: one hidden absolute Box per setting (the help alone, no name in front: the longest help is about 600 px, a name in
// front would wrap most of them), revealed through the hover scope `ck-tip-<id>`. `view.sheetRows` counts the rows (11 in both layouts), view.sheetModel
// says what each setting shows. No hotkeys, no Select, no footer, no captions.
import type { Elements } from 'claude-code'

import type { Settings } from '../types'
import { infoSvg, segSvg, sliderSvg, toggleSvg } from './art'
import type { ArtColors } from './art'
import { hitRow } from './hit'
import type { PaneModel } from './pane'
import { CONTROL_PX, GUTTER_CELLS, INLINE_CONTROL_PX, LABEL_CELLS, MARK_CELLS, MARK_PX, SHEET_TOGGLE_CELLS, STOP_CELLS, TWO_COLUMNS, cellsPx, hitLabel, segCells, settingRows, sheetBlocks, sheetModel } from './view'
import type { SheetRow } from './view'

/** What the sheet's controls do: a setting applies to the session at once, Save as default (the header pill), close (the header mark). */
export type SheetActions = { set: (patch: Partial<Settings>) => void; save: () => void; close: () => void }

/** The hover group a setting's label, control and help share. */
export const tipScope = (id: string): string => `ck-tip-${id}`

export function sheetBody(ui: Elements['desktop'], columns: number, m: PaneModel, c: ArtColors, act: SheetActions) {
  const { Box, Text, Svg } = ui
  const two = columns >= TWO_COLUMNS
  // Inline, a setting's row is ~19 px with no blank row beside it: a 20 px control would touch its neighbour's.
  const ctlPx = two ? CONTROL_PX : INLINE_CONTROL_PX
  // Every Text and Button of a setting names its group itself: a Box's scope is not enough (an Svg is an image and never a pointer target).
  const control = (r: SheetRow) => {
    const scope = tipScope(r.id)
    if (r.kind === 'toggle') {
      return hitRow(ui, {
        id: 'ck-api-toggle', cells: [SHEET_TOGGLE_CELLS], svg: toggleSvg(r.on, c, cellsPx(SHEET_TOGGLE_CELLS), ctlPx), height: ctlPx, keys: ['ck-api-toggle'],
        alt: `1-hour cache for API keys, ${r.on ? 'on' : 'off'}`,
        onPress: () => act.set({ upgradeTo1h: !r.on }), scope,
      })
    }
    const dots = r.kind === 'dots'
    const cells = r.stops.map(s => (dots ? STOP_CELLS : segCells(s.label)))
    const px = cellsPx(cells.reduce((a, b) => a + b, 0))
    const pre = dots ? 'ck-dot-lead-' : `ck-seg-${r.id}-`
    return hitRow(ui, {
      id: `ck-${dots ? 'dots' : 'seg'}-${r.id}`,
      cells,
      svg: dots ? sliderSvg(r.stops.length, r.selected, c, px, ctlPx) : segSvg(r.stops.map(s => s.label), cells, r.selected, c, px, ctlPx),
      height: ctlPx,
      keys: r.stops.map(s => `${pre}${s.value}`),
      alt: `${r.name}: ${r.stops.map(s => s.label).join(', ')}; ${r.stops[r.selected]?.label ?? 'none'} selected`,
      onPress: i => act.set(r.patch((r.stops[i] as { value: string }).value)),
      scope,
    })
  }
  const rows = sheetModel(m.settings, m.kind)
  // The info mark: the drawn ring, and over exactly its box a blank Text in the setting's group (the Svg itself is no pointer target; the Text is
  // not a Button, so it takes no focus and no press). Its alt carries the help.
  const mark = (r: SheetRow) => (
    <Box key={`ck-mark-${r.id}`} position="relative" flexShrink={0} width={MARK_CELLS} height={1} flexDirection="row" alignItems="center">
      <Svg source={infoSvg(c.dim)} alt={`About ${r.name}: ${r.help}`} width={MARK_PX} height={MARK_PX} />
      <Box position="absolute" top={0} bottom={0} left={0} right={0} overflow="hidden">
        <Box flexShrink={0}>
          <Text hover={{ scope: tipScope(r.id) }}>{hitLabel(MARK_PX)}</Text>
        </Box>
      </Box>
    </Box>
  )
  // The label in the text colour (it is the primary text; it turns accent while its group is lit) and the info mark. Where the control sits beside
  // it (inline) the space between belongs to this Box (paddingRight), so the pointer never crosses a gap on the way to the control; inline the Box is a
  // fixed-width label column.
  const label = (r: SheetRow) => (
    <Box
      key={`ck-label-${r.id}`}
      flexDirection="row"
      alignItems="center"
      gap={1}
      minWidth={0}
      hover={{ scope: tipScope(r.id) }}
      {...(two ? { alignSelf: 'flex-start' as const, flexShrink: 1 } : { width: LABEL_CELLS, flexShrink: 0, paddingRight: 1 })}
    >
      <Box flexShrink={1} minWidth={0}>
        <Text color={c.text} wrap="truncate" hover={{ scope: tipScope(r.id), color: c.accent }}>
          {r.label}
        </Text>
      </Box>
      {mark(r)}
    </Box>
  )
  // The control and the short value beside it (the slider's `5 min`).
  const ctl = (r: SheetRow) => (
    <Box key={`ck-control-${r.id}`} flexDirection="row" alignItems="center" alignSelf="flex-start" gap={1} flexShrink={0} hover={{ scope: tipScope(r.id) }}>
      {control(r)}
      {r.value ? (
        <Text color={c.text} wrap="truncate" hover={{ scope: tipScope(r.id) }}>
          {r.value}
        </Text>
      ) : null}
    </Box>
  )
  // One unit: the label above its control (two columns) or beside it (inline). Units are `second` apart by the gutter.
  const setting = (r: SheetRow, second: boolean) => (
    <Box key={`ck-row-${r.id}`} flexDirection="column" height={settingRows(columns)} {...(two ? { flexGrow: 1, flexShrink: 1, width: 0, minWidth: 0 } : {})} {...(two && second ? { marginLeft: GUTTER_CELLS } : {})}>
      {two ? (
        <Box flexDirection="column" height={2}>
          <Box flexDirection="row" height={1}>
            {label(r)}
          </Box>
          <Box flexDirection="row" height={1}>
            {ctl(r)}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" alignItems="center" height={1}>
          {label(r)}
          {ctl(r)}
        </Box>
      )}
    </Box>
  )
  return (
    <Box key="ck-sheet" position="relative" flexDirection="column" paddingX={2}>
      <Box key="ck-savings" flexDirection="row" marginTop={1}>
        {m.savings.has ? (
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={0}>
              <Text bold color={c.accent}>
                {m.savings.hero}
              </Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <Text color={c.dim} wrap="truncate">
                {`· ${m.savings.session}`}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text color={c.dim} wrap="truncate">
            {m.savings.empty}
          </Text>
        )}
      </Box>
      <Box key="ck-settings-grid" flexDirection="column" marginTop={1}>
        {sheetBlocks(m.kind).map((block, n) => (
          <Box key={`ck-block-${n}`} flexDirection={two ? 'row' : 'column'} {...(n > 0 ? { marginTop: 1 } : {})}>
            {block.map((id, i) => setting(rows.find(r => r.id === id) as SheetRow, i > 0))}
          </Box>
        ))}
      </Box>
      {/* The help, one hidden Box per setting over the savings row and the blank row under it (a long help takes the second line), in the panel's
          background so it covers the savings text (inline, on one truncated line: a second line would be cut through by the 9.5 px blank row; the full help is the mark's alt); the label and control Boxes of the same setting reveal it by the shared scope. */}
      {rows.map(r => (
        <Box
          key={tipScope(r.id)}
          position="absolute"
          top={1}
          left={2}
          right={2}
          height={2}
          overflow="hidden"
          flexDirection="row"
          alignItems="flex-start"
          backgroundColor={c.bg}
          display="none"
          hover={{ scope: tipScope(r.id), display: 'flex' }}
        >
          <Text color={c.text} {...(two ? {} : { wrap: 'truncate' as const })}>
            {r.help}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
