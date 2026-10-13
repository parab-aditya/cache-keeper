// Click targets for drawn controls (the band's toggle, gear and keep chip, the sheet's segments and slider stops). A custom control
// is an Svg with a blank Button laid over it (pattern from HeyCubit/effortless, MIT); band.tsx and sheet.tsx draw both through these two.
import type { Elements } from 'claude-code'

import { CELL_PX, cellsPx, hitLabel } from './view'

type Desktop = Elements['desktop']

/** The absolute layer's one cell: a Box `cells` wide that clips a blank Button whose label is far wider than it. One NBSP is ~2.6 px, not a cell. */
function cell(ui: Desktop, key: string, cells: number, px: number, onPress: () => void, scope?: string) {
  const { Box, Button } = ui
  return (
    <Box key={`${key}-cell`} flexShrink={0} width={cells} flexDirection="row" alignItems="center" justifyContent="center" overflow="hidden">
      <Box flexShrink={0}>
        <Button key={key} plain label={hitLabel(px)} hover={{ backgroundColor: '#00000000', ...(scope ? { scope } : {}) }} onPress={onPress} />
      </Box>
    </Box>
  )
}

/**
 * A drawn control with blank Buttons over it. The Svg is exactly the box (`cells` wide, summed); the Buttons sit in an absolute layer
 * over the whole box, one per entry of `cells`, each in a Box exactly that many cells wide (so each covers exactly its own part of the
 * drawing) that clips a label of no-break spaces far wider than it. One segment = the toggle, the gear, the chip; several = a
 * segmented control's segments or a slider's stops. A `scope` puts every Button in that hover group (a sheet setting's: an Svg is never a pointer
 * target, so the blank Buttons over it have to carry the group).
 */
export function hitRow(
  ui: Desktop,
  o: { id: string; cells: readonly number[]; svg: string; alt: string; height: number; keys: readonly string[]; onPress: (i: number) => void; scope?: string },
) {
  const { Box, Svg } = ui
  const total = o.cells.reduce((a, b) => a + b, 0)
  return (
    <Box key={`${o.id}-box`} position="relative" flexShrink={0} width={total} height={1} flexDirection="row" alignItems="center">
      <Svg source={o.svg} alt={o.alt} width={cellsPx(total)} height={o.height} />
      <Box position="absolute" top={0} bottom={0} left={0} right={0} flexDirection="row" justifyContent="center" overflow="hidden">
        {o.cells.map((c, i) => cell(ui, o.keys[i] as string, c, c * CELL_PX, () => o.onPress(i), o.scope))}
      </Box>
    </Box>
  )
}

/** One drawn control with one blank Button over all of it. */
export function hit(ui: Desktop, o: { id: string; cells: number; svg: string; alt: string; height: number; onPress: () => void }) {
  return hitRow(ui, { id: o.id, cells: [o.cells], svg: o.svg, alt: o.alt, height: o.height, keys: [o.id], onPress: o.onPress })
}
