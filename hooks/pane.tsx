// cache-keeper settings pane (design.md §10, brief C, 2c): one savings line, one Select per setting (the band style is /config's alone; each applied to the
// session at once), and a footer; Save as default writes them to the /config rows (defaults.ts). The status line and the
// totals are in /cache status and /cache stats.
// The ui.render hook (component Pane, requestId 'cache-keeper') lives in register.tsx; this file builds the model and the tree.
import type { Elements } from 'claude-code'

import type { Elsewhere, KeepFor, Settings } from '../types'
import { changes, saveAsDefault } from './defaults'
import type { Io } from './io'
import { elsewhereTitle, requestStop, rowText } from './live'
import { safely, savedSettings, sessionKind, setSettings, snapshot } from './keeper'
import { readAllTime } from './log'
import { OPTIONS, savingsOf } from './policy'
import type { Savings } from './policy'
import { NAMES } from './view'
import type { SessionKind } from './view'

export type PaneModel = {
  settings: Settings
  /** What the session pays by: the sheet shows the weekly guard or the 1-hour switch, not both. */
  kind: SessionKind
  /** The session differs from the saved defaults in something that can be saved. */
  dirty: boolean
  /** The savings line: what the refreshes saved, overall and this session. */
  savings: Savings
  /** The user's other warming sessions (the "Warming elsewhere" section), and the time their idle spans count from. */
  elsewhere: Elsewhere[]
  now: number
}

export async function paneModel(io: Io): Promise<PaneModel> {
  const s = await snapshot(io)
  const all = await readAllTime(io)
  return {
    settings: s.settings,
    kind: sessionKind(),
    dirty: Object.keys(changes(s.settings, savedSettings())).length > 0,
    savings: savingsOf(all, s.session),
    elsewhere: s.elsewhere,
    now: s.now,
  }
}

export type Row = {
  key: string
  label: string
  options: readonly { value: string; label: string }[]
  value: (s: Settings) => string
  patch: (v: string) => Partial<Settings>
}
const opt = (values: readonly (string | number)[], label: (v: string) => string) =>
  values.map(v => ({ value: String(v), label: label(String(v)) }))

export const ROWS: readonly Row[] = [
  {
    key: 'ck-keepFor', label: NAMES.keepFor,
    options: opt(OPTIONS.keepFor, v => (v === 'off' ? 'Off' : v === 'forever' ? 'No end' : v)),
    value: s => s.keepFor,
    patch: v => ({ keepFor: v as KeepFor }),
  },
  {
    key: 'ck-lead', label: NAMES.lead,
    options: opt(OPTIONS.lead, v => `${v} min`),
    value: s => String(s.leadMin),
    patch: v => ({ leadMin: Number(v) }),
  },
  {
    key: 'ck-minTokens', label: NAMES.minTokens,
    options: opt(OPTIONS.minTokens, v => `${Number(v) / 1000}k`),
    value: s => String(s.minTokens),
    patch: v => ({ minTokens: Number(v) }),
  },
  {
    key: 'ck-weeklyGuard', label: NAMES.weeklyGuard,
    options: opt(OPTIONS.weeklyGuard, v => `${v}%`),
    value: s => String(s.weeklyGuard),
    patch: v => ({ weeklyGuard: Number(v) }),
  },
  {
    key: 'ck-upgradeTo1h', label: NAMES.api,
    options: opt(['off', 'on'], v => (v === 'on' ? '1-hour cache' : 'off')),
    value: s => (s.upgradeTo1h ? 'on' : 'off'),
    patch: v => ({ upgradeTo1h: v === 'on' }),
  },
]

/** A change applies to the session at once (reschedules); Save as default and Close are presses. */
export const paneActions = (io: Io, onClose: () => Promise<unknown> = () => io.closePane()) => ({
  set: (patch: Partial<Settings>) => void safely(io, 'pane.set', () => setSettings(io, patch)),
  save: () =>
    void safely(io, 'pane.save', async () => {
      const s = await snapshot(io)
      await saveAsDefault(io, s.settings, savedSettings())
    }),
  close: () => void safely(io, 'pane.close', onClose),
  /** Asks other sessions to stop: their live files get a stop request, and their rows say "stopping…" until they report back. */
  stop: (targets: readonly Elsewhere[]) => void safely(io, 'pane.stop', () => requestStop(io, targets)),
})

/** The savings in one line: the figure bold and the session dim, or one dim line until something was avoided. */
export const savingsLine = (ui: Elements['terminal'] | Elements['desktop'] | Elements['vscode'], m: PaneModel) => {
  const { Box, Text } = ui
  return m.savings.has ? (
    <Box key="ck-savings" flexDirection="row" gap={1}>
      <Text bold>{m.savings.hero}</Text>
      <Text dimColor wrap="truncate">{`· ${m.savings.session}`}</Text>
    </Box>
  ) : (
    <Text key="ck-savings" dimColor wrap="wrap">
      {m.savings.empty}
    </Text>
  )
}

/** The "Warming elsewhere" section: a row per other session with a Stop button (or "stopping…"), and Stop all from two. At most MAX_ROWS rows; /cache sessions has the rest. */
const MAX_ROWS = 5
const elsewhereSection = (ui: Elements['terminal'] | Elements['desktop'] | Elements['vscode'], m: PaneModel, act: ReturnType<typeof paneActions>) => {
  const { Box, Text, Button } = ui
  if (m.elsewhere.length === 0) return null
  const live = m.elsewhere.filter(e => !e.stopping)
  return (
    <Box key="ck-elsewhere" flexDirection="column">
      <Text bold>{elsewhereTitle(m.elsewhere.length)}</Text>
      {m.elsewhere.slice(0, MAX_ROWS).map(e => (
        <Box key={`ck-else-${e.sessionId}`} flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor={e.stopping === true} wrap="truncate">{rowText(e, m.now)}</Text>
          </Box>
          {e.stopping ? null : <Button key={`ck-stop-${e.sessionId}`} label="Stop" onPress={() => act.stop([e])} />}
        </Box>
      ))}
      {m.elsewhere.length > MAX_ROWS ? <Text dimColor>{`+${m.elsewhere.length - MAX_ROWS} more: /cache sessions`}</Text> : null}
      {m.elsewhere.length >= 2 && live.length > 0 ?<Button key="ck-stop-all" label="Stop all" onPress={() => act.stop(live)} /> : null}
    </Box>
  )
}

export function paneTree(
  ui: Elements['terminal'] | Elements['desktop'] | Elements['vscode'],
  m: PaneModel,
  act: ReturnType<typeof paneActions>,
) {
  const { Box, Button, Select } = ui
  return (
    <Box flexDirection="column" gap={1}>
      {savingsLine(ui, m)}
      {elsewhereSection(ui, m, act)}
      <Box flexDirection="column">
        {ROWS.map(r => {
          // /cache lead 7 puts a value in the session that the row does not list: show it rather than a wrong pick.
          const cur = r.value(m.settings)
          const options = r.options.some(o => o.value === cur) ? r.options : [...r.options, { value: cur, label: cur }]
          return <Select key={r.key} label={r.label} options={options} value={cur} onSelect={v => act.set(r.patch(v))} />
        })}
      </Box>
      <Box flexDirection="row" gap={1}>
        {m.dirty ? <Button key="ck-save" variant="primary" label="Save as default" hotkey="s" onPress={act.save} /> : null}
        <Button key="ck-close" label="Close" hotkey="c" onPress={act.close} />
      </Box>
    </Box>
  )
}
