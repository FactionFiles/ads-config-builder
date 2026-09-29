// the edited document holds only what the user set, which is exactly what gets
// written. everything else is derived by the resolver.

import { parse, stringify } from 'smol-toml'
import { meta, rconCommandAliases, rulesIndex, server as serverSchema, serverIndex } from '../schema'
import type { ArrayKey, SchemaKey } from '../schema/types'
import type { MutatorDeclaration } from './resolve'

/** flat dotted path -> value, e.g. { "overtime.enabled": true } */
export type ManualKeys = Record<string, unknown>

export interface RulesScope {
  mutators: MutatorDeclaration[]
  manual: ManualKeys
  /** rules with no editor here, kept verbatim */
  unknown: ManualKeys
}

export interface LevelEntry {
  filename: string
  rules: RulesScope
  /** keys inside this [[levels]] entry that are not filename or rules */
  unknown: ManualKeys
}

/** fields are keyed by schema key so the page can render them from the schema */
export interface RconProfile {
  fields: ManualKeys
  /** unrecognized keys, kept verbatim */
  unknown: ManualKeys
}

export interface ConfigDocument {
  server: ManualKeys
  base: RulesScope
  levels: LevelEntry[]
  rconProfiles: RconProfile[]
  /** unrecognized keys, kept verbatim so newer configs survive a round trip */
  unknown: ManualKeys
}

export function emptyScope(): RulesScope {
  return { mutators: [], manual: {}, unknown: {} }
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

// accepts numbered lists, spreadsheet columns, or config lines; strips anything
// that is not the filename
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

// needed for rows the parser reseeds per scope, which the game rules alone cannot hold
export function withRowOnEveryLevel(
  levels: LevelEntry[],
  path: string,
  mergeKey: string,
  row: Record<string, unknown>,
): LevelEntry[] {
  return levels.map(level => {
    const held = level.rules.manual[path]
    const rows = Array.isArray(held) ? (held as Record<string, unknown>[]) : []
    const at = rows.findIndex(r => r[mergeKey] === row[mergeKey])
    const next = at === -1 ? [...rows, row] : rows.map((r, i) => (i === at ? row : r))
    return { ...level, rules: { ...level.rules, manual: { ...level.rules.manual, [path]: next } } }
  })
}

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

  // nested together so a table with both edited and unknown keys stays whole
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
// import. keys with no editor are kept verbatim and written back out.
// ---------------------------------------------------------------------------

export interface ImportReport {
  doc: ConfigDocument
  /** known settings with no editor yet */
  kept: string[]
  unrecognized: string[]
  /** keys alpine has removed. dropped rather than kept, since the server ignores them */
  removed: string[]
  fromVersion: number | null
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && !Array.isArray(value) && !(value instanceof Date)
}

// only tables the schema knows are walked into, so unmodeled structures stay whole
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

function isEditableList(schema: SchemaKey | undefined): boolean {
  return schema?.kind === 'array' && !schema.complex
    && ((schema.item?.length ?? 0) > 0 || schema.itemType !== undefined)
}

function split(entries: [string, unknown][], index: Map<string, SchemaKey>): Split {
  const out: Split = { manual: {}, unknown: {}, kept: [], unrecognized: [] }
  for (const [path, value] of entries) {
    const schema = index.get(path)
    if (schema?.kind === 'scalar' || isEditableList(schema)) {
      out.manual[path] = value
      continue
    }
    out.unknown[path] = value
    if (schema) out.kept.push(path)
    else out.unrecognized.push(path)
  }
  return out
}

function readMutators(value: unknown): MutatorDeclaration[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (!isTable(entry) || typeof entry.name !== 'string') return []
    const { name, ...options } = entry
    return [Object.keys(options).length ? { name, options } : { name }]
  })
}

function scopeFromToml(table: Record<string, unknown>, report: ImportReport, where: string): RulesScope {
  // alpine 1.4 still accepts rules_presets so old configs load, but ignores it
  const { rules_presets, rules, ...direct } = table
  if (rules_presets !== undefined) report.removed.push(where)

  // alpine reads keys set directly on the scope before [rules], so [rules] wins
  const inner = isTable(rules) ? rules : {}
  const { mutators, ...innerRules } = inner
  const merged = { ...direct, ...innerRules }

  const parts = split(flatten(merged, rulesIndex), rulesIndex)
  report.kept.push(...parts.kept)
  report.unrecognized.push(...parts.unrecognized)

  return {
    mutators: readMutators(mutators),
    manual: parts.manual,
    unknown: parts.unknown,
  }
}

