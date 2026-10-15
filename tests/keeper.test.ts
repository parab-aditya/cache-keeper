// Keeper scenarios (design.md §12): mock clock, a fork that is only ever a stub. Each asserts fork count at exact
// clock times and the status.
import { test } from 'claude-code/testing'

import { onToolCall } from '../hooks/keeper'
import type { Io } from '../hooks/io'
import { FORK_PROMPT, fmtClock, refreshUsd, rewriteUsd } from '../hooks/policy'
import {
  HOUR, LOG_PATH, MINUTE, OPUS, START, apiError, cache, closeTurn, coldFork, expect, forkTimes, logLines, measure,
  openTurn, prompt, setConfig, snap, start, st, turnUsage, warmed, world,
} from './world'

const at = (...mins: number[]) => mins.map(m => m * MINUTE)

test('1. a 1h session at 400k forks at T+55m, then every 55m, until the 8h window ends with one notice', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  expect((await st($, 'status')).kind).toBe('scheduled')
  expect(await st($, 'status')).toEqual({ kind: 'scheduled', nextAt: START + 55 * MINUTE })
  await w.clock.advance(55 * MINUTE - 1)
  expect(w.forks).toHaveLength(0)
  await w.clock.advance(1)
  expect(w.forks).toHaveLength(1)
  expect(w.forks[0]?.prompt).toBe(FORK_PROMPT)
  expect(await st($, 'status')).toEqual({ kind: 'scheduled', nextAt: START + 110 * MINUTE })
  await w.clock.advance(55 * MINUTE - 1)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(1)
  expect(forkTimes(w)).toEqual(at(55, 110))
  expect(w.appended).toHaveLength(0)
  await w.clock.advance(9 * HOUR)
  expect(forkTimes(w)).toEqual(at(55, 110, 165, 220, 275, 330, 385, 440))
  const status = await st($, 'status')
  expect(status).toMatchObject({ kind: 'done', code: 'window' })
  // the notice is written once, however long we wait and whatever else asks the scheduler to look
  await closeTurn($, 'nope').catch(() => undefined)
  await prompt($, w, 't2').catch(() => undefined)
  expect(w.appended.filter(t => t.includes('window ended'))).toHaveLength(1)
})

test('1b. the window notice says how long it kept the cache, what it cost and when the cache expires', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(8 * HOUR)
  expect(w.appended).toEqual([
    `cache-keeper · kept warm 7h20m · 8 refreshes · $0.64 · window ended (8h) · cache expires ${fmtClock(START + 500 * MINUTE)}`,
  ])
  expect((await snap($)).chain).toMatchObject({ refreshes: 8 })
})

test('2. a dialog pending across 3h does not stop the 55m cadence', async ($, on) => {
  const w = world(on)
  await start($)
  await openTurn($, w, 't1')
  const release = w.holdTool()
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await w.clock.settle()
  expect((await snap($)).dialog).toMatchObject({ tool: 'AskUserQuestion' })
  await w.clock.advance(3 * HOUR)
  expect(forkTimes(w)).toEqual(at(55, 110, 165))
  expect((await snap($)).dialog).toMatchObject({ tool: 'AskUserQuestion' })
  expect(await st($, 'status')).toMatchObject({ kind: 'scheduled' })
  expect(logLines(w).filter(l => l.ev === 'refresh').map(l => l.phase)).toEqual(['dialog', 'dialog', 'dialog'])
  release()
  await call
  expect((await snap($)).dialog).toBeNull()
})

const bash = (id: string) => ({ tool: 'Bash', command: 'sleep 99999', run_in_background: true, description: `job ${id}` }) as never

test('3. a background task keeps warming to anchor+24h; its notification drops the window back to 8h', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  w.toolResults.push({ backgroundTaskId: 'bg1' })
  await $.tool.call(bash('1'))
  expect((await snap($)).tasks).toMatchObject([{ id: 'bg1', kind: 'shell', desc: 'job 1' }])
  await w.clock.advance(9 * HOUR)
  expect(forkTimes(w).at(-1)).toBe(495 * MINUTE)
  expect(forkTimes(w)).toHaveLength(9)
  expect(await st($, 'status')).toMatchObject({ kind: 'scheduled' })
  // the task finishes: the notification arrives as a prompt of origin task-notification
  await $.prompt.submit({ text: '<task-notification><task-id>bg1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect((await snap($)).tasks).toEqual([])
  expect(await st($, 'status')).toMatchObject({ kind: 'done', code: 'window' })
  await w.clock.advance(5 * HOUR)
  expect(w.forks).toHaveLength(9)
})

test('3b. with the task still alive the chain runs to the 24h cap and then ends', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  w.toolResults.push({ backgroundTaskId: 'bg1' })
  await $.tool.call(bash('1'))
  await w.clock.advance(26 * HOUR)
  expect(forkTimes(w)).toHaveLength(26)
  expect(forkTimes(w).at(-1)).toBe(1430 * MINUTE)
  expect(await st($, 'status')).toMatchObject({ kind: 'done', code: 'window' })
  expect(w.appended.some(t => t.includes('window ended (24h)'))).toBe(true)
})

