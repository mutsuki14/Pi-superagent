/** Proactive candidate assessment for the main Session: relays candidate cards, serves bounded thread reads, and records outcomes. */
import { z } from 'zod'
import { reasonText, threadKey, type Assessor, type Candidate, type EngineForMainSession, type Trigger } from '../core/index.ts'
import { AdmissionDirectionSchema, RuleAssessmentSchema, assessmentOutcome, directionAllowed, type Settings } from '../policy.ts'
import { relatedTickets, textPage, triggerCard } from './cards.ts'
import { AcknowledgementSchema } from './tool.ts'
import type { Effects } from './effects.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'
import { preview } from './text.ts'

/** Schema for a short lowercase kebab-case English ticket worktree name (1–4 words, at most 32 characters). */
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters')
  .describe('Meaningful short English ticket name, e.g. fix-plan-color. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** Schema for the main Session's proactive candidate assessment decision (`orchestrator_eval_decide`). */
export const AssessmentSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema)
    .refine(assessments => new Set(assessments.map(assessment => assessment.rule_id)).size === assessments.length, 'Duplicate rule assessment IDs')
    .describe('One per enabled rule.'),
  direction: AdmissionDirectionSchema.describe('Required for every decision.'),
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  intent_evidence: z.string().trim().min(1).max(700).nullish().describe('For acceptance: the quotes that establish the three facts.'),
  acknowledgement: AcknowledgementSchema.nullish().describe('For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence.'),
  reason: z.string().min(1).max(500),
}).strict().refine(value => value.decision !== 'accept' || !directionAllowed(value.direction) || !value.rule_assessments.some(rule => rule.matched)
  || !!value.worktree_name, { message: 'Accepted work requires a short English worktree_name', path: ['worktree_name'] })
export type AssessmentInput = z.infer<typeof AssessmentSchema>

const TRIGGER_CHARS = 4000, WINDOW_CHARS = 400
const EXPLICIT = 'This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'

export interface AssessorHost {
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads'>
  readonly sources: Pick<SourceRegistry, 'threadContext' | 'repliesTo'>
  settings(): Settings
  paused(): boolean
  /** Delivers a candidate card to the main Session once per request ID. */
  deliver(requestId: string, text: string): Promise<void>
}
export const EvalReadSchema = z.object({
  trigger_id: z.string().min(1).describe('The candidate\'s trigger_id; every reference is scoped to it.'),
  resource: z.enum(['message', 'thread']),
  cursor: z.string().optional().describe('Only for thread: omit on the first page, then the next cursor a page returned.'),
  offset: z.number().int().min(0).default(0).describe('Text pagination for message: copy next_offset.'),
}).strict()
export type EvalRead = z.infer<typeof EvalReadSchema>

/**
 * Implements the `Assessor` port: relays each Eval's candidate card to the main Session through the durable `assessment`
 * effect, serves bounded thread reads while the Eval runs, and converts the main Session's assessment into an outcome for
 * `Engine.decide`.
 */
