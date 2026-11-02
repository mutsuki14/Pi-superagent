/**
 * Composes each role's system prompt from the built-in parts in `prompts/` and the team's sections, which an installation
 * overrides by files of the same name under `<stateDir>/prompts/`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Settings } from '../policy.ts'
import { policyVersion } from '../policy.ts'

export const TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
export type TeamSection = typeof TEAM_SECTIONS[number]
const TEAM_HEADINGS: Record<TeamSection, string> = { communication: 'Communication', scope: 'Ticket scope', delivery: 'Delivery requirements' }
export type Role = 'orchestrator' | 'worker'
/** Where the built-in prompt files are: `prompts/` beside `src/` or `dist/`. */
export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts')

export interface PromptInput {
  settings: Settings
  /** Execution environment variables, with descriptions, for the worker; the main Session reads the same list. */
  environment: { key: string; value: string; description: string }[]
  /** Extra text for one ticket's worker, such as its mandate instructions. */
  ticket?: string
}
export class Prompts {
  constructor(private readonly stateDir: string, private readonly builtIn = PROMPTS_DIR) {}
  /** A built-in part's text, or the installation's override of it under `<stateDir>/prompts/<name>.md`. */
  part(name: string): string {
    const override = join(this.stateDir, 'prompts', `${name}.md`)
    const file = existsSync(override) ? override : join(this.builtIn, `${name}.md`)
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  }
  private section(heading: string, name: string): string {
    const text = this.part(name)
    return text ? `## ${heading}\n${text}` : ''
  }
  private team(): string { return TEAM_SECTIONS.map(section => this.section(TEAM_HEADINGS[section], `team/${section}`)).filter(Boolean).join('\n\n') }
  private environment(variables: PromptInput['environment']): string {
    const lines = variables.map(variable => `- ${variable.key}=${JSON.stringify(variable.value)}: ${variable.description}`).join('\n')
    return this.part('environment').replace('{variables}', lines || '- (none configured)')
  }
  private policy(settings: Settings): string {
    const rules = settings.policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`).join('\n')
    return this.part('policy').replace('{version}', policyVersion(settings)).replace('{mode}', settings.eval.mode).replace('{rules}', rules || '- (no rule is enabled; every proactive candidate is ignored)')
  }
  compose(role: Role, input: PromptInput): string {
    const parts = role === 'orchestrator'
      ? [this.part('orchestrator'), this.part('shared'), this.section('dispatch', 'dispatch'), this.section('admission', 'admission'),
        this.section('handoff', 'handoff'), this.part('handoff-orchestrator'), this.section('subscriptions', 'subscriptions'), this.section('replies', 'replies'),
        this.team(), this.environment(input.environment), this.policy(input.settings)]
      : [this.part('worker'), this.part('shared'), this.section('work', 'work'), this.section('handoff', 'handoff'), this.part('handoff-worker'),
        this.section('subscriptions', 'subscriptions'), this.section('replies', 'replies'), this.part('cli'), this.team(), this.environment(input.environment),
        ...input.ticket ? [`## This ticket\n${input.ticket}`] : []]
    return parts.filter(Boolean).join('\n\n')
  }
}