test('3c. Monitor, background Agent and TaskStop; classic.Stop is the authoritative list', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  w.toolResults.push({ taskId: 'mon1' })
  await $.tool.call({ tool: 'Monitor', description: 'watch', command: 'tail -f x', timeout_ms: 1000 } as never)
  w.toolResults.push({ status: 'async_launched', agentId: 'ag1' })
  await $.tool.call({ tool: 'Agent', description: 'dig', prompt: 'x', subagent_type: 'general-purpose', run_in_background: true } as never)
  // a foreground Bash and an Agent that ran to the end are not background work
  w.toolResults.push({ stdout: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  w.toolResults.push({ status: 'completed', agentId: 'ag2' })
  await $.tool.call({ tool: 'Agent', description: 'quick', prompt: 'x', subagent_type: 'general-purpose' } as never)
  expect((await snap($)).tasks.map(t => `${t.kind}:${t.id}`)).toEqual(['monitor:mon1', 'agent:ag1'])
  w.toolResults.push({ task_id: 'mon1' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'mon1' } as never)
  expect((await snap($)).tasks.map(t => t.id)).toEqual(['ag1'])
  // the list at the turn end wins: it drops ag1 and names one we never saw
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'sh9', type: 'shell', status: 'running', description: 'build' }] })
  expect((await snap($)).tasks.map(t => `${t.kind}:${t.id}`)).toEqual(['shell:sh9'])
  await $.classic.SubagentStop({ agent_id: 'sh9', agent_type: 'x', agent_transcript_path: '', stop_hook_active: false } as never)
  expect((await snap($)).tasks).toEqual([])
})

test('4a. a 5m session (API key) that is idle holds, with no forks', async ($, on) => {
  const w = world(on, { authKind: 'api-key', rateLimits: [] })
  await start($)
  await prompt($, w, 't1')
  expect((await snap($)).anchor).toMatchObject({ ttl: '5m' })
  expect(await st($, 'status')).toEqual({ kind: 'holding', reason: 'idle-5m' })
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(0)
  expect((await cache($, 'status')).text).toContain('5m (no subscription seen)')
})

test('4b. a 5m session forks every 4m30s while a turn runs, up to 1h from the anchor', async ($, on) => {
  const w = world(on, { authKind: 'api-key', rateLimits: [] })
  await start($)
  await openTurn($, w, 't1')
  expect(await st($, 'status')).toEqual({ kind: 'scheduled', nextAt: START + 4.5 * MINUTE })
  await w.clock.advance(4.5 * MINUTE - 1)
  expect(w.forks).toHaveLength(0)
  await w.clock.advance(1)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(2 * HOUR)
  expect(forkTimes(w)).toEqual(Array.from({ length: 13 }, (_, i) => (i + 1) * 4.5 * MINUTE))
  expect(await st($, 'status')).toEqual({ kind: 'holding', reason: 'idle-5m' })
})

test('4c. a 5m session starts forking when a turn opens, and stops when it closes', async ($, on) => {
  const w = world(on, { authKind: 'api-key', rateLimits: [] })
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(3 * MINUTE)
  await $.turn.start({ text: 'x', turnId: 't2' })
  expect(await st($, 'status')).toMatchObject({ kind: 'scheduled' })
  await w.clock.advance(1.5 * MINUTE)
  expect(forkTimes(w)).toEqual([4.5 * MINUTE])
  await closeTurn($, 't2')
  expect(await st($, 'status')).toEqual({ kind: 'holding', reason: 'idle-5m' })
  await w.clock.advance(HOUR)
  expect(w.forks).toHaveLength(1)
})

test('5. a 20k context is held as small: no forks', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1', turnUsage(OPUS, 19_000, 1_000))
  expect((await snap($)).anchor).toMatchObject({ promptTokens: 20_000 })
  expect(await st($, 'status')).toEqual({ kind: 'holding', reason: 'small' })
  expect((await cache($, 'status')).text).toContain('Context 20k is below the 30k minimum · not kept warm')
  await w.clock.advance(3 * HOUR)
  expect(w.forks).toHaveLength(0)
})

test('6. weekly 91% reaching the 90% guard stops warming, once, with a notice', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await measure($, w, { fiveHour: 9, weekly: 91 })
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'weekly-guard', reason: 'weekly 91% ≥ guard 90%' })
  await w.clock.advance(3 * HOUR)
  expect(w.forks).toHaveLength(0)
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]).toContain('stopped: weekly 91% ≥ guard 90%')
  // Later main requests re-decide the same stop: no second notice, no second stop line.
  await prompt($, w, 't2')
  await prompt($, w, 't3')
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'weekly-guard' })
  expect(w.appended).toHaveLength(1)
  expect(logLines(w).filter(l => l.ev === 'stop')).toHaveLength(1)
})

test('6b. weekly below the guard keeps forking; raising the guard lets a stopped chain go on', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await measure($, w, { fiveHour: 9, weekly: 89 })
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
  await measure($, w, { fiveHour: 9, weekly: 90 })
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'weekly-guard' })
  await w.clock.advance(HOUR)
  expect(w.forks).toHaveLength(1)
})

test('7. a timer that fires after the Mac slept stops as missed, cold since expiry, and never forks', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  w.skew.ms = 3 * HOUR // the process wakes three hours late
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(0)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'missed', coldSince: START + HOUR })
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]).toContain('stopped:')
  expect((await cache($, 'status')).text).toContain(`❄ Cache cold · next message rewrites 400k (~$3.20)`)
  expect((await cache($, 'status')).text).toContain(`Refresh missed while asleep · cache cold since ${fmtClock(START + HOUR)}`)
  await w.clock.advance(5 * HOUR)
  expect(w.forks).toHaveLength(0)
  // the next request re-anchors and warming resumes
  w.skew.ms = 0
  await prompt($, w, 't2')
  expect((await st($, 'status')).kind).toBe('scheduled')
})

