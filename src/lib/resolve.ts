// replays alpine's rule layering and records which layer set each value.
//
// from dedi_cfg.cpp, the base rules resolve as:
//
//   Alpine built-in default
//     -> game type defaults
//     -> mutators             (fixed apply order, before manual keys)
//     -> manual keys
//
// a map replays the base rules under its own game type, leaving out any base
// mutator it switches off, then applies its own mutators and keys on top.

import { gametypes, mutatorAllowsMode, mutators as mutatorSchema, mutatorEffects, rules as rulesSchema, server as serverSchema } from '../schema'
import type { ArrayKey, DefaultOp, Guard, Mutator, ScalarKey, SchemaKey, StockReserve } from '../schema/types'
import { railGunName, reserveAmmo } from './gamedata'

export type Layer =
  | 'default'      // Alpine's built-in value
  | 'gametype'     // game type defaults
  | 'mutator'
  | 'manual'       // set in this scope
  | 'inherited'    // resolved in the base scope, unchanged here

export interface Contribution {
  layer: Layer
  value: unknown
  /** mutator or game type name */
  source?: string
  /** explanation, where the value alone is not enough */
  description?: string
}

export interface Resolved {
  value: unknown
  layer: Layer
  source?: string
  /** oldest first; the last one won */
  trail: Contribution[]
}

export type ResolvedRules = Map<string, Resolved>

export interface MutatorDeclaration {
  name: string
  options?: Record<string, unknown>
  /** false switches off a mutator a broader scope declared */
  enabled?: false
}

export interface RulesScopeInput {
  /** game type declared in this scope, if any */
  gameType?: string
  mutators?: MutatorDeclaration[]
  /** keys written directly in this scope */
  manual?: Record<string, unknown>
}

export interface ScopeInput extends RulesScopeInput {
  /** the base scope and its resolved rules; omit for the base scope itself */
  base?: { scope: RulesScopeInput; resolved: ResolvedRules }
}

function contribute(into: ResolvedRules, path: string, c: Contribution) {
  const existing = into.get(path)
  const trail = existing ? [...existing.trail, c] : [c]
  into.set(path, { value: c.value, layer: c.layer, source: c.source, trail })
}

function collectDefaults(roots: SchemaKey[]): ResolvedRules {
  const out: ResolvedRules = new Map()
  const walk = (keys: SchemaKey[], prefix = '') => {
    for (const key of keys) {
      const path = prefix + key.key
      if (key.kind === 'scalar') {
        const scalar = key as ScalarKey
        if (scalar.default !== undefined) {
          out.set(path, { value: scalar.default, layer: 'default', trail: [{ layer: 'default', value: scalar.default }] })
        }
        continue
      }
      if ('keys' in key && key.keys) walk(key.keys, path + '.')
    }
  }
  walk(roots)
  return out
}

function copy(source: ResolvedRules): ResolvedRules {
  return new Map([...source].map(([k, v]) => [k, { ...v, trail: [...v.trail] }]))
}

let cachedRuleDefaults: ResolvedRules | null = null
export function defaults(): ResolvedRules {
  if (!cachedRuleDefaults) cachedRuleDefaults = collectDefaults(rulesSchema.keys)
  return copy(cachedRuleDefaults)
}

let cachedServerDefaults: ResolvedRules | null = null

// server settings have one scope and no mutators, but still need their defaults
export function resolveServer(manual: Record<string, unknown>): ResolvedRules {
  if (!cachedServerDefaults) {
    cachedServerDefaults = collectDefaults([
      ...serverSchema.keys,
      ...serverSchema.tables,
      ...serverSchema.arrays,
    ])
  }
  const out = copy(cachedServerDefaults)
  for (const [path, value] of Object.entries(manual)) {
    contribute(out, path, { layer: 'manual', value })
  }
  return out
}

// no layering, but the shared field renderer needs a resolved map with defaults
export function resolveEntry(root: SchemaKey, fields: Record<string, unknown>): ResolvedRules {
  const out = collectDefaults([root])
  for (const [key, value] of Object.entries(fields)) {
    contribute(out, `${root.key}.${key}`, { layer: 'manual', value })
  }
  return out
}

// ---------------------------------------------------------------------------
// merged lists. alpine folds some list entries into the existing list by one key
// field, so a layer can change one entry (e.g. one spawn loadout weapon) without
// restating the rest. which lists merge comes from the parser.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

