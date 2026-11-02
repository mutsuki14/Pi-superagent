/** Readable resources for the `orchestrator_read` tool: pages of tickets, triggers, threads, decisions, settings and ticket texts. */
import { key, latestReport, reached, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, textPage, threadCard, ticketCard, ticketDetails, triggerCard,
  ASSIGNMENTS, INPUTS, type TicketThread } from './cards.ts'
import type { Store } from './store.ts'
import type { HealthBoard } from './health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { inputMessage } from '../executor/pi.ts'

export interface ResourceHost {
  readonly store: Store
  readonly health: HealthBoard
  readonly sources: Pick<SourceRegistry, 'threadContext' | 'repliesTo'>
}
const LIST = 20, LIST_MAX = 50, TEXT = 4000, TEXT_MAX = 8000
const MAIN_GRAMMAR = 'overview | tickets[?state=open|ended] | ticket/<id> | ticket/<id>/assignment | ticket/<id>/result | ticket/<id>/assignments | ticket/<id>/inputs | ticket/<id>/input/<key> | ticket/<id>/report/<assignment id> | trigger/<id> | trigger/<id>/thread | thread/<key> | threads | decisions | decision/<id> | settings | settings/<policy|eval|executor|source:<id>> | health'
const WORKER_GRAMMAR = 'ticket/<id> (your own) | ticket/<id>/assignment | ticket/<id>/inputs | ticket/<id>/input/<key> | ticket/<id>/report/<assignment id> | trigger/<id> (one that reached your ticket) | trigger/<id>/thread'
export const resourceGrammar = (worker: boolean): string => worker ? WORKER_GRAMMAR : MAIN_GRAMMAR

function ticketThreads(store: Store, ticket: Ticket): TicketThread[] {
  const bound = new Set(ticket.follows?.map(item => item.thread))
  return store.threads.list().filter(thread => thread.subscriptions.includes(ticket.id)).map(thread => ({ thread: thread.key,
    ...thread.context?.includes(ticket.id) ? { context: true as const } : {}, ...bound.has(thread.key) ? { bound: true as const } : {} }))
}
/**
 * Reads one page of a resource. A worker Session (`ticketId` given) may read only its own ticket and the Triggers that reached it.
 * @throws when the resource is unknown or not the worker's to read.
 */