test('8a. a 429 stops warming as rate-limited', async ($, on) => {
  const w = world(on)
  w.replies.push(apiError('rate_limit', 429))
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'rate-limited', reason: 'rate_limit 429' })
  await w.clock.advance(4 * HOUR)
  expect(w.forks).toHaveLength(1)
  expect(w.appended).toHaveLength(1)
  expect(logLines(w).find(l => l.ev === 'refresh')).toMatchObject({ result: 'failed', detail: 'rate_limit 429', costUsd: 0 })
})

test('8b. overloaded twice then warmed: three forks, 30 s and 90 s apart, and the chain goes on', async ($, on) => {
  const w = world(on)
  w.replies.push(apiError('overloaded', 529), apiError('overloaded', 529))
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  expect(await st($, 'status')).toMatchObject({ kind: 'retrying', attempt: 1, error: 'overloaded 529', nextAt: START + 55 * MINUTE + 30_000 })
  await w.clock.advance(30_000 - 1)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.forks).toHaveLength(2)
  expect(await st($, 'status')).toMatchObject({ kind: 'retrying', attempt: 2 })
  await w.clock.advance(90_000)
  expect(forkTimes(w)).toEqual([55 * MINUTE, 55 * MINUTE + 30_000, 55 * MINUTE + 120_000])
  expect((await snap($)).chain).toMatchObject({ touchAt: START + 55 * MINUTE + 120_000, refreshes: 1 })
  expect((await st($, 'status')).kind).toBe('scheduled')
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(4)
  expect(forkTimes(w)[3]).toBe(110 * MINUTE + 120_000)
  expect(logLines(w).filter(l => l.ev === 'refresh').map(l => [l.attempt, l.result])).toEqual([[0, 'failed'], [1, 'failed'], [2, 'warmed'], [0, 'warmed']])
  expect(w.appended).toHaveLength(0)
})

test('8c. overloaded four times stops as api-error (15 min lead leaves room for the retries)', { options: { lead: '15' } }, async ($, on) => {
  const w = world(on)
  w.replies.push(...Array.from({ length: 4 }, () => apiError('overloaded', 529)))
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(2 * HOUR)
  expect(forkTimes(w)).toEqual([45 * MINUTE, 45 * MINUTE + 30_000, 45 * MINUTE + 120_000, 45 * MINUTE + 300_000])
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'api-error', reason: 'overloaded 529' })
  expect(w.appended).toHaveLength(1)
})

test('8d. with the 5 min lead a retry that would land after expiry stops instead', async ($, on) => {
  const w = world(on)
  w.replies.push(...Array.from({ length: 3 }, () => apiError('overloaded', 529)))
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(2 * HOUR)
  expect(forkTimes(w)).toEqual([55 * MINUTE, 55 * MINUTE + 30_000, 55 * MINUTE + 120_000])
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'api-error' })
  expect((await snap($)).status).toMatchObject({ reason: expect.stringContaining('no time left to retry') })
})

test('8e. an abort is retried once; authentication errors stop at once', async ($, on) => {
  const w = world(on)
  w.replies.push({ isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE + 30_000)
  expect(w.forks).toHaveLength(2)
  expect((await st($, 'status')).kind).toBe('scheduled')
  w.replies.push(apiError('authentication_failed', 401))
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(3)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'api-error', reason: 'authentication_failed 401' })
})

test('8f. a fork that throws is an unknown API error: retried', async ($, on) => {
  const w = world(on, { forkThrows: true })
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  expect(await st($, 'status')).toMatchObject({ kind: 'retrying', error: 'unknown' })
  expect((await snap($)).refreshing).toBeNull()
})

test('9. a fork that finds the cache cold stops the chain', async ($, on) => {
  const w = world(on)
  w.replies.push(coldFork())
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'cold' })
  expect(w.appended).toHaveLength(1)
  await w.clock.advance(5 * HOUR)
  expect(w.forks).toHaveLength(1)
  expect(logLines(w).find(l => l.ev === 'refresh')).toMatchObject({ result: 'cold', cacheRead: 0, cacheWrite: 399_000 })
})

test('10a. compaction stops warming and forgets the anchor; the next request starts it again', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'compacted' })
  expect((await snap($)).anchor).toBeNull()
  await w.clock.advance(3 * HOUR)
  expect(w.forks).toHaveLength(0)
  expect(w.appended).toHaveLength(0)
  await prompt($, w, 't2')
  expect((await st($, 'status')).kind).toBe('scheduled')
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
})

test('10a2. a precompute compaction installs nothing: anchor and chain survive, warming goes on', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect((await snap($)).anchor).not.toBeNull()
  expect((await st($, 'status')).kind).toBe('scheduled')
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
})

test('10b. a model switch stops warming; a /clear (session.end clear) too', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await $.classic.PostModelSwitch({
    from_model: OPUS, to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command', context_tokens: 400_000,
    prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 3, pricing: 'catalog',
  } as never)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'model-switched' })
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(0)
  await prompt($, w, 't2')
  expect((await st($, 'status')).kind).toBe('scheduled')
  expect(w.appended).toHaveLength(1) // only the model switch writes a notice; a clear is the user's own doing
  expect(w.appended[0]).toContain('stopped: model switched')
  await $.session.end({ reason: 'clear', sessionId: 's-test', resume: {} } as never)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'cleared' })
  expect((await snap($)).chain).toBeNull()
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(0)
  expect(w.appended).toHaveLength(1)
  await prompt($, w, 't3')
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
})

