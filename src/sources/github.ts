/**
 * The GitHub Source: polls one repository through the `gh` CLI for Issues, pull requests, comments and reviews, turns them into
 * Triggers, follows the pull requests tickets opened, reports their merges and closes, and posts comments as its Channel.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { liveTicket, threadKey, type ChannelRef, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../app/text.ts'
import type { SourceContext, SourceKind } from './kind.ts'

const run = promisify(execFile)
export const GITHUB = 'github'
export const GithubConfigSchema = z.object({
  /** The repository the Source watches, `owner/name`. */
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name').default(''),
  /** The agent's GitHub login, whose own comments are dropped and whose mention addresses the agent; resolved from `gh` when empty. */
  account: z.string().default(''),
  commitEmail: z.string().default(''),
  /** Receive every new Issue, pull request and comment (observed), or only mentions and subscribed threads. */
  receiveAll: z.boolean().default(false),
  pollSeconds: z.number().int().min(15).max(3600).default(60),
  /** How far back the first poll looks, in hours. */
  initialLookbackHours: z.number().int().min(0).max(24 * 30).default(1),
}).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>

export const githubChannel = (number: number, commentId?: number): ChannelRef =>
  ({ source: GITHUB, thread: `github:${number}`, address: { number: String(number), ...(commentId ? { comment: String(commentId) } : {}) } })
const UserSchema = z.object({ login: z.string(), type: z.string().optional() }).nullable().transform(user => user ?? { login: 'ghost', type: 'User' })
const IssueSchema = z.object({ number: z.number(), title: z.string(), body: z.string().nullish(), user: UserSchema, state: z.string(), created_at: z.string(),
  updated_at: z.string(), html_url: z.string(), pull_request: z.object({ url: z.string(), merged_at: z.string().nullish() }).nullish() })
const CommentSchema = z.object({ id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string(), created_at: z.string(),
  issue_url: z.string().optional(), pull_request_url: z.string().optional(), path: z.string().nullish(), line: z.number().nullish(), in_reply_to_id: z.number().nullish() })
const ReviewSchema = z.object({ id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string(), submitted_at: z.string().nullish(), state: z.string(), commit_id: z.string() })
const PullSchema = z.object({ number: z.number(), state: z.string(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullish() }), html_url: z.string(), user: UserSchema })
export const isHumanLogin = (user: { login: string; type?: string }): boolean => !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
export const mentions = (text: string, login: string): boolean => login !== '' && new RegExp(`(^|[^\\w])@${escapeRegExp(login)}\\b`, 'i').test(text)
const numberOf = (url: string | undefined): number | undefined => { const match = /\/(\d+)$/.exec(url ?? ''); return match ? Number(match[1]) : undefined }

/** Runs `gh api` and parses JSON; a 404 is thrown as `GithubGone`. */
export class GithubGone extends Error {}
export async function gh(args: string[], signal?: AbortSignal): Promise<unknown> {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, ...signal ? { signal } : {} })
    return stdout.trim() ? JSON.parse(stdout) : undefined
  } catch (error) {
    const text = String((error as { stderr?: string }).stderr ?? (error as Error).message)
    if (/HTTP 404|Not Found/.test(text)) throw new GithubGone(text)
    throw new Error(text.trim())
  }
}
export const ghApi = (path: string, signal?: AbortSignal) => gh(['api', '-H', 'Accept: application/vnd.github+json', path], signal)

