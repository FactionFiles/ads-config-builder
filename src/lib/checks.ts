// findings for anything the server will not do as the file says. unusual but
// deliberate choices are not problems. network results are passed in, so this
// stays pure.

import {
  appliesToMode, gametypesByName, modeTitles, modesFor, mutatorsByName,
  rules as rulesSchema, rulesIndex, schemaFor, textFor, mutatorAllowsMode, type Scope,
} from '../schema'
import type { ArrayKey, ScalarKey } from '../schema/types'
import type { ConfigDocument, ManualKeys, RulesScope } from './config'
import { unsatisfiedGuard, type MutatorDeclaration, type ResolvedRules } from './resolve'
import { formatValue } from './format'
import { tableFor } from './gamedata'

export type Severity =
  | 'broken'   // the server will not do this at all
  | 'ignored'  // the server uses a different value, or none
  | 'note'     // informational

export interface FindingScope {
  kind: 'server' | 'base' | 'rotation' | 'map'
  /** index into the rotation, for a map */
  map: number | null
  label: string
}

export interface Finding {
  id: string
  severity: Severity
  scope: FindingScope
  title: string
  detail: string
  /** page to open, where one page owns the fix */
  page: string | null
  /** display names of the settings or maps involved */
  items?: string[]
}

export interface CheckInput {
  doc: ConfigDocument
  baseRules: ResolvedRules
  levelRules: ResolvedRules[]
  server: ResolvedRules
  /** rotation entries missing from FactionFiles */
  absentMaps?: string[]
}

const SERVER_SCOPE: FindingScope = { kind: 'server', map: null, label: 'Server' }
const BASE_SCOPE: FindingScope = { kind: 'base', map: null, label: 'Game rules' }
const ROTATION_SCOPE: FindingScope = { kind: 'rotation', map: null, label: 'Map rotation' }

function mapScope(index: number, filename: string): FindingScope {
  return { kind: 'map', map: index, label: filename || `Map ${index + 1}` }
}

function modeTitle(mode: string): string {
  return gametypesByName.get(mode)?.title ?? mode
}

function labelOf(scope: Scope, path: string): string {
  return textFor(scope, path).label
}

function pageOf(scope: Scope, path: string): string | null {
  return textFor(scope, path).page || null
}