test('10c. a session that ends for another reason stops too; a resumed session shows a cold warning', async ($, on) => {
  const w = world(on)
  await start($)
  await $.classic.SessionStart({ source: 'resume', context_tokens: 408_000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 3.26 } as never)
  expect((await snap($)).resumed).toEqual({ tokens: 408_000, estUsd: 3.26, cold: true })
  expect((await cache($, 'status')).text).toContain('❄ Cache cold · next message rewrites 408k (~$3.26)')
  await prompt($, w, 't1')
  expect((await snap($)).resumed).toBeNull()
  await $.session.end({ reason: 'logout', sessionId: 's-test', resume: {} } as never)
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'session-ended' })
})

test('11a. a reload re-arms the timer: exactly one fork at the original time', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(10 * MINUTE)
  await start($) // register runs again, session.start fires for the reloaded module; state survives
  await start($)
  await w.clock.advance(45 * MINUTE - 1)
  expect(w.forks).toHaveLength(0)
  await w.clock.advance(1)
  expect(forkTimes(w)).toEqual([55 * MINUTE])
  await w.clock.advance(55 * MINUTE)
  expect(forkTimes(w)).toEqual(at(55, 110))
})

test('11b. a reload keeps what the session changed; the options only seed it the first time', { options: { keepFor: '4h', lead: '10' } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect((await snap($)).settings).toMatchObject({ keepFor: '4h', leadMin: 10, minTokens: 30_000 })
  await cache($, 'keep 2h')
  await start($, false) // a reload
  expect((await snap($)).settings.keepFor).toBe('2h')
  await prompt($, w, 't1')
  await w.clock.advance(50 * MINUTE)
  expect(forkTimes(w)).toEqual(at(50)) // lead 10 min
})

test('11c. a claim older than 3 minutes is cleared at session start; a fresh one is left', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  const release = w.holdFork()
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
  expect((await snap($)).refreshing).toEqual({ claimAt: START + 55 * MINUTE })
  expect(await st($, 'status')).toMatchObject({ kind: 'refreshing' })
  await w.clock.advance(2 * MINUTE)
  await start($)
  expect((await snap($)).refreshing).not.toBeNull()
  await w.clock.advance(2 * MINUTE)
  await start($)
  expect((await snap($)).refreshing).toBeNull()
  expect(logLines(w).some(l => l.ev === 'claim-stale')).toBe(true)
  release()
  await w.clock.settle()
  expect(w.forks).toHaveLength(1)
  expect((await st($, 'status')).kind).toBe('scheduled')
})

test('12. a tool attempt carrying an agentId (a fork, a subagent) touches no task or dialog state', async () => {
  // The kit cannot raise tool.call with an agentId (a plugin's $.tool.call drops it), so the hook's body runs
  // against an Io that records every use and fails it.
  const used: string[] = []
  const io = new Proxy({}, { get: (_, name) => () => { used.push(String(name)); throw new Error('io touched') } }) as Io
  const result = { result: { backgroundTaskId: 'x' } }
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'Bash', 'Monitor', 'Agent', 'TaskStop']) {
    const got = await onToolCall(io, { tool, tool_use_id: 'u1', agentId: 'ae08' }, { run_in_background: true }, async () => result)
    expect(got).toBe(result)
  }
  expect(used).toEqual([])
  // control: without an agentId the same calls do use state, so the guard is what spared them
  await onToolCall(io, { tool: 'AskUserQuestion', tool_use_id: 'u1' }, {}, async () => result)
  expect(used.length).toBeGreaterThan(0)
})

test('12b. a subagent step is not a main request: it neither anchors nor touches the chain', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  const before = await snap($)
  await w.clock.advance(20 * MINUTE)
  w.setUsage(turnUsage(OPUS, 99_000, 1_000))
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: OPUS, messageCount: 4, agentId: 'sub1' })) {
    // drain
  }
  const after = await snap($)
  expect(after.anchor).toEqual(before.anchor)
  expect(after.chain).toEqual(before.chain)
  await w.clock.advance(35 * MINUTE)
  expect(forkTimes(w)).toEqual(at(55))
})

test('13a. a main request that lands while a fork runs wins: the chain is the new request\'s', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  const release = w.holdFork()
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(10_000)
  const mainAt = w.clock.now()
  await prompt($, w, 't2')
  expect((await snap($)).chain).toEqual({ touchAt: mainAt, refreshes: 0, costUsd: 0 })
  release()
  await w.clock.settle()
  const s = await snap($)
  expect(s.chain).toEqual({ touchAt: mainAt, refreshes: 0, costUsd: 0 })
  expect(s.anchor?.at).toBe(mainAt)
  // the fork still happened and is counted
  expect(s.session.refreshes).toBe(1)
  expect(s.refreshing).toBeNull()
  expect(s.status).toEqual({ kind: 'scheduled', nextAt: mainAt + 55 * MINUTE })
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(2)
})

test('13b. a main request still running when the fork lands: touchAt does not move back to the fork\'s start', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  const releaseFork = w.holdFork()
  await w.clock.advance(55 * MINUTE)
  await w.clock.advance(10_000)
  const mainAt = w.clock.now()
  const releaseStep = w.holdStep()
  const main = prompt($, w, 't2')
  await w.clock.settle()
  expect((await snap($)).chain?.touchAt).toBe(mainAt)
  releaseFork()
  await w.clock.settle()
  expect((await snap($)).chain).toMatchObject({ touchAt: mainAt, refreshes: 1 })
  releaseStep()
  await main
  expect((await snap($)).chain).toEqual({ touchAt: mainAt, refreshes: 0, costUsd: 0 })
})

