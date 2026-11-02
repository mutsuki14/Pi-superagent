/**
 * Sessions: one Pi `AgentSession` per role, created on demand and kept across restarts. The `SessionDriver` port lets the
 * host run against Pi (`PiSessions`) or a fake in tests. On top of the driver, `Sessions` relays messages into the main
 * Session in order and injects notices without waking it.
 */
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { RoleModel } from '../policy.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import { piTool, type Tool } from './tool.ts'
import { now } from './text.ts'

export type Role = 'orchestrator' | 'worker'
export interface SessionSpec {
  /** Working directory: the repository checkout for the main Session, the ticket directory for a worker. */
  cwd: string
  role: Role
  /** Text appended to Pi's system prompt for this Session. */
  systemPrompt: string
  tools: Tool[]
  /** Pi built-in tools to enable, such as `read` and `bash`. */
  builtinTools: string[]
  model?: RoleModel | null
  /** A short name for people. */
  title: string
}
export type SessionStatus = 'idle' | 'running'
/** One Session the driver runs. */
export interface SessionHandle {
  readonly id: string
  status(): SessionStatus
  /**
   * Sends a message: when the Session is idle, it starts a turn; when it runs, `steer` delivers it before the next model call
   * and `queue` after the run ends. Resolves once the message is accepted, not when the turn ends.
   */
  send(text: string, mode: 'steer' | 'queue'): Promise<void>
  /** Appends a message the model reads at its next turn, without starting one. */
  inject(text: string): Promise<void>
  whenIdle(): Promise<void>
  /** Aborts the running turn, if any. */
  cancel(): Promise<void>
  lastAssistantText(): string
  /** The Session's own idea of what it holds, such as whether its history has a message `requestId` sent. */
  holds(requestId: string): boolean
  dispose(): Promise<void>
}
export interface SessionDriver {
  ensure(id: string, spec: SessionSpec): Promise<SessionHandle>
  get(id: string): SessionHandle | undefined
  /** A Session went from running to idle. */
  onIdle(listener: (id: string) => void): () => void
  /** A Session's turn failed, such as when the model provider answered an error. */
  onError(listener: (id: string, error: string) => void): () => void
  disposeAll(): Promise<void>
}

/** Pi's model ids and thinking levels as `RoleModel` names them. */
type Pi = typeof import('@earendil-works/pi-coding-agent')
type AgentSession = import('@earendil-works/pi-coding-agent').AgentSession

export interface PiSessionsOptions {
  stateDir: string
  /** Pi's global config directory, with its `auth.json` and `models.json`; defaults to `~/.pi/agent`. */
  agentDir?: string
  log: (message: string) => void
}

/**
 * Runs Sessions on the Pi coding agent SDK: each Session is an `AgentSession` with its own persistent session file under
 * `<stateDir>/sessions/<id>`, the role's tools, and the configured model. A Session that exists on disk is continued.
 */
