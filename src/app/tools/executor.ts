/** Executor (worker) Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type EngineForSources, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../text.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, tool, type Tool } from '../tool.ts'
import { readTool } from './main.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'> & Pick<EngineForSources, 'bindThread'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** Verifies a pull request the worker claims for its ticket; returns why it is refused, or nothing. */
  claimPull?(ticketId: string, number: number, signal: AbortSignal): Promise<string | undefined>
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({ trigger_id: z.string(), text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`) }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, such as github:<number> or inbox:<thread>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({ thread: z.string().describe('Thread key, such as github:<number>.'), reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.') }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s.',
      schema: z.object({ trigger_id: z.string().min(1), reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.') }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe('The ticket\'s GitHub pull request: its source PR, or one opened from a branch named after this ticket (PI_SUPERAGENT_NAME).'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const refused = args.pr_number != null && host.claimPull ? await host.claimPull(ticketId, args.pr_number, signal) : undefined
        if (refused) throw new Error(refused)
        return host.store.atomic(() => {
          if (args.pr_number != null && !host.claimPull) host.engine.bindThread(ticketId, { source: 'github', id: String(args.pr_number) }, true)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}), ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          return { reported: true, notification: relay ? 'orchestrator' : 'internal_only', ...(updated.attention ? { attention: updated.attention } : {}),
            ...(updated.ended ? { ticket_ended: updated.ended.outcome } : {}) }
        })
      },
    }),
  ]
}