test('13c. a main request that gets no response gives its touch back', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(20 * MINUTE)
  const before = await snap($)
  w.noResponse.on = true
  await $.turn.start({ text: 'x', turnId: 't2' })
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: OPUS, messageCount: 2 })) {
    // drain
  }
  expect((await snap($)).chain).toEqual(before.chain)
  expect((await snap($)).anchor).toEqual(before.anchor)
})

test('14. the next request after >1h with refreshes counts an avoided rewrite and what it saved', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(2)
  await prompt($, w, 't2', turnUsage(OPUS, 399_000, 1_000))
  const s = await snap($)
  expect(s.session.avoided).toBe(1)
  // gross: the rewrite of 399k at the 1h write price ($8/MTok) that the request did not pay; cost: the two refreshes' ledger cost
  expect(Math.abs(s.session.grossUsd - rewriteUsd(OPUS, 399_000, '1h')) < 1e-9).toBe(true)
  expect(Math.abs(s.session.costUsd - 2 * 0.0804) < 1e-9).toBe(true)
  expect(w.stored.get('allTime')).toMatchObject({ refreshes: 2, avoided: 1, grossUsd: s.session.grossUsd })
  expect(logLines(w).some(l => l.ev === 'avoided')).toBe(true)
  const stats = (await cache($, 'stats')).text ?? ''
  expect(stats).toContain('1 rewrite avoided (would have cost $3.19)')
  expect(stats).toContain('refreshes cost $0.16 · saved $3.03')
  expect(stats).toContain('This session')
  expect(stats).toContain('All time')
})

test('14b. no avoided rewrite without refreshes, within the TTL, or when the request had to rewrite', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(30 * MINUTE)
  await prompt($, w, 't2')
  expect((await snap($)).session.avoided).toBe(0) // within the TTL, no refresh
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(70 * MINUTE)
  await prompt($, w, 't3', turnUsage(OPUS, 0, 400_000)) // the cache lapsed anyway: the request rewrote it
  expect((await snap($)).session.avoided).toBe(0)
})

test('15a. /cache keep, lead, pause, resume, off, on change the session as specified', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  expect((await cache($, 'keep 4h')).text).toContain('4h')
  expect((await snap($)).settings.keepFor).toBe('4h')
  expect(w.configSets).toEqual([])
  expect((await cache($, 'keep 2h --save')).text).toContain('saved as default')
  expect(w.configSets).toEqual([{ key: 'cache-keeper.keepFor', value: '2h' }])
  expect((await cache($, 'keep 3h')).text).toContain('Usage')
  expect((await cache($, 'lead 3')).text).toContain('3 minutes')
  expect(await st($, 'status')).toEqual({ kind: 'scheduled', nextAt: START + 57 * MINUTE })
  expect((await cache($, 'lead 20')).text).toContain('Usage')
  expect((await cache($, 'lead 4 --save')).text).toContain('not saved')
  expect(w.configSets).toHaveLength(1)
  await cache($, 'lead 3 --save')
  expect(w.configSets.at(-1)).toEqual({ key: 'cache-keeper.lead', value: '3' })
  await w.clock.advance(57 * MINUTE)
  expect(forkTimes(w)).toEqual(at(57))
  // 2h window: the chain ends after the second refresh
  await w.clock.advance(HOUR)
  expect(forkTimes(w)).toEqual(at(57, 57 + 57))
  expect(await st($, 'status')).toMatchObject({ kind: 'done' })
})

test('15b. off stops with no notice, on restarts; pause and resume are the same two switches', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(10 * MINUTE)
  await cache($, 'off')
  expect(await st($, 'status')).toMatchObject({ kind: 'stopped', code: 'user-off', reason: 'off' })
  expect(await st($, 'settings')).toMatchObject({ keepFor: 'off' })
  await w.clock.advance(30 * MINUTE)
  expect(w.forks).toHaveLength(0)
  expect(w.appended).toHaveLength(0)
  expect((await cache($, 'status')).text).toContain('○ Auto-refresh off · cache expires in 20m')
  await cache($, 'on')
  expect((await snap($)).settings.keepFor).toBe('8h')
  expect(await st($, 'status')).toEqual({ kind: 'scheduled', nextAt: START + 55 * MINUTE })
  await w.clock.advance(15 * MINUTE)
  expect(forkTimes(w)).toEqual(at(55))
  // the old names still work, as aliases
  expect((await cache($, 'pause')).text).toContain('off')
  expect((await snap($)).settings.keepFor).toBe('off')
  expect((await cache($, 'resume')).text).toContain('Warming on')
  expect((await snap($)).settings.keepFor).toBe('8h')
  expect('paused' in (await snap($))).toBe(false)
})

test('15b2. switching off through the expiry leaves a cold cache, and switching on does not pretend otherwise', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await cache($, 'off')
  await w.clock.advance(2 * HOUR)
  await cache($, 'on')
  expect(w.forks).toHaveLength(0)
  expect((await cache($, 'status')).text).toContain('Cache cold since')
  await cache($, 'off')
  await cache($, 'on')
  expect(await st($, 'status')).toEqual({ kind: 'waiting' })
  expect(w.appended).toHaveLength(0)
})

test('15c. /cache on goes back to the saved default, not to 8h', async ($, on) => {
  const w = world(on)
  await start($)
  await cache($, 'off')
  expect((await cache($, 'on')).text).toContain('8h')
  void w
})

test('15c2. /cache off remembers the window, so /cache on restores it', async ($, on) => {
  world(on)
  await start($)
  await cache($, 'keep 4h')
  await cache($, 'off')
  expect((await cache($, 'on')).text).toContain('4h')
})

