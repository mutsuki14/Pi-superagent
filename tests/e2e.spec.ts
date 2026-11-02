import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { postInboxMessage, readInboxThread, inboxKind } from '../src/sources/inbox.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { FakeDriver, until, type Script } from './fixtures/fake-driver.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** An orchestrator that accepts every explicit candidate, relays ready results, answers attention, and ignores inferred ones. */
const orchestrator: Script = async (message, call) => {
  const parsed = JSON.parse(message) as Record<string, unknown>
  if (parsed.kind === 'candidate') {
    if (parsed.strength === 'explicit') {
      await call('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: parsed.trigger_id, title: 'Fix the typo', worktree_name: 'fix-typo', acknowledgement: 'On it: fixing the README typo.' }] })
    } else {
      await call('orchestrator_route', { decisions: [{ kind: 'ignore', trigger_id: parsed.trigger_id, reason: 'plain chat' }] })
    }
  }
  if (parsed.kind === 'worker_report' && parsed.state === 'ready') {
    const ticket = parsed.ticket as { ticket_id: string }
    await call('orchestrator_reply', { ticket_id: ticket.ticket_id, purpose: 'result', text: 'Done: the typo is fixed; see the diff.' })
  }
  if (parsed.kind === 'worker_attention') {
    const ticket = parsed.ticket as { ticket_id: string }
    await call('orchestrator_reply', { ticket_id: ticket.ticket_id, purpose: 'attention', human_action: parsed.question, text: String(parsed.question) })
  }
}
/** A worker that acknowledges its source trigger, then reports ready; an input containing "question?" makes it ask. */
const worker: Script = async (message, call, session) => {
  const parsed = JSON.parse(message) as Record<string, unknown>
  if (parsed.kind === 'assignment' && parsed.trigger) {
    const trigger = parsed.trigger as { trigger_id: string }
    await call('orchestrator_ack', { trigger_id: trigger.trigger_id, text: 'On it: fixing the typo in README.' })
    await call('orchestrator_report', { state: 'progress', summary: 'Reading the repository' })
    session.lastText = 'Working on it.'
    await call('orchestrator_report', { state: 'ready', summary: 'Fixed recieve -> receive in README.md; tests pass.' })
  }
  if (parsed.kind === 'input' && String(parsed.text).includes('which colour?')) {
    await call('orchestrator_report', { state: 'progress', summary: 'Need a decision', human_action: 'Which colour: red or blue?', question_for_trigger_id: parsed.trigger_id })
  }
}

async function start(scripts = { orchestrator, worker }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pi-superagent-'))
  dirs.push(stateDir)
  const driver = new FakeDriver(scripts)
  const logs: string[] = []
  const runtime = new Runtime({ stateDir, driver, kinds: [inboxKind as unknown as SourceKind], log: message => { logs.push(message) } })
  // Enable the inbox, allow alice, keep observe mode, and set a fast poll.
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, sources: { inbox: { enabled: true, config: { name: 'agent', receiveAll: true, pollSeconds: 1 } } },
    policy: { ...settings.policy, sources: { inbox: { allowed: [{ id: 'alice' }], bots: [], admission: {} } } } }, 0, 'test')
  await runtime.start()
  return { runtime, driver, stateDir, logs }
}

