/** SourceKind plugin contract: configuration schema, policy integration, channel adapter, thread context reader and the poll loop. */
import type { z } from 'zod'
import type { EngineForSources, OutboundMessage, ScopeResult, Thread, Ticket, Trigger } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { HealthEntry } from '../app/health.ts'
import type { SourcePolicy } from '../policy.ts'

/** Normalized message returned by thread context readers; `bot` marks a non-human sender. */
export interface ContextMessage { id: string; from: string; at: string; text: string; bot?: true; url?: string }
export interface ContextPage { messages: ContextMessage[]; next?: string; body: Record<string, unknown> }

/** What a Source kind receives from the host: the Engine's Source role, its stored instance and typed state, and its health entries. */
export interface SourceContext<C> {
  readonly id: string
  readonly config: C
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'get' | 'set' | 'atomic'>
  readonly engine: EngineForSources
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  readonly stateDir: string
  /** The Source's part of the Policy, such as its allowed senders. */
  policy(): SourcePolicy
  /** Typed per-instance state, such as a read position. */
  state<T>(key: string): T | undefined
  setState<T>(key: string, value: T): void
  /** The Threads live Tickets subscribe to on this Source, which polling follows. */
  subscribedThreads(): Thread[]
  /** Passes a Trigger to the Engine and schedules a pass. */
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered'
  log(message: string): void
}

export interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(context: SourceContext<C>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** A link to `address` for people. */
  link?(address: Record<string, string>, config: C): string | undefined
}

/** Variables the kind contributes to the execution environment of a Ticket's worker. */
export interface EnvironmentInput<C> { config: C; ticket?: Ticket; trigger?: Trigger }

export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; one instance of the kind exists under the same ID. */
  kind: string
  title: string
  description: string
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>
  /** Listening rule for a trigger (or recorded Mandate basis); kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  channel?: SourceChannel<C>
  /** Reads a page of the Thread a Trigger belongs to, for assessments and workers. */
  threadContext?(context: SourceContext<C>, trigger: Trigger, cursor?: string): Promise<ContextPage>
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined
  /** Environment variables for workers and the prepare command. */
  environment?: { variables: readonly { key: string; description: string }[]; values(input: EnvironmentInput<C>): Record<string, string> }
  /** Starts the kind's event loop (polling or listening); resolves when `context.lifetime` aborts. */
  run?(context: SourceContext<C>): Promise<void>
  /** Describes the admission rows the kind offers, for the Policy's admission table. */
  admissionRows?(config: C): { id: string; label: string }[]
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
