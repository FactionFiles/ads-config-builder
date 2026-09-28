// replays alpine's rule layering and records which layer set each value.
//
// from dedi_cfg.cpp, one scope resolves as:
//
//   Alpine built-in default
//     -> game type defaults   (only when the game type changed, or was never applied)
//     -> mutators             (fixed apply order, before manual keys)
//     -> manual keys in this scope
//
// applied once for [base], then per [[levels]] entry starting from the resolved
// base rules.
//
// exception: a level that changes the game type restarts from built-in defaults
// plus [base]'s manual keys, and the new game type's defaults land on top.

import { gametypes, mutators as mutatorSchema, mutatorEffects, rules as rulesSchema, server as serverSchema } from '../schema'
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
}

export interface ScopeInput {
  /** resolved base rules; omit for the base scope itself */
  base?: ResolvedRules
  /** game type declared in this scope, if any */
  gameType?: string
  /** manual keys from [base], which a game type change restarts from */
  baseManual?: Record<string, unknown>
  mutators?: MutatorDeclaration[]
  /** keys written directly in this scope */
  manual?: Record<string, unknown>
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

function applyMutator(into: ResolvedRules, decl: MutatorDeclaration) {
  const mutator = mutatorSchema.mutators.find(m => m.name === decl.name)
  if (!mutator) return
  const effect = mutatorEffects[decl.name]
  if (!effect) return

  for (const set of effect.sets ?? []) {
    // mutator lists replace rather than merge
    const list = listAt(set.key)
    if (list && Array.isArray(set.value)) {
      setRows(into, set.key, mutatorRows(list, set.value), { layer: 'mutator', source: mutator.label })
      continue
    }
    const schema = findScalar(set.key)
    const value = set.fromOption === undefined
      ? set.value
      : optionValue(mutator, decl, set.fromOption, into.get(set.key)?.value)
    // a mistyped value is prose describing an effect we cannot compute
    const usable = schema ? valueMatchesType(value, schema.type) : false
    contribute(into, set.key, usable
      ? { layer: 'mutator', value, source: mutator.label }
      : {
          layer: 'mutator',
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

export function resolveScope(input: ScopeInput): ResolvedRules {
  const isBase = !input.base

  // repeating the base game type does not reset anything
  const baseGameType = input.base ? (input.base.get('game_type')?.value as string | undefined) : undefined
  const gameType = input.gameType ?? baseGameType ?? gametypes.gametypes[0].name
  const changedGameType = !isBase && !!input.gameType && input.gameType !== baseGameType

  let out: ResolvedRules

  if (isBase) {
    out = defaults()
  } else if (changedGameType) {
    // old game type defaults and base mutators are discarded
    out = defaults()
    applyValues(out, input.baseManual ?? {}, {
      layer: 'inherited',
      source: 'base rules',
      description: 'Set in the base rules. Manual settings carry over when a map changes the game type.',
    })
  } else {
    out = new Map()
    for (const [path, resolved] of input.base!) {
      out.set(path, { ...resolved, layer: 'inherited', trail: [...resolved.trail] })
    }
  }

  if (input.gameType) {
    contribute(out, 'game_type', {
      layer: 'manual',
      value: input.gameType,
      description: changedGameType
        ? 'This map changes the game type. Its rules start from the manual settings in the base '
          + "rules, with this game type's defaults applied on top."
        : undefined,
    })
  }
  else if (isBase) {
    contribute(out, 'game_type', { layer: 'default', value: gameType, source: 'Alpine default' })
  }

  if (isBase || changedGameType) {
    applyGameTypeDefaults(out, gameType)
  }

  for (const decl of orderMutators(input.mutators ?? [])) {
    applyMutator(out, decl)
  }

  applySeeds(out)

  applyValues(out, input.manual ?? {}, { layer: 'manual' })

  return out
}

// a game type change clears base mutators. otherwise level mutators stack on
// the base's, replacing any with the same name
export function effectiveMutators(
  base: MutatorDeclaration[],
  level: MutatorDeclaration[],
  modeChanged: boolean,
): MutatorDeclaration[] {
  if (modeChanged) return level
  return [...base.filter(b => !level.some(l => l.name === b.name)), ...level]
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

/** paths this scope changed relative to what it inherited */
export function overridden(resolved: ResolvedRules): string[] {
  return [...resolved]
    .filter(([, r]) => r.layer !== 'inherited' && r.layer !== 'default')
    .map(([path]) => path)
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