test('15d. refresh-now forks at once and moves the schedule; it refuses while off or without a request', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await cache($, 'refresh-now')).text).toContain('no request has been made')
  await prompt($, w, 't1')
  await w.clock.advance(10 * MINUTE)
  const out = await cache($, 'refresh-now')
  expect(out.text).toContain('warmed')
  expect(forkTimes(w)).toEqual(at(10))
  expect(await st($, 'status')).toEqual({ kind: 'scheduled', nextAt: START + 65 * MINUTE })
  await w.clock.advance(55 * MINUTE)
  expect(forkTimes(w)).toEqual(at(10, 65))
  await cache($, 'off')
  expect((await cache($, 'refresh-now')).text).toContain('Not refreshing: off')
  expect(w.forks).toHaveLength(2)
})

test('15e. status, stats, settings, debug and bare /cache answer', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await cache($, '')).text).toContain('No cache to keep yet')
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  const status = (await cache($, 'status')).text ?? ''
  expect(status).toContain('● Warm · next refresh in 55m')
  expect(status).toContain('TTL: 1h (subscription session)')
  expect(status).toContain('Last request:')
  expect(status).toContain('Last refresh: warmed')
  expect(status).toContain('Limits: 5h 9% · weekly 5%')
  expect((await cache($, 'status')).text).toBe(status)
  const stats = (await cache($, 'stats')).text ?? ''
  expect(stats).toContain('This session: 1 refresh')
  expect(stats).toContain('All time')
  expect((await cache($, 'settings')).text).toContain('Settings pane opened')
  expect(w.panes.opened).toEqual([{ id: 'cache-keeper', focus: true, closeOnEscape: true, rows: 12 }])
  expect((await cache($, 'nonsense')).text).toContain('Usage')
  const debug = (await cache($, 'debug')).text ?? ''
  expect(debug).toContain('"kind": "scheduled"')
  expect(debug).toContain('"ev":"refresh"')
  expect(w.files.get(LOG_PATH)).toContain('"ev":"refresh"')
})

test('a /config change of our row applies to the session', async ($, on) => {
  world(on)
  await start($)
  await setConfig($, 'cache-keeper.keepFor', '12h')
  expect((await snap($)).settings.keepFor).toBe('12h')
  await setConfig($, 'cache-keeper.lead', '10')
  expect((await snap($)).settings.leadMin).toBe(10)
  await setConfig($, 'other.thing', 'x')
  expect((await snap($)).settings.keepFor).toBe('12h')
})

test('TTL: FORCE_PROMPT_CACHING_5M makes a subscription 5m; CLAUDE_CODE_PROMPT_CACHE_TTL makes it 1h', async ($, on) => {
  const w = world(on, { env: { FORCE_PROMPT_CACHING_5M: '1' } })
  await start($)
  await prompt($, w, 't1')
  expect((await snap($)).anchor).toMatchObject({ ttl: '5m' })
})

test('TTL: an env TTL wins on an API key session', async ($, on) => {
  const w = world(on, { authKind: 'api-key', rateLimits: [], env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
  await start($)
  await prompt($, w, 't1')
  expect((await snap($)).anchor).toMatchObject({ ttl: '1h' })
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
})

test('upgradeTo1h sets the env on an API key session, and only there', { options: { upgradeTo1h: 'on' } }, async ($, on) => {
  const w = world(on, { authKind: 'api-key', rateLimits: [] })
  await start($)
  expect(w.envSets).toEqual([['CLAUDE_CODE_PROMPT_CACHE_TTL', '1h']])
  await prompt($, w, 't1')
  expect((await snap($)).anchor).toMatchObject({ ttl: '1h' })
})

test('upgradeTo1h leaves a subscription, a forced 5m and an off setting alone', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.envSets).toEqual([])
})

test('a subscription whose windows only appear with the first response still gets the 1h TTL', async ($, on) => {
  const w = world(on)
  w.usage.rateLimits = []
  await start($)
  expect((await snap($)).limits).toMatchObject({ overLimit: false })
  w.usage.rateLimits = [{ kind: 'five_hour', percentUsed: 1 }] // the first response reported them
  await prompt($, w, 't1')
  expect((await snap($)).anchor).toMatchObject({ ttl: '1h' })
})

test('over the plan limit a subscription drops to 5m', async ($, on) => {
  const w = world(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 100 }, { kind: 'seven_day', percentUsed: 20 }] })
  await start($)
  await prompt($, w, 't1')
  expect((await snap($)).anchor).toMatchObject({ ttl: '5m' })
})

test('plan-percent rates are learned from cost deltas at whole-point crossings', async ($, on) => {
  const w = world(on)
  await start($) // 5h at 9%, $10
  await measure($, w, { fiveHour: 10, weekly: 5 }, 12) // first crossing: re-bases, learns nothing
  expect(w.stored.get('learned')).toBeUndefined()
  await measure($, w, { fiveHour: 11, weekly: 5 }, 14.4)
  expect(Math.abs((w.stored.get('learned') as { usdPerPoint5h: number }).usdPerPoint5h - 2.4) < 1e-9).toBe(true)
  await measure($, w, { fiveHour: 12, weekly: 5 }, 15.6) // 1.2 per point: 0.3 * 1.2 + 0.7 * 2.4
  expect(Math.abs(((w.stored.get('learned') as { usdPerPoint5h: number }).usdPerPoint5h) - 2.04) < 1e-9).toBe(true)
  // and the cold line shows it: a rewrite of 400k at 1h is $3.20, ~1.6 points
  await prompt($, w, 't1')
  await cache($, 'pause')
  await w.clock.advance(3 * HOUR)
  expect((await cache($, 'status')).text).toMatch(/~1\.6% of 5h/)
})

