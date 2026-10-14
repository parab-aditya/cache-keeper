// What the engine glue needs from `$`, as plain functions. The hooks loader follows `$` only into functions
// declared in the hooks module itself (register.tsx), never across an import, so keeper.ts, log.ts and
// command.ts take an `Io` that register.tsx builds from each hook's `$` (ioOf) and never see `$` at all.
import type { ModelForkResult, PluginState, SessionUsage, ShapedValue, Timer } from 'claude-code'

/** The plugin's whole state, as declared in types/index.d.ts (every key `Shaped`; atoms read and take the plain value). */
export type KeeperState = { [K in keyof PluginState['cache-keeper']]: ShapedValue<PluginState['cache-keeper'][K]> }

export type Io = {
  now(): Promise<number>
  after(ms: number, fn: () => void): Timer
  /** One state value by key (the atoms live in register.tsx). */
  read<K extends keyof KeeperState>(key: K): Promise<KeeperState[K]>
  update<K extends keyof KeeperState>(key: K, fn: (v: KeeperState[K]) => KeeperState[K]): Promise<KeeperState[K]>
  /** env HOME */
  home(): Promise<string | undefined>
  sessionId(): Promise<string>
  /** Sets CLAUDE_CODE_PROMPT_CACHE_TTL for this process, or unsets it. */
  setTtlEnv(value: '5m' | '1h' | undefined): Promise<void>
  /** `$.settings.read()` */
  settings(): Promise<Readonly<Record<string, unknown>>>
  authKind(): Promise<'bearer' | 'api-key' | null>
  usage(): Promise<SessionUsage>
  fork(prompt: string): Promise<ModelForkResult>
  /** A system notice row: never read by the model. */
  append(text: string): Promise<void>
  /** Debug log only. */
  debug(text: string): void
  fsExists(path: string): Promise<boolean>
  fsRead(path: string): Promise<string>
  fsWrite(path: string, text: string): Promise<void>
  /** `$.fs.list(path)`: the directory's entries (rejects when it is missing). */
  fsList(path: string): Promise<readonly { name: string; kind: string; mtimeMs: number }[]>
  /** `$.process.run(argv)`: rejects when the command cannot start. */
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  /** `$.config.set`: resolves with the deny reason, or undefined when written (a rejection counts as a deny). */
  saveConfig(key: string, value: string): Promise<string | undefined>
  /** `$.config.list()` rows, as `{ key, value }` (the `theme` row and our own `cache-keeper.*` rows). */
  configRows(): Promise<readonly { key: string; value: unknown }[]>
  /** `$.ui.open` for our pane; resolves whether it was placed. */
  openPane(): Promise<boolean>
  closePane(): Promise<void>
  /** `$.ui.invalidate('ui.render')`: the bands draw again. */
  invalidate(): void
  toast(text: string): void
}