const mergedLists = rulesSchema.keys
  .filter((key): key is ArrayKey => key.kind === 'array' && key.mergeKey !== undefined)

const SPAWN_KIT = 'spawn_loadout'

// read from the game type defaults so the alpine source stays the only authority
const stockSpawnReserve = gametypes.defaults.after
  .find(op => op.op === 'loadoutSpawnWeapon')?.ammoFrom

// the game matches names case-insensitively
function sameId(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return a === b
  return a.toLowerCase() === b.toLowerCase()
}

function listAt(path: string): ArrayKey | undefined {
  return mergedLists.find(list => list.key === path)
}

function rowsAt(into: ResolvedRules, path: string): Row[] {
  const value = into.get(path)?.value
  return Array.isArray(value) ? (value as Row[]) : []
}

function withRow(list: ArrayKey, rows: Row[], edit: Row): Row[] {
  const key = list.mergeKey!
  const at = rows.findIndex(row => sameId(row[key], edit[key]))
  const previous = at === -1 ? undefined : rows[at]

  const next: Row = {}
  for (const field of list.item ?? []) {
    // an omitted optional field keeps the previous value; otherwise it takes the parser default
    const value = edit[field.key] !== undefined ? edit[field.key]
      : field.optional && previous?.[field.key] !== undefined ? previous[field.key]
      : field.default !== undefined ? field.default
      : previous?.[field.key]
    if (value !== undefined) next[field.key] = value
  }

  return at === -1 ? [...rows, next] : rows.map((row, i) => (i === at ? next : row))
}

// skip no-op layers so the trail only lists real changes
function setRows(into: ResolvedRules, path: string, rows: Row[], c: Omit<Contribution, 'value'>) {
  if (JSON.stringify(rowsAt(into, path)) === JSON.stringify(rows)) return
  contribute(into, path, { ...c, value: rows })
}

/** null when the entry has no merge key */
function readRow(list: ArrayKey, entry: unknown): Row | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
  const row = entry as Row
  const id = row[list.mergeKey!]
  // unknown names are kept so they stay visible and fixable in the editor
  return typeof id === 'string' && id !== '' ? row : null
}

function clipsOf(into: ResolvedRules): number {
  const clips = into.get('spawn_weapon.clips')?.value
  return typeof clips === 'number' ? clips : 0
}

function spawnWeaponRow(into: ResolvedRules, from: StockReserve | undefined): Row | null {
  const name = into.get('spawn_weapon.weapon_name')?.value
  if (typeof name !== 'string' || !name || !from) return null
  return { weapon_name: name, ammo: reserveAmmo(from, name, clipsOf(into)), include: true }
}

// matches alpine's order: the spawn weapon is read before loadout entries, and
// changing it removes the previous spawn weapon from the loadout
function applyListKeys(
  into: ResolvedRules,
  values: Record<string, unknown>,
  previousWeapon: string,
  c: Omit<Contribution, 'value'>,
) {
  const kit = listAt(SPAWN_KIT)
  if (kit && ('spawn_weapon.weapon_name' in values || 'spawn_weapon.clips' in values)) {
    const row = spawnWeaponRow(into, stockSpawnReserve)
    if (row) {
      const rows = rowsAt(into, SPAWN_KIT)
      const kept = previousWeapon && !sameId(previousWeapon, row.weapon_name)
        ? rows.filter(existing => !sameId(existing.weapon_name, previousWeapon))
        : rows
      setRows(into, SPAWN_KIT, withRow(kit, kept, row), c)
    }
  }

  for (const list of mergedLists) {
    const entries = values[list.key]
    if (!Array.isArray(entries)) continue
    let rows = rowsAt(into, list.key)
    for (const entry of entries) {
      const edit = readRow(list, entry)
      if (edit) rows = withRow(list, rows, edit)
    }
    setRows(into, list.key, rows, c)
  }
}

function applyValues(
  into: ResolvedRules,
  values: Record<string, unknown>,
  c: Omit<Contribution, 'value'>,
) {
  const previousWeapon = (into.get('spawn_weapon.weapon_name')?.value as string) ?? ''
  for (const [path, value] of Object.entries(values)) {
    // game_type and merged lists are handled separately
    if (path === 'game_type' || listAt(path)) continue
    contribute(into, path, { ...c, value })
  }
  applyListKeys(into, values, previousWeapon, c)
}

