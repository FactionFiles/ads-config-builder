// The document the user is editing. It holds only what they actually set, which
// is exactly what gets written to the file - everything else is derived by the
// resolver. That is what keeps the export free of surprises, and what lets a
// setting say honestly that nobody has touched it.

import { parse, stringify } from 'smol-toml'
import { meta, rulesIndex, server as serverSchema, serverIndex } from '../schema'
import type { SchemaKey } from '../schema/types'
import type { MutatorDeclaration } from './resolve'

/** flat dotted path -> value, e.g. { "overtime.enabled": true } */
export type ManualKeys = Record<string, unknown>

export interface RulesScope {
  /** preset file names, applied in order */
  presets: string[]
  mutators: MutatorDeclaration[]
  manual: ManualKeys
  /**
   * Rules this scope sets that the tool has no field for - a setting it knows
   * but cannot yet edit, or one a newer Alpine added. Kept verbatim and written
   * back out, so opening a config here never costs you anything.
   */
  unknown: ManualKeys
}

export interface LevelEntry {
  filename: string
  rules: RulesScope
  /** keys inside this [[levels]] entry that are not filename or rules */
  unknown: ManualKeys
}

/**
 * One admin profile. The fields are keyed by their schema key rather than named
 * here, so the page renders them from the schema like every other setting and
 * the key names live in exactly one place.
 */
export interface RconProfile {
  fields: ManualKeys
  /** anything else in this profile entry, kept verbatim */
  unknown: ManualKeys
}

export interface ConfigDocument {
  server: ManualKeys
  base: RulesScope
  levels: LevelEntry[]
  rconProfiles: RconProfile[]
  /**
   * Keys we did not recognize when the file was opened, kept verbatim so a
   * config written by a newer Alpine survives a round trip through this tool
   * instead of being quietly eaten.
   */
  unknown: ManualKeys
}

export function emptyScope(): RulesScope {
  return { presets: [], mutators: [], manual: {}, unknown: {} }
}

export function emptyDocument(): ConfigDocument {
  return { server: {}, base: emptyScope(), levels: [], rconProfiles: [], unknown: {} }
}

export function emptyRconProfile(): RconProfile {
  return { fields: {}, unknown: {} }
}

export function emptyLevel(filename: string): LevelEntry {
  return { filename, rules: emptyScope(), unknown: {} }
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

  // nested in one pass so a table holding both an edited key and an untouched
  // one comes back out whole rather than one half replacing the other
  const rules = nest({ ...scope.manual, ...scope.unknown })
  if (scope.mutators.length) {
    rules.mutators = scope.mutators.map(m => ({ name: m.name, ...(m.options ?? {}) }))
  }
  if (Object.keys(rules).length) out.rules = rules
  return out
}

export function toToml(doc: ConfigDocument): string {
  const root: Record<string, unknown> = {
    ads_version: meta.adsVersion,
    ...nest({ ...doc.server, ...doc.unknown }),
  }

  const base = scopeToToml(doc.base)
  if (Object.keys(base).length) root.base = base

  if (doc.rconProfiles.length) {
    root.rcon_profiles = doc.rconProfiles.map(p => ({ ...p.fields, ...p.unknown }))
  }

  if (doc.levels.length) {
    root.levels = doc.levels.map(level => ({
      filename: level.filename,
      ...level.unknown,
      ...scopeToToml(level.rules),
    }))
  }

  return stringify(root) + '\n'
}

// ---------------------------------------------------------------------------
// Opening a config somebody else wrote. The rule throughout is that nothing is
// thrown away: a key this tool has no field for is kept exactly as it was and
// written back out, so a config from a newer Alpine survives the round trip.
// ---------------------------------------------------------------------------