function triggerOf(config: GithubConfig, number: number, pr: boolean, kind: 'issue' | 'pull' | 'comment' | 'review' | 'review_comment', id: string,
  user: { login: string; type?: string }, at: string, text: string, url: string, extra: Record<string, unknown> = {}, channelComment?: number): Trigger {
  const human = isHumanLogin(user)
  const addressed = mentions(text, config.account) ? 'mention' as const : undefined
  return { id: `github:${kind}:${id}`, source: GITHUB, threads: [{ source: GITHUB, id: String(number) }], actor: { source: GITHUB, id: user.login }, human,
    ...addressed ? { addressed } : {}, at, text, url, channel: githubChannel(number, channelComment),
    meta: { number, pr, kind, ...extra, row: kind === 'issue' ? 'issues' : kind === 'pull' ? 'pulls' : 'comments' } }
}
interface Seen { since: string }
/** The pull requests tickets opened, by head branch: a PR whose head's last path segment is a ticket's short name belongs to that ticket. */
function ticketOfBranch(context: SourceContext<GithubConfig>, branch: string): Ticket | undefined {
  const name = branch.split('/').at(-1) ?? branch
  return context.store.tickets.list().find(ticket => ticket.execution?.name === name && liveTicket(ticket))
}
/** One poll: new Issues and PRs, new comments and reviews on every Issue/PR updated since the read position, and PR closes. */
export async function pollGithub(context: SourceContext<GithubConfig>, signal?: AbortSignal): Promise<{ received: number; errors: string[] }> {
  const { config } = context
  if (!config.repository) return { received: 0, errors: [] }
  const repo = config.repository
  const seen = context.state<Seen>('position') ?? { since: new Date(Date.now() - config.initialLookbackHours * 3_600_000).toISOString() }
  const started = new Date().toISOString()
  let received = 0
  const errors: string[] = []
  const subscribed = new Set(context.subscribedThreads().map(thread => Number(thread.ref.id)).filter(Number.isFinite))
  const issues = z.array(IssueSchema).parse(await ghApi(`repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(seen.since)}&per_page=100`, signal))
  const own = (login: string) => sameName(login, config.account)
  const take = (trigger: Trigger) => { if (!own(trigger.actor.id) && context.receive(trigger) === 'stored') received++ }
  const numbers = new Set<number>([...issues.map(issue => issue.number), ...subscribed])
  for (const number of numbers) {
    try {
      const listed = issues.find(issue => issue.number === number)
      const issue = listed ?? IssueSchema.parse(await ghApi(`repos/${repo}/issues/${number}`, signal))
      const pr = !!issue.pull_request
      context.store.threads.patchMeta(`github:${number}`, { source: GITHUB, id: String(number) }, { label: `#${number} ${issue.title}`, url: issue.html_url, pr, state: issue.state })
      if (issue.created_at > seen.since) {
        take(triggerOf(config, number, pr, pr ? 'pull' : 'issue', String(number), issue.user, issue.created_at, `${issue.title}\n\n${issue.body ?? ''}`, issue.html_url, { title: issue.title }))
      }
      const comments = z.array(CommentSchema).parse(await ghApi(`repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(seen.since)}&per_page=100`, signal))
      for (const comment of comments) if (comment.created_at > seen.since) {
        take(triggerOf(config, number, pr, 'comment', String(comment.id), comment.user, comment.created_at, comment.body ?? '', comment.html_url, { commentId: comment.id }))
      }
      if (pr) {
        const reviews = z.array(ReviewSchema).parse(await ghApi(`repos/${repo}/pulls/${number}/reviews?per_page=100`, signal))
        for (const review of reviews) if ((review.submitted_at ?? '') > seen.since) {
          const decided = review.state !== 'COMMENTED' ? `${review.state} review of commit ${review.commit_id}\n\n` : ''
          take(triggerOf(config, number, true, 'review', String(review.id), review.user, review.submitted_at!, `${decided}${review.body ?? ''}`, review.html_url, { reviewId: review.id, state: review.state }))
        }
        const reviewComments = z.array(CommentSchema).parse(await ghApi(`repos/${repo}/pulls/${number}/comments?since=${encodeURIComponent(seen.since)}&per_page=100`, signal))
        for (const comment of reviewComments) if (comment.created_at > seen.since) {
          const place = comment.path ? `${comment.path}${comment.line != null ? `:${comment.line}` : ''}\n\n` : ''
          take(triggerOf(config, number, true, 'review_comment', String(comment.id), comment.user, comment.created_at, `${place}${comment.body ?? ''}`, comment.html_url,
            { commentId: comment.id, inReplyTo: comment.in_reply_to_id ?? undefined }, comment.in_reply_to_id ?? comment.id))
        }
        const pull = PullSchema.parse(await ghApi(`repos/${repo}/pulls/${number}`, signal))
        // A PR from a ticket's branch belongs to the ticket: bind it, so its close ends the ticket.
        const owner = pull.head.repo && sameName(pull.head.repo.full_name, repo) ? ticketOfBranch(context, pull.head.ref) : undefined
        const bound = context.store.threads.get(`github:${number}`)?.subscriptions ?? []
        if (owner && !owner.follows?.some(item => item.thread === `github:${number}`)) context.engine.bindThread(owner.id, { source: GITHUB, id: String(number) }, true)
        if (pull.state === 'closed' && (bound.length || owner)) {
          context.engine.threadClosed({ source: GITHUB, id: String(number) }, pull.merged_at ? 'merged' : 'closed', pull.merged_at ?? pull.closed_at ?? started)
        }
      }
    } catch (error) {
      if (error instanceof GithubGone) { context.store.threads.patchMeta(`github:${number}`, { source: GITHUB, id: String(number) }, { pollError: 'Not found: deleted, or access lost' }); continue }
      errors.push(`#${number}: ${String(error).slice(0, 300)}`)
    }
  }
  if (!errors.length) context.setState<Seen>('position', { since: started })
  return { received, errors }
}
/** Resolves the agent's login through `gh api user` when the configuration leaves it empty. */
export async function resolveAccount(config: GithubConfig): Promise<string> {
  if (config.account) return config.account
  const user = z.object({ login: z.string() }).safeParse(await ghApi('user').catch(() => undefined))
  return user.success ? user.data.login : ''
}
export const githubKind: SourceKind<GithubConfig> = {
  kind: GITHUB,
  title: 'GitHub',
  description: 'Polls one repository through the gh CLI: Issues, pull requests, comments and reviews. Replies are comments.',
  schema: GithubConfigSchema,
  scope: (input, config) => config.repository ? { listened: true, observed: config.receiveAll, row: String(input.meta.row ?? 'comments') } : { listened: false, reason: 'no_repository' },
  admissionRows: () => [{ id: 'issues', label: 'New Issues' }, { id: 'pulls', label: 'New pull requests' }, { id: 'comments', label: 'Comments and reviews' }],
  channel: {
    link: (address, config) => config.repository ? `https://github.com/${config.repository}/issues/${address.number}${address.comment ? `#issuecomment-${address.comment}` : ''}` : undefined,
    async send(context, message: OutboundMessage) {
      const repo = context.config.repository
      const number = message.channel.address.number
      const marker = `<!-- pi-superagent:${message.id} -->`
      // Idempotent: a comment that carries the marker was posted by an earlier attempt.
      try {
        const existing = z.array(CommentSchema).parse(await ghApi(`repos/${repo}/issues/${number}/comments?per_page=100&sort=created&direction=desc`))
        if (existing.some(comment => comment.body?.includes(marker))) return 'sent'
        const body = `${message.text}\n\n${marker}`
        if (message.channel.address.comment && message.channel.thread) {
          // A reply in a review thread: GitHub's reply endpoint, falling back to the conversation when the comment is gone.
          try { await gh(['api', '-X', 'POST', `repos/${repo}/pulls/${number}/comments/${message.channel.address.comment}/replies`, '-f', `body=${body}`]); return 'sent' }
          catch (error) { if (!(error instanceof GithubGone)) throw error }
        }
        await gh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`])
        return 'sent'
      } catch (error) {
        if (error instanceof GithubGone) return 'gone'
        if (/locked/i.test(String(error))) return 'gone'
        throw error
      }
    },
  },
  repliesTo: trigger => typeof trigger.meta.inReplyTo === 'number' ? `github:review_comment:${trigger.meta.inReplyTo}` : undefined,
  async threadContext(context, trigger, cursor) {
    const repo = context.config.repository, number = Number(trigger.meta.number)
    const page = cursor ? Number(cursor) : 1
    const issue = IssueSchema.parse(await ghApi(`repos/${repo}/issues/${number}`))
    const comments = z.array(CommentSchema).parse(await ghApi(`repos/${repo}/issues/${number}/comments?per_page=30&page=${page}`))
    const messages = [...page === 1 ? [{ id: `github:${issue.pull_request ? 'pull' : 'issue'}:${number}`, from: issue.user.login, at: issue.created_at, text: `${issue.title}\n\n${issue.body ?? ''}`, url: issue.html_url, ...isHumanLogin(issue.user) ? {} : { bot: true as const } }] : [],
      ...comments.map(comment => ({ id: `github:comment:${comment.id}`, from: comment.user.login, at: comment.created_at, text: comment.body ?? '', url: comment.html_url, ...isHumanLogin(comment.user) ? {} : { bot: true as const } }))]
    return { messages, ...comments.length === 30 ? { next: String(page + 1) } : {}, body: { number, title: issue.title, state: issue.state, url: issue.html_url, pr: !!issue.pull_request } }
  },
  environment: {
    variables: [
      { key: 'PI_SUPERAGENT_GITHUB_REPOSITORY', description: 'The repository the Source watches, owner/name' },
      { key: 'PI_SUPERAGENT_GITHUB_ACCOUNT', description: 'The agent\'s GitHub account' },
      { key: 'PI_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: 'The commit email of the agent account' },
      { key: 'PI_SUPERAGENT_GITHUB_NUMBER', description: 'The Issue or pull request that started the ticket' },
      { key: 'PI_SUPERAGENT_GITHUB_PR_HEAD', description: 'The head ref when the ticket started from a pull request' },
    ],
    values: ({ config, trigger }) => ({ PI_SUPERAGENT_GITHUB_REPOSITORY: config.repository, PI_SUPERAGENT_GITHUB_ACCOUNT: config.account, PI_SUPERAGENT_GITHUB_COMMIT_EMAIL: config.commitEmail,
      ...trigger?.source === GITHUB ? { PI_SUPERAGENT_GITHUB_NUMBER: String(trigger.meta.number) } : {},
      ...trigger?.source === GITHUB && typeof trigger.meta.prHead === 'string' ? { PI_SUPERAGENT_GITHUB_PR_HEAD: trigger.meta.prHead } : {} }),
  },
  async run(context) {
    let failures = 0
    while (!context.lifetime.aborted) {
      const { config } = context
      if (config.repository) {
        try {
          const { errors } = await pollGithub(context, context.lifetime)
          failures = errors.length ? failures + 1 : 0
          if (errors.length && failures >= 3) context.health.set({ state: 'error', detail: `Polling failed ${failures} times: ${errors.join('; ')}`, at: new Date().toISOString() })
          else context.health.set({ state: 'ready', detail: `Polling ${config.repository}${errors.length ? `; ${errors.length} thread(s) failed` : ''}`, at: new Date().toISOString() })
        } catch (error) {
          failures++
          if (failures >= 3) context.health.set({ state: 'error', detail: `Polling failed: ${String(error).slice(0, 500)}`, at: new Date().toISOString() })
          context.log(`github poll failed: ${String(error).slice(0, 300)}`)
        }
      } else context.health.set({ state: 'waiting', detail: 'No repository configured', at: new Date().toISOString() })
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, (config.repository ? config.pollSeconds : 15) * 1000)
        context.lifetime.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  },
}
/** A pull request the worker claims for its ticket: refused unless it is from the ticket's branch or the ticket's source PR. */
export async function claimPull(context: SourceContext<GithubConfig>, ticketId: string, number: number, signal?: AbortSignal): Promise<string | undefined> {
  const ticket = context.store.tickets.get(ticketId)
  if (!ticket) return 'Unknown ticket'
  const repo = context.config.repository
  if (!repo) return 'No GitHub repository is configured'
  const pull = PullSchema.parse(await ghApi(`repos/${repo}/pulls/${number}`, signal))
  const source = context.store.triggers.get(ticket.origin.triggerId)
  const fromSource = source?.source === GITHUB && Number(source.meta.number) === number
  const fromBranch = pull.head.repo && sameName(pull.head.repo.full_name, repo) && (pull.head.ref.split('/').at(-1) ?? '') === ticket.execution?.name
  if (!fromSource && !fromBranch) return `PR #${number} is neither this ticket's source PR nor from its branch (${ticket.execution?.name ?? 'unknown'})`
  const other = context.store.tickets.list().find(item => item.id !== ticketId && liveTicket(item) && item.follows?.some(follow => follow.thread === `github:${number}` && follow.own))
  if (other) return `PR #${number} belongs to ticket ${other.id}`
  context.store.atomic(() => {
    context.engine.bindThread(ticketId, { source: GITHUB, id: String(number) }, fromBranch || !fromSource)
    if (pull.state === 'closed') context.engine.threadClosed({ source: GITHUB, id: String(number) }, pull.merged_at ? 'merged' : 'closed', pull.merged_at ?? pull.closed_at ?? new Date().toISOString())
  })
  return undefined
}
export { threadKey }
