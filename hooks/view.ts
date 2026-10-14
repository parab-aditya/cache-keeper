// The band's view model, pure: the control set, the click-target sizes, the sheet's settings (labels, hover help) and its row count. band.tsx and
// sheet.tsx draw from it and tools/preview.ts draws the same rows, so the three cannot drift apart.
import type { KeepFor, Settings } from '../types'
import type { ArtState } from './art'
import { OPTIONS } from './policy'
import type { Line } from './policy'

/** One terminal cell in CSS px on the desktop app (measured by effortless); widths there are counted in cells. */
export const CELL_PX = 7.9
/** One no-break space in a Button label is about this wide (effortless measured it: ~2.6 px, not a cell), which is why a
 * blank label of a few spaces covered only the far left of a control. */
export const NBSP_PX = 2.6

/** A blank Button label that covers `px` of a control and more: the box around it clips the rest. */
export const hitLabel = (px: number): string => ' '.repeat(Math.ceil((px / NBSP_PX) * 1.6))

/** The drawn controls' boxes, in cells: the Svg is exactly this wide and so is the layer the blank Button covers. */
export const TOGGLE_CELLS = 4
/** The sheet's switch is 20 px tall (the header's stays 16): a wider box for it. */
export const SHEET_TOGGLE_CELLS = 5
/** The height of the sheet's drawn controls (the pills, the slider, the switch), in px. */
export const CONTROL_PX = 20
/** The inline tier's controls: its settings sit in adjacent rows of ~19 px with no blank row between, so 20 px controls would touch (2 px of air). */
export const INLINE_CONTROL_PX = 17
export const GEAR_CELLS = 3
export const CHIP_CELLS = 5
/** The elsewhere chip (a flame and one or two characters): a little wider than the keep chip. */
export const ELSEWHERE_CELLS = 6
/** The header's Save as default pill: its label (15 characters) and a little air. */
export const SAVE_CELLS = 17
export const cellsPx = (cells: number): number => Math.floor(cells * CELL_PX)

/** Does a band `columns` wide leave the cold flakes' strip (art x 125..210, band x W-315..W-230) clear of a line of `cells`?
 * Glyphs are narrower than their cells (about 0.75 of CELL_PX), and the dot and paddings take 34 px. */
export const coldStripFits = (columns: number, cells: number): boolean => columns * CELL_PX - 315 >= 34 + cells * CELL_PX * 0.75

/** The art a line gets is its tone. */
export const artStateOf = (line: Line): ArtState => line.tone

export type ButtonKey = 'toggle' | 'settings' | 'keep' | 'elsewhere'

/** Wide enough for two columns of settings (each half of the body, 5 cells apart); below this, and from INLINE_COLUMNS up, one row per setting.
 * tests/band.test.ts checks it against the widest control (two of them, the gutter and the body's 8 cells fit from 87). */
export const TWO_COLUMNS = 90
/** The cells between the two columns. */
export const GUTTER_CELLS = 5
/** The info mark (a 13 px Svg) in px and in cells, rounded up. */
export const MARK_PX = 13
export const MARK_CELLS = Math.ceil(MARK_PX / CELL_PX)
/** The inline tier's label column, in cells: the longest label a person can reach (`Stop at weekly usage · 50%`, 26), a gap, the mark, and a
 * gap of padding inside the label Box (so no dead space sits between a label and its control). tests/band.test.ts derives it from the real strings. */
export const LABEL_CELLS = 30
/** Narrower than this the inline tier does not fit (body = columns - 8: border 2, band padding 2, sheet padding 4): the label column and the widest
 * control with its value (the slider, 30 cells, a gap and `15 min`). Below it the gear opens the Pane. tests/band.test.ts derives it. */
export const INLINE_COLUMNS = 75

export type SheetId = 'keepFor' | 'lead' | 'minTokens' | 'weeklyGuard' | 'api'
/** What the session pays by: it decides the fourth setting (a subscription has weekly plan usage and already gets the 1-hour cache, an API key the reverse). */
export type SessionKind = 'subscription' | 'api-key'
/** The sheet's settings in two blocks of two, a blank row between them: in two columns a block is a row of two settings, inline a column of two. */
export const sheetBlocks = (kind: SessionKind): SheetId[][] => [['keepFor', 'lead'], ['minTokens', kind === 'api-key' ? 'api' : 'weeklyGuard']]
/** A setting's rows: in two columns a label row above its control row, inline the label beside the control. */
export const settingRows = (columns: number): number => (columns >= TWO_COLUMNS ? 2 : 1)

/** The sheet's rows: border 2, the band's header row 1, a blank row, the savings line, a blank row, the two blocks of two settings and the blank row between them:
 * 11 in either layout (two columns: two rows a setting, two settings a row; inline: one row a setting). */
export const sheetRows = (_columns: number): number => 2 + 1 + 1 + 1 + 1 + 2 + 1 + 2
/** The slot may hold the sheet when it has the rows and one to spare (it drops a taller tree whole, without a word) and the columns. */
export const sheetFits = (maxRows: number, columns: number): boolean =>
  Number.isFinite(maxRows) && maxRows >= sheetRows(columns) + 1 && columns >= INLINE_COLUMNS

/** The settings' names, one source for the sheet's labels and the Pane's. */
export const NAMES: Record<SheetId, string> = {
  keepFor: 'Keep warm for',
  lead: 'Refresh before it expires',
  minTokens: 'Skip chats smaller than',
  weeklyGuard: 'Stop at weekly usage',
  api: '1-hour cache for API keys',
}

