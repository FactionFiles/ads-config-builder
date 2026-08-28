// Resolving a scope means replaying Alpine's layering and remembering who did
// what, because the record is the whole point: it is what the provenance dot on
// each setting shows.
//
// From dedi_cfg.cpp, one scope resolves as:
//
//   Alpine built-in default
//     -> game type defaults   (only when the game type changed, or was never applied)
//     -> rules presets        (files, in declared order)
//     -> mutators             (fixed apply order, before manual keys)
//     -> manual keys in this scope
//
// applied once for [base], then again per [[levels]] entry, with the resolved
// base rules as the starting point. Manual keys always beat mutators in the same
// scope.

import { gametypes, mutators as mutatorSchema, mutatorEffects, rules as rulesSchema, server as serverSchema } from '../schema'
import type { ArrayKey, DefaultOp, Guard, Mutator, ScalarKey, SchemaKey, StockReserve } from '../schema/types'
import { railGunName, reserveAmmo } from './gamedata'

export type Layer =
  | 'default'      // Alpine's built-in value
  | 'gametype'     // this game mode's defaults
  | 'preset'       // a rules preset file
  | 'mutator'
  | 'manual'       // set in this scope
  | 'inherited'    // resolved in the base scope, unchanged here

export interface Contribution {
  layer: Layer
  value: unknown
  /** preset file name, mutator name, or game mode name */
  source?: string
  /** why this layer did what it did, where the value alone does not say */
  description?: string
}

export interface Resolved {
  value: unknown
  layer: Layer
  source?: string
  /** every layer that touched this setting, oldest first; the last one won */
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
  /** preset contents in declared order, each a flat path -> value map */
  presets?: { name: string; values: Record<string, unknown> }[]
  mutators?: MutatorDeclaration[]
  /** keys written directly in this scope */
  manual?: Record<string, unknown>
}

function contribute(into: ResolvedRules, path: string, c: Contribution) {
  const existing = into.get(path)
  const trail = existing ? [...existing.trail, c] : [c]
  into.set(path, { value: c.value, layer: c.layer, source: c.source, trail })
}

/** every scalar setting in a key tree, with its built-in default */
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

/** the built-in rules defaults, computed once */
let cachedRuleDefaults: ResolvedRules | null = null
export function defaults(): ResolvedRules {
  if (!cachedRuleDefaults) cachedRuleDefaults = collectDefaults(rulesSchema.keys)
  return copy(cachedRuleDefaults)
}

let cachedServerDefaults: ResolvedRules | null = null

/**
 * The server-level settings are not layered the way the rules are - there is one
 * scope and no presets or mutators - but they still have Alpine defaults, and a
 * field showing nothing until you touch it would be lying about what the server
 * will do.
 */
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

/**
 * One entry of an array of tables, against the built-in defaults for its fields.
 * Nothing layers here - an admin profile is not inherited from anywhere - but
 * the fields still render through the shared field renderer, which wants a
 * resolved map and a value for a field nobody has touched.
 */
export function resolveEntry(root: SchemaKey, fields: Record<string, unknown>): ResolvedRules {
  const out = collectDefaults([root])
  for (const [key, value] of Object.entries(fields)) {
    contribute(out, `${root.key}.${key}`, { layer: 'manual', value })
  }
  return out
}

// ---------------------------------------------------------------------------
// Lists that are folded together rather than replaced. Alpine parses some list
// keys by handing each entry to the list it already has, keyed by one field, so
// a later layer that names one entry changes that entry and leaves the rest -
// which is what lets a map turn one weapon of a game mode's spawn kit off
// without restating the kit. Which lists work that way comes from the parser.
// ---------------------------------------------------------------------------

/** one entry of a merged list, with every field the file can hold filled in */
type Row = Record<string, unknown>

const mergedLists = rulesSchema.keys
  .filter((key): key is ArrayKey => key.kind === 'array' && key.mergeKey !== undefined)

const SPAWN_KIT = 'spawn_loadout'

/**
 * The reserve the stock spawn grant hands out, as the Alpine source states it.
 * It is read off the game type defaults rather than written down again here, so
 * the source stays the one place it is stated.
 */
const stockSpawnReserve = gametypes.defaults.after
  .find(op => op.op === 'loadoutSpawnWeapon')?.ammoFrom

// entries are keyed by the name they resolve to, and the game resolves a name
// without case, so two spellings of one weapon are one entry
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

