/**
 * The inbox Source: a local, file-based conversation for development and for teams without a chat integration. People write
 * messages into `<stateDir>/inbox/in/<thread>.jsonl` (or through the panel's API), and replies land in `<stateDir>/inbox/out/<thread>.jsonl`.
 * A message addresses the agent when it mentions `@<name>` or its thread is a direct one (`dm-...`).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { SourceContext, SourceKind } from './kind.ts'

export const INBOX = 'inbox'
export const InboxConfigSchema = z.object({
  /** The agent's name people mention, such as `agent` for `@agent`. */
  name: z.string().trim().min(1).max(40).default('agent'),
  /** Whether unaddressed messages are received too (observed), which the admission table then decides. */
  receiveAll: z.boolean().default(false),
  pollSeconds: z.number().int().min(1).max(300).default(3),
}).strict()
export type InboxConfig = z.infer<typeof InboxConfigSchema>
export const InboxMessageSchema = z.object({
  id: z.string().min(1).optional(),
  from: z.string().min(1),
  text: z.string(),
  at: z.string().optional(),
  /** `true` for a bot's message; people's messages omit it. */
  bot: z.boolean().optional(),
  reply_to: z.string().optional(),
})
export type InboxMessage = z.infer<typeof InboxMessageSchema>

const mentions = (text: string, name: string): boolean => new RegExp(`(^|[^\\w])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
export const inboxDir = (stateDir: string): string => join(stateDir, 'inbox')
/** Appends a message to a thread's incoming file; the Source picks it up on its next poll. Returns the message id. */
export function postInboxMessage(stateDir: string, thread: string, message: InboxMessage): string {
  const dir = join(inboxDir(stateDir), 'in')
  mkdirSync(dir, { recursive: true })
  const id = message.id ?? key('inbox', thread, message.from, message.at ?? new Date().toISOString(), message.text, String(Math.random()))
  appendFileSync(join(dir, `${thread}.jsonl`), `${JSON.stringify({ ...message, id, at: message.at ?? new Date().toISOString() })}\n`)
  return id
}
/** Every message of a thread's conversation, incoming and outgoing, in time order. */
export function readInboxThread(stateDir: string, thread: string): { id: string; from: string; text: string; at: string; bot?: boolean; reply_to?: string; outgoing?: true }[] {
  const read = (file: string, outgoing: boolean) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { const parsed = JSON.parse(line) as Record<string, unknown>; return [{ ...(parsed as object), ...outgoing ? { outgoing: true as const } : {} }] } catch { return [] }
  }) : []
  const messages = [...read(join(inboxDir(stateDir), 'in', `${thread}.jsonl`), false), ...read(join(inboxDir(stateDir), 'out', `${thread}.jsonl`), true)]
  return (messages as { id: string; from: string; text: string; at: string; bot?: boolean; reply_to?: string; outgoing?: true }[]).sort((a, b) => a.at.localeCompare(b.at))
}
export const inboxThreads = (stateDir: string): string[] => {
  const dir = join(inboxDir(stateDir), 'in')
  return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort() : []
}
const inboxTrigger = (name: string, thread: string, message: InboxMessage & { id: string; at: string }): Trigger => {
  const direct = thread.startsWith('dm-')
  const addressed = direct ? 'direct' as const : mentions(message.text, name) ? 'mention' as const : undefined
  return { id: `inbox:${message.id}`, source: INBOX, threads: [{ source: INBOX, id: thread }], actor: { source: INBOX, id: message.from }, human: !message.bot,
    ...addressed ? { addressed } : {}, at: message.at, text: message.text, channel: { source: INBOX, thread: `inbox:${thread}`, address: { thread, message: message.id } },
    meta: { thread, ...message.reply_to ? { replyTo: message.reply_to } : {} } }
}
/** Polls `<stateDir>/inbox/in/*.jsonl` once: every message after the recorded position of its thread becomes a Trigger. */
export function pollInbox(context: SourceContext<InboxConfig>): number {
  const dir = join(inboxDir(context.stateDir), 'in')
  if (!existsSync(dir)) return 0
  let received = 0
  for (const thread of inboxThreads(context.stateDir)) {
    const lines = readFileSync(join(dir, `${thread}.jsonl`), 'utf8').split('\n').filter(Boolean)
    const position = context.state<number>(`position:${thread}`) ?? 0
    if (lines.length <= position) continue
    for (const line of lines.slice(position)) {
      const parsed = InboxMessageSchema.safeParse((() => { try { return JSON.parse(line) } catch { return undefined } })())
      if (!parsed.success || !parsed.data.id) continue
      // The agent's own replies are never written here; a message from the agent's name is dropped all the same.
      if (parsed.data.from.toLowerCase() === context.config.name.toLowerCase()) continue
      const trigger = inboxTrigger(context.config.name, thread, { ...parsed.data, id: parsed.data.id, at: parsed.data.at ?? new Date().toISOString() })
      if (context.receive(trigger) === 'stored') received++
    }
    context.setState(`position:${thread}`, lines.length)
    context.store.threads.patchMeta(`inbox:${thread}`, { source: INBOX, id: thread }, { label: thread })
  }
  return received
}
export const inboxKind: SourceKind<InboxConfig> = {
  kind: INBOX,
  title: 'Inbox',
  description: 'A local, file-based conversation: people write to <stateDir>/inbox/in/<thread>.jsonl, replies go to <stateDir>/inbox/out/<thread>.jsonl.',
  schema: InboxConfigSchema,
  scope: (input, config) => ({ listened: true, observed: config.receiveAll, row: String(input.meta.thread ?? '').startsWith('dm-') ? 'direct' : 'threads' }),
  admissionRows: () => [{ id: 'threads', label: 'Threads' }, { id: 'direct', label: 'Direct messages' }],
  channel: {
    async send(context, message: OutboundMessage) {
      const dir = join(inboxDir(context.stateDir), 'out')
      mkdirSync(dir, { recursive: true })
      const thread = message.channel.address.thread ?? message.channel.thread.replace(/^inbox:/, '')
      const file = join(dir, `${thread}.jsonl`)
      const sent = existsSync(file) && readFileSync(file, 'utf8').includes(`"id":${JSON.stringify(message.id)}`)
      if (!sent) appendFileSync(file, `${JSON.stringify({ id: message.id, from: context.config.name, text: message.text, at: new Date().toISOString(), kind: message.kind,
        ...message.channel.address.message ? { reply_to: message.channel.address.message } : {} })}\n`)
      return 'sent'
    },
  },
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? `inbox:${trigger.meta.replyTo}` : undefined,
  async threadContext(context, trigger, cursor) {
    const thread = String(trigger.meta.thread)
    const messages = readInboxThread(context.stateDir, thread)
    const start = cursor ? Number(cursor) : 0
    const page = messages.slice(start, start + 50)
    return { messages: page.map(message => ({ id: message.id, from: message.from, at: message.at, text: message.text, ...message.bot ? { bot: true as const } : {} })),
      ...start + 50 < messages.length ? { next: String(start + 50) } : {}, body: { thread } }
  },
  environment: { variables: [{ key: 'PI_SUPERAGENT_INBOX_THREAD', description: 'The inbox thread that started the ticket' }],
    values: ({ trigger }): Record<string, string> => trigger?.source === INBOX ? { PI_SUPERAGENT_INBOX_THREAD: String(trigger.meta.thread) } : {} },
  async run(context) {
    context.health.set({ state: 'ready', detail: 'Polling the inbox', at: new Date().toISOString() })
    while (!context.lifetime.aborted) {
      try { pollInbox(context); if (context.health.get()?.state === 'error') context.health.set({ state: 'ready', detail: 'Polling the inbox', at: new Date().toISOString() }) }
      catch (error) { context.health.set({ state: 'error', detail: String(error), at: new Date().toISOString() }) }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, context.config.pollSeconds * 1000)
        context.lifetime.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  },
}