export class MasterAssessor implements Assessor {
  constructor(private readonly host: AssessorHost) {
    host.effects.handle('assessment', async ({ triggerId }, evalId) => {
      const candidate = this.host.engine.candidate(triggerId)
      if (candidate?.evalId !== evalId) return
      await this.host.deliver(`candidate:${evalId}`, JSON.stringify({ kind: 'candidate', ...await this.candidateCard(candidate) }))
      this.host.engine.candidateDelivered(evalId)
    }, { limit: () => host.paused() ? 0 : 4 })
  }
  request(candidate: Candidate): void { this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }
  release(_evalId: string): void { /* nothing is kept per Eval */ }
  /** The candidate card the main Session reads: the batch, the Thread's tickets, where the Trigger went, and who handed it back. */
  async candidateCard(candidate: Candidate): Promise<Record<string, unknown>> {
    const { store } = this.host
    const primary = candidate.triggers.find(trigger => trigger.id === (candidate.thread.evaluating?.primary ?? candidate.triggers.at(-1)!.id)) ?? candidate.triggers.at(-1)!
    const disposition = store.triggers.disposition(primary.id)
    const parentId = this.host.sources.repliesTo(primary)
    const parent = parentId ? store.triggers.get(parentId) : undefined
    return { eval_id: candidate.evalId, strength: candidate.strength, trigger_id: primary.id,
      trigger: { ...triggerCard(primary), text: primary.text.length > TRIGGER_CHARS ? `${primary.text.slice(0, TRIGGER_CHARS)}…` : primary.text },
      ...parent ? { replies_to: { trigger_id: parent.id, from: parent.actor.id, preview: preview(parent.text) } } : {},
      batch: candidate.triggers.filter(trigger => trigger.id !== primary.id).map(trigger => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, preview: preview(trigger.text, WINDOW_CHARS), read: `trigger/${trigger.id}` })),
      thread: candidate.thread.key, ...relatedTickets(candidate.tickets),
      delivered_to: disposition?.fanout ?? [], ...disposition?.handbacks?.length ? { handed_back: disposition.handbacks } : {},
      ...candidate.strength === 'explicit' ? { route: 'orchestrator_route' } : { assess: 'orchestrator_eval, then orchestrator_eval_decide' } }
  }
  private evalFor(triggerId: string): { candidate: Candidate; trigger: Trigger } {
    const candidate = this.host.engine.candidate(triggerId)
    if (!candidate) throw new Error('No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment')
    if (candidate.strength === 'explicit') throw new Error(EXPLICIT)
    const trigger = candidate.triggers.find(item => item.id === triggerId)!
    return { candidate, trigger }
  }
  /** `orchestrator_eval`: the candidate's own message, the first page of its Thread, the enabled rules and the Thread's tickets. */
  async context(triggerId: string, _signal?: AbortSignal): Promise<unknown> {
    const { candidate, trigger } = this.evalFor(triggerId)
    const page = await this.host.sources.threadContext(trigger).catch(error => ({ messages: [], body: {}, error: String(error) }))
    const rules = this.host.settings().policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => ({ rule_id: id, name, instruction }))
    return { eval_id: candidate.evalId, trigger_id: trigger.id, strength: candidate.strength, policy_version: candidate.policyVersion,
      trigger: { from: trigger.actor.id, at: trigger.at, text: trigger.text.slice(0, TRIGGER_CHARS), chars: trigger.text.length, url: trigger.url },
      batch: candidate.triggers.filter(item => item.id !== trigger.id).map(item => ({ trigger_id: item.id, from: item.actor.id, text: item.text.slice(0, WINDOW_CHARS) })),
      thread: { key: threadKey(trigger.threads[0]!), ...page }, enabled_rules: rules, ...relatedTickets(candidate.tickets),
      decide: 'orchestrator_eval_decide with this trigger_id, one rule_assessments entry per enabled rule, and direction' }
  }
  async read(read: EvalRead, _signal?: AbortSignal): Promise<unknown> {
    const { trigger } = this.evalFor(read.trigger_id)
    if (read.resource === 'message') return textPage(`trigger/${trigger.id}`, trigger.text, read.offset, 4000)
    const page = await this.host.sources.threadContext(trigger, read.cursor)
    return page ?? { messages: [], note: 'This Source gives no thread context' }
  }
  /** `orchestrator_eval_decide`: validates the assessment against the enabled rules and records the Decision. */
  async decide(triggerId: string, assessment: AssessmentInput, _signal?: AbortSignal): Promise<{ state: string; reason: string; ticket_id?: string }> {
    const { candidate } = this.evalFor(triggerId)
    const outcome = assessmentOutcome(assessment, this.host.settings(), candidate.strength)
    const decision = this.host.engine.decide(triggerId, { ...outcome, evalId: candidate.evalId })
    return { state: decision.kind, reason: reasonText(decision.reason), ...decision.ticketId ? { ticket_id: decision.ticketId } : {} }
  }
}
