#!/usr/bin/env node
/** pi-superagent CLI: `start` runs the agent; `post` writes a message into the inbox Source; `status` prints the tickets. */
import { resolve } from 'node:path'
import { Runtime } from './app/runtime.ts'
import { PiSessions } from './app/sessions.ts'
import { Store } from './app/store.ts'
import { postInboxMessage, readInboxThread } from './sources/inbox.ts'
import { ticketCard } from './app/cards.ts'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const option = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const stateDir = resolve(option('state', process.env.PI_SUPERAGENT_STATE ?? '.state')!)

async function main(): Promise<void> {
  switch (command) {
    case 'start': {
      const driver = new PiSessions({ stateDir, log: message => console.log(`[pi-superagent] ${message}`), ...option('agent-dir') ? { agentDir: option('agent-dir')! } : {} })
      const runtime = new Runtime({ stateDir, driver, ...option('repo') ? { repoDir: resolve(option('repo')!) } : {} })
      await runtime.start()
      const stop = async () => { await runtime.stop(); process.exit(0) }
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
      if (option('panel') !== undefined) {
        const { startPanel } = await import('./panel/server.ts')
        startPanel(runtime, Number(option('panel', '8787')))
      }
      return
    }
    case 'post': {
      const thread = option('thread', 'general')!
      const from = option('from', 'alice')!
      const text = args.filter((arg, index) => index > 0 && !arg.startsWith('--') && args[index - 1] !== `--${['thread', 'from', 'state'].find(name => args[index - 1] === `--${name}`) ?? ''}`).join(' ')
      const id = postInboxMessage(stateDir, thread, { from, text })
      console.log(`posted inbox:${id} to thread ${thread}`)
      return
    }
    case 'thread': {
      for (const message of readInboxThread(stateDir, option('thread', 'general')!)) console.log(`${message.at} ${message.outgoing ? '<-' : '->'} ${message.from}: ${message.text}`)
      return
    }
    case 'status': {
      const store = new Store(stateDir)
      const tickets = store.tickets.list()
      console.log(JSON.stringify({ paused: store.settings().paused, settingsRevision: store.settingsRevision(), tickets: tickets.map(ticketCard), effects: store.effects.all().length }, null, 2))
      return
    }
    case 'settings': {
      const store = new Store(stateDir)
      console.log(JSON.stringify({ revision: store.settingsRevision(), ...store.settings() }, null, 2))
      return
    }
    default:
      console.log(`pi-superagent <command> [--state <dir>]
  start [--repo <checkout>] [--panel [port]] [--agent-dir <pi config dir>]   run the agent
  post --thread <t> --from <who> <text...>                                  write a message into the inbox Source
  thread --thread <t>                                                       print an inbox conversation
  status                                                                    print tickets and queue size
  settings                                                                  print the settings (edit them through the panel API or the orchestrator)`)
  }
}
main().catch(error => { console.error(error); process.exit(1) })