test('the log is JSONL with one line per refresh and per stop, and an over-large log is trimmed', async ($, on) => {
  const w = world(on)
  w.replies.push(warmed(), coldFork())
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(2 * HOUR)
  const lines = logLines(w)
  expect(lines.map(l => l.ev)).toEqual(['refresh', 'refresh', 'stop'])
  expect(lines[0]).toMatchObject({
    result: 'warmed', attempt: 0, phase: 'idle', promptTokens: 400_000, cacheRead: 399_000, input: 91, output: 4,
    lateMs: 0, weeklyBefore: 5, weeklyAfter: 5, fiveHourBefore: 9,
  })
  expect(Math.abs((lines[0]?.costUsd as number) - 0.0804) < 1e-9).toBe(true)
  expect(Math.abs((lines[0]?.estUsd as number) - 0.080464) < 1e-9).toBe(true)
  expect(lines[2]).toMatchObject({ ev: 'stop', code: 'cold', refreshes: 1 })
  // a log past 2 MB loses its oldest half before the next write
  w.files.set(LOG_PATH, `${'{"ev":"old","pad":"' + 'x'.repeat(1000) + '"}\n'}`.repeat(2100))
  await cache($, 'off')
  await cache($, 'on')
  await prompt($, w, 't2')
  const after = w.files.get(LOG_PATH) ?? ''
  expect(after.length).toBeLessThan(2_000_000)
})

test('a throwing log or store never breaks warming', async ($, on) => {
  const w = world(on, { failWrites: true })
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(1)
  expect((await st($, 'status')).kind).toBe('scheduled')
  expect(w.logged.some(l => l.includes('log write failed'))).toBe(true)
})

test('a permission prompt shows as a dialog until the call resolves or the turn ends', async ($, on) => {
  const w = world(on)
  await start($)
  await openTurn($, w, 't1')
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
  expect((await snap($)).dialog).toMatchObject({ tool: 'permission:Bash' })
  w.toolResults.push({ stdout: '' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((await snap($)).dialog).toBeNull()
  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: {} } as never)
  await closeTurn($, 't1')
  expect((await snap($)).dialog).toBeNull()
  expect((await snap($)).turn).toBeNull()
})

test('every observed hook passes the engine\'s answer through untouched', async ($, on) => {
  const w = world(on)
  await start($)
  const step = { turnId: 't1', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn' as const, usage: turnUsage(OPUS, 399_000, 1_000) }
  expect(await $.turn.start({ text: 'x', turnId: 't1' })).toEqual({ turnId: 't1' })
  w.toolResults.push({ stdout: 'out' })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((r as { result: unknown }).result).toEqual({ stdout: 'out' })
  expect((await $.session.measure({ context: { tokens: 1, window: 2 }, rateLimits: [], changed: ['context'] })).changed).toEqual(['context'])
  void step
})

// ---------------------------------------------------------------------------
// Phase 2, section A

const r6 = (n: number | null | undefined) => (n == null ? n : Math.round(n * 1e6) / 1e6)
const OLD_ANCHOR = { at: START, model: OPUS, promptTokens: 400_000, ttl: '1h' } as const

test('A1. state another version wrote reads as absent; a lone anchor says nothing instead of "expires "', async ($, on) => {
  const w = world(on)
  // The test's $ has no state noun, so what the kit's state answers for a read is replaced beneath the plugin.
  const stored: Record<string, unknown> = {}
  on('state.get', { plugin: 'cache-keeper' }, (_, e, next) => ('key' in e && (e.key as string) in stored ? { value: { value: stored[e.key as string], version: 7 } } : next(e)) as never)
  await start($)
  // what the Phase 0 spike left behind: an anchor and a status of another shape, stored untagged
  stored.anchor = { at: START, tokens: 400_000 }
  stored.status = { kind: 'scheduled', nextAt: START + HOUR }
  const s = await snap($)
  expect(s.anchor).toBeNull()
  expect(s.status).toEqual({ kind: 'waiting' })
  expect((await cache($, 'status')).text).toContain('No cache to keep yet')
  // a value under the current tag reads; one under another tag does not
  stored.anchor = { shape: 'ck2', value: OLD_ANCHOR }
  expect((await snap($)).anchor).toMatchObject({ promptTokens: 400_000 })
  stored.anchor = { shape: 'ck0', value: OLD_ANCHOR }
  expect((await snap($)).anchor).toBeNull()
  // the tag was bumped with the paused flag's removal: what ck1 wrote (a `paused` of true, a holding/paused status) is gone
  stored.anchor = { shape: 'ck1', value: OLD_ANCHOR }
  stored.status = { shape: 'ck1', value: { kind: 'holding', reason: 'paused' } }
  expect((await snap($)).anchor).toBeNull()
  expect((await snap($)).status).toEqual({ kind: 'waiting' })
  // an anchor without a chain (a version that kept them apart): no half-empty line, no refresh
  stored.anchor = { shape: 'ck2', value: OLD_ANCHOR }
  stored.status = { shape: 'ck2', value: { kind: 'waiting' } }
  expect((await cache($, 'status')).text).toContain('No cache to keep yet')
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(0)
  // a chain without an anchor is the same
  delete stored.anchor
  stored.chain = { shape: 'ck2', value: { touchAt: START, refreshes: 0, costUsd: 0 } }
  expect((await cache($, 'status')).text).toContain('No cache to keep yet')
  // and the next request starts clean
  delete stored.chain
  delete stored.status
  await prompt($, w, 't1')
  expect((await cache($, 'status')).text).toContain('Warm · next refresh in')
})

test('A2. a permission prompt raised in a subagent or fork is not a dialog; a stale one clears on the next turn.start', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'fork1' } as never)
  expect((await snap($)).dialog).toBeNull()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
  expect((await snap($)).dialog).toMatchObject({ tool: 'permission:Bash' })
  // the turn never completed (an abort): the next turn clears it
  await $.turn.start({ text: 'x', turnId: 't2' })
  expect((await snap($)).dialog).toBeNull()
  // a real dialog (AskUserQuestion) is not touched by a turn start
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' } as never)
  const release = w.holdTool()
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await w.clock.settle()
  await $.turn.start({ text: 'y', turnId: 't3' })
  expect((await snap($)).dialog).toMatchObject({ tool: 'AskUserQuestion' })
  release()
  await call
})

