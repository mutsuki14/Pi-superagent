/**
 * Durable side-effect queue: a command enqueues work inside its transaction, and the work runs after commit, with retries.
 * Adapted from the SQLite-backed queue to the JSON `Store`.
 */
import type { Store } from './store.ts'
import type { HealthBoard, HealthEntry } from './health.ts'

/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count.
 */
export class Later extends Error {}
/** Consecutive failures before an effect kind reports an error. */
export const FAILURES_BEFORE_ERROR = 3

export interface EffectPayloads {
  /** Build an Eval's candidate card and relay it to the main Session; the key is the Eval ID. */
  assessment: { triggerId: string }
  /** Launch a pending Assignment; the key is the Assignment ID. */
  launch: { ticketId: string; assignmentId: string }
  /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
  delivery: { ticketId: string }
  /** Steer a report or a candidate into the main Session; the key is the request ID. */
  relay: { text: string }
  /** Inject a notice into the main Session without waking it; the key names what it reports. */
  notice: { value: Record<string, unknown>; summary: string }
  /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
  reply: Record<string, never>
}
export type EffectKind = keyof EffectPayloads
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
  limit: () => number
  /** Initial and maximum retry backoff delays, in milliseconds. */
  retry: readonly [number, number]
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
  ordered: boolean
  /** When true, repeated failures do not mark the kind's health entry as `error`. */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
type Task = { kind: EffectKind; key: string; done: Promise<void> }

export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  private readonly broken = new Set<EffectKind>()
  private scheduled = false
  private started = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {}
  /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.store.effects.upsert(kind, key, JSON.stringify(payload), this.now())
    this.store.afterCommit(() => this.kick())
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  pending(kind: EffectKind, key?: string): boolean {
    return this.store.effects.rows(kind).some(row => key === undefined || row.key === key)
  }
  /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
  cancel(kind: EffectKind, key: string): void {
    this.store.effects.cancel(kind, key)
    this.store.afterCommit(() => { this.report(kind) })
  }
  start(): void { this.started = true; this.kick() }
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** Resolves once no effect of `kind` (or of any kind) is running and none can start now. */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** Stops starting new effects and waits for running ones; waiting rows remain for the next start. */
  async drain(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    let soonest: number | undefined
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        const rows = this.store.effects.rows(kind)
        const candidates = handler.ordered ? rows.slice(0, 1) : rows
        const ready = handler.ordered && running.size ? [] : candidates.filter(row => row.due <= this.now() && !running.has(row.key))
        for (const row of candidates) if (row.due > this.now() && !running.has(row.key)) soonest = Math.min(soonest ?? row.due, row.due)
        let room = ready.length ? handler.limit() - running.size : 0
        if (ready.length && room <= 0) soonest = Math.min(soonest ?? this.now() + 1000, this.now() + 1000)
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
    // Wake up again when the next deferred row is due, so a retry does not wait for the next pass.
    clearTimeout(this.timer)
    if (soonest !== undefined) this.timer = setTimeout(() => this.kick(), Math.max(10, soonest - this.now()))
    this.timer?.unref?.()
  }
  private run(kind: EffectKind, handler: Handler<never>, row: { key: string; value: string; seq: number; generation: number; attempts: number }): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    this.tasks.add(task)
  }
  private async attempt(kind: EffectKind, handler: Handler<never>, row: { key: string; value: string; seq: number; generation: number; attempts: number }): Promise<void> {
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    if (!failure) this.store.effects.complete(kind, row.key, row.seq, row.generation)
    else if (this.stopped) return
    else if (failure.error instanceof Later) this.store.effects.defer(kind, row.key, row.seq, row.generation, this.now() + handler.retry[0])
    else {
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      this.store.effects.defer(kind, row.key, row.seq, row.generation, this.now() + delay, String(failure.error))
    }
    if (!this.stopped) this.report(kind)
  }
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    const rows = this.store.effects.rows(kind)
    const waiting = rows.length
    const attempts = Math.max(0, ...rows.map(row => row.attempts))
    const failing = attempts >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    const lastError = rows.filter(row => row.attempts > 0).at(-1)?.error
    const detail = waiting ? `${waiting} waiting since ${rows[0]?.since}` : 'Nothing waiting'
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${lastError}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}
