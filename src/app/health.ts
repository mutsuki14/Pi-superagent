/** A board of named health entries, each claimed once by the component that reports it. */
export interface HealthState { state: 'ready' | 'error' | 'waiting'; detail: string; at: string }
export interface HealthEntry { name: string; get(): HealthState | undefined; set(value: HealthState): void }

export class HealthBoard {
  private readonly entries = new Map<string, HealthState>()
  private readonly claimed = new Set<string>()
  claim(name: string): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`Health entry ${name} is already claimed`)
    this.claimed.add(name)
    return { name, get: () => this.entries.get(name), set: value => { this.entries.set(name, value) } }
  }
  /** Every entry, by name. */
  snapshot(): Record<string, HealthState> { return Object.fromEntries(this.entries) }
  /** The entries in `error` state. */
  problems(): { name: string; state: HealthState }[] {
    return [...this.entries].filter(([, state]) => state.state === 'error').map(([name, state]) => ({ name, state }))
  }
}