export type Stop = { value: string; label: string }
/** One setting as the sheet shows it: `name` is the label's words (also the name in the info mark's alt text), `label` adds the exact value a stop cannot show, `help` is the plain-language hover text, `value` the short text beside a control that cannot show it. */
type Base = { id: SheetId; name: string; label: string; help: string; value: string }
export type SheetRow =
  | (Base & { kind: 'seg'; id: 'keepFor' | 'minTokens' | 'weeklyGuard'; stops: Stop[]; selected: number; patch: (v: string) => Partial<Settings> })
  | (Base & { kind: 'dots'; id: 'lead'; stops: Stop[]; selected: number; patch: (v: string) => Partial<Settings> })
  | (Base & { kind: 'toggle'; id: 'api'; on: boolean })

const stops = (values: readonly (string | number)[], label: (v: string) => string): Stop[] => values.map(v => ({ value: String(v), label: label(String(v)) }))
/** The stop nearest `n` (the lower one on a tie); -1 when there is no number. */
const nearest = (list: readonly Stop[], n: number): number =>
  Number.isFinite(n) ? list.reduce((best, s, i) => (Math.abs(Number(s.value) - n) < Math.abs(Number(list[best]?.value) - n) ? i : best), 0) : -1
const kLabel = (n: number): string => `${n / 1000}k`

/** The stops the sheet draws: a subset of what /config offers (keep warm for has no Off here, the switch is that; weekly guard no 50). */
export const KEEP_STOPS: Stop[] = stops(['2h', '4h', '8h', '12h', 'forever'], v => (v === 'forever' ? '∞' : v))
export const LEAD_STOPS: Stop[] = stops(OPTIONS.lead, v => v)
export const TOKEN_STOPS: Stop[] = stops(OPTIONS.minTokens, v => kLabel(Number(v)))
export const GUARD_STOPS: Stop[] = stops([75, 80, 90, 95, 100], v => `${v}%`)

/** The hover help, in plain words: it replaces the savings line while the pointer is on a setting's label or control. */
export const HELP: Record<SheetId, string> = {
  keepFor: 'How long your chat stays ready after your last message. ∞: no end.',
  lead: 'Minutes before expiry to refresh. More leaves room for retries.',
  minTokens: 'Small chats are cheap to reload, so they are not kept warm.',
  weeklyGuard: 'Refreshing stops when your weekly plan usage reaches this level.',
  api: 'API-key sessions cache for 5 minutes by default. Turn on to ask for the 1-hour cache.',
}

/**
 * What the sheet shows for `s`: four settings with the stop selected (the first three, then the weekly guard on a subscription or the 1-hour switch on an API key). A value the stops do not list (/cache lead 7, a guard of 50)
 * selects the nearest stop and names the exact value (beside the slider, or after the label); Off selects none.
 */
export function sheetModel(s: Settings, kind: SessionKind = 'subscription'): SheetRow[] {
  /** The selected stop, and whether the value is one of them (else the nearest, the exact value then goes in the label). */
  const pick = (list: Stop[], n: number) => {
    const i = list.findIndex(x => Number(x.value) === n)
    return i >= 0 ? { selected: i, listed: true } : { selected: nearest(list, n), listed: false }
  }
  const num = (id: 'minTokens' | 'weeklyGuard', name: string, list: Stop[], n: number, exact: string, help: string, patch: (v: string) => Partial<Settings>): SheetRow => {
    const p = pick(list, n)
    return { kind: 'seg', id, name, label: p.listed ? name : `${name} · ${exact}`, help, value: '', stops: list, selected: p.selected, patch }
  }
  const lead = pick(LEAD_STOPS, s.leadMin)
  return [
    {
      kind: 'seg', id: 'keepFor', name: NAMES.keepFor, label: s.keepFor === 'off' ? `${NAMES.keepFor} · off` : NAMES.keepFor,
      help: HELP.keepFor, value: '', stops: KEEP_STOPS,
      selected: KEEP_STOPS.findIndex(x => x.value === s.keepFor), // Off selects none
      patch: v => ({ keepFor: v as KeepFor }),
    },
    { kind: 'dots', id: 'lead', name: NAMES.lead, label: NAMES.lead, help: HELP.lead, value: `${s.leadMin} min`, stops: LEAD_STOPS, selected: lead.selected, patch: v => ({ leadMin: Number(v) }) },
    num('minTokens', NAMES.minTokens, TOKEN_STOPS, s.minTokens, kLabel(s.minTokens), HELP.minTokens, v => ({ minTokens: Number(v) })),
    kind === 'api-key'
      ? { kind: 'toggle', id: 'api', name: NAMES.api, label: NAMES.api, help: HELP.api, value: '', on: s.upgradeTo1h }
      : num('weeklyGuard', NAMES.weeklyGuard, GUARD_STOPS, s.weeklyGuard, `${s.weeklyGuard}%`, HELP.weeklyGuard, v => ({ weeklyGuard: Number(v) })),
  ]
}

/** A segment's width in cells from its label (at least 6): the same count the Svg is drawn with and each blank Button covers. */
export const segCells = (label: string): number => Math.max(6, [...label].length + 4)
/** A dot slider's stop is this many cells wide (equal slices of the track). */
export const STOP_CELLS = 6
