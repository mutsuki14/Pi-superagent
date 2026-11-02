/** Compact, bounded model-facing projections of triggers, tickets, threads, and decisions; full texts stay behind readable resources. */
import { latestReport, reasonText, threadKey, ticketStage, key, type Decision, type Mandate, type Thread, type Ticket, type TicketInput,
  type Trigger, type TriggerDisposition } from '../core/index.ts'
import { preview } from './text.ts'

export function triggerCard(trigger: Trigger, disposition?: TriggerDisposition) {
  return { trigger_id: trigger.id, source: trigger.source, ...(trigger.url ? { source_url: trigger.url } : {}), actor: trigger.actor.id,
    thread: threadKey(trigger.threads[0]!), human: trigger.human, ...(trigger.addressed ? { addressed: trigger.addressed } : {}), at: trigger.at,
    preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}`,
    ...(disposition ? { disposition: { ...(disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {}),
      ...(disposition.decisionId ? { decision_id: disposition.decisionId } : {}),
      delivered_to: disposition.fanout, ...(disposition.handbacks?.length ? { handed_back: disposition.handbacks } : {}) } } : {}) }
}
/** The states a ticket card shows: an open ticket's stage (docs/003), and an ended ticket's outcome. */
export const TICKET_STATES = ['person/delivery', 'person/answer', 'person/review', 'person/blocked', 'person/failed', 'working', 'working/queued', 'idle',
  'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type TicketCardState = typeof TICKET_STATES[number]
export function cardState(ticket: Ticket): TicketCardState {
  if (ticket.ended) return ticket.ended.outcome
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') return `person/${stage.action}`
  return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? 'working/queued' : 'working'
}
/** The pull request a ticket follows as its own, from its `follows`. */
export function pullOf(ticket: Ticket): number | undefined {
  const own = ticket.follows?.find(item => item.own && item.thread.startsWith('github:'))
  const number = own ? Number(own.thread.slice('github:'.length)) : NaN
  return Number.isFinite(number) ? number : undefined
}
export function ticketCard(ticket: Ticket) {
  const ended = ticket.ended && { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome }
  const { attention } = ticket
  const pr = pullOf(ticket)
  return { ticket_id: ticket.id, title: ticket.title, state: cardState(ticket), strength: ticket.mandate.strength,
    ...(pr ? { pr_number: pr } : {}), ...(ended ? { ended } : {}),
    ...(attention ? { attention: { question: attention.question, ...attention.triggerId ? { trigger_id: attention.triggerId } : {} } } : {}),
    preview: preview(latestReport(ticket)?.summary ?? ''), read: `ticket/${ticket.id}` }
}
const mandateOf = ({ policyVersion: _version, ...mandate }: Mandate) => mandate
export const INPUTS = 10, ASSIGNMENTS = 3
const INPUT_TEXT = 80
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
export function inputLine(ticket: Ticket, input: TicketInput, worker = false) {
  const read = { read: inputResource(ticket.id, input.id) }
  const names = input.kind === 'trigger' || input.kind === 'resumed' ? { trigger_id: input.triggerId }
    : input.kind === 'reopen' && !worker ? { decision_id: input.decisionId }
    : input.kind !== 'text' ? read
    : input.text.length <= INPUT_TEXT ? { text: input.text }
    : { preview: preview(input.text).slice(0, INPUT_TEXT), chars: input.text.length, ...read }
  return { kind: input.kind, at: input.at, ...names, ...ticket.undelivered.includes(input.id) ? { undelivered: true } : {} }
}
export function assignmentLine(ticket: Ticket, item: Ticket['assignments'][number]) {
  return { id: item.id, state: item.state, at: item.createdAt, ...(item.endedReason ? { ended_reason: reasonText({ code: item.endedReason }) } : {}),
    ...(item.report ? { report: { state: item.report.state, at: item.report.at, preview: preview(item.report.summary).slice(0, 100),
      chars: item.report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` } } : {}) }
}
export function newestPage<T, L>(items: readonly T[], offset: number, size: number, line: (item: T) => L, next: string) {
  const newest = items.slice().reverse()
  const more = offset + size < newest.length
  return { items: newest.slice(offset, offset + size).map(line), ...more ? { next_resource: next, next_offset: offset + size } : {} }
}
export interface TicketThread { thread: string; context?: true; bound?: true }
export function ticketDetails(ticket: Ticket, threads: TicketThread[], batch: readonly Trigger[], worker = false) {
  const { preview: _preview, ...card } = ticketCard(ticket)
  return { ...card, trigger_id: ticket.origin.triggerId, ...batch.length ? { batch: batch.map(batchLine) } : {},
    ...worker ? {} : { decision_id: ticket.decisionId }, threads, directory: ticket.execution?.directory,
    scope: ticket.mandate.scope, requested_by: ticket.mandate.actor.id,
    assignments: newestPage(ticket.assignments, 0, ASSIGNMENTS, item => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
    inputs: newestPage(ticket.inputs, 0, INPUTS, input => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`),
    assignment: `ticket/${ticket.id}/assignment`, result: `ticket/${ticket.id}/result` }
}
export function threadCard(thread: Thread) {
  return { thread: thread.key, label: String(thread.meta.label ?? thread.key), source: thread.ref.source, tickets: thread.subscriptions,
    ...(thread.evaluating ? { evaluating: { since: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {}),
    pending: thread.pending.length,
    ...(thread.meta.pollError ? { error: preview(String(thread.meta.pollError)) } : {}), ...(thread.meta.url ? { url: thread.meta.url } : {}),
    read: `thread/${thread.key}` }
}
export function decisionCard(decision: Decision) {
  return { decision_id: decision.id, kind: decision.kind, reason: reasonText(decision.reason), strength: decision.strength, thread: decision.threadKey,
    trigger_ids: decision.triggerIds, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), at: decision.at, read: `decision/${decision.id}` }
}
export function decisionDetails(decision: Decision) {
  return { ...decisionCard(decision), ...(decision.mandate ? { mandate: mandateOf(decision.mandate) } : {}), ...(decision.audit ? { audit: decision.audit } : {}) }
}
/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
export function textPage(resource: string, text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit)
  return { resource, offset, total_chars: text.length, next_offset: end < text.length ? end : null, text: text.slice(offset, end) }
}
export function relatedTickets(tickets: readonly Ticket[]) {
  const order = [...tickets].sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1)
  return { related_tickets: order.slice(0, 8).map(ticketCard), tickets_total: tickets.length }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
export const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
const cap = (text: string, limit: number, read: string) => text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/** Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, link, routing note, and the replied-to message. */
export function triggerMessage(trigger: Trigger, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, human: trigger.human, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...cap(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...(trigger.url ? { source_url: trigger.url } : {}), ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: preview(repliesTo.text) } } : {}) }
}
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, preview: preview(trigger.text), read: `trigger/${trigger.id}` })
