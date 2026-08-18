// The document the user is editing. It holds only what they actually set, which
// is exactly what gets written to the file - everything else is derived by the
// resolver. That is what keeps the export free of surprises, and what lets a
// setting say honestly that nobody has touched it.

import { stringify } from 'smol-toml'
import { meta } from '../schema'
import type { MutatorDeclaration } from './resolve'

/** flat dotted path -> value, e.g. { "overtime.enabled": true } */
export type ManualKeys = Record<string, unknown>

export interface RulesScope {
  /** preset file names, applied in order */
  presets: string[]
  mutators: MutatorDeclaration[]
  manual: ManualKeys
}

export interface LevelEntry {
  filename: string
  rules: RulesScope
}

export interface ConfigDocument {
  server: ManualKeys
  base: RulesScope
  levels: LevelEntry[]
  /**
   * Keys we did not recognize when the file was opened, kept verbatim so a
   * config written by a newer Alpine survives a round trip through this tool
   * instead of being quietly eaten.
   */
  unknown: Record<string, unknown>
}

export function emptyScope(): RulesScope {
  return { presets: [], mutators: [], manual: {} }
}

export function emptyDocument(): ConfigDocument {
  return { server: {}, base: emptyScope(), levels: [], unknown: {} }
}

export function emptyLevel(filename: string): LevelEntry {
  return { filename, rules: emptyScope() }
}

/**
 * A pasted rotation turned into level entries. People paste all sorts of things
 * - a numbered list, a column out of a spreadsheet, the lines of somebody else's
 * config - so anything that is not the file name is stripped rather than
 * rejected.
 */
export function parseLevelList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map(line => line.trim()
      .replace(/^[-*\d.)\s]+/, '')
      .replace(/^["']|["'],?$/g, '')
      .replace(/^filename\s*=\s*/, '')
      .replace(/^["']|["']$/g, '')
      .trim())
    .filter(name => name.length > 0)
    .map(name => (name.includes('.') ? name : name + '.rfl'))
}

/** turn flat dotted paths back into the nested tables TOML wants */
function nest(flat: ManualKeys): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    if (value === undefined) continue
    const parts = path.split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = node[parts[i]]
      if (typeof existing !== 'object' || existing === null) node[parts[i]] = {}
      node = node[parts[i]] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

function scopeToToml(scope: RulesScope): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (scope.presets.length) out.rules_presets = scope.presets

  const rules = nest(scope.manual)
  if (scope.mutators.length) {
    rules.mutators = scope.mutators.map(m => ({ name: m.name, ...(m.options ?? {}) }))
  }
  if (Object.keys(rules).length) out.rules = rules
  return out
}

export function toToml(doc: ConfigDocument): string {
  const root: Record<string, unknown> = {
    ads_version: meta.adsVersion,
    ...nest(doc.server),
    ...doc.unknown,
  }

  const base = scopeToToml(doc.base)
  if (Object.keys(base).length) root.base = base

  if (doc.levels.length) {
    root.levels = doc.levels.map(level => ({
      filename: level.filename,
      ...scopeToToml(level.rules),
    }))
  }

  return stringify(root) + '\n'
}