/** one layer's word on one entry, folded into what the layers under it left */
function withRow(list: ArrayKey, rows: Row[], edit: Row): Row[] {
  const key = list.mergeKey!
  const at = rows.findIndex(row => sameId(row[key], edit[key]))
  const previous = at === -1 ? undefined : rows[at]

  const next: Row = {}
  for (const field of list.item ?? []) {
    // a field the entry leaves out keeps what the layer under it left, where the
    // parser asks whether the entry carried one at all, and otherwise falls back
    // to whatever the parser reads in its place
    const value = edit[field.key] !== undefined ? edit[field.key]
      : field.optional && previous?.[field.key] !== undefined ? previous[field.key]
      : field.default !== undefined ? field.default
      : previous?.[field.key]
    if (value !== undefined) next[field.key] = value
  }

  return at === -1 ? [...rows, next] : rows.map((row, i) => (i === at ? next : row))
}

// a layer that leaves a list exactly as it found it did not touch it, and saying
// so in the trail would make the popover list layers that did nothing
function setRows(into: ResolvedRules, path: string, rows: Row[], c: Omit<Contribution, 'value'>) {
  if (JSON.stringify(rowsAt(into, path)) === JSON.stringify(rows)) return
  contribute(into, path, { ...c, value: rows })
}

/** an entry as a layer wrote it, or null for one with nothing to key it by */
function readRow(list: ArrayKey, entry: unknown): Row | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
  const row = entry as Row
  const id = row[list.mergeKey!]
  // a name the game does not know is kept rather than dropped, so it stays
  // visible in the editor where it can be corrected
  return typeof id === 'string' && id !== '' ? row : null
}

/** the spare clips the spawn weapon comes with, which its reserve counts */
function clipsOf(into: ResolvedRules): number {
  const clips = into.get('spawn_weapon.clips')?.value
  return typeof clips === 'number' ? clips : 0
}

/** the weapon the scope spawns players holding, as an entry of the kit */
function spawnWeaponRow(into: ResolvedRules, from: StockReserve | undefined): Row | null {
  const name = into.get('spawn_weapon.weapon_name')?.value
  if (typeof name !== 'string' || !name || !from) return null
  return { weapon_name: name, ammo: reserveAmmo(from, name, clipsOf(into)), include: true }
}

/**
 * The merged list keys of one scope. Alpine reads the spawn weapon before the
 * kit entries, and naming a different one takes the weapon the mode chose back
 * out of the kit, so the order here is the order there.
 */
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

/** everything one layer of ordinary keys says, merged lists included */
function applyValues(
  into: ResolvedRules,
  values: Record<string, unknown>,
  c: Omit<Contribution, 'value'>,
) {
  const previousWeapon = (into.get('spawn_weapon.weapon_name')?.value as string) ?? ''
  for (const [path, value] of Object.entries(values)) {
    // the game type decides which defaults ran in the first place, and a merged
    // list is not this layer's alone, so both are handled on their own
    if (path === 'game_type' || listAt(path)) continue
    contribute(into, path, { ...c, value })
  }
  applyListKeys(into, values, previousWeapon, c)
}

/**
 * Rows the parser puts into a list before it reads the scope's own, once for
 * every scope it parses.
 *
 * Alpine keeps the stock weapon stay rule for the Fusion Rocket Launcher this
 * way: it patches the game's own hardcoded exemption out so the rule can be
 * configured at all, then seeds the list with the same row so a config that
 * says nothing still plays like stock. Because the seeding runs per scope
 * rather than once, a map that says nothing gets the row put back - so turning
 * it off in the base rules does not reach any map that has not turned it off
 * too. That is upstream behavior, not a decision here, and the trail says so.
 *
 * `setRows` stays quiet when a layer changes nothing, so the seed only appears
 * in the trail where it actually took something away.
 */
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
      description: 'Alpine puts this row back at the start of every map, so a map keeps it '
        + 'unless that map turns it off itself.',
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
        // the case above may have placed the spawn weapon already, with a
        // reserve of its own choosing that this must not overwrite
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
  // a mode with no case of its own still gets the arm that covers the rest,
  // which is where deathmatch and capture the flag get their spawn weapon
  apply(gametypes.defaults.perType[gameType] ?? gametypes.defaults.fallback)
  apply(gametypes.defaults.after)
}

