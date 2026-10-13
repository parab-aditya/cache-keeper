// cache-keeper wiring only (design.md §8): every hook delegates to keeper, command or band.
// Observers never change behaviour: our part runs inside `safely`, and every hook returns what `next` returned.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { bandModel, bandTree, pressButton, sheetActions } from './band'
import { ARGUMENT_HINT, runCommand } from './command'
import {
  onClassicSessionStart,
  onClassicStop,
  onCompact,
  onConfigSet,
  onMeasure,
  onModelSwitch,
  onPermission,
  onPromptSubmit,
  onSessionEnd,
  onSubagentStop,
  onToolCall,
  onTurnComplete,
  noteBand,
  onTurnStart,
  refreshTheme,
  resetKeeper,
  setSurface,
  safely,
  start,
  stepEnd,
  stepStart,
} from './keeper'
import type { Io, KeeperState } from './io'
import { resetLog } from './log'
import { paneActions, paneModel, paneTree } from './pane'
import { DEFAULT_SETTINGS } from './policy'

// State ($.state, survives a reload). Declared here, not in keeper.ts: the loader lists a module's state by
// scanning this file, and wants each `read`/`update` to name one of these consts.
// Every atom carries the shape tag 'ck2': a value another version of the code wrote (the Phase 0 spike, an older
// build) reads as absent, so it cannot leave an anchor without a chain. Bump the tag when a shape changes.
const anchorA = atom({ plugin: 'cache-keeper', key: 'anchor' } as const, null, { shape: 'ck2' })
const chainA = atom({ plugin: 'cache-keeper', key: 'chain' } as const, null, { shape: 'ck2' })
const statusA = atom({ plugin: 'cache-keeper', key: 'status' } as const, { kind: 'waiting' }, { shape: 'ck2' })
const settingsA = atom({ plugin: 'cache-keeper', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'ck2' })
const turnA = atom({ plugin: 'cache-keeper', key: 'turn' } as const, null, { shape: 'ck2' })
const dialogA = atom({ plugin: 'cache-keeper', key: 'dialog' } as const, null, { shape: 'ck2' })
const tasksA = atom({ plugin: 'cache-keeper', key: 'tasks' } as const, [], { shape: 'ck2' })
const limitsA = atom({ plugin: 'cache-keeper', key: 'limits' } as const, null, { shape: 'ck2' })
const contextTokensA = atom({ plugin: 'cache-keeper', key: 'contextTokens' } as const, null, { shape: 'ck2' })
const costUsdA = atom({ plugin: 'cache-keeper', key: 'costUsd' } as const, null, { shape: 'ck2' })
const refreshingA = atom({ plugin: 'cache-keeper', key: 'refreshing' } as const, null, { shape: 'ck2' })
const lastA = atom({ plugin: 'cache-keeper', key: 'last' } as const, null, { shape: 'ck2' })
const sessionA = atom({ plugin: 'cache-keeper', key: 'session' } as const, { refreshes: 0, costUsd: 0, avoided: 0, grossUsd: 0, since: 0 }, { shape: 'ck2' })
const resumedA = atom({ plugin: 'cache-keeper', key: 'resumed' } as const, null, { shape: 'ck2' })
const surfaceA = atom({ plugin: 'cache-keeper', key: 'surface' } as const, null, { shape: 'ck2' })
const lightA = atom({ plugin: 'cache-keeper', key: 'light' } as const, false, { shape: 'ck2' })
const sheetOpenA = atom({ plugin: 'cache-keeper', key: 'sheetOpen' } as const, false, { shape: 'ck2' })
const ttlSetA = atom({ plugin: 'cache-keeper', key: 'ttlSet' } as const, false, { shape: 'ck2' })