test('A3. a fork that overlapped a main request, or whose ledger rise is over 3x the estimate, books the estimate', async ($, on) => {
  const w = world(on)
  await start($)
  await prompt($, w, 't1')
  const est = refreshUsd(OPUS, 400_000)
  // a normal refresh books the ledger's rise
  await w.clock.advance(55 * MINUTE)
  expect(r6((await snap($)).last?.costUsd)).toBe(0.0804)
  expect(r6((await snap($)).session.costUsd)).toBe(0.0804)
  // a main request lands while the next fork runs: the ledger took its cost too
  const release = w.holdFork()
  await w.clock.advance(55 * MINUTE)
  expect(w.forks).toHaveLength(2)
  w.usage.costUsd += 0.5 // the main request's own cost, on the same ledger
  await w.clock.advance(1000)
  await prompt($, w, 't2')
  release()
  await w.clock.settle()
  let s = await snap($)
  expect(s.last).toMatchObject({ costUsd: null, estUsd: est })
  expect(r6(s.session.costUsd)).toBe(r6(0.0804 + est))
  expect(s.session.refreshes).toBe(2)
  expect(w.stored.get('allTime')).toMatchObject({ refreshes: 2 })
  expect(r6(((await w.stored.get('allTime')) as { costUsd: number }).costUsd)).toBe(r6(0.0804 + est))
  // a main step still in flight while the fork lands counts as overlap too
  const releaseFork = w.holdFork()
  await w.clock.advance(55 * MINUTE)
  const releaseStep = w.holdStep()
  const main = prompt($, w, 't3')
  await w.clock.settle()
  releaseFork()
  await w.clock.settle()
  expect((await snap($)).last?.costUsd).toBeNull()
  releaseStep()
  await main
  // no overlap, but the rise is far beyond one refresh (another session on the same ledger): estimate again
  const before = (await snap($)).session.costUsd
  await w.clock.advance(55 * MINUTE)
  expect(r6((await snap($)).session.costUsd)).toBe(r6(before + 0.0804))
})

test('A3b. a ledger rise over 3x the estimate books the estimate', async ($, on) => {
  const w = world(on, { forkUsd: 1 })
  await start($)
  await prompt($, w, 't1')
  await w.clock.advance(55 * MINUTE)
  const s = await snap($)
  expect(s.last).toMatchObject({ costUsd: null })
  expect(r6(s.session.costUsd)).toBe(r6(refreshUsd(OPUS, 400_000)))
  expect(r6(s.chain?.costUsd)).toBe(r6(refreshUsd(OPUS, 400_000)))
})

test('totals saved before grossUsd carry over with their net: gross = net + cost', async ($, on) => {
  const w = world(on)
  w.stored.set('allTime', { refreshes: 7, costUsd: 0.5, avoided: 2, savedUsd: 3, since: START })
  await start($)
  const stats = (await cache($, 'stats')).text ?? ''
  expect(stats).toContain('All time')
  expect(stats).toContain('7 refreshes · 2 rewrites avoided (would have cost $3.50) · refreshes cost $0.50 · saved $3.00')
  // and new totals add to them
  await prompt($, w, 't1')
  await w.clock.advance(2 * HOUR)
  await prompt($, w, 't2', turnUsage(OPUS, 399_000, 1_000))
  expect(w.stored.get('allTime')).toMatchObject({ refreshes: 9, avoided: 3 })
  expect(Math.abs((w.stored.get('allTime') as { grossUsd: number }).grossUsd - (3.5 + rewriteUsd(OPUS, 399_000, '1h'))) < 1e-9).toBe(true)
})

test('a new session starts with warming off, whatever the saved window; /cache on then uses the saved window', { options: { keepFor: '4h' } }, async ($, on) => {
  const w = world(on)
  await start($, false)
  expect((await snap($)).settings.keepFor).toBe('off')
  await prompt($, w, 't1')
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(0)
  await cache($, 'on')
  expect((await snap($)).settings.keepFor).toBe('4h')
})

test('changing the saved window from /config never turns warming on: an off session stays off, and On then uses the new window', async ($, on) => {
  const w = world(on)
  await start($, false)
  await prompt($, w, 't1')
  await setConfig($, 'cache-keeper.keepFor', '2h')
  expect((await snap($)).settings.keepFor).toBe('off')
  await w.clock.advance(2 * HOUR)
  expect(w.forks).toHaveLength(0)
  await cache($, 'on')
  expect((await snap($)).settings.keepFor).toBe('2h')
})
