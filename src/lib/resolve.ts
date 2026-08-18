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
import type { DefaultOp, Mutator, ScalarKey, SchemaKey } from '../schema/types'
import { railGunName } from './gamedata'

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
  /** for a mutator whose effect is not a value we can compute */
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

function applyGameTypeDefaults(into: ResolvedRules, gameType: string) {
  const apply = (ops: DefaultOp[]) => {
    for (const op of ops) {
      // loadout operations are not scalar settings; the loadout editor reads
      // them from the schema directly rather than through the resolver
      if (op.op !== 'set' || !op.key) continue
      contribute(into, op.key, { layer: 'gametype', value: op.value, source: gameType })
    }
  }
  apply(gametypes.defaults.common)
  const perType = gametypes.defaults.perType[gameType]
  if (perType) apply(perType)
}

function applyMutator(into: ResolvedRules, decl: MutatorDeclaration) {
  const mutator = mutatorSchema.mutators.find(m => m.name === decl.name)
  if (!mutator) return
  const effect = mutatorEffects[decl.name]
  if (!effect) return

  for (const set of effect.sets ?? []) {
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
    for (const [path, value] of Object.entries(preset.values)) {
      contribute(out, path, { layer: 'preset', value, source: preset.name })
    }
  }

  for (const decl of orderMutators(input.mutators ?? [])) {
    applyMutator(out, decl)
  }

  for (const [path, value] of Object.entries(input.manual ?? {})) {
    // the game type is not layered like the rest - it decides which defaults ran
    // in the first place, so it is contributed above rather than here
    if (path === 'game_type') continue
    contribute(out, path, { layer: 'manual', value })
  }

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

/** paths this scope changed relative to what it inherited */
export function overridden(resolved: ResolvedRules): string[] {
  return [...resolved]
    .filter(([, r]) => r.layer !== 'inherited' && r.layer !== 'default')
    .map(([path]) => path)
}
