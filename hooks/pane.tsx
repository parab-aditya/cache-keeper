// cache-keeper settings pane (design.md §10, brief C, 2c): one savings line, one Select per setting (the band style is /config's alone; each applied to the
// session at once), and a footer; Save as default writes them to the /config rows (defaults.ts). The status line and the
// totals are in /cache status and /cache stats.
// The ui.render hook (component Pane, requestId 'cache-keeper') lives in register.tsx; this file builds the model and the tree.
import type { Elements } from 'claude-code'

import type { KeepFor, Settings } from '../types'
import { changes, saveAsDefault } from './defaults'
import type { Io } from './io'
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
}

export async function paneModel(io: Io): Promise<PaneModel> {
  const s = await snapshot(io)
  const all = await readAllTime(io)
  return {
    settings: s.settings,
    kind: sessionKind(),
    dirty: Object.keys(changes(s.settings, savedSettings())).length > 0,
    savings: savingsOf(all, s.session),
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

export function paneTree(
  ui: Elements['terminal'] | Elements['desktop'] | Elements['vscode'],
  m: PaneModel,
  act: ReturnType<typeof paneActions>,
) {
  const { Box, Button, Select } = ui
  return (
    <Box flexDirection="column" gap={1}>
      {savingsLine(ui, m)}
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