function levelFromToml(table: Record<string, unknown>, report: ImportReport): LevelEntry {
  const { filename, rules_presets, rules, ...rest } = table
  const level = emptyLevel(typeof filename === 'string' ? filename : '')
  level.rules = scopeFromToml({ rules_presets, rules }, report, 'levels.rules_presets')
  level.unknown = rest
  for (const key of Object.keys(rest)) report.unrecognized.push(`levels.${key}`)
  return level
}

const rconKeys = serverSchema.arrays.find(a => a.key === 'rcon_profiles')?.keys ?? []
const rconFields = new Set(rconKeys.map(k => k.key))
const rconCommands = (rconKeys.find(k => k.key === 'allowed_commands') as ArrayKey | undefined)?.choices ?? []

// an alias is granted and revoked with its command, in the master list's order
export function withCommandAliases(commands: string[]): string[] {
  const have = new Set(commands.map(c => c.toLowerCase()))
  for (const [alias, target] of Object.entries(rconCommandAliases)) {
    if (have.has(alias) || have.has(target)) { have.add(alias); have.add(target) }
  }
  return [...rconCommands.filter(c => have.has(c)), ...[...have].filter(c => !rconCommands.includes(c))]
}

function rconProfileFromToml(table: Record<string, unknown>, report: ImportReport): RconProfile {
  const profile = emptyRconProfile()
  for (const [key, value] of Object.entries(table)) {
    if (key === 'allowed_commands' && Array.isArray(value)) {
      profile.fields[key] = withCommandAliases(value.filter((c): c is string => typeof c === 'string'))
    } else if (rconFields.has(key)) profile.fields[key] = value
    else {
      profile.unknown[key] = value
      report.unrecognized.push(`rcon_profiles.${key}`)
    }
  }
  return profile
}

export function fromToml(text: string): ImportReport {
  const root = parse(text) as Record<string, unknown>
  const { ads_version, base, levels, rcon_profiles, rules_preset_aliases, ...server } = root

  const report: ImportReport = {
    doc: emptyDocument(),
    kept: [],
    unrecognized: [],
    removed: [],
    fromVersion: typeof ads_version === 'number' ? ads_version : null,
  }

  const parts = split(flatten(server, serverIndex), serverIndex)
  report.kept.push(...parts.kept)
  report.unrecognized.push(...parts.unrecognized)
  report.doc.server = parts.manual
  report.doc.unknown = parts.unknown

  if (rules_preset_aliases !== undefined) report.removed.push('rules_preset_aliases')

  if (Array.isArray(rcon_profiles)) {
    report.doc.rconProfiles = rcon_profiles.filter(isTable).map(p => rconProfileFromToml(p, report))
  }

  if (isTable(base)) report.doc.base = scopeFromToml(base, report, 'base.rules_presets')
  if (Array.isArray(levels)) {
    report.doc.levels = levels.filter(isTable).map(level => levelFromToml(level, report))
  }

  return report
}

// ---------------------------------------------------------------------------
// the launch command. the config name and port are launcher arguments rather
// than config keys, so the only place they live in the file is this comment.
// ---------------------------------------------------------------------------

export const defaultPort = 7755
export const configNameMax = 32

export function sanitizeConfigName(raw: string): string {
  return raw
    .replace(/\.toml$/i, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, configNameMax)
    .replace(/^-+|-+$/g, '')
}

export function launchComment(configName: string, port: number): string {
  const file = `${configName}.toml`
  const arg = /\s/.test(file) ? `"${file}"` : file
  return `# Launch using command: AlpineFactionLauncher.exe -ads ${arg} -port ${port}\n`
}

// only reads the comment this tool writes, so a hand-edited header falls back to the default
export function portFromLaunchComment(text: string): number | null {
  const found = text.match(/^#\s*Launch using command:.*\s-port\s+(\d+)/m)
  const port = found ? Number(found[1]) : NaN
  return port >= 1 && port <= 65535 ? port : null
}
