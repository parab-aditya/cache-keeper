// State contract of cache-keeper (design.md §4). All times are epoch ms; all values are JSON.

export type Ttl = '5m' | '1h'
export type KeepFor = 'off' | '2h' | '4h' | '8h' | '12h' | 'forever'
export type BandStyle = 'full' | 'minimal' | 'off'

export type Anchor = {
  /** Start of the last main-thread request (a turn.step with agentId undefined). */
  at: number
  /** usage.model of that request ('' until its usage arrives). */
  model: string
  /** input + cacheRead + cacheWrite of the last main request with usage. */
  promptTokens: number
  /** ttlOf(...) sampled at request start. */
  ttl: Ttl
}

/** The cache entry's life since the last main request. */
export type Chain = {
  /** Last cache touch: main request start or last warmed refresh start. */
  touchAt: number
  /** Warmed refreshes since the anchor. */
  refreshes: number
  /** Sum of the engine's cost deltas of those refreshes. */
  costUsd: number
}

export type StopCode =
  | 'window'
  | 'weekly-guard'
  | 'rate-limited'
  | 'api-error'
  | 'missed'
  | 'cold'
  | 'compacted'
  | 'cleared'
  | 'model-switched'
  | 'session-ended'
  | 'nothing-to-fork'
  | 'user-off'

export type Status =
  | { kind: 'waiting' }
  | { kind: 'scheduled'; nextAt: number }
  | { kind: 'refreshing'; since: number; attempt: number }
  | { kind: 'retrying'; nextAt: number; attempt: number; error: string }
  | { kind: 'holding'; reason: 'small' | 'idle-5m' }
  | { kind: 'done'; code: 'window'; at: number }
  | { kind: 'stopped'; code: StopCode; reason: string; at: number; coldSince?: number }

export type Settings = {
  keepFor: KeepFor
  leadMin: number
  minTokens: number
  weeklyGuard: number
  band: BandStyle
  upgradeTo1h: boolean
}

export type Task = { id: string; kind: 'shell' | 'monitor' | 'agent'; desc: string; since: number }
/** AskUserQuestion | ExitPlanMode | permission:<tool> */
export type Dialog = { id: string; tool: string; since: number }

export type Limits = { fiveHour?: number; weekly?: number; overLimit: boolean; at: number }

export type RefreshRecord = {
  at: number
  ms: number
  lateMs: number
  attempt: number
  phase: 'turn' | 'dialog' | 'tasks' | 'idle'
  result: 'warmed' | 'cold' | 'failed'
  /** Error kind/status or arm. */
  detail?: string
  promptTokens: number
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  /** Engine cost delta; null if unavailable. */
  costUsd: number | null
  /** Policy estimate. */
  estUsd: number
  weeklyBefore?: number
  weeklyAfter?: number
  fiveHourBefore?: number
  fiveHourAfter?: number
}

/**
 * Savings model: `grossUsd` is the sum of the rewrites avoided (what each next request would have paid to write the
 * prefix again), `costUsd` the sum of every refresh's spend, `avoided` how many rewrites were avoided. Net saved is
 * `grossUsd - costUsd` (negative early on).
 */
export type Totals = { refreshes: number; costUsd: number; avoided: number; grossUsd: number; since: number }

export type Resumed = { tokens: number; estUsd?: number; cold: boolean }

// Aliases for the module block below: inside `declare module 'claude-code'` plain names like Settings and Task
// resolve to claude-code's own exports first.
export type CkAnchor = Anchor
export type CkChain = Chain
export type CkStatus = Status
export type CkSettings = Settings
export type CkDialog = Dialog
export type CkTask = Task
export type CkLimits = Limits
export type CkRefreshRecord = RefreshRecord
export type CkTotals = Totals
export type CkResumed = Resumed

declare module 'claude-code' {
  // Every key carries the shape tag 'ck2' (atoms in hooks/register.tsx): a value another version of the code
  // wrote (the Phase 0 spike, an older build, the paused flag of ck1) reads as absent. Bump the tag when a shape changes.
  interface PluginState {
    'cache-keeper': {
      anchor: Shaped<CkAnchor | null>
      chain: Shaped<CkChain | null>
      status: Shaped<CkStatus>
      /** Session values; seeded from options at the first session.start, kept across reloads. */
      settings: Shaped<CkSettings>
      turn: Shaped<{ id: string; since: number } | null>
      dialog: Shaped<CkDialog | null>
      tasks: Shaped<CkTask[]>
      limits: Shaped<CkLimits | null>
      /** Latest from session.usage / session.measure. */
      contextTokens: Shaped<number | null>
      costUsd: Shaped<number | null>
      /** In-flight claim; stale after 3 minutes (a reload mid-fork). */
      refreshing: Shaped<{ claimAt: number } | null>
      last: Shaped<CkRefreshRecord | null>
      /** This session; all-time lives in $.store 'allTime'. */
      session: Shaped<CkTotals>
      /** From classic.SessionStart resume/fork. */
      resumed: Shaped<CkResumed | null>
      /** Last band surface seen (for art choices). */
      surface: Shaped<'terminal' | 'desktop' | null>
      /** The app's theme is a light one (config row `theme` starts with `light`). */
      light: Shaped<boolean>
      /** The in-band settings sheet is open (the gear, /cache settings). */
      sheetOpen: Shaped<boolean>
      /** The mod itself set CLAUDE_CODE_PROMPT_CACHE_TTL=1h (upgradeTo1h), so turning that off unsets it. */
      ttlSet: Shaped<boolean>
    }
  }
}
