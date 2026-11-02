/** Runtime: the composition root. Opens the Store, builds every component, starts the Sources, passes and effects, and shuts down cleanly. */
import { join } from 'node:path'
import { Engine, type DomainEvent, type Trigger } from '../core/index.ts'
import { settingsPolicy, type Settings as SettingsValue } from '../policy.ts'
import { MasterAssessor } from './assessment.ts'
import { Effects } from './effects.ts'
import { HealthBoard } from './health.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { Outbox } from './outbox.ts'
import { Prompts } from './prompts.ts'
import { Sessions, type SessionDriver, type SessionSpec } from './sessions.ts'
import { Settings } from './settings.ts'
import { Store } from './store.ts'
import { executorTools } from './tools/executor.ts'
import { mainTools } from './tools/main.ts'
import { mandateInstructions, PiExecutor } from '../executor/pi.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { githubKind, claimPull, type GithubConfig } from '../sources/github.ts'
import { inboxKind } from '../sources/inbox.ts'
import type { SourceKind } from '../sources/kind.ts'

export interface RuntimeOptions {
  stateDir: string
  /** The repository checkout the main Session works from; defaults to `<stateDir>/repo` (created if missing). */
  repoDir?: string
  driver: SessionDriver
  kinds?: SourceKind[]
  log?: (message: string) => void
}
export class Runtime {
  readonly store: Store
  readonly health = new HealthBoard()
  readonly effects: Effects
  readonly engine: Engine
  readonly sources: SourceRegistry
  readonly outbox: Outbox
  readonly sessions: Sessions
  readonly assessor: MasterAssessor
  readonly executor: PiExecutor
  readonly settings: Settings
  readonly prompts: Prompts
  readonly log: (message: string) => void
  private readonly lifetime = new AbortController()
  private closing = false
  private timer?: ReturnType<typeof setInterval>
  private pumping?: Promise<void>
  private again = false
  constructor(readonly options: RuntimeOptions) {
    this.log = options.log ?? ((message: string) => { console.log(`[pi-superagent ${new Date().toISOString()}] ${message}`) })
    this.store = new Store(options.stateDir)
    this.prompts = new Prompts(options.stateDir)
    this.effects = new Effects(this.store, this.health)
    const paused = () => this.store.settings().paused
    this.sources = new SourceRegistry({ store: this.store, health: this.health, lifetime: this.lifetime.signal, stateDir: options.stateDir,
      engine: () => this.engine, settings: () => this.store.settings(), receive: trigger => this.receive(trigger), log: this.log })
    for (const kind of options.kinds ?? [githubKind as unknown as SourceKind, inboxKind as unknown as SourceKind]) this.sources.register(kind)
    this.outbox = new Outbox({ store: this.store, effects: this.effects, sources: this.sources, paused })
    this.sessions = new Sessions({ driver: options.driver, store: this.store, effects: this.effects, mainSpec: () => this.mainSpec(), paused, log: this.log })
    this.assessor = new MasterAssessor({ engine: { candidate: id => this.engine.candidate(id), candidateDelivered: id => this.engine.candidateDelivered(id), decide: (id, outcome) => this.engine.decide(id, outcome) },
      effects: this.effects, store: this.store, sources: this.sources, settings: () => this.store.settings(), paused,
      deliver: (id, text) => this.sessions.deliver(id, text, 'queue') })
    this.executor = new PiExecutor({
      engine: { assignmentStarted: (t, a) => this.engine.assignmentStarted(t, a), inputsDelivered: (t, a, i) => this.engine.inputsDelivered(t, a, i), inputsRead: (t, i) => this.engine.inputsRead(t, i),
        turnEnded: (t, a) => this.engine.turnEnded(t, a), deliveryFailed: (t, a, e) => this.engine.deliveryFailed(t, a, e), report: (t, r) => this.engine.report(t, r),
        assignmentInterrupted: (t, a) => this.engine.assignmentInterrupted(t, a) },
      store: this.store, effects: this.effects, health: this.health.claim('worker'), driver: options.driver, stateDir: options.stateDir, lifetime: this.lifetime.signal,
      closing: () => this.closing, paused, environment: ticket => this.environment(ticket), workerSpec: ticket => this.workerSpec(ticket),
      relay: (id, text) => this.sessions.relay(id, text), repliedTo: trigger => { const id = this.sources.repliesTo(trigger); return id ? this.store.triggers.get(id) : undefined }, log: this.log })
    this.engine = new Engine({ repo: this.store, scope: this.sources, policy: () => settingsPolicy(this.store.settings(), this.sources), assessor: this.assessor,
      executor: this.executor, outbox: this.outbox, prepareTicket: (ticket, outcome) => this.executor.prepare(ticket, outcome), emit: event => this.emitted(event) })
    this.settings = new Settings({ store: this.store, engine: this.engine, sources: this.sources, sessions: this.sessions, scope: settings => this.scopeUnder(settings), requestPass: () => this.requestPass() })
  }
  private scopeUnder(settings: SettingsValue) {
    return { scope: (input: { source: string; meta: Record<string, unknown> }) => {
      const kind = this.sources.kind(input.source), stored = settings.sources[input.source]
      if (!kind || !stored?.enabled) return { listened: false as const, reason: 'source_off' }
      const parsed = kind.schema.safeParse(stored.config)
      if (!parsed.success) return { listened: false as const, reason: 'source_invalid' }
      return kind.scope ? kind.scope(input, parsed.data) : { listened: true as const, observed: false }
    } }
  }
  get repoDir(): string { return this.options.repoDir ?? join(this.options.stateDir, 'repo') }
  environment(ticket?: import('../core/index.ts').Ticket) {
    const trigger = ticket ? this.store.triggers.get(ticket.origin.triggerId) : undefined
    const own = ticket ? [{ key: 'PI_SUPERAGENT_DIR', value: ticket.execution?.directory ?? '', description: 'The ticket\'s directory' },
      { key: 'PI_SUPERAGENT_NAME', value: ticket.execution?.name ?? '', description: 'The ticket\'s short name, which its branch should end with' },
      { key: 'PI_SUPERAGENT_TICKET', value: ticket.id, description: 'The ticket id' }] : []
    return [...own, ...this.sources.environment(ticket, trigger)]
  }
  private mainSpec(): SessionSpec {
    const settings = this.store.settings()
    const resources = { store: this.store, health: this.health, sources: this.sources }
    const tools = mainTools({ engine: this.engine, store: this.store, settings: this.settings, assessor: this.assessor, resources,
      requestPass: () => this.requestPass(), sendReplies: () => this.outbox.sent(), log: this.log })
    return { cwd: this.repoDir, role: 'orchestrator', title: 'orchestrator', tools, builtinTools: [], model: settings.eval.model,
      systemPrompt: this.prompts.compose('orchestrator', { settings, environment: this.environment() }) }
  }
  private workerSpec(ticket: import('../core/index.ts').Ticket): SessionSpec {
    const settings = this.store.settings()
    const resources = { store: this.store, health: this.health, sources: this.sources }
    const github = this.sources.context('github') as import('../sources/kind.ts').SourceContext<GithubConfig> | undefined
    const tools = executorTools({ engine: this.engine, store: this.store, sessions: this.sessions, resources, sendReplies: () => this.outbox.sent(),
      ...github ? { claimPull: (ticketId: string, number: number, signal: AbortSignal) => claimPull(github, ticketId, number, signal) } : {} }, ticket)
    const extra = [mandateInstructions(ticket.mandate), `Ticket ${ticket.id}: ${ticket.title}. Scope: ${ticket.mandate.scope}.`].filter(Boolean).join('\n')
    return { cwd: ticket.execution?.directory ?? join(this.options.stateDir, 'work', ticket.id), role: 'worker', title: ticket.title, tools,
      builtinTools: settings.executor.tools, model: settings.executor.model,
      systemPrompt: this.prompts.compose('worker', { settings, environment: this.environment(ticket), ticket: extra }) }
  }
  private emitted(event: DomainEvent): void {
    const notice = eventNotice(event, id => this.store.tickets.get(id))
    if (notice) this.store.afterCommit(() => this.sessions.notify(...notice))
    if (event.type === 'trigger.received') {
      this.store.afterCommit(() => {
        const relay = followupNotice(this.store, event.data.triggerId, id => { const trigger = this.store.triggers.get(id); return trigger && this.sources.repliesTo(trigger) })
        if (relay) this.sessions.relay(relay.id, relay.text)
      })
    }
  }
  /** A Source's Trigger enters the Engine, and a pass follows. */
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered' {
    if (this.closing) throw new Error('pi-superagent is stopping')
    const result = this.engine.receive(trigger)
    if (result === 'stored') this.requestPass()
    return result
  }
  /** One pass: due effects, then the Engine's due Evals and resumes. */
  requestPass(): void {
    if (this.pumping) { this.again = true; return }
    this.pumping = (async () => {
      do {
        this.again = false
        try { this.effects.kick(); if (!this.closing) this.engine.evaluateDue() }
        catch (error) { this.log(`pass failed: ${String(error)}`) }
        await new Promise(resolve => setTimeout(resolve, 0))
      } while (this.again && !this.closing)
    })().finally(() => { this.pumping = undefined })
  }
  async start(): Promise<void> {
    this.executor.install()
    this.executor.resume()
    this.effects.start()
    this.sources.start()
    this.timer = setInterval(() => this.requestPass(), 2000)
    this.timer.unref?.()
    this.requestPass()
    this.log(`started; state in ${this.options.stateDir}`)
  }
  async stop(): Promise<void> {
    this.closing = true
    clearInterval(this.timer)
    this.lifetime.abort()
    await this.sources.stop()
    await this.effects.drain()
    this.executor.dispose()
    await this.options.driver.disposeAll()
    this.log('stopped')
  }
  /** Waits until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await this.pumping
      await this.effects.idle()
      if (!this.pumping) return
    }
  }
}