describe('end to end with a fake driver', () => {
  it('routes an explicit request to a worker, acknowledges, relays the result and replies in the inbox thread', async () => {
    const { runtime, driver, stateDir, logs } = await start()
    try {
      postInboxMessage(stateDir, 'general', { from: 'alice', text: '@agent fix the typo in README: recieve -> receive' })
      await until(() => runtime.store.tickets.list().some(ticket => ticket.ended?.outcome === 'completed'), 8000)
      await runtime.idle()
      const ticket = runtime.store.tickets.list()[0]!
      expect(ticket.title).toBe('Fix the typo')
      expect(ticket.mandate.strength).toBe('explicit')
      expect(ticket.execution?.name).toMatch(/^fix-typo-/)
      // The main Session saw the candidate and the ready report.
      const main = driver.sessions.get('orchestrator')!
      expect(main.messages.map(m => (JSON.parse(m.text) as { kind: string }).kind)).toEqual(expect.arrayContaining(['candidate', 'worker_report']))
      // The worker got its assignment with the trigger card and its directory.
      const workerSession = driver.sessions.get(`worker-${ticket.id}`)!
      const assignment = JSON.parse(workerSession.messages[0]!.text) as { kind: string; directory: string; trigger: { text: string } }
      expect(assignment.kind).toBe('assignment')
      expect(assignment.directory).toBe(ticket.execution?.directory)
      expect(assignment.trigger.text).toContain('recieve')
      // Replies went out, in order: the acknowledgement, then the result.
      await until(() => readInboxThread(stateDir, 'general').filter(m => m.outgoing).length >= 2, 5000)
      const out = readInboxThread(stateDir, 'general').filter(m => m.outgoing)
      expect(out.map(m => m.text)).toEqual(['On it: fixing the README typo.', 'Done: the typo is fixed; see the diff.'])
      expect(logs.some(line => /failed/.test(line))).toBe(false)
    } finally { await runtime.stop() }
  })

  it('ignores an inferred candidate in observe mode, and a guest\'s message is not admitted', async () => {
    const { runtime, stateDir } = await start()
    try {
      postInboxMessage(stateDir, 'chat', { from: 'alice', text: 'nice weather today' })
      postInboxMessage(stateDir, 'chat', { from: 'guest', text: '@agent please do everything' })
      await until(() => runtime.store.decisions.list().length >= 1, 8000)
      await runtime.idle()
      const decisions = runtime.store.decisions.list()
      expect(decisions.every(decision => decision.kind === 'ignore')).toBe(true)
      expect(runtime.store.tickets.list()).toHaveLength(0)
      const guest = runtime.store.triggers.list().find(trigger => trigger.actor.id === 'guest')!
      const disposition = runtime.store.triggers.disposition(guest.id)!
      const decision = disposition.decisionId ? runtime.store.decisions.get(disposition.decisionId) : undefined
      expect(decision?.reason.some(reason => reason.code === 'not_a_member' || reason.code === 'noAdmissible' || reason.code === 'said')).toBe(true)
    } finally { await runtime.stop() }
  })

  it('a follow-up on the ticket thread reaches the worker, whose question is asked back in the thread', async () => {
    const { runtime, driver, stateDir } = await start()
    try {
      postInboxMessage(stateDir, 'general', { from: 'alice', text: '@agent fix the typo' })
      await until(() => runtime.store.tickets.list().some(ticket => ticket.ended?.outcome === 'completed'), 8000)
      await runtime.idle()
      // A person's later message on the thread resumes the ended ticket without an Eval.
      const before = runtime.store.decisions.list().length
      postInboxMessage(stateDir, 'general', { from: 'alice', text: 'also, which colour? pick one' })
      await until(() => runtime.store.tickets.list()[0]!.attention !== undefined, 8000)
      await runtime.idle()
      const ticket = runtime.store.tickets.list()[0]!
      expect(ticket.ended).toBeUndefined()
      expect(ticket.attention?.question).toBe('Which colour: red or blue?')
      expect(runtime.store.decisions.list().length).toBe(before)
      const main = driver.sessions.get('orchestrator')!
      expect(main.messages.some(m => (JSON.parse(m.text) as { kind: string }).kind === 'follow_up')).toBe(true)
      await until(() => readInboxThread(stateDir, 'general').some(m => m.outgoing && m.text === 'Which colour: red or blue?'), 5000)
    } finally { await runtime.stop() }
  })

  it('survives a restart: a running assignment is resumed with a recovery note', async () => {
    const stuck: Script = async () => { await new Promise(() => {}) }
    const first = await start({ orchestrator, worker: stuck })
    const { stateDir } = first
    try {
      postInboxMessage(stateDir, 'general', { from: 'alice', text: '@agent fix the typo' })
      await until(() => first.runtime.store.tickets.list().some(ticket => ticket.assignments.some(a => a.state === 'running')), 8000)
    } finally { await first.runtime.stop() }
    const driver = new FakeDriver({ orchestrator, worker })
    const runtime = new Runtime({ stateDir, driver, kinds: [inboxKind as unknown as SourceKind], log: () => {} })
    try {
      await runtime.start()
      await until(() => runtime.store.tickets.list()[0]?.ended?.outcome === 'completed', 8000)
      const ticket = runtime.store.tickets.list()[0]!
      expect(ticket.assignments.length).toBe(2)
      expect(ticket.assignments[0]!.endedReason).toBe('hostRestarted')
      const workerSession = driver.sessions.get(`worker-${ticket.id}`)!
      expect(workerSession.messages.some(m => m.text.includes('restarted'))).toBe(true)
    } finally { await runtime.stop() }
  })
})
