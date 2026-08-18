// One place that turns a stored value into the words a person reads. The
// rotation sheet and a setting's own field render the same value in different
// shapes, and if they each did their own conversion they would eventually
// disagree about what the config says.

import { choiceLabelsFor, schemaFor, textFor, type Scope } from '../schema'
import type { AuthoredEntry, ScalarKey } from '../schema/types'
import { tableFor } from './gamedata'

/** the file stores seconds where the user thinks in minutes, and so on */
export function toDisplay(text: AuthoredEntry, value: unknown): unknown {
  if (typeof value !== 'number') return value
  if (text.display === 'minutes' && text.unit === 'seconds') return value / 60
  return value
}

export function toFile(text: AuthoredEntry, value: number): number {
  if (text.display === 'minutes' && text.unit === 'seconds') return value * 60
  return value
}

/** the unit next to the number, in whatever unit is being shown */
export function unitFor(text: AuthoredEntry): string | undefined {
  return text.display ?? text.unit
}

function scalarFor(scope: Scope, path: string): ScalarKey | undefined {
  const schema = schemaFor(scope, path)
  return schema?.kind === 'scalar' ? (schema as ScalarKey) : undefined
}

function tidy(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** what a choice or a game data name is called, falling back to the raw token */
export function labelForChoice(scope: Scope, path: string, value: string): string {
  const fromAuthored = choiceLabelsFor(scope, path)?.[value]
  if (fromAuthored) return fromAuthored
  const lookup = scalarFor(scope, path)?.lookup
  if (lookup) {
    const found = tableFor(lookup).find(e => e.name === value)
    if (found) return found.display
  }
  return value
}

/** a setting's value as one short phrase, for a table cell or a summary line */
export function formatValue(scope: Scope, path: string, value: unknown): string {
  if (value === undefined || value === null) return 'not set'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'string') return value === '' ? 'not set' : labelForChoice(scope, path, value)
  if (typeof value === 'number') {
    const text = textFor(scope, path)
    const shown = tidy(toDisplay(text, value) as number)
    const unit = unitFor(text)
    return unit ? `${shown} ${unit}` : shown
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none'
  return String(value)
}