/** keeper.ts names state by key; each key reads and updates its own atom. */
const stateOf = ($: EngineInterface) => ({
  anchor: { read: () => read($, anchorA), update: (fn: (v: KeeperState['anchor']) => KeeperState['anchor']) => update($, anchorA, fn) },
  chain: { read: () => read($, chainA), update: (fn: (v: KeeperState['chain']) => KeeperState['chain']) => update($, chainA, fn) },
  status: { read: () => read($, statusA), update: (fn: (v: KeeperState['status']) => KeeperState['status']) => update($, statusA, fn) },
  settings: { read: () => read($, settingsA), update: (fn: (v: KeeperState['settings']) => KeeperState['settings']) => update($, settingsA, fn) },
  turn: { read: () => read($, turnA), update: (fn: (v: KeeperState['turn']) => KeeperState['turn']) => update($, turnA, fn) },
  dialog: { read: () => read($, dialogA), update: (fn: (v: KeeperState['dialog']) => KeeperState['dialog']) => update($, dialogA, fn) },
  tasks: { read: () => read($, tasksA), update: (fn: (v: KeeperState['tasks']) => KeeperState['tasks']) => update($, tasksA, fn) },
  limits: { read: () => read($, limitsA), update: (fn: (v: KeeperState['limits']) => KeeperState['limits']) => update($, limitsA, fn) },
  contextTokens: { read: () => read($, contextTokensA), update: (fn: (v: KeeperState['contextTokens']) => KeeperState['contextTokens']) => update($, contextTokensA, fn) },
  costUsd: { read: () => read($, costUsdA), update: (fn: (v: KeeperState['costUsd']) => KeeperState['costUsd']) => update($, costUsdA, fn) },
  refreshing: { read: () => read($, refreshingA), update: (fn: (v: KeeperState['refreshing']) => KeeperState['refreshing']) => update($, refreshingA, fn) },
  last: { read: () => read($, lastA), update: (fn: (v: KeeperState['last']) => KeeperState['last']) => update($, lastA, fn) },
  session: { read: () => read($, sessionA), update: (fn: (v: KeeperState['session']) => KeeperState['session']) => update($, sessionA, fn) },
  resumed: { read: () => read($, resumedA), update: (fn: (v: KeeperState['resumed']) => KeeperState['resumed']) => update($, resumedA, fn) },
  surface: { read: () => read($, surfaceA), update: (fn: (v: KeeperState['surface']) => KeeperState['surface']) => update($, surfaceA, fn) },
  light: { read: () => read($, lightA), update: (fn: (v: KeeperState['light']) => KeeperState['light']) => update($, lightA, fn) },
  sheetOpen: { read: () => read($, sheetOpenA), update: (fn: (v: KeeperState['sheetOpen']) => KeeperState['sheetOpen']) => update($, sheetOpenA, fn) },
  ttlSet: { read: () => read($, ttlSetA), update: (fn: (v: KeeperState['ttlSet']) => KeeperState['ttlSet']) => update($, ttlSetA, fn) },
})

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Every engine call the glue modules make, spelled `$.noun.event(...)` here because the loader follows `$` no further. */
const ioOf = ($: EngineInterface): Io => ({
  now: () => $.clock.now(),
  after: (ms, fn) => $.clock.after(ms, fn),
  read: key => stateOf($)[key].read() as never,
  update: (key, fn) => stateOf($)[key].update(fn as never) as never,
  home: () => $.env.get('HOME'),
  sessionId: () => $.session.id(),
  setTtlEnv: value => $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', value),
  settings: () => $.settings.read(),
  authKind: async () => (await $.session.authorize())?.kind ?? null,
  usage: () => $.session.usage(),
  fork: prompt => $.model.fork({ prompt }),
  append: async text => {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  },
  debug: text => $.ui.log(text, { to: 'debug' }),
  fsExists: path => $.fs.exists(path),
  fsRead: path => $.fs.read(path),
  fsWrite: (path, text) => $.fs.write(path, text),
  run: async argv => {
    const r = await $.process.run(argv, { timeoutMs: 3000 })
    return { exitCode: r.exitCode, stdout: r.stdout }
  },
  storeGet: key => $.store.get(key),
  storeSet: (key, value) => $.store.set(key, value),
  saveConfig: async (key, value) => {
    try {
      const r = await $.config.set({ key, value })
      return r.deny
    } catch (err) {
      return errText(err)
    }
  },
  configRows: async () => (await $.config.list()).map(r => ({ key: r.key, value: r.value })),
  openPane: async () => (await $.ui.open({ id: 'cache-keeper', title: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 })).isPlaced,
  closePane: () => $.ui.close({ id: 'cache-keeper' }),
  invalidate: () => $.ui.invalidate('ui.render'),
  toast: text => $.ui.toast(text),
})

