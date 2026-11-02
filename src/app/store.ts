/**
 * Durable state in one JSON file: the domain repositories, settings, outbox receipts, the effect queue and typed key-value records.
 * Every method is synchronous so `atomic` can wrap a unit of work; a failed unit rolls the in-memory state back to its snapshot,
 * and a committed one is written to disk (atomically, through a temporary file) after the outermost transaction.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { latestAssignment, type Decision, type OutboundMessage, type Repositories, type ReplyStatus, type Thread, type Ticket, type Trigger,
  type TriggerDisposition } from '../core/index.ts'
import { SettingsSchema, type Settings } from '../policy.ts'

export type DropReason = 'channelGone' | 'channelIgnored'
export interface Receipt extends OutboundMessage { status: ReplyStatus; attempts: number; error?: string; at: string; sentAt?: string; dropped?: { at: string; reason: DropReason } }
/** One queued side effect: `seq` keeps its queue position, `generation` guards a running attempt against a replaced payload. */
export interface EffectRow { kind: string; key: string; value: string; seq: number; generation: number; attempts: number; due: number; since: string; error: string }
export interface SettingsRecord { revision: number; value: Settings; at: string; origin: string }

interface Data {
  schema: number
  triggers: Record<string, Trigger>
  dispositions: Record<string, TriggerDisposition>
  threads: Record<string, Thread>
  tickets: Record<string, Ticket>
  /** Ticket ids in creation order. */
  ticketOrder: string[]
  decisions: Record<string, Decision>
  settings: SettingsRecord
  settingsHistory: SettingsRecord[]
  receipts: Record<string, Receipt>
  receiptOrder: string[]
  effects: EffectRow[]
  effectSeq: number
  kv: Record<string, unknown>
}
const SCHEMA = 1
const clone = <T>(value: T): T => structuredClone(value)
const emptyData = (now: string): Data => ({ schema: SCHEMA, triggers: {}, dispositions: {}, threads: {}, tickets: {}, ticketOrder: [], decisions: {},
  settings: { revision: 0, value: SettingsSchema.parse({}), at: now, origin: 'default' }, settingsHistory: [], receipts: {}, receiptOrder: [], effects: [],
  effectSeq: 0, kv: {} })

/**
 * Implements the domain `Repositories`, settings, outbox receipts, the effect queue and key-value state over one JSON file.
 * Runtime opens it once; Engine, Effects, Outbox and the panel read and write through it.
 */