export interface ImportReport {
  doc: ConfigDocument
  /** settings Alpine has but this tool cannot edit yet, kept as they were */
  kept: string[]
  /** keys this tool does not recognize at all, also kept */
  unrecognized: string[]
  /** the ads_version the file declared, when it declared one */
  fromVersion: number | null
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * Every leaf in a table as a dotted path. A table the schema knows is walked
 * into; anything else stays whole, which is what preserves a structure we have
 * no model for.
 */
function flatten(
  table: Record<string, unknown>,
  index: Map<string, SchemaKey>,
  prefix = '',
): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [key, value] of Object.entries(table)) {
    const path = prefix + key
    const schema = index.get(path)
    if (isTable(value) && schema?.kind === 'table' && !schema.complex) {
      out.push(...flatten(value, index, path + '.'))
      continue
    }
    out.push([path, value])
  }
  return out
}

interface Split {
  manual: ManualKeys
  unknown: ManualKeys
  kept: string[]
  unrecognized: string[]
}

function split(entries: [string, unknown][], index: Map<string, SchemaKey>): Split {
  const out: Split = { manual: {}, unknown: {}, kept: [], unrecognized: [] }
  for (const [path, value] of entries) {
    const schema = index.get(path)
    if (schema?.kind === 'scalar') {
      out.manual[path] = value
      continue
    }
    out.unknown[path] = value
    if (schema) out.kept.push(path)
    else out.unrecognized.push(path)
  }
  return out
}

function readPresets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

function readMutators(value: unknown): MutatorDeclaration[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (!isTable(entry) || typeof entry.name !== 'string') return []
    const { name, ...options } = entry
    return [Object.keys(options).length ? { name, options } : { name }]
  })
}

function scopeFromToml(table: Record<string, unknown>, report: ImportReport): RulesScope {
  const { rules_presets, rules, ...direct } = table

  // Alpine reads rule keys written straight into the scope before it reads the
  // [rules] table, so both are the same layer with [rules] winning
  const inner = isTable(rules) ? rules : {}
  const { mutators, ...innerRules } = inner
  const merged = { ...direct, ...innerRules }

  const parts = split(flatten(merged, rulesIndex), rulesIndex)
  report.kept.push(...parts.kept)
  report.unrecognized.push(...parts.unrecognized)

  return {
    presets: readPresets(rules_presets),
    mutators: readMutators(mutators),
    manual: parts.manual,
    unknown: parts.unknown,
  }
}

function levelFromToml(table: Record<string, unknown>, report: ImportReport): LevelEntry {
  const { filename, rules_presets, rules, ...rest } = table
  const level = emptyLevel(typeof filename === 'string' ? filename : '')
  level.rules = scopeFromToml({ rules_presets, rules }, report)
  level.unknown = rest
  for (const key of Object.keys(rest)) report.unrecognized.push(`levels.${key}`)
  return level
}

const rconFields = new Set(
  (serverSchema.arrays.find(a => a.key === 'rcon_profiles')?.keys ?? []).map(k => k.key)
)

function rconProfileFromToml(table: Record<string, unknown>, report: ImportReport): RconProfile {
  const profile = emptyRconProfile()
  for (const [key, value] of Object.entries(table)) {
    if (rconFields.has(key)) profile.fields[key] = value
    else {
      profile.unknown[key] = value
      report.unrecognized.push(`rcon_profiles.${key}`)
    }
  }
  return profile
}

export function fromToml(text: string): ImportReport {
  const root = parse(text) as Record<string, unknown>
  const { ads_version, base, levels, rcon_profiles, ...server } = root

  const report: ImportReport = {
    doc: emptyDocument(),
    kept: [],
    unrecognized: [],
    fromVersion: typeof ads_version === 'number' ? ads_version : null,
  }

  const parts = split(flatten(server, serverIndex), serverIndex)
  report.kept.push(...parts.kept)
  report.unrecognized.push(...parts.unrecognized)
  report.doc.server = parts.manual
  report.doc.unknown = parts.unknown

  if (Array.isArray(rcon_profiles)) {
    report.doc.rconProfiles = rcon_profiles.filter(isTable).map(p => rconProfileFromToml(p, report))
  }

  if (isTable(base)) report.doc.base = scopeFromToml(base, report)
  if (Array.isArray(levels)) {
    report.doc.levels = levels.filter(isTable).map(level => levelFromToml(level, report))
  }

  return report
}