export const register: Register = (on, options) => {
  resetKeeper()
  resetLog()
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    const io = ioOf($)
    try {
      await $.command.register({
        name: 'cache',
        description: 'Keep the prompt cache warm: status, on/off, settings, stats',
        argumentHint: ARGUMENT_HINT,
        immediate: true,
      })
    } catch (err) {
      io.debug(`cache-keeper: command.register failed: ${errText(err)}`)
    }
    await safely(io, 'session.start', async () => {
      const env = {
        force: await $.env.get('FORCE_PROMPT_CACHING_5M'),
        envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
        enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      }
      await start(io, options, {
        ...(env.force !== undefined ? { force: env.force } : {}),
        ...(env.envTtl !== undefined ? { envTtl: env.envTtl } : {}),
        ...(env.enable1h !== undefined ? { enable1h: env.enable1h } : {}),
      })
      // The desktop band's countdown ticks inside its own image and its look changes are timed in keeper.ts, so it is not
      // redrawn each minute (a redraw restarts its animations). A terminal band's text is static: it redraws each minute.
      // The same tick looks at the app's theme.
      tick?.cancel()
      tick = $.clock.every(60_000, () => {
        void safely(io, 'tick', async () => {
          if ((await read($, surfaceA)) === 'terminal') $.ui.invalidate('ui.render')
          await refreshTheme(io)
        })
      })
    })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await safely(ioOf($), 'classic.SessionStart', () => onClassicSessionStart(ioOf($), e))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await safely(ioOf($), 'turn.start', () => onTurnStart(ioOf($), e))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const io = ioOf($)
    const ctx = await stepStart(io, e)
    let r
    try {
      r = yield* next(e)
    } finally {
      // finally, not catch: a consumer that stops iterating early must still close the step.
      await stepEnd(io, ctx, r?.usage ?? null)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await safely(ioOf($), 'turn.complete', () => onTurnComplete(ioOf($), e))
    return next(e)
  })

  on('tool.call', ($, e, next) => onToolCall(ioOf($), e, e as unknown as Record<string, unknown>, () => next(e)))

  on('classic.PermissionRequest', async ($, e, next) => {
    await safely(ioOf($), 'classic.PermissionRequest', () => onPermission(ioOf($), e))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await safely(ioOf($), 'prompt.submit', () => onPromptSubmit(ioOf($), e))
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await safely(ioOf($), 'classic.Stop', () => onClassicStop(ioOf($), e))
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await safely(ioOf($), 'classic.SubagentStop', () => onSubagentStop(ioOf($), e))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await safely(ioOf($), 'session.measure', () => onMeasure(ioOf($), e))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // precompute installs nothing: the conversation is not compacted.
    if (e.agentId === undefined && e.trigger !== 'precompute' && r.skip === undefined)
      await safely(ioOf($), 'session.compact', () => onCompact(ioOf($)))
    return r
  })

  on('session.end', async ($, e, next) => {
    await safely(ioOf($), 'session.end', () => onSessionEnd(ioOf($), e.reason))
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await safely(ioOf($), 'classic.PostModelSwitch', () => onModelSwitch(ioOf($)))
    return next(e)
  })

  on('config.set', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && e.key.startsWith('cache-keeper.'))
      await safely(ioOf($), 'config.set', () => onConfigSet(ioOf($), e.key, r.value))
    if (r.deny === undefined && e.key === 'theme') await safely(ioOf($), 'config.set', () => refreshTheme(ioOf($)))
    return r
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    try {
      return await runCommand(ioOf($), e.args)
    } catch (err) {
      return { text: `cache-keeper: ${errText(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const io = ioOf($)
    const geo = { desktop: e.surface === 'desktop', columns: e.props.bodyColumns, maxRows: e.props.maxRows }
    noteBand(geo)
    const model = await bandModel(io, e.props.hasSurvey, geo).catch(err => {
      io.debug(`cache-keeper: band: ${errText(err)}`)
      return null
    })
    // $.state.set is refused while a render draws: record the surface from a clock callback. Before the band
    // check, so the theme probes stop at the first render in a terminal even when the band draws nothing.
    const surface = e.surface
    $.clock.after(0, () => void setSurface(io, surface))
    if (model === null) return next(e)
    const inner = await next(e)
    if ('deny' in inner) return inner
    const target = e.surface === 'desktop' ? ({ surface: 'desktop', ui: $.ui.resolve(e) } as const) : ({ surface: 'terminal', ui: $.ui.resolve(e) } as const)
    return bandTree(target, e.props.bodyColumns, model, key => void pressButton(io, key, geo), () => sheetActions(io).close(), sheetActions(io), inner)
  })

  on('ui.render', { component: 'Pane', requestId: 'cache-keeper' }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const io = ioOf($)
    return paneTree($.ui.resolve(e), await paneModel(io), paneActions(io))
  })
}