export class Store implements Repositories {
  private data: Data
  private depth = 0
  private dirty = false
  private readonly after: (() => void)[] = []
  readonly file: string
  constructor(readonly stateDir: string, private readonly now = () => new Date().toISOString()) {
    mkdirSync(stateDir, { recursive: true })
    this.file = join(stateDir, 'state.json')
    this.data = existsSync(this.file) ? this.migrate(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Data>) : emptyData(now())
    this.data.settings.value = SettingsSchema.parse(this.data.settings.value)
    this.write()
  }
  private migrate(raw: Partial<Data>): Data { return { ...emptyData(this.now()), ...raw, schema: SCHEMA } }
  private write(): void {
    const tmp = `${this.file}.tmp`
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.file)
    this.dirty = false
  }
  /** Marks state changed; the outermost `atomic` writes it, or this call does when no transaction is open. */
  private touch(): void { this.dirty = true; if (this.depth === 0) this.flush() }
  private flush(): void {
    if (this.dirty) this.write()
    const callbacks = this.after.splice(0)
    for (const callback of callbacks) { try { callback() } catch { /* an after-commit action must not fail the transaction */ } }
  }
  /** Runs `work` as one unit: all changes are kept, or none of them. Nested calls join the outer unit. */
  atomic<T>(work: () => T): T {
    if (this.depth > 0) { this.depth++; try { return work() } finally { this.depth-- } }
    const snapshot = clone(this.data)
    const afterLength = this.after.length
    this.depth = 1
    try {
      const result = work()
      this.depth = 0
      this.flush()
      return result
    } catch (error) {
      this.data = snapshot
      this.after.length = afterLength
      this.dirty = false
      this.depth = 0
      throw error
    }
  }
  /** Runs `action` once the current transaction commits, or at once outside one; never after a rollback. */
  afterCommit(action: () => void): void { if (this.depth > 0) this.after.push(action); else action() }

  readonly triggers = {
    get: (id: string): Trigger | undefined => clone(this.data.triggers[id]),
    save: (trigger: Trigger): void => { this.data.triggers[trigger.id] = clone(trigger); this.touch() },
    disposition: (id: string): TriggerDisposition | undefined => clone(this.data.dispositions[id]),
    saveDisposition: (id: string, value: TriggerDisposition): void => { this.data.dispositions[id] = clone(value); this.touch() },
    list: (): Trigger[] => Object.values(this.data.triggers).map(clone).sort((a, b) => a.at.localeCompare(b.at)),
  }
  readonly threads = {
    get: (key: string): Thread | undefined => clone(this.data.threads[key]),
    save: (thread: Thread): void => { this.data.threads[thread.key] = clone(thread); this.touch() },
    list: (): Thread[] => Object.values(this.data.threads).map(clone),
    active: (): Thread[] => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
    /** Patch a thread's Source-owned metadata, creating the thread when needed. */
    patchMeta: (key: string, ref: Thread['ref'], meta: Record<string, unknown>): void => {
      const thread = this.data.threads[key] ?? { key, ref, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} }
      thread.meta = { ...thread.meta, ...meta }
      this.data.threads[key] = thread
      this.touch()
    },
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => clone(this.data.tickets[id]),
    save: (ticket: Ticket): void => {
      if (!this.data.tickets[ticket.id]) this.data.ticketOrder.push(ticket.id)
      this.data.tickets[ticket.id] = clone(ticket); this.touch()
    },
    /** Newest first. */
    list: (): Ticket[] => [...this.data.ticketOrder].reverse().flatMap(id => this.data.tickets[id] ? [clone(this.data.tickets[id]!)] : []),
    open: (): Ticket[] => this.tickets.list().filter(ticket => !ticket.ended),
    active: (): Ticket[] => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => clone(this.data.decisions[id]),
    save: (decision: Decision): void => { this.data.decisions[decision.id] = clone(decision); this.touch() },
    byThread: (key: string): Decision[] => Object.values(this.data.decisions).filter(decision => decision.threadKey === key).map(clone).sort((a, b) => a.at.localeCompare(b.at)),
    list: (): Decision[] => Object.values(this.data.decisions).map(clone).sort((a, b) => b.at.localeCompare(a.at)),
  }

  // Settings
  settings(): Settings { return clone(this.data.settings.value) }
  settingsRevision(): number { return this.data.settings.revision }
  settingsRecord(): SettingsRecord { return clone(this.data.settings) }
  settingsHistory(): SettingsRecord[] { return clone(this.data.settingsHistory) }
  /**
   * Replace the settings with `value` if `revision` is the current one.
   * @throws when `revision` is stale.
   */
  saveSettings(value: Settings, revision: number, origin: string): SettingsRecord {
    if (revision !== this.data.settings.revision) throw new Error(`Settings revision ${revision} is stale; the current revision is ${this.data.settings.revision}`)
    const record: SettingsRecord = { revision: revision + 1, value: SettingsSchema.parse(value), at: this.now(), origin }
    this.data.settingsHistory = [...this.data.settingsHistory, this.data.settings].slice(-50)
    this.data.settings = record
    this.touch()
    return clone(record)
  }

  // Outbox receipts (only the Outbox writes)
  replyStatus(id: string): ReplyStatus | undefined { return this.data.receipts[id]?.status }
  readonly receipts = {
    get: (id: string): Receipt | undefined => clone(this.data.receipts[id]),
    list: (): Receipt[] => this.data.receiptOrder.flatMap(id => this.data.receipts[id] ? [clone(this.data.receipts[id]!)] : []),
    waiting: (): Receipt[] => this.receipts.list().filter(receipt => receipt.status === 'pending'),
    /** Whether an earlier pending message of the same ticket to the same conversation waits with fewer than `failures` failures. */
    behind: (id: string, failures: number): boolean => {
      const receipt = this.data.receipts[id]
      if (!receipt?.ticketId) return false
      for (const other of this.data.receiptOrder) {
        if (other === id) return false
        const earlier = this.data.receipts[other]
        if (earlier && earlier.status === 'pending' && earlier.ticketId === receipt.ticketId && earlier.channel.source === receipt.channel.source
          && earlier.channel.thread === receipt.channel.thread && earlier.attempts < failures) return true
      }
      return false
    },
    /** Adds a receipt; false when the id was queued before. */
    add: (message: OutboundMessage): boolean => {
      if (this.data.receipts[message.id]) return false
      this.data.receipts[message.id] = { ...clone(message), status: 'pending', attempts: 0, at: this.now() }
      this.data.receiptOrder.push(message.id)
      this.touch()
      return true
    },
    settle: (id: string, outcome: 'sent' | DropReason): void => {
      const receipt = this.data.receipts[id]
      if (!receipt) return
      if (outcome === 'sent') { receipt.status = 'sent'; receipt.sentAt = this.now() }
      else { receipt.status = 'dropped'; receipt.dropped = { at: this.now(), reason: outcome } }
      delete receipt.error
      this.touch()
    },
    failed: (id: string, error: string): void => {
      const receipt = this.data.receipts[id]
      if (!receipt) return
      receipt.attempts++; receipt.error = error.slice(0, 500)
      this.touch()
    },
    /** Marks a pending receipt dropped as withdrawn; false when it is not pending. */
    withdraw: (id: string): boolean => {
      const receipt = this.data.receipts[id]
      if (receipt?.status !== 'pending') return false
      receipt.status = 'dropped'; receipt.dropped = { at: this.now(), reason: 'channelIgnored' }
      this.touch()
      return true
    },
  }

  // Effect queue rows
  readonly effects = {
    upsert: (kind: string, key: string, value: string, due: number): void => {
      const row = this.data.effects.find(item => item.kind === kind && item.key === key)
      if (row) { row.value = value; row.generation++; row.attempts = 0; row.error = ''; row.due = due }
      else this.data.effects.push({ kind, key, value, seq: ++this.data.effectSeq, generation: 0, attempts: 0, due, since: this.now(), error: '' })
      this.touch()
    },
    rows: (kind: string): EffectRow[] => this.data.effects.filter(row => row.kind === kind).sort((a, b) => a.seq - b.seq).map(clone),
    all: (): EffectRow[] => this.data.effects.map(clone),
    /** Deletes a row if it is still the same attempt (`seq` and `generation`). */
    complete: (kind: string, key: string, seq: number, generation: number): void => {
      const before = this.data.effects.length
      this.data.effects = this.data.effects.filter(row => !(row.kind === kind && row.key === key && row.seq === seq && row.generation === generation))
      if (this.data.effects.length !== before) this.touch()
    },
    defer: (kind: string, key: string, seq: number, generation: number, due: number, error?: string): void => {
      const row = this.data.effects.find(item => item.kind === kind && item.key === key && item.seq === seq && item.generation === generation)
      if (!row) return
      row.due = due
      if (error !== undefined) { row.attempts++; row.error = error.slice(0, 1000) }
      this.touch()
    },
    cancel: (kind: string, key: string): boolean => {
      const before = this.data.effects.length
      this.data.effects = this.data.effects.filter(row => !(row.kind === kind && row.key === key))
      const removed = this.data.effects.length !== before
      if (removed) this.touch()
      return removed
    },
  }

  // Typed key-value records
  get<T>(key: string): T | undefined { return clone(this.data.kv[key]) as T | undefined }
  set<T>(key: string, value: T): void { this.data.kv[key] = clone(value); this.touch() }
  delete(key: string): void { delete this.data.kv[key]; this.touch() }
  keys(prefix = ''): string[] { return Object.keys(this.data.kv).filter(key => key.startsWith(prefix)) }
}