export class PiSessions implements SessionDriver {
  private readonly handles = new Map<string, SessionHandle>()
  private readonly idleListeners = new Set<(id: string) => void>()
  private readonly errorListeners = new Set<(id: string, error: string) => void>()
  private pi?: Promise<Pi>
  private runtime?: Promise<import('@earendil-works/pi-coding-agent').ModelRuntime>
  constructor(private readonly options: PiSessionsOptions) {}
  private sdk(): Promise<Pi> { return this.pi ??= import('@earendil-works/pi-coding-agent') }
  private async models() {
    const pi = await this.sdk()
    const dir = this.agentDir(pi)
    mkdirSync(dir, { recursive: true })
    seedModelsFile(join(dir, 'models.json'))
    return this.runtime ??= pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') })
  }
  agentDir(pi: Pi): string { return this.options.agentDir ?? pi.getAgentDir() }
  /** The model for a role: the configured one, else the first available. */
  private async model(role: RoleModel | null | undefined) {
    const runtime = await this.models()
    if (role) {
      const model = runtime.getModel(role.provider, role.model)
      if (!model) throw new Error(`The model ${role.provider}/${role.model} is not known to Pi; add it to models.json or pick another`)
      return model
    }
    const available = await runtime.getAvailable()
    const first = available[0]
    if (!first) throw new Error('No model is available: configure an API key for Pi (such as ANTHROPIC_API_KEY or OPENAI_API_KEY), or log in with the pi CLI')
    return first
  }
  get(id: string): SessionHandle | undefined { return this.handles.get(id) }
  async ensure(id: string, spec: SessionSpec): Promise<SessionHandle> {
    const existing = this.handles.get(id)
    if (existing) return existing
    const pi = await this.sdk()
    const sessionDir = join(this.options.stateDir, 'sessions', id)
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(spec.cwd, { recursive: true })
    const stored = existsSync(sessionDir) && readdirSync(sessionDir).some(file => file.endsWith('.jsonl'))
    const sessionManager = stored ? pi.SessionManager.continueRecent(spec.cwd, sessionDir) : pi.SessionManager.create(spec.cwd, sessionDir)
    let api: ExtensionAPI | undefined
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: spec.cwd, agentDir: this.agentDir(pi), noExtensions: true, noPromptTemplates: true, noThemes: true,
      appendSystemPrompt: [spec.systemPrompt],
      extensionFactories: [(extension: ExtensionAPI) => { api = extension }],
    })
    await resourceLoader.reload()
    const customTools: ToolDefinition[] = spec.tools.map(definition => piTool(definition, this.options.log))
    const model = await this.model(spec.model)
    const { session } = await pi.createAgentSession({
      cwd: spec.cwd, agentDir: this.agentDir(pi), model, modelRuntime: await this.models(), resourceLoader, sessionManager,
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 3 } }),
      // `tools` is an allowlist: the role's built-in tools, and every custom tool by name.
      tools: [...spec.builtinTools, ...customTools.map(definition => definition.name)], customTools,
      ...(spec.model?.thinking ? { thinkingLevel: spec.model.thinking } : {}),
    })
    const handle = this.handleOf(id, session, () => api)
    this.handles.set(id, handle)
    this.options.log(`session ${id} (${spec.role}) ready on ${model.provider}/${model.id} in ${spec.cwd}; tools: ${session.getActiveToolNames().join(', ')}`)
    return handle
  }
  private handleOf(id: string, session: AgentSession, api: () => ExtensionAPI | undefined): SessionHandle {
    let status: SessionStatus = session.isStreaming ? 'running' : 'idle'
    let idleWaiters: (() => void)[] = []
    const settle = () => { status = 'idle'; const waiters = idleWaiters; idleWaiters = []; for (const wake of waiters) wake(); for (const listener of this.idleListeners) listener(id) }
    session.subscribe(event => {
      if (event.type === 'agent_start') status = 'running'
      else if (event.type === 'agent_settled') settle()
      else if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
        const error = event.message.errorMessage ?? 'The model answered an error'
        for (const listener of this.errorListeners) listener(id, error)
      }
    })
    const { log } = this.options
    const run = (promise: Promise<unknown>) => { promise.catch((error: unknown) => {
      log(`session ${id}: ${error instanceof Error ? error.message : String(error)}`)
      for (const listener of this.errorListeners) listener(id, error instanceof Error ? error.message : String(error))
      if (status === 'running' && !session.isStreaming) settle()
    }) }
    const handle: SessionHandle = {
      id,
      status: () => status,
      async send(text, mode) {
        if (session.isStreaming) { await (mode === 'steer' ? session.steer(text) : session.followUp(text)); return }
        status = 'running'
        // The turn runs on; its end comes through `agent_settled`.
        run(session.prompt(text, { expandPromptTemplates: false }))
      },
      async inject(text) {
        const extension = api()
        if (extension && !session.isStreaming) { extension.sendMessage({ customType: 'pi-superagent-notice', content: text, display: true }, { triggerTurn: false, deliverAs: 'nextTurn' }); return }
        if (extension) { extension.sendMessage({ customType: 'pi-superagent-notice', content: text, display: true }, { triggerTurn: false, deliverAs: 'followUp' }); return }
        await handle.send(text, 'queue')
      },
      whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve) }),
      cancel: async () => { if (session.isStreaming) await session.abort() },
      lastAssistantText: () => session.getLastAssistantText() ?? '',
      holds: requestId => session.messages.some(message => message.role === 'user' && typeof message.content === 'string'
        ? message.content.includes(requestId) : message.role === 'user' && Array.isArray(message.content)
        && message.content.some(block => block.type === 'text' && block.text.includes(requestId))),
      dispose: async () => { if (session.isStreaming) await session.abort().catch(() => {}); session.dispose(); this.handles.delete(id) },
    }
    return handle
  }
  onIdle(listener: (id: string) => void): () => void { this.idleListeners.add(listener); return () => { this.idleListeners.delete(listener) } }
  onError(listener: (id: string, error: string) => void): () => void { this.errorListeners.add(listener); return () => { this.errorListeners.delete(listener) } }
  async disposeAll(): Promise<void> { await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose())) }
}

/**
 * Routes built-in providers through the proxies `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` name, when the agent directory has
 * no `models.json` of its own: Pi reads provider keys from the environment but not these base URLs.
 */
export function seedModelsFile(file: string): void {
  if (existsSync(file)) return
  const providers: Record<string, { baseUrl: string }> = {}
  if (process.env.ANTHROPIC_BASE_URL) providers.anthropic = { baseUrl: process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') }
  if (process.env.OPENAI_BASE_URL) providers.openai = { baseUrl: process.env.OPENAI_BASE_URL.replace(/\/+$/, '') }
  if (!Object.keys(providers).length) return
  writeFileSync(file, JSON.stringify({ providers }, null, 2))
}

export const MAIN_SESSION = 'orchestrator'
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined

export interface SessionsHost {
  readonly driver: SessionDriver
  readonly store: Pick<Store, 'get' | 'set' | 'atomic'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The spec of the main Session, built from the current prompts and settings. */
  mainSpec(): SessionSpec
  paused(): boolean
  log(message: string): void
}
/**
 * Delivers messages to the main Session: `relay` steers a report, a candidate or a follow-up into its turn, in order and
 * once per request id; `notify` injects a notice the model reads at its next turn without starting one.
 */
export class Sessions {
  constructor(private readonly host: SessionsHost) {
    host.effects.handle('relay', async ({ text }, id) => { await this.deliver(id, text, 'steer') }, { ordered: true, limit: () => host.paused() ? 0 : 1 })
    host.effects.handle('notice', async ({ value, summary }, name) => {
      const main = await this.main()
      await main.inject(JSON.stringify({ kind: 'notice', name, summary, ...value, at: now() }))
    }, { ordered: true })
  }
  async main(): Promise<SessionHandle> { return this.host.driver.ensure(MAIN_SESSION, this.host.mainSpec()) }
  /** Queues a relay to the main Session; the same id goes once. */
  relay(id: string, text: string): void { this.host.effects.enqueue('relay', id, { text }) }
  /** Queues a notice to the main Session; a newer notice of the same name replaces an unsent one. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Delivers once per request id, remembered in the Store. */
  async deliver(requestId: string, text: string, mode: 'steer' | 'queue'): Promise<void> {
    const delivered = this.host.store.get<string[]>('relayed') ?? []
    if (delivered.includes(requestId)) return
    const main = await this.main()
    await main.send(text, mode)
    this.host.store.set('relayed', [...delivered, requestId].slice(-2000))
  }
}
