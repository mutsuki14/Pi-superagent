/** A small HTTP panel: JSON API over the Runtime for what needs a person, tickets, settings and the inbox Source. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Runtime } from '../app/runtime.ts'
import { readResource } from '../app/resources.ts'
import { UserError } from '../core/index.ts'
import { InboxMessageSchema, postInboxMessage, readInboxThread, inboxThreads } from '../sources/inbox.ts'
import { PANEL_HTML } from './page.ts'

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const body = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
  let data = ''
  req.on('data', chunk => { data += String(chunk) }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (error) { reject(error) } }); req.on('error', reject)
})
export function startPanel(runtime: Runtime, port: number): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const resources = { store: runtime.store, health: runtime.health, sources: runtime.sources }
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PANEL_HTML) }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
      if (req.method === 'GET' && url.pathname === '/api') return json(res, 200, { name: 'pi-superagent', routes: ['/api/overview', '/api/read?resource=', '/api/settings', '/api/tickets/:id/stop|retry', '/api/triggers/:id/reevaluate', '/api/threads/:key/unsubscribe', '/api/inbox/threads', '/api/inbox/:thread'] })
      if (req.method === 'GET' && url.pathname === '/api/overview') return json(res, 200, await readResource(resources, 'overview'))
      if (req.method === 'GET' && url.pathname === '/api/read') return json(res, 200, await readResource(resources, url.searchParams.get('resource') ?? 'overview', Number(url.searchParams.get('offset') ?? 0)))
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, runtime.settings.view())
      if (req.method === 'PUT' && url.pathname.startsWith('/api/settings/')) {
        const block = decodeURIComponent(url.pathname.slice('/api/settings/'.length)) as Parameters<typeof runtime.settings.save>[0] | 'pause'
        const payload = await body(req) as { value: unknown; revision: number; paused?: boolean }
        if (block === 'pause') return json(res, 200, runtime.settings.pause(!!payload.paused, 'panel'))
        return json(res, 200, await runtime.settings.save(block, payload.value, payload.revision, 'panel'))
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/tickets/')) {
        const [, , , id, action] = url.pathname.split('/')
        if (action === 'stop') return json(res, 200, runtime.engine.stopTicket(id!, ((await body(req)) as { reason?: string }).reason))
        if (action === 'retry') { const ticket = runtime.engine.retryTicket(id!); runtime.requestPass(); return json(res, 200, ticket) }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/triggers/') && url.pathname.endsWith('/reevaluate')) {
        const id = url.pathname.split('/')[3]!
        const queued = runtime.engine.reevaluate(id); runtime.requestPass(); return json(res, 200, { queued })
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/threads/') && url.pathname.endsWith('/unsubscribe')) {
        const key = decodeURIComponent(url.pathname.slice('/api/threads/'.length, -'/unsubscribe'.length))
        return json(res, 200, { removed: runtime.engine.unsubscribe(key), thread: key })
      }
      if (req.method === 'GET' && url.pathname === '/api/inbox/threads') return json(res, 200, inboxThreads(runtime.options.stateDir))
      if (url.pathname.startsWith('/api/inbox/')) {
        const thread = decodeURIComponent(url.pathname.slice('/api/inbox/'.length))
        if (req.method === 'GET') return json(res, 200, readInboxThread(runtime.options.stateDir, thread))
        if (req.method === 'POST') { const message = InboxMessageSchema.parse(await body(req)); return json(res, 201, { id: postInboxMessage(runtime.options.stateDir, thread, message) }) }
      }
      json(res, 404, { error: 'Not found' })
    } catch (error) {
      json(res, error instanceof UserError ? (error.missing ? 404 : 409) : 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  server.listen(port, '0.0.0.0', () => runtime.log(`panel at http://0.0.0.0:${port}/`))
  return server
}
