/** The Source kinds installed and their stored instances; implements the Engine's `SourceScope` and routes outbound messages. */
import type { ChannelRef, EngineForSources, OutboundMessage, ScopeResult, SourceScope, Thread, Ticket, Trigger } from '../core/index.ts'
import type { HealthBoard } from '../app/health.ts'
import type { Store } from '../app/store.ts'
import { SourcePolicySchema, type Settings, type SourcePolicy } from '../policy.ts'
import type { SourceContext, SourceInstance, SourceKind } from './kind.ts'

export interface RegistryHost {
  readonly store: Store
  readonly health: HealthBoard
  readonly lifetime: AbortSignal
  readonly stateDir: string
  engine(): EngineForSources
  settings(): Settings
  /** Receives a Trigger and schedules a pass. */
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered'
  log(message: string): void
}

export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly contexts = new Map<string, SourceContext<Record<string, unknown>>>()
  private readonly loops = new Map<string, Promise<void>>()
  constructor(private readonly host: RegistryHost) {}
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind ${kind.kind} is registered already`)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  kindIds(): string[] { return [...this.kinds.keys()] }
  /** The stored instance of a kind, with its configuration validated; a kind without stored settings has a default, disabled instance. */
  instance(id: string): SourceInstance | undefined {
    const kind = this.kinds.get(id)
    if (!kind) return undefined
    const stored = this.host.settings().sources[id]
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    if (!parsed.success) return { id, kind: id, enabled: false, config: {} }
    return { id, kind: id, enabled: stored?.enabled ?? false, config: parsed.data }
  }
  instances(): SourceInstance[] { return this.kindIds().flatMap(id => this.instance(id) ?? []) }
  /** Validation problems of a kind's stored configuration. */
  validate(id: string, config: unknown): string | undefined {
    const kind = this.kinds.get(id)
    if (!kind) return `Unknown Source kind ${id}`
    const parsed = kind.schema.safeParse(config)
    return parsed.success ? undefined : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  }
  policyPart(id: string): SourcePolicy { return SourcePolicySchema.parse(this.host.settings().policy.sources[id] ?? {}) }
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    const kind = this.kinds.get(input.source), instance = this.instance(input.source)
    if (!kind || !instance) return { listened: false, reason: 'source_not_installed' }
    if (!instance.enabled) return { listened: false, reason: 'source_off' }
    return kind.scope ? kind.scope(input, instance.config) : { listened: true, observed: false }
  }
  channelAllowed(channel: ChannelRef): boolean {
    const kind = this.kinds.get(channel.source), instance = this.instance(channel.source)
    if (!kind?.channel || !instance) return false
    return kind.channel.allowed ? kind.channel.allowed(channel.address, instance.config) : true
  }
  channelLink(channel: ChannelRef): string | undefined {
    const kind = this.kinds.get(channel.source), instance = this.instance(channel.source)
    return kind?.channel?.link?.(channel.address, instance?.config ?? {})
  }
  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kinds.get(message.channel.source)
    const context = this.context(message.channel.source)
    if (!kind?.channel || !context) return 'waiting'
    return kind.channel.send(context, message)
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kinds.get(trigger.source)?.repliesTo?.(trigger) }
  async threadContext(trigger: Trigger, cursor?: string) {
    const kind = this.kinds.get(trigger.source), context = this.context(trigger.source)
    if (!kind?.threadContext || !context) return undefined
    return kind.threadContext(context, trigger, cursor)
  }
  /** Environment variables every installed kind contributes for `ticket`. */
  environment(ticket?: Ticket, trigger?: Trigger): { key: string; value: string; description: string }[] {
    return this.instances().flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      if (!kind?.environment) return []
      const values = kind.environment.values({ config: instance.config, ...ticket ? { ticket } : {}, ...trigger ? { trigger } : {} })
      return kind.environment.variables.flatMap(variable => variable.key in values ? [{ key: variable.key, value: values[variable.key]!, description: variable.description }] : [])
    })
  }
  /** The `SourceContext` of a kind's instance, built once. */
  context(id: string): SourceContext<Record<string, unknown>> | undefined {
    const kind = this.kinds.get(id)
    if (!kind) return undefined
    let context = this.contexts.get(id)
    if (context) return context
    const { host } = this
    const health = host.health.claim(`source:${id}`)
    const self = this
    context = {
      id, store: host.store, lifetime: host.lifetime, stateDir: host.stateDir, health,
      get config() { return self.instance(id)?.config ?? {} },
      get engine() { return host.engine() },
      policy: () => this.policyPart(id),
      state: <T>(key: string) => host.store.get<T>(`source:${id}:${key}`),
      setState: <T>(key: string, value: T) => host.store.set(`source:${id}:${key}`, value),
      subscribedThreads: (): Thread[] => {
        const open = new Set(host.store.tickets.list().filter(ticket => !ticket.ended || Date.now() - Date.parse(ticket.updatedAt) < 14 * 86_400_000).map(ticket => ticket.id))
        return host.store.threads.list().filter(thread => thread.ref.source === id && thread.subscriptions.some(ticketId => open.has(ticketId)))
      },
      receive: trigger => host.receive(trigger),
      log: message => host.log(`[${id}] ${message}`),
    }
    this.contexts.set(id, context)
    return context
  }
  /** Starts the loop of every enabled kind; a kind's loop reads `context.config` afresh on each iteration, so it follows settings changes. */
  start(): void {
    for (const id of this.kindIds()) {
      const kind = this.kinds.get(id)!
      if (!kind.run || this.loops.has(id)) continue
      const context = this.context(id)!
      const loop = kind.run(context).catch(error => {
        context.health.set({ state: 'error', detail: `The Source loop failed: ${String(error)}`, at: new Date().toISOString() })
      })
      this.loops.set(id, loop)
    }
  }
  async stop(): Promise<void> { await Promise.allSettled([...this.loops.values()]) }
}