// rows the parser seeds before reading each scope. alpine seeds the stock fusion
// weapon stay exemption this way, and since it runs per scope, a base change to
// that row does not reach maps that do not repeat it. this is upstream behavior.
function applySeeds(into: ResolvedRules) {
  for (const key of rulesSchema.keys) {
    if (key.kind !== 'array') continue
    const list = key as ArrayKey
    if (!list.seed || !list.mergeKey) continue

    let rows = rowsAt(into, list.key)
    for (const seed of list.seed) rows = withRow(list, rows, seed)
    setRows(into, list.key, rows, {
      layer: 'default',
      source: 'Alpine',
      description: 'Alpine resets this row on every map. Change it on each map to override it.',
    })
  }
}

function applyGameTypeDefaults(into: ResolvedRules, gameType: string) {
  const c = { layer: 'gametype' as const, source: gameType }

  const apply = (ops: DefaultOp[]) => {
    for (const op of ops) {
      if (op.op === 'set') {
        if (op.key) contribute(into, op.key, { ...c, value: op.value })
        continue
      }
      const kit = listAt(op.op !== 'loadoutSpawnWeapon' && op.blueTeam ? 'spawn_loadout_blue' : SPAWN_KIT)
      if (!kit) continue
      if (op.op === 'loadoutClear') {
        setRows(into, kit.key, [], c)
        continue
      }
      if (op.op === 'loadoutSpawnWeapon') {
        // do not overwrite a spawn weapon the per-type case already placed
        const row = spawnWeaponRow(into, op.ammoFrom)
        const rows = rowsAt(into, kit.key)
        if (row && !rows.some(existing => sameId(existing.weapon_name, row.weapon_name))) {
          setRows(into, kit.key, withRow(kit, rows, row), c)
        }
        continue
      }
      if (!op.weapon) continue
      const ammo = op.ammo ?? (op.ammoFrom ? reserveAmmo(op.ammoFrom, op.weapon, clipsOf(into)) : 0)
      setRows(into, kit.key, withRow(kit, rowsAt(into, kit.key), {
        weapon_name: op.weapon, ammo, include: op.enabled,
      }), c)
    }
  }

  apply(gametypes.defaults.common)
  // the fallback arm is where dm and ctf get their spawn weapon
  apply(gametypes.defaults.perType[gameType] ?? gametypes.defaults.fallback)
  apply(gametypes.defaults.after)
}

function applyMutator(into: ResolvedRules, decl: MutatorDeclaration, inherited: boolean, gameType: string) {
  const mutator = mutatorSchema.mutators.find(m => m.name === decl.name)
  if (!mutator) return
  // the server skips a mutator its game type cannot run
  if (!mutatorAllowsMode(mutator, gameType)) return
  const effect = mutatorEffects[decl.name]
  if (!effect) return
  const layer: Layer = inherited ? 'inherited' : 'mutator'

  for (const set of effect.sets ?? []) {
    if (set.modes && !set.modes.includes(gameType)) continue
    // mutator lists replace rather than merge
    const list = listAt(set.key)
    if (list && Array.isArray(set.value)) {
      setRows(into, set.key, mutatorRows(list, set.value), { layer, source: mutator.label })
      continue
    }
    const schema = findScalar(set.key)
    const current = into.get(set.key)?.value
    const option = set.fromOption === undefined
      ? set.value
      : optionValue(mutator, decl, set.fromOption, set.transform ? roundsToWin(current) : current)
    const value = set.transform && typeof option === 'number' ? winsToRounds(option) : option
    // a mistyped value is prose describing an effect we cannot compute
    const usable = schema ? valueMatchesType(value, schema.type) : false
    contribute(into, set.key, usable
      ? { layer, value, source: mutator.label }
      : {
          layer,
          value: into.get(set.key)?.value,
          source: mutator.label,
          description: typeof value === 'string' ? value : set.note,
        })
  }
}