export async function readResource(host: ResourceHost, resource: string, offset = 0, limit?: number, ticketId?: string, _signal?: AbortSignal): Promise<unknown> {
  const { store } = host
  const [path, query = ''] = resource.split('?') as [string, string?]
  const parts = path.split('/').filter(Boolean)
  const size = (fallback: number, max: number) => Math.min(max, Math.max(1, limit ?? fallback))
  const own = (ticket: Ticket) => { if (ticketId !== undefined && ticket.id !== ticketId) throw new Error('A worker reads only its own ticket') }
  const text = (value: string) => textPage(resource, value, offset, size(TEXT, TEXT_MAX))
  const params = Object.fromEntries(new URLSearchParams(query))
  switch (parts[0]) {
    case 'overview': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const tickets = store.tickets.list()
      const open = tickets.filter(ticket => !ticket.ended)
      const byState = new Map<string, number>()
      for (const ticket of open) byState.set(ticketCard(ticket).state, (byState.get(ticketCard(ticket).state) ?? 0) + 1)
      const attention = open.filter(ticket => ticketCard(ticket).state.startsWith('person/')).map(ticketCard)
      const evaluating = store.threads.active().map(threadCard)
      return { open: open.length, ended: tickets.length - open.length, by_state: Object.fromEntries(byState), needs_person: attention, evaluating,
        problems: host.health.problems(), paused: store.settings().paused }
    }
    case 'health': return host.health.snapshot()
    case 'tickets': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const tickets = store.tickets.list().filter(ticket => params.state === 'open' ? !ticket.ended : params.state === 'ended' ? !!ticket.ended : true)
      const page = size(LIST, LIST_MAX)
      return { items: tickets.slice(offset, offset + page).map(ticketCard), total: tickets.length, ...offset + page < tickets.length ? { next_offset: offset + page } : {} }
    }
    case 'ticket': {
      const ticket = store.tickets.get(parts[1] ?? '')
      if (!ticket) throw new Error(`Unknown ticket ${parts[1]}`)
      own(ticket)
      const worker = ticketId !== undefined
      const batch = ticket.origin.triggerIds.filter(id => id !== ticket.origin.triggerId).flatMap(id => store.triggers.get(id) ?? [])
      switch (parts[2]) {
        case undefined: return ticketDetails(ticket, ticketThreads(store, ticket), batch, worker)
        case 'assignment': return text(ticket.execution?.assignment ?? '')
        case 'result': return text(latestReport(ticket)?.summary ?? '')
        case 'assignments': return newestPage(ticket.assignments, offset, size(ASSIGNMENTS, LIST_MAX), item => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`)
        case 'inputs': return newestPage(ticket.inputs, offset, size(INPUTS, LIST_MAX), input => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`)
        case 'input': {
          const input = ticket.inputs.find(item => key(item.id) === parts[3])
          if (!input) throw new Error('Unknown input')
          const trigger = input.kind === 'trigger' ? store.triggers.get(input.triggerId) : undefined
          return text(inputMessage(input, trigger ? { trigger_id: trigger.id, from: trigger.actor.id, text: trigger.text } : undefined) ?? '')
        }
        case 'report': {
          const assignment = ticket.assignments.find(item => item.id === parts[3])
          if (!assignment?.report) throw new Error('Unknown report')
          return text(assignment.report.summary)
        }
        default: throw new Error(`Unknown ticket resource ${parts[2]}`)
      }
    }
    case 'trigger': {
      const trigger = store.triggers.get(parts[1] ?? '')
      if (!trigger) throw new Error(`Unknown trigger ${parts[1]}`)
      if (ticketId !== undefined) {
        const ticket = store.tickets.get(ticketId)
        if (!ticket || !reached(ticket, trigger, k => store.threads.get(k))) throw new Error('This trigger did not reach your ticket')
      }
      if (parts[2] === 'thread') {
        const page = await host.sources.threadContext(trigger, params.cursor)
        if (!page) return { messages: [], note: 'This Source gives no thread context' }
        return page
      }
      if (parts[2] !== undefined) throw new Error(`Unknown trigger resource ${parts[2]}`)
      return { ...triggerCard(trigger, store.triggers.disposition(trigger.id)), ...text(trigger.text), replies_to: host.sources.repliesTo(trigger) ?? null }
    }
    case 'threads': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const threads = store.threads.list().sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
      const page = size(LIST, LIST_MAX)
      return { items: threads.slice(offset, offset + page).map(threadCard), total: threads.length, ...offset + page < threads.length ? { next_offset: offset + page } : {} }
    }
    case 'thread': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const threadId = parts.slice(1).join('/')
      const thread = store.threads.get(threadId)
      if (!thread) throw new Error(`Unknown thread ${threadId}`)
      const triggers = store.triggers.list().filter(trigger => trigger.threads.some(ref => threadKey(ref) === thread.key))
      const page = size(LIST, LIST_MAX)
      return { ...threadCard(thread), correlated: thread.correlated, decisions: store.decisions.byThread(thread.key).slice(-5).map(decisionCard),
        triggers: triggers.slice(offset, offset + page).map(trigger => triggerCard(trigger, store.triggers.disposition(trigger.id))), total: triggers.length,
        ...offset + page < triggers.length ? { next_offset: offset + page } : {} }
    }
    case 'decisions': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const decisions = store.decisions.list()
      const page = size(LIST, LIST_MAX)
      return { items: decisions.slice(offset, offset + page).map(decisionCard), total: decisions.length, ...offset + page < decisions.length ? { next_offset: offset + page } : {} }
    }
    case 'decision': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const decision = store.decisions.get(parts[1] ?? '')
      if (!decision) throw new Error(`Unknown decision ${parts[1]}`)
      return decisionDetails(decision)
    }
    case 'settings': {
      if (ticketId !== undefined) throw new Error('Not a worker resource')
      const settings = store.settings(), revision = store.settingsRevision()
      if (!parts[1]) return { revision, blocks: ['policy', 'eval', 'executor', ...Object.keys(settings.sources).map(id => `source:${id}`)], paused: settings.paused }
      if (parts[1].startsWith('source:')) return { revision, block: parts[1], value: settings.sources[parts[1].slice('source:'.length)] ?? null }
      if (parts[1] === 'policy' || parts[1] === 'eval' || parts[1] === 'executor') return { revision, block: parts[1], value: settings[parts[1]] }
      throw new Error(`Unknown settings block ${parts[1]}`)
    }
    default: throw new Error(`Unknown resource ${resource}; one of: ${resourceGrammar(ticketId !== undefined)}`)
  }
}
export type { Trigger }