function applyMutator(into: ResolvedRules, decl: MutatorDeclaration) {
  const mutator = mutatorSchema.mutators.find(m => m.name === decl.name)
  if (!mutator) return
  const effect = mutatorEffects[decl.name]
  if (!effect) return

  for (const set of effect.sets ?? []) {
    // a mutator with a kit of its own builds it from nothing rather than adding
    // to what the mode handed out, so its list replaces rather than folds in
    const list = listAt(set.key)
    if (list && Array.isArray(set.value)) {
      setRows(into, set.key, mutatorRows(list, set.value), { layer: 'mutator', source: mutator.label })
      continue
    }
    const schema = findScalar(set.key)
    const value = set.fromOption === undefined
      ? set.value
      : optionValue(mutator, decl, set.fromOption, into.get(set.key)?.value)
    // a `sets` entry whose value is not a value of the right type is a prose
    // description of something we cannot compute - record it as such rather than
    // writing a bogus value into the setting
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

/**
 * A list a mutator builds for itself. An entry of a spawn kit that names no
 * reserve ammo gets the weapon's own, which is the figure the source hands those
 * entries out of the weapon table.
 */
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

/**
 * What a mutator option is set to. An option the user has not touched falls back
 * to its declared default, and the two options declared as `currentValue` fall
 * back to whatever the setting already resolved to - which is what the server
 * does, and is why turning those mutators on changes nothing by itself.
 */
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

/**
 * Mutators run in a fixed order rather than the order they are declared in, so
 * that two active mutators that touch the same rule always land the same way.
 */
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
  let out: ResolvedRules

  if (isBase) {
    out = defaults()
  } else {
    // a level scope starts from the resolved base rules; anything it does not
    // touch stays inherited, which is what lets the rotation table show at a
    // glance which cells a map actually overrides
    out = new Map()
    for (const [path, resolved] of input.base!) {
      out.set(path, { ...resolved, layer: 'inherited', trail: [...resolved.trail] })
    }
  }

  // the server only rebuilds the game type defaults when the type actually
  // changes, so a level that repeats the base game type does not reset anything
  const baseGameType = input.base ? (input.base.get('game_type')?.value as string | undefined) : undefined
  const gameType = input.gameType ?? baseGameType ?? gametypes.gametypes[0].name
  if (input.gameType) contribute(out, 'game_type', { layer: 'manual', value: input.gameType })
  else if (isBase) {
    contribute(out, 'game_type', { layer: 'default', value: gameType, source: 'Alpine default' })
  }
  if (isBase || (input.gameType && input.gameType !== baseGameType)) {
    applyGameTypeDefaults(out, gameType)
  }

  for (const preset of input.presets ?? []) {
    applyValues(out, preset.values, { layer: 'preset', source: preset.name })
  }

  for (const decl of orderMutators(input.mutators ?? [])) {
    applyMutator(out, decl)
  }

  applySeeds(out)

  applyValues(out, input.manual ?? {}, { layer: 'manual' })

  return out
}

/**
 * The mutators actually running in a level scope. A level that changes the game
 * mode starts from a cleared mutator state, because rebuilding a mode's defaults
 * would leave a half-applied mutator behind - so only that level's own
 * declarations count there. Otherwise the level's declarations stack on the
 * base's, with one for the same mutator replacing the base's.
 */
export function effectiveMutators(
  base: MutatorDeclaration[],
  level: MutatorDeclaration[],
  modeChanged: boolean,
): MutatorDeclaration[] {
  if (modeChanged) return level
  return [...base.filter(b => !level.some(l => l.name === b.name)), ...level]
}

/** where one row of a resolved list came from */
export interface RowOrigin {
  /** the layer that left the row the way it is now */
  by?: Contribution
  /** the first layer to name it at all, which is what a later layer folded into */
  first?: Contribution
}

/**
 * Which layer each row of a list owes its current state to. A row no later layer
 * touched still shows the one that put it there, which is what lets the kit a
 * game mode hands out read as the mode's rather than as yours.
 */
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
      // a layer that rebuilt the list from nothing dropped the row, so whatever
      // put it back owns it rather than whoever had it before
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

/** the sibling a guard names, as a full path */
function siblingPath(full: string, key: string): string {
  const parts = full.split('.')
  parts[parts.length - 1] = key
  return parts.join('.')
}

/**
 * The guard stopping the server from reading this setting, if one is. A setting
 * behind an unsatisfied guard is parsed and then never looked at, so a field
 * shows it inert and the problems page counts it as doing nothing.
 */
export function unsatisfiedGuard(
  key: SchemaKey | undefined,
  path: string,
  resolved: ResolvedRules,
): Guard | undefined {
  return (key?.requires ?? []).find(
    g => g.key !== undefined && resolved.get(siblingPath(path, g.key))?.value !== (g.equals ?? true)
  )
}
