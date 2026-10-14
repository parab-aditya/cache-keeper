// Test world for cache-keeper: everything the engine answers beneath the plugin, held in memory.
// Adapted from paulbkim-dev/claude-code-cache-warmer tests/world.ts (MIT, (c) Paul B. Kim): the clock/env/store/fs
// stubs, WARMED, stubTurns with prompt(), and the held-write trick used to freeze a fork mid-flight.
import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, TurnUsage } from 'claude-code'

import type { KeeperState } from '../hooks/io'

export const OPUS = 'claude-opus-5-5'
export const START = 1_000_000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const SESSION_ID = 's-test'
export const LOG_PATH = `/home/t/.claude/cache-keeper/${SESSION_ID}.jsonl`

export const turnUsage = (model: string, cacheRead: number, cacheWrite: number, input = 0): TurnUsage => ({
  model,
  input_tokens: input,
  output_tokens: 5,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

/** A refresh that read `read` tokens: the measured shape of one FORK_PROMPT request (91 in, 4 out). */
export const warmed = (read = 399_000): ModelForkResult => ({
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 91, output_tokens: 4, cache_read_input_tokens: read, cache_creation_input_tokens: 0 },
})

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export const apiError = (error: 'overloaded' | 'rate_limit' | 'authentication_failed' | 'server_error', status: number | null): ModelForkResult => ({
  isAnswered: false,
  reason: 'api-error',
  status,
  error,
  usage: ZERO,
})
export const coldFork = (): ModelForkResult => ({
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 91, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 399_000 },
})

export type WorldOptions = {
  env?: Record<string, string>
  authKind?: 'bearer' | 'api-key' | null
  /** Default: a subscription's two windows at 9% and 5%. */
  rateLimits?: { kind: string; percentUsed: number }[]
  /** What the engine's cost ledger rises by on each fork. */
  forkUsd?: number
  settings?: Record<string, unknown>
  /** The fork call itself throws. */
  forkThrows?: boolean
  /** The log file and the store refuse every write. */
  failWrites?: boolean
  /** The `theme` config row's value. */
  theme?: string
  /** What `defaults read -g AppleInterfaceStyle` does: prints Dark, exits 1 (the key is absent: light), or cannot start. */
  os?: 'Dark' | 'Light' | 'cannot-run'
  /** `$.config.set` answers { deny } with this reason. */
  denyConfig?: string
  /** `$.ui.open` answers isPlaced: false (a narrow window). */
  paneNotPlaced?: boolean
}

