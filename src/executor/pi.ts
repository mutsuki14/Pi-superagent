/** Pi executor: one persistent worker Session and workspace directory per ticket, driven through the durable effect queue. */
import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { HealthEntry } from '../app/health.ts'
import type { SessionDriver, SessionHandle, SessionSpec } from '../app/sessions.ts'
import { ticketOfSession, workerSessionId } from '../app/sessions.ts'
import { ASSIGNMENT_CHARS, batchLine, inputResource, triggerMessage } from '../app/cards.ts'
import { resultRelay } from '../app/notices.ts'
import { capped, now } from '../app/text.ts'

/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
const SLOT_WAIT_MS = 5000
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/** True when an error represents a transient network or model-provider failure. */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
export const WorktreeName = /^[a-z]+(?:-[a-z0-9]+){0,3}$/
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeName.test(name) ? name : 'ticket'}-${id.slice(0, 12)}`
export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

export interface ExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report' | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly health: HealthEntry
  readonly driver: SessionDriver
  readonly stateDir: string
  readonly lifetime: AbortSignal
  closing(): boolean
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its prepare command and named in its prompt. */
  environment(ticket: Ticket): { key: string; value: string; description: string }[]
  /** The worker Session's spec for a ticket: its prompt and tools. */
  workerSpec(ticket: Ticket): SessionSpec
  /** Steers a relay into the main Session. */
  relay(id: string, text: string): void
  repliedTo(trigger: Trigger): Trigger | undefined
  log(message: string): void
}
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined => host.store.triggers.get(ticket.origin.triggerId)

/** Extra mandate instructions for work accepted proactively under rules. */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings, stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id)).map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}` : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Formats a ticket input for worker delivery. */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  if (input.kind === 'trigger') return JSON.stringify({ kind: 'input', ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` }, ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}

/** Tracks worker slots against the configured concurrency limit, with one extra slot for a person's message. */
export class WorkerSlots {
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/** Runs a shell command with a timeout and environment; resolves with its output or rejects with the output of a failed one. */
export function runCommand(command: string, cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', error => reject(new Error(`${error.message}\n${output}`.trim())))
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`exit ${code}\n${output.slice(-4000)}`.trim())))
  })
}

/**
 * Executes ticket assignments in persistent per-ticket Pi worker Sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for Session idle and
 * error events, and reports status transitions back to the Engine.
 */
export class PiExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  private readonly transient = new Map<string, number>()
  private readonly resuming = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Tickets whose worker a person is talking to directly, or that handed off; their idle is not reported waiting. */
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(), retry: [5000, 300_000] })
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.stateDir) }
  }
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) {
      try { await runCommand(command, dirname(directory), env, signal) }
      catch (error) {
        await rm(directory, { recursive: false, force: true }).catch(() => {})
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await mkdir(directory, { recursive: true })
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    this.host.store.afterCommit(() => {
      this.clearTurnTimer(ticket.id)
      if (!ownTurn) void this.host.driver.get(workerSessionId(ticket.id))?.cancel().catch(() => {})
    })
  }
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  private async deliverQueued(ticketId: string): Promise<void> {
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        if (!woken && !this.running(ticket)) {
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          const session = await this.host.driver.ensure(workerSessionId(ticketId), this.host.workerSpec(ticket))
          if (input) await this.deliverInput(ticket, assignment, input, session)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.store.atomic(() => {
          this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
          // Pi takes a message into its history as soon as it is accepted, so the worker's model has it from here.
          this.host.engine.inputsRead(ticketId, [inputId])
        })
        this.armTurnTimer(ticketId)
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput, session: SessionHandle): Promise<void> {
    const current = this.host.store.tickets.get(ticket.id)
    if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
    const trigger = input.kind === 'trigger' ? this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await session.send(text, 'steer')
  }
  private triggerCard(ticket: Ticket, triggerId: string, note?: string): object | undefined {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, note, seen ? undefined : parent)
  }
  /** Whether a ticket's worker holds a slot: its turn runs. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.driver.get(workerSessionId(ticket.id))?.status() === 'running'
  }
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) return
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.host.relay(...this.relayArgs(resultRelay(updated, 'failed', summary)))
    })
  }
  private relayArgs(relay: { id: string; text: string }): [string, string] { return [relay.id, relay.text] }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('pi-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    const sessionId = workerSessionId(ticket.id)
    const session = await this.host.driver.ensure(sessionId, this.host.workerSpec(ticket))
    if (!current()) return
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && session.holds(first)
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : this.triggerCard(ticket, source.id)
    const batch = told ? [] : ticket.origin.triggerIds.filter(id => id !== ticket.origin.triggerId).flatMap(id => this.host.store.triggers.get(id) ?? []).map(batchLine)
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    const environment = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const text = told ? JSON.stringify({ kind: 'assignment', request_id: requestId, ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ kind: 'assignment', request_id: requestId, ticket_id: ticket.id, title: ticket.title, directory: workspace, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}), ...(batch.length ? { batch } : {}),
        environment, ...retried })
    if (!current()) return
    await session.send(text, 'queue')
    this.host.store.atomic(() => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.armTurnTimer(ticket.id)
  }
  /** Subscribes to Session idle and error events. Call once at startup. */
  install(): void {
    this.disposers.push(this.host.driver.onIdle(sessionId => {
      const ticketId = ticketOfSession(sessionId)
      if (ticketId === undefined || this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment))
    }))
    this.disposers.push(this.host.driver.onError((sessionId, error) => {
      const ticketId = ticketOfSession(sessionId)
      if (ticketId === undefined || this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket)) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    for (const timer of this.turnTimers.values()) clearTimeout(timer)
    this.timers.clear(); this.turnTimers.clear()
  }
  /** Reconciles assignments after a host restart: running ones are interrupted, pending ones queued again. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }); this.host.log(`worker event failed: ${String(error)}`) })
  }
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.driver.ensure(workerSessionId(ticketId), this.host.workerSpec(ticket)).then(session => session.send(text, 'queue'))
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /** A turn that runs past the configured limit is aborted and the ticket reported failed. */
  private armTurnTimer(ticketId: string): void {
    this.clearTurnTimer(ticketId)
    const minutes = this.host.store.settings().executor.turnTimeoutMinutes
    const timer = setTimeout(() => {
      this.turnTimers.delete(ticketId)
      const session = this.host.driver.get(workerSessionId(ticketId))
      if (session?.status() !== 'running') return
      void this.background(session.cancel().then(() => { this.failed(ticketId, `The worker's turn ran longer than ${minutes} minutes and was aborted.`) }))
    }, minutes * 60_000)
    timer.unref?.()
    this.turnTimers.set(ticketId, timer)
  }
  private clearTurnTimer(ticketId: string): void { clearTimeout(this.turnTimers.get(ticketId)); this.turnTimers.delete(ticketId) }
  /**
   * The worker's turn ended: the Engine hears `turnEnded`; a turn that ended without a report since its last Input, and did not
   * hand off to a person, is reported `waiting` with the worker's last words so the main Session can ask for a status.
   */
  private async workerIdle(ticket: Ticket, idle: Assignment): Promise<void> {
    this.clearTurnTimer(ticket.id)
    if (this.resuming.has(idle.id)) return
    this.transient.delete(idle.id)
    const stored = this.host.store.tickets.get(ticket.id)
    if (!stored || !liveTicket(stored) || runningAssignment(stored)?.id !== idle.id || this.host.closing()) return
    const assignment = runningAssignment(stored)!, report = assignment.report
    this.host.store.atomic(() => { this.host.engine.turnEnded(ticket.id, idle.id) })
    const since = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const handedOff = ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    if (handedOff) return
    // The worker reported since its last Input: that report stands, and the main Session heard it if it needed to.
    if (report && !since && report.state !== 'progress') return
    if (this.host.store.tickets.get(ticket.id)?.undelivered.length) return
    const said = this.host.driver.get(workerSessionId(ticket.id))?.lastAssistantText().trim() ?? ''
    this.host.store.atomic(() => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== idle.id) return
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      if (said) this.host.relay(...this.relayArgs(resultRelay(updated, 'waiting', said)))
      else if (!before.trim()) this.host.relay(...this.relayArgs(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.')))
    })
  }
}
export { key as effectKey }