// loadout entries with no ammo get the weapon's stock reserve, as in the source
function mutatorRows(list: ArrayKey, entries: unknown[]): Row[] {
  let rows: Row[] = []
  for (const entry of entries) {
    const edit = readRow(list, entry)
    if (!edit) continue
    if (list.key === SPAWN_KIT && edit.ammo === undefined && stockSpawnReserve) {
      edit.ammo = reserveAmmo({ field: stockSpawnReserve.field }, String(edit.weapon_name), 1)
    }
    rows = withRow(list, rows, edit)
  }
  return rows
}

// a best-of-n match: round wins from the round count, and back as the server sets it
export function roundsToWin(rounds: unknown): unknown {
  return typeof rounds === 'number' ? Math.floor(rounds / 2) + 1 : rounds
}

function winsToRounds(wins: number): number {
  return Math.min(Math.max(Math.trunc(wins), 1), 500) * 2 - 1
}

// `currentValue` options default to the setting's already-resolved value, as the server does
export function optionValue(
  mutator: Mutator,
  decl: MutatorDeclaration,
  name: string,
  currentValue?: unknown,
): unknown {
  const declared = decl.options?.[name]
  if (declared !== undefined) return declared
  const option = mutator.options.find(o => o.name === name)
  if (!option) return undefined
  if (option.defaultFrom === 'currentValue') return currentValue
  if (option.defaultFrom === 'railGun') return railGunName
  return option.default
}

function valueMatchesType(value: unknown, type: ScalarKey['type']): boolean {
  if (type === 'bool') return typeof value === 'boolean'
  if (type === 'int' || type === 'float') return typeof value === 'number'
  return typeof value === 'string'
}

function findScalar(path: string): ScalarKey | undefined {
  let keys: SchemaKey[] | undefined = rulesSchema.keys
  const parts = path.split('.')
  for (let i = 0; i < parts.length; i++) {
    const found: SchemaKey | undefined = keys?.find(k => k.key === parts[i])
    if (!found) return undefined
    if (i === parts.length - 1) return found.kind === 'scalar' ? (found as ScalarKey) : undefined
    keys = 'keys' in found ? found.keys : undefined
  }
  return undefined
}

// alpine applies mutators in a fixed order, not declaration order
function orderMutators(declared: MutatorDeclaration[]): MutatorDeclaration[] {
  const rank = new Map(mutatorSchema.applyOrder.map((id, i) => [id, i]))
  return [...declared].sort((a, b) => {
    const ra = rank.get(mutatorSchema.mutators.find(m => m.name === a.name)?.id ?? -1) ?? Infinity
    const rb = rank.get(mutatorSchema.mutators.find(m => m.name === b.name)?.id ?? -1) ?? Infinity
    return ra - rb
  })
}

// one mutators array as the server reads it: a later entry for the same mutator
// replaces an earlier one, and enabled = false removes it
export function activeMutators(declared: MutatorDeclaration[]): MutatorDeclaration[] {
  const active = new Map<string, MutatorDeclaration>()
  for (const decl of declared) {
    active.delete(decl.name)
    if (decl.enabled !== false) active.set(decl.name, decl)
  }
  return [...active.values()]
}

/** base mutators a map switches off */
export function disabledMutators(declared: MutatorDeclaration[]): string[] {
  return declared.filter(d => d.enabled === false).map(d => d.name)
}

function resolveBase(scope: RulesScopeInput, gameType: string, skip: string[], inherited: boolean): ResolvedRules {
  const out = defaults()
  if (scope.gameType) {
    contribute(out, 'game_type', inherited
      ? { layer: 'inherited', value: scope.gameType, source: 'base rules' }
      : { layer: 'manual', value: scope.gameType })
  } else {
    contribute(out, 'game_type', { layer: 'default', value: gametypes.gametypes[0].name, source: 'Alpine default' })
  }
  applyGameTypeDefaults(out, gameType)

  // the server leaves a skipped mutator's entries out entirely, enabled or not
  const kept = (scope.mutators ?? []).filter(d => !skip.includes(d.name))
  for (const decl of orderMutators(activeMutators(kept))) applyMutator(out, decl, inherited, gameType)
  applySeeds(out)
  applyValues(out, scope.manual ?? {}, inherited ? { layer: 'inherited', source: 'base rules' } : { layer: 'manual' })
  return out
}

