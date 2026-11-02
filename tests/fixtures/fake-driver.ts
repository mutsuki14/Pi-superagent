/** A fake `SessionDriver`: scripted Sessions whose "model" is a function that receives each message and calls tools. */
import type { SessionDriver, SessionHandle, SessionSpec, SessionStatus } from '../../src/app/sessions.ts'
import type { Tool } from '../../src/app/tool.ts'

/** What a fake Session does with a message: call tools by name, in order. */
export type Script = (message: string, call: (name: string, args: unknown) => Promise<unknown>, session: FakeSession) => Promise<void>

export class FakeSession implements SessionHandle {
  readonly messages: { text: string; mode: 'steer' | 'queue' | 'inject' }[] = []
  readonly calls: { name: string; args: unknown; result: unknown }[] = []
  private state: SessionStatus = 'idle'
  private queue: string[] = []
  private waiters: (() => void)[] = []
  lastText = ''
  constructor(readonly id: string, readonly spec: SessionSpec, private readonly driver: FakeDriver, public script: Script) {}
  status(): SessionStatus { return this.state }
  tool(name: string): Tool { const tool = this.spec.tools.find(item => item.name === name); if (!tool) throw new Error(`No tool ${name} in ${this.id}`); return tool }
  async call(name: string, args: unknown): Promise<unknown> {
    const tool = this.tool(name)
    let result: unknown
    try { result = await tool.execute(tool.schema.parse(args), new AbortController().signal) }
    catch (error) { result = { error: error instanceof Error ? error.message : String(error) } }
    this.calls.push({ name, args, result })
    return result
  }
  async send(text: string, mode: 'steer' | 'queue'): Promise<void> {
    this.messages.push({ text, mode })
    this.queue.push(text)
    if (this.state === 'idle') void this.run()
  }
  async inject(text: string): Promise<void> { this.messages.push({ text, mode: 'inject' }) }
  private async run(): Promise<void> {
    this.state = 'running'
    this.driver.statusChanged(this.id, 'running')
    try {
      while (this.queue.length) {
        const text = this.queue.shift()!
        await Promise.resolve()
        try { await this.script(text, (name, args) => this.call(name, args), this) }
        catch (error) { this.driver.errored(this.id, error instanceof Error ? error.message : String(error)) }
      }
    } finally {
      this.state = 'idle'
      const waiters = this.waiters; this.waiters = []
      for (const wake of waiters) wake()
      this.driver.statusChanged(this.id, 'idle')
    }
  }
  whenIdle(): Promise<void> { return this.state === 'idle' ? Promise.resolve() : new Promise(resolve => { this.waiters.push(resolve) }) }
  async cancel(): Promise<void> { this.queue = [] }
  lastAssistantText(): string { return this.lastText }
  holds(requestId: string): boolean { return this.messages.some(message => message.text.includes(requestId)) }
  async dispose(): Promise<void> {}
}

export class FakeDriver implements SessionDriver {
  readonly sessions = new Map<string, FakeSession>()
  private readonly idle = new Set<(id: string) => void>()
  private readonly errors = new Set<(id: string, error: string) => void>()
  /** Scripts by Session id, or by role for Sessions without one. */
  constructor(private readonly scripts: { orchestrator: Script; worker: Script }) {}
  async ensure(id: string, spec: SessionSpec): Promise<SessionHandle> {
    let session = this.sessions.get(id)
    if (!session) { session = new FakeSession(id, spec, this, this.scripts[spec.role]); this.sessions.set(id, session) }
    return session
  }
  get(id: string): SessionHandle | undefined { return this.sessions.get(id) }
  onIdle(listener: (id: string) => void): () => void { this.idle.add(listener); return () => { this.idle.delete(listener) } }
  onError(listener: (id: string, error: string) => void): () => void { this.errors.add(listener); return () => { this.errors.delete(listener) } }
  statusChanged(id: string, status: SessionStatus): void { if (status === 'idle') for (const listener of this.idle) listener(id) }
  errored(id: string, error: string): void { for (const listener of this.errors) listener(id, error) }
  async disposeAll(): Promise<void> {}
}
/** Waits until `check` holds, polling, for up to `ms`. */
export async function until(check: () => boolean, ms = 5000, step = 20): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise(resolve => setTimeout(resolve, step))
  }
}