function scalarAt(scope: Scope, path: string): ScalarKey | undefined {
  const schema = schemaFor(scope, path)
  return schema?.kind === 'scalar' ? schema : undefined
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

// each setting is reported once, for the first reason it goes unused
function settingFindings(
  scope: Scope,
  manual: ManualKeys,
  resolved: ResolvedRules,
  gameType: string,
  where: FindingScope,
  out: Finding[],
) {
  for (const path of Object.keys(manual)) {
    const id = `${where.kind}${where.map ?? ''}:${scope}:${path}`
    const label = labelOf(scope, path)
    const page = pageOf(scope, path)

    if (!appliesToMode(scope, path, gameType)) {
      const modes = modesFor(scope, path)
      out.push({
        id: `${id}:offmode`,
        severity: 'ignored',
        scope: where,
        title: `${label} does nothing in ${modeTitle(gameType)}`,
        detail: modes
          ? `Only used in ${modeTitles(modes)}.`
          : 'Not used by this game type.',
        page,
      })
      continue
    }

    const scalar = scalarAt(scope, path)
    const guard = unsatisfiedGuard(scalar, path, resolved)
    if (guard?.key) {
      const sibling = path.split('.').slice(0, -1).concat(guard.key).join('.')
      out.push({
        id: `${id}:guard`,
        severity: 'ignored',
        scope: where,
        title: `${label} is not used`,
        detail: `Only used when ${labelOf(scope, sibling)} is ${
          guard.equals === false ? 'off' : 'on'
        }.`,
        page,
      })
      continue
    }

    if (!scalar) continue
    const value = manual[path]

    // alpine clamps out-of-range values instead of rejecting them
    if (typeof value === 'number') {
      const low = scalar.min !== undefined && value < scalar.min
      const high = scalar.max !== undefined && value > scalar.max
      if (low || high) {
        const limit = low ? scalar.min! : scalar.max!
        out.push({
          id: `${id}:range`,
          severity: 'ignored',
          scope: where,
          title: `${label} is out of range`,
          detail: `Set to ${formatValue(scope, path, value)}. The server uses ${
            formatValue(scope, path, limit)
          } instead.`,
          page,
        })
        continue
      }
    }

    if (typeof value === 'string' && scalar.maxLength !== undefined && value.length > scalar.maxLength) {
      out.push({
        id: `${id}:length`,
        severity: 'ignored',
        scope: where,
        title: `${label} is too long`,
        detail: `Alpine truncates it to ${scalar.maxLength} characters.`,
        page,
      })
      continue
    }

    if (scalar.typeMismatch) {
      out.push({
        id: `${id}:typemismatch`,
        severity: 'note',
        scope: where,
        title: `${label} is read as a ${scalar.typeMismatch.readAs} and stored as a ${scalar.typeMismatch.storedAs}`,
        detail: 'This is an Alpine bug. The setting may not behave as configured.',
        page,
      })
    }
  }
}

function mutatorFindings(
  running: MutatorDeclaration[],
  gameType: string,
  where: FindingScope,
  out: Finding[],
) {
  const blocked = running
    .map(d => mutatorsByName.get(d.name))
    .filter(m => m !== undefined && !mutatorAllowsMode(m, gameType))
  if (!blocked.length) return

  out.push({
    id: `${where.kind}${where.map ?? ''}:mutators:mode`,
    severity: 'ignored',
    scope: where,
    title: blocked.length === 1
      ? `${blocked[0]!.label} does nothing in ${modeTitle(gameType)}`
      : `${blocked.length} mutators do nothing in ${modeTitle(gameType)}`,
    detail: 'The server logs a warning at startup and skips '
      + (blocked.length === 1 ? 'it' : 'them') + '.',
    page: 'rules-mutators',
    items: blocked.map(m => m!.label),
  })
}

// keys preserved but not editable here, reported per scope so each is easy to find
function carriedFindings(doc: ConfigDocument, out: Finding[]) {
  const sources: { where: FindingScope; page: string | null; paths: string[] }[] = [
    { where: SERVER_SCOPE, page: null, paths: Object.keys(doc.unknown) },
    { where: BASE_SCOPE, page: null, paths: Object.keys(doc.base.unknown) },
    ...doc.levels.map((level, i) => ({
      where: mapScope(i, level.filename),
      page: 'rotation' as string | null,
      paths: Object.keys(level.rules.unknown),
    })),
  ]

  for (const profile of doc.rconProfiles) {
    if (Object.keys(profile.unknown).length) {
      sources.push({ where: SERVER_SCOPE, page: 'admin', paths: Object.keys(profile.unknown) })
    }
  }

  for (const { where, page, paths } of sources) {
    const known = paths.filter(path => rulesIndex.has(path))
    const strange = paths.filter(path => !rulesIndex.has(path))

    if (known.length) {
      out.push({
        id: `carried:known:${where.kind}${where.map ?? ''}`,
        severity: 'note',
        scope: where,
        title: `${known.length} ${plural(known.length, 'setting has', 'settings have')} no editor yet`,
        detail: plural(known.length, 'It is', 'They are') + ' preserved unchanged when the config is saved.',
        page,
        items: known,
      })
    }

    if (strange.length) {
      out.push({
        id: `carried:strange:${where.kind}${where.map ?? ''}`,
        severity: 'note',
        scope: where,
        title: `${strange.length} unrecognized ${plural(strange.length, 'key', 'keys')}`,
        detail: 'Possibly misspelled, or from a newer Alpine version. '
          + plural(strange.length, 'It is', 'They are') + ' preserved when the config is saved.',
        page,
        items: strange,
      })
    }
  }

  // a [[levels]] entry holds only a filename and rules; alpine warns about anything else
  doc.levels.forEach((level, i) => {
    const misplaced = Object.keys(level.unknown)
    if (!misplaced.length) return
    out.push({
      id: `carried:misplaced:${i}`,
      severity: 'note',
      scope: mapScope(i, level.filename),
      title: `${misplaced.length} ${plural(misplaced.length, 'key', 'keys')} on this map ${
        plural(misplaced.length, 'is', 'are')
      } misplaced`,
      detail: 'A rotation entry can only hold a filename and game rules. Alpine ignores '
        + plural(misplaced.length, 'this key', 'these keys') + ' with a warning at startup.',
      page: 'rotation',
      items: misplaced,
    })
  })
}

function repeatedFindings(doc: ConfigDocument, out: Finding[]) {
  if (doc.levels.length < 2) return

  const first = doc.levels[0].rules.manual
  for (const path of Object.keys(first)) {
    // seeded lists are reset per map, so they must be repeated
    const schema = schemaFor('rules', path)
    if (schema?.kind === 'array' && schema.seed) continue
    const value = JSON.stringify(first[path])
    const everywhere = doc.levels.every(l => JSON.stringify(l.rules.manual[path]) === value)
    if (!everywhere) continue
    out.push({
      id: `repeated:${path}`,
      severity: 'note',
      scope: BASE_SCOPE,
      title: `Every map sets ${labelOf('rules', path)} to the same value`,
      detail: 'Consider setting it once in the game rules instead, so new maps inherit it.',
      page: pageOf('rules', path),
    })
  }
}

function rotationFindings(doc: ConfigDocument, absent: string[], out: Finding[]) {
  const blank = doc.levels
    .map((level, i) => ({ level, i }))
    .filter(({ level }) => level.filename.trim() === '')
  if (blank.length) {
    out.push({
      id: 'rotation:blank',
      severity: 'broken',
      scope: mapScope(blank[0].i, ''),
      title: blank.length === 1
        ? 'A map in the rotation has no filename'
        : `${blank.length} maps in the rotation have no filename`,
      detail: 'The server skips entries with no filename.',
      page: 'rotation',
    })
  }

  if (absent.length) {
    out.push({
      id: 'rotation:absent',
      severity: 'broken',
      scope: ROTATION_SCOPE,
      title: absent.length === 1
        ? 'A map in the rotation is not on the FactionFiles autodownloader'
        : `${absent.length} maps in the rotation are not on the FactionFiles autodownloader`,
      detail: 'Unless the file is already on the server, Alpine removes it from the rotation '
        + 'at startup. Players cannot download it either.',
      page: 'rotation',
      items: absent,
    })
  }

  const written = Object.keys(doc.base.manual).length + doc.base.mutators.length
    + Object.keys(doc.server).length
  if (!doc.levels.length && written > 0) {
    out.push({
      id: 'rotation:empty',
      severity: 'note',
      scope: ROTATION_SCOPE,
      title: 'The rotation is empty',
      detail: 'No maps are listed. This is only intended for servers that run on votes alone.',
      page: 'rotation',
    })
  }
}

// changing game_type clears inherited mutators, and alpine does not warn about it
function clearedMutatorFindings(
  doc: ConfigDocument,
  base: MutatorDeclaration[],
  modeChanged: boolean[],
  out: Finding[],
) {
  if (!base.length) return

  doc.levels.forEach((level, i) => {
    if (!modeChanged[i]) return
    const kept = new Set(level.rules.mutators.map(m => m.name))
    const lost = base.filter(m => !kept.has(m.name))
    if (!lost.length) return

    out.push({
      id: `map${i}:mutators:cleared`,
      severity: 'broken',
      scope: mapScope(i, level.filename),
      title: `This map changes the game type and drops ${
        lost.length === 1 ? 'a mutator' : 'mutators'
      } from the game rules`,
      detail: 'Changing the game type clears all mutators, so re-enable any this map needs. '
        + 'Settings those mutators changed are not reset, so their effects may partially remain.',
      page: 'rules-mutators',
      items: lost.map(m => mutatorsByName.get(m.name)?.label ?? m.name),
    })
  })
}

// the parser reseeds some list rows before each scope, undoing base changes on
// any map that does not repeat them. alpine does not warn about it
function reseededRowFindings(doc: ConfigDocument, out: Finding[]) {
  if (!doc.levels.length) return

  for (const key of rulesSchema.keys) {
    if (key.kind !== 'array') continue
    const list = key as ArrayKey
    if (!list.seed || !list.mergeKey) continue

    const mergeKey = list.mergeKey
    const held = doc.base.manual[list.key]
    if (!Array.isArray(held)) continue

    for (const row of held as Record<string, unknown>[]) {
      const seed = list.seed.find(s => s[mergeKey] === row[mergeKey])
      if (!seed) continue
      const differs = Object.entries(seed).some(([f, v]) => f !== mergeKey && row[f] !== v)
      if (!differs) continue

      const missing = doc.levels.filter(level => {
        const own = level.rules.manual[list.key]
        return !Array.isArray(own)
          || !own.some(r => (r as Record<string, unknown>)?.[mergeKey] === row[mergeKey])
      })
      if (!missing.length) continue

      const column = list.item?.find(f => f.key === mergeKey)
      const id = String(row[mergeKey])
      const name = column?.lookup
        ? tableFor(column.lookup).find(e => e.name === id)?.display ?? id
        : id

      out.push({
        id: `reseed:${list.key}:${String(row[mergeKey])}`,
        severity: 'broken',
        scope: BASE_SCOPE,
          title: `${name} settings from the game rules do not apply to ${
          missing.length === doc.levels.length ? 'any map' : 'every map'
        }`,
        detail: `Alpine resets ${name} to its defaults on every map, so each map must set it too. `
          + 'The weapons page can copy it to every map.',
        page: pageOf('rules', list.key),
        items: missing.map((level, i) => level.filename || `Map ${i + 1}`),
      })
    }
  }
}

const RANK: Record<Severity, number> = { broken: 0, ignored: 1, note: 2 }

export function findProblems(input: CheckInput): Finding[] {
  const { doc, baseRules, levelRules, server, absentMaps = [] } = input
  const out: Finding[] = []

  const baseMode = (baseRules.get('game_type')?.value as string) ?? ''
  const modeOf = (i: number) => (levelRules[i]?.get('game_type')?.value as string) ?? baseMode
  const modeChanged = doc.levels.map((_, i) => modeOf(i) !== baseMode)

  rotationFindings(doc, absentMaps, out)
  reseededRowFindings(doc, out)
  clearedMutatorFindings(doc, doc.base.mutators, modeChanged, out)

  settingFindings('server', doc.server, server, baseMode, SERVER_SCOPE, out)
  settingFindings('rules', doc.base.manual, baseRules, baseMode, BASE_SCOPE, out)
  mutatorFindings(doc.base.mutators, baseMode, BASE_SCOPE, out)

  doc.levels.forEach((level: { filename: string; rules: RulesScope }, i) => {
    const rules = levelRules[i] ?? baseRules
    const where = mapScope(i, level.filename)
    settingFindings('rules', level.rules.manual, rules, modeOf(i), where, out)
    // only this map's own mutators; inherited ones were already checked against the base mode
    mutatorFindings(level.rules.mutators, modeOf(i), where, out)
  })

  repeatedFindings(doc, out)
  carriedFindings(doc, out)

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity])
}