export function resolveScope(input: ScopeInput): ResolvedRules {
  if (!input.base) return resolveBase(input, input.gameType ?? gametypes.gametypes[0].name, [], false)

  const base = input.base
  const baseGameType = base.resolved.get('game_type')?.value as string
  const gameType = input.gameType ?? baseGameType
  const modeChanged = gameType !== baseGameType
  const baseActive = activeMutators(base.scope.mutators ?? []).map(d => d.name)
  const skip = disabledMutators(input.mutators ?? [])

  let out: ResolvedRules
  if (modeChanged || skip.some(name => baseActive.includes(name))) {
    // the base rules replayed under this map's game type and without its switched-off mutators
    out = resolveBase(base.scope, gameType, skip, true)
    // the same game type's defaults are the base rules', not this map's, and
    // anything that differs from the base rules does so because of this map
    if (!modeChanged) {
      const names = skip.filter(name => baseActive.includes(name))
        .map(name => mutatorSchema.mutators.find(m => m.name === name)?.label ?? name)
      for (const [path, resolved] of out) {
        if (resolved.layer === 'gametype' || resolved.layer === 'default') out.set(path, { ...resolved, layer: 'inherited' })
        if (JSON.stringify(resolved.value) !== JSON.stringify(base.resolved.get(path)?.value)) {
          // a mutator change rather than a key the map sets, so there is nothing to reset
          contribute(out, path, {
            layer: 'mutator',
            value: resolved.value,
            description: `This map turns off ${names.join(', ')}.`,
          })
        }
      }
    }
  } else {
    out = new Map()
    for (const [path, resolved] of base.resolved) {
      out.set(path, { ...resolved, layer: 'inherited', trail: [...resolved.trail] })
    }
  }

  if (input.gameType) {
    contribute(out, 'game_type', {
      layer: 'manual',
      value: input.gameType,
      description: modeChanged
        ? "This map changes the game type. Its rules start from this game type's defaults, "
          + 'with the base rules applied on top.'
        : undefined,
    })
  }

  for (const decl of orderMutators(activeMutators(input.mutators ?? []))) applyMutator(out, decl, false, gameType)
  applySeeds(out)
  applyValues(out, input.manual ?? {}, { layer: 'manual' })
  return out
}

// what runs on a map: the base's mutators less any the map switches off or
// redeclares, then the map's own
export function effectiveMutators(
  base: MutatorDeclaration[],
  level: MutatorDeclaration[],
): MutatorDeclaration[] {
  const skip = disabledMutators(level)
  const own = activeMutators(level)
  const inherited = activeMutators(base.filter(b => !skip.includes(b.name)))
    .filter(b => !own.some(l => l.name === b.name))
  return [...inherited, ...own]
}

export interface RowOrigin {
  /** layer that last changed the row */
  by?: Contribution
  /** layer that first added the row */
  first?: Contribution
}

export function rowSources(resolved: Resolved | undefined, mergeKey?: string): RowOrigin[] {
  const rows = Array.isArray(resolved?.value) ? (resolved.value as unknown[]) : []
  const lists = (resolved?.trail ?? [])
    .filter(c => Array.isArray(c.value))
    .map(c => ({ c, rows: c.value as Record<string, unknown>[] }))

  const idOf = (row: unknown) =>
    mergeKey ? String((row as Record<string, unknown>)?.[mergeKey]) : JSON.stringify(row)

  return rows.map(row => {
    const id = idOf(row)
    const origin: RowOrigin = {}
    let previous: string | undefined
    for (const list of lists) {
      const found = list.rows.find(r => idOf(r) === id)
      // the row was dropped here, so whoever re-adds it owns it
      if (!found) { previous = undefined; origin.first = undefined; continue }
      const now = JSON.stringify(found)
      if (!origin.first) origin.first = list.c
      if (now !== previous) origin.by = list.c
      previous = now
    }
    return origin
  })
}

function siblingPath(full: string, key: string): string {
  const parts = full.split('.')
  parts[parts.length - 1] = key
  return parts.join('.')
}

/** the guard that stops the server from reading this setting, if any */
export function unsatisfiedGuard(
  key: SchemaKey | undefined,
  path: string,
  resolved: ResolvedRules,
): Guard | undefined {
  return (key?.requires ?? []).find(
    g => g.key !== undefined && resolved.get(siblingPath(path, g.key))?.value !== (g.equals ?? true)
  )
}