export const world = (on: On, o: WorldOptions = {}) => {
  // Mac asleep: what the plugin reads as now runs ahead of the mocked clock that fires its timers.
  // mock.clock registers clock.now through the `on` it is given; this one adds the skew to its answer.
  const skew = { ms: 0 }
  const clockOn = ((name: string, ...args: unknown[]) => {
    const last = args.length - 1
    if (name === 'clock.now') {
      const inner = args[last] as (...a: unknown[]) => Promise<{ value: number }> | { value: number }
      args[last] = async (...a: unknown[]) => ({ value: (await inner(...a)).value + skew.ms })
    }
    return (on as unknown as (...x: unknown[]) => unknown)(name, ...args)
  }) as unknown as On
  const clock = mock.clock(clockOn, { now: START })
  mock.env(on, { HOME: '/home/t', ...o.env })

  const files = new Map<string, string>()
  /** Each file's modification time on the mock clock (a write sets it; a test can set it to age a file). */
  const mtimes = new Map<string, number>()
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.list', (_, e) => {
    const dir = `${e.path}/`
    const entries = [...files.keys()]
      .filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
      .map(p => ({ name: p.slice(dir.length), kind: 'file' as 'file' | 'dir', size: 0, mtimeMs: mtimes.get(p) ?? clock.now(), isLink: false }))
    // and the folders a deeper file sits in
    for (const d of new Set([...files.keys()].filter(p => p.startsWith(dir) && p.slice(dir.length).includes('/')).map(p => p.slice(dir.length).split('/')[0] as string)))
      entries.push({ name: d, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    return { value: entries }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    if (o.failWrites) throw new Error('disk full')
    files.set(e.path, e.text)
    mtimes.set(e.path, clock.now())
    return { value: undefined }
  })
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    if (o.failWrites) throw new Error('store write failed')
    stored.set(e.key, e.value)
    return { value: undefined }
  })

  on('session.id', () => ({ value: SESSION_ID }))
  on('session.authorize', () => ({
    value: o.authKind === null ? null : { handle: 'h', kind: o.authKind ?? 'bearer' },
  }))
  on('settings.read', () => ({ value: o.settings ?? {} }))
  const usage = { tokens: 400_000, rateLimits: o.rateLimits ?? [{ kind: 'five_hour', percentUsed: 9 }, { kind: 'seven_day', percentUsed: 5 }], costUsd: 10 }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: usage.tokens, window: 1_000_000 },
      rateLimits: usage.rateLimits,
      cost: { usd: usage.costUsd },
    },
  }))
  const envSets: [string, string | undefined][] = []
  on('env.set', (_, e) => {
    envSets.push([e.name, e.value])
    return { value: undefined }
  })
  const configSets: { key: string; value: unknown }[] = []
  const configDeny = { reason: o.denyConfig }
  on('config.set', (_, e) => {
    if (configDeny.reason !== undefined) return { deny: configDeny.reason }
    configSets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  // The /config rows as `$.config.list()` shows them: the theme and our own, each at what the last write left.
  const theme = { value: o.theme ?? 'dark' }
  on('config.list', () => {
    const row = (key: string, value: unknown) => ({ key, label: key, kind: 'choice', value, provider: { plugin: 'x', tier: 'user' }, isLocked: false })
    const mine = new Map<string, unknown>()
    for (const c of configSets) mine.set(c.key, c.value)
    return { value: [row('theme', theme.value), ...[...mine].map(([k, v]) => row(k, v))] as never }
  })
  const probes: string[][] = []
  const os = { value: o.os ?? 'Dark' }
  on('process.run', (_, e) => {
    probes.push([...e.argv])
    if (os.value === 'cannot-run') throw new Error('spawn defaults ENOENT')
    return { value: os.value === 'Dark' ? { exitCode: 0, stdout: 'Dark\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'The domain/default pair does not exist' } } as never
  })
  const panes = { opened: [] as { id: string; focus?: unknown; closeOnEscape?: unknown; rows?: unknown }[], closed: [] as string[] }
  on('ui.open', (_, e) => {
    panes.opened.push({ id: e.id, focus: e.focus, closeOnEscape: e.closeOnEscape, rows: e.rows })
    return { value: o.paneNotPlaced ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } } as never
  })
  on('ui.close', (_, e) => {
    panes.closed.push(e.id)
    return { value: undefined }
  })
  /** The mock clock's time (ms after START) of each `$.ui.invalidate`: what makes the bands draw again. */
  const invalidations: number[] = []
  on('ui.invalidate', (_, e) => {
    if (e.event === 'ui.render') invalidations.push(clock.now() - START)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'cache' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  for (const name of ['classic.Stop', 'classic.SubagentStop', 'classic.SessionStart', 'classic.PostModelSwitch', 'classic.PermissionRequest'] as const)
    on(name, () => ({}))
  const appended: string[] = []
  on('session.append', (_, e, next) => {
    const [part] = e.message.content
    if (part?.type === 'text') appended.push(String(part.text))
    return next(e)
  })
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })

  // The fork: counted with the clock time, answered from a queue, optionally held mid-flight.
  const forks: { at: number; prompt: string }[] = []
  const replies: ModelForkResult[] = []
  let forkGate: Promise<void> | undefined
  const forkUsd = o.forkUsd ?? 0.0804
  on('model.fork', async (_, e) => {
    forks.push({ at: clock.now() + skew.ms, prompt: String(e.prompt) })
    if (o.forkThrows) throw new Error('engine refused')
    const gate = forkGate
    forkGate = undefined
    await gate
    const reply = replies.shift() ?? warmed()
    if (reply.isAnswered) usage.costUsd += forkUsd
    return { value: reply }
  })
  /** The next fork waits until the returned function is called. */
  const holdFork = () => {
    let release = () => {}
    forkGate = new Promise<void>(r => (release = r))
    return release
  }

  // Main requests: each prompt is one turn of one step, answered with `next`.
  let nextUsage: TurnUsage = turnUsage(OPUS, 399_000, 1_000)
  let stepGate: Promise<void> | undefined
  const noResponse = { on: false }
  on('turn.step', async function* (_, e) {
    const gate = stepGate
    stepGate = undefined
    await gate
    const usage = noResponse.on ? null : nextUsage
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  /** The next main request waits until the returned function is called. */
  const holdStep = () => {
    let release = () => {}
    stepGate = new Promise<void>(r => (release = r))
    return release
  }

  // Tools: results come from a queue; a held tool call is a dialog waiting on the person.
  const toolResults: unknown[] = []
  let toolGate: Promise<void> | undefined
  const toolCalls: { tool: string; agentId?: string }[] = []
  on('tool.call', async (_, e) => {
    toolCalls.push({ tool: e.tool, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) })
    const gate = toolGate
    toolGate = undefined
    await gate
    return { result: toolResults.shift() ?? {} } as never
  })
  const holdTool = () => {
    let release = () => {}
    toolGate = new Promise<void>(r => (release = r))
    return release
  }

  return {
    clock, skew, files, mtimes, stored, usage, envSets, configSets, configDeny, theme, os, probes, panes, toasts, invalidations, appended, logged, forks, replies, toolResults, toolCalls,
    holdFork, holdStep, holdTool, noResponse,
    setUsage: (u: TurnUsage) => {
      nextUsage = u
    },
  }
}

export type World = ReturnType<typeof world>

export const start = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

const drain = async ($: Engine, turnId: string, model: string) => {
  for await (const _ of $.turn.step({ turnId, index: 0, model, messageCount: 1 })) {
    // drain the stream
  }
}

/** A whole turn: start, one main request, complete. */
export const prompt = async ($: Engine, w: World, turnId: string, usage?: TurnUsage) => {
  if (usage) w.setUsage(usage)
  await $.turn.start({ text: 'x', turnId })
  await drain($, turnId, usage?.model ?? OPUS)
  await $.turn.complete({ answer: 'ACK', durationMs: 5, isAborted: false, turnId, reason: 'answer' })
}

/** A turn left open after its request: a long tool call, a dialog. */
export const openTurn = async ($: Engine, w: World, turnId: string, usage?: TurnUsage) => {
  if (usage) w.setUsage(usage)
  await $.turn.start({ text: 'x', turnId })
  await drain($, turnId, usage?.model ?? OPUS)
}

export const closeTurn = ($: Engine, turnId: string) =>
  $.turn.complete({ answer: 'ACK', durationMs: 5, isAborted: false, turnId, reason: 'answer' })

export const cache = ($: Engine, args: string) =>
  $.command.run({
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
    command: 'cache',
    args,
  })

/** The plugin's whole state, as `/cache debug` dumps it (plus `now`). */
export const snap = async ($: Engine): Promise<KeeperState & { now: number }> => {
  const text = (await cache($, 'debug')).text ?? ''
  return JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\n```'))) as KeeperState & { now: number }
}

/** One state value of the plugin. */
export const st = async <K extends keyof KeeperState>($: Engine, key: K): Promise<KeeperState[K]> => (await snap($))[key]

export const logLines = (w: World): Record<string, unknown>[] =>
  (w.files.get(LOG_PATH) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)

/** The times (ms after START) at which forks started. */
export const forkTimes = (w: World): number[] => w.forks.map(f => f.at - START)

export { expect }

/** The engine's measurement after a window moved: updates what `$.session.usage()` answers, then raises the event. */
export const measure = (
  $: Engine,
  w: World,
  limits: { fiveHour?: number; weekly?: number },
  cost = w.usage.costUsd,
) => {
  w.usage.rateLimits = [
    ...(limits.fiveHour !== undefined ? [{ kind: 'five_hour', percentUsed: limits.fiveHour }] : []),
    ...(limits.weekly !== undefined ? [{ kind: 'seven_day', percentUsed: limits.weekly }] : []),
  ]
  w.usage.costUsd = cost
  return $.session.measure({
    context: { tokens: w.usage.tokens, window: 1_000_000 },
    rateLimits: w.usage.rateLimits,
    cost: { usd: cost },
    changed: ['rateLimits'],
  })
}

/** A /config row changing from the menu (origin composer), as the engine raises it. */
export const setConfig = ($: Engine, key: string, value: string) =>
  $.config.set({ key, value, previous: '', provider: { plugin: 'cache-keeper', tier: 'user' }, origin: { kind: 'composer' } } as never)
