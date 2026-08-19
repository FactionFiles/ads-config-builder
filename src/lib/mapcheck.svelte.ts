/**
 * Which maps in the rotation the autodownloader will actually serve.
 *
 * A rotation entry FactionFiles does not carry is not a typo the server will
 * shrug off: every player who joins on that map fails to download it. That is
 * worth saying while the config is still being written, so the answer is kept
 * here for the rotation sheet to mark and for the problems page to read.
 *
 * It fails quiet. Not knowing is the state the tool was in before any of this,
 * and an unreachable archive must never look like a broken config.
 */

import { checkMaps, levelName, type MapHeld } from './maps'

export type MapStatus = 'unknown' | 'held' | 'absent'

/** long enough that pasting a rotation is one check rather than one per line */
const SETTLE = 400

class RotationCheck {
  /** level name, lowercased, to what the archive said about it */
  private answers = $state(new Map<string, MapHeld | null>())
  private timer: ReturnType<typeof setTimeout> | null = null
  private run = 0

  busy = $state(false)
  /** the archive could not be reached. a fact about us, not about the config */
  offline = $state(false)

  statusOf(written: string): MapStatus {
    const answer = this.answers.get(levelName(written).toLowerCase())
    if (answer === undefined) return 'unknown'
    return answer === null ? 'absent' : 'held'
  }

  heldAs(written: string): MapHeld | null {
    return this.answers.get(levelName(written).toLowerCase()) ?? null
  }

  /** the names in this rotation the archive does not carry, in the order given */
  absentAmong(names: string[]): string[] {
    return names.filter(name => this.statusOf(name) === 'absent')
  }

  /** check after the rotation stops changing, and only ever ask about new names */
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
      // a later check having already landed means this answer is the stale one
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

  /** ask again about everything, including names already answered for */
  retry(names: string[]) {
    this.answers = new Map()
    this.offline = false
    this.check(names)
  }
}

export const rotationCheck = new RotationCheck()
