/** Settings: saving blocks with a revision check, telling the Engine about Policy changes, and pausing processing. */
import { z } from 'zod'
import { UserError, type EngineForSettings, type SourceScope } from '../core/index.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema, SourceInstanceSchema, policyEffects, policyVersion,
  type Settings as SettingsValue, type SettingsBlock } from '../policy.ts'
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export interface SettingsHost {
  readonly store: Pick<Store, 'settings' | 'settingsRevision' | 'saveSettings' | 'tickets' | 'atomic'>
  readonly engine: EngineForSettings
  readonly sources: Pick<SourceRegistry, 'validate' | 'kind'>
  readonly sessions: Pick<Sessions, 'notify'>
  /** The Source scope under given settings, for policy effects. */
  scope(settings: SettingsValue): SourceScope
  requestPass(): void
}
export type SettingsOrigin = 'panel' | 'tool'

export class Settings {
  constructor(private readonly host: SettingsHost) {}
  view(): { revision: number; settings: SettingsValue; policyVersion: string } {
    const settings = this.host.store.settings()
    return { revision: this.host.store.settingsRevision(), settings, policyVersion: policyVersion(settings) }
  }
  /**
   * Save one block, checked against `revision`. A change that bears on the Policy restarts Evals in progress and tells the
   * affected tickets how; the main Session hears of every save through a notice.
   * @throws UserError for an unknown block or an invalid Source configuration.
   */
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin): Promise<{ revision: number; block: string; changed: string[] }> {
    const before = this.host.store.settings()
    const next: SettingsValue = structuredClone(before)
    if (block === 'policy') next.policy = PolicyConfigSchema.parse(value)
    else if (block === 'eval') next.eval = EvalConfigSchema.parse(value)
    else if (block === 'executor') next.executor = ExecutorConfigSchema.parse(value)
    else if (block.startsWith('source:')) {
      const id = block.slice('source:'.length)
      if (!this.host.sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
      const instance = SourceInstanceSchema.parse(value)
      const problem = this.host.sources.validate(id, instance.config)
      if (problem) throw new Error(`Invalid ${id} configuration: ${problem}`)
      next.sources[id] = instance
    } else throw new UserError('unknownBlock', { block })
    const parsed = SettingsSchema.parse(next)
    const changed = changedPaths(before, parsed)
    const record = this.host.store.atomic(() => {
      const saved = this.host.store.saveSettings(parsed, revision, origin)
      const from = policyVersion(before), to = policyVersion(parsed)
      if (from !== to) {
        const effects = policyEffects(this.host.store.tickets.open(), before, parsed, settings => this.host.scope(settings))
        this.host.engine.policyChanged(from, to, effects)
      }
      if (origin !== 'tool') this.host.sessions.notify(...settingsNotice(block, changed))
      return saved
    })
    this.host.requestPass()
    return { revision: record.revision, block, changed }
  }
  /** Pause or resume processing; the revision is not checked, since the switch is its own block. */
  pause(paused: boolean, origin: SettingsOrigin): { paused: boolean; revision: number } {
    const settings = this.host.store.settings()
    if (settings.paused === paused) return { paused, revision: this.host.store.settingsRevision() }
    const record = this.host.store.atomic(() => {
      const saved = this.host.store.saveSettings({ ...settings, paused }, this.host.store.settingsRevision(), origin)
      if (origin !== 'tool') this.host.sessions.notify(...settingsNotice('pause', ['paused']))
      return saved
    })
    this.host.requestPass()
    return { paused, revision: record.revision }
  }
}
export const PauseSchema = z.object({ paused: z.boolean() }).strict()
