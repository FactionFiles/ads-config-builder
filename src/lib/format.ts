// the single place stored values become display text, so every view agrees

import { choiceLabelsFor, schemaFor, textFor, type Scope } from '../schema'
import type { AuthoredEntry, ScalarKey } from '../schema/types'
import { tableFor } from './gamedata'

type Measured = Pick<AuthoredEntry, 'unit' | 'display'>

export function toDisplay(text: Measured, value: unknown): unknown {
  if (typeof value !== 'number') return value
  if (text.display === 'minutes' && text.unit === 'seconds') return value / 60
  if (text.display === 'seconds' && text.unit === 'milliseconds') return value / 1000
  return value
}

export function toFile(text: Measured, value: number): number {
  if (text.display === 'minutes' && text.unit === 'seconds') return value * 60
  if (text.display === 'seconds' && text.unit === 'milliseconds') return value * 1000
  return value
}

export function unitFor(text: Measured): string | undefined {
  return text.display ?? text.unit
}

function scalarFor(scope: Scope, path: string): ScalarKey | undefined {
  const schema = schemaFor(scope, path)
  return schema?.kind === 'scalar' ? (schema as ScalarKey) : undefined
}

function tidy(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** falls back to the raw token */
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

// records show their merge key, or just a count when they have none
function listOf(scope: Scope, path: string, value: unknown[]): string {
  if (value.every(entry => typeof entry !== 'object' || entry === null)) return value.join(', ')
  const schema = schemaFor(scope, path)
  const list = schema?.kind === 'array' ? schema : undefined
  const key = list?.mergeKey
  if (!key) return value.length === 1 ? '1 entry' : `${value.length} entries`
  const column = list?.item?.find(f => f.key === key)
  return value
    .map(entry => String((entry as Record<string, unknown>)[key] ?? ''))
    .map(name => (column?.lookup ? tableFor(column.lookup).find(e => e.name === name)?.display ?? name : name))
    .join(', ')
}

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
  if (Array.isArray(value)) return value.length ? listOf(scope, path, value) : 'none'
  return String(value)
}
