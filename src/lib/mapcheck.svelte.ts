// which rotation maps the autodownloader can serve. fails soft: an unreachable
// archive must never look like a broken config.

import { checkMaps, levelName, type MapHeld } from './maps'

export type MapStatus = 'unknown' | 'held' | 'absent'

/** debounce so pasting a rotation is one request */
const SETTLE = 400

class RotationCheck {
  /** keyed by lowercased level name */
  private answers = $state(new Map<string, MapHeld | null>())
  private timer: ReturnType<typeof setTimeout> | null = null
  private run = 0

  busy = $state(false)
  offline = $state(false)

  statusOf(written: string): MapStatus {
    const answer = this.answers.get(levelName(written).toLowerCase())
    if (answer === undefined) return 'unknown'
    return answer === null ? 'absent' : 'held'
  }

  heldAs(written: string): MapHeld | null {
    return this.answers.get(levelName(written).toLowerCase()) ?? null
  }

  absentAmong(names: string[]): string[] {
    return names.filter(name => this.statusOf(name) === 'absent')
  }

  schedule(names: string[]) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.check(names), SETTLE)
  }

  async check(names: string[]) {
    const wanted = names.filter(name => this.statusOf(name) === 'unknown')
    if (!wanted.length) return

    const run = ++this.run
    this.busy = true
    try {
      const answered = await checkMaps(wanted)
      // a newer check has started, so this answer is stale
      if (run !== this.run) return
      const next = new Map(this.answers)
      for (const [name, held] of answered) next.set(name.toLowerCase(), held)
      this.answers = next
      this.offline = false
    } catch {
      if (run === this.run) this.offline = true
    } finally {
      if (run === this.run) this.busy = false
    }
  }

  retry(names: string[]) {
    this.answers = new Map()
    this.offline = false
    this.check(names)
  }
}

export const rotationCheck = new RotationCheck()
