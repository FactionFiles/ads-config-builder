// Everything in this config that will not do what it reads like.
//
// A problem here is something the server will not do, or will do differently
// from what the file says. A deliberate choice is never a problem, however
// unusual it looks: a rotation that plays one map twice is playing it twice on
// purpose, and a config that only Alpine clients can join was written that way.
// The line is whether the operator would be surprised by what the server does.
//
// Nothing here asks anything of the network. The one check that needs an answer
// from outside takes it as an argument, already gathered, so this stays a pure
// reading of the document and the resolver.

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
  | 'ignored'  // it is in the file, and the server uses something else or nothing
  | 'note'     // worth knowing, nothing is wrong

/** which part of the config a finding is about, and where to go to fix it */
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
  /** the settings or maps this is about, named as the user reads them */
  items?: string[]
}

export interface CheckInput {
  doc: ConfigDocument
  baseRules: ResolvedRules
  levelRules: ResolvedRules[]
  server: ResolvedRules
  /** rotation entries FactionFiles does not carry, already asked about */
  absentMaps?: string[]
}

const SERVER_SCOPE: FindingScope = { kind: 'server', map: null, label: 'The whole server' }
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

/** one or many, so a count never reads "1 keys" */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/**
 * The settings one scope sets by hand that the server will not use as written.
 *
 * A setting that does nothing is reported once, for the first reason it does
 * nothing - a value the mode ignores is not also worth a note about its range.
 */
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
          ? `This mode never reads it. It only applies in ${modeTitles(modes)}.`
          : 'This mode never reads it.',
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
        title: `${label} is never read`,
        detail: `The server only reads it when ${labelOf(scope, sibling)} is ${
          guard.equals === false ? 'off' : 'on'
        }, and here it is ${guard.equals === false ? 'on' : 'off'}.`,
        page,
      })
      continue
    }

    if (!scalar) continue
    const value = manual[path]

    // the source clamps rather than refuses, so the file keeps a number the
    // server has already replaced - which is exactly the surprise this page is for
    if (typeof value === 'number') {
      const low = scalar.min !== undefined && value < scalar.min
      const high = scalar.max !== undefined && value > scalar.max
      if (low || high) {
        const limit = low ? scalar.min! : scalar.max!
        out.push({
          id: `${id}:range`,
          severity: 'ignored',
          scope: where,
          title: `${label} is outside the range Alpine accepts`,
          detail: `It is set to ${formatValue(scope, path, value)}. Alpine brings it back to ${
            formatValue(scope, path, limit)
          }, so that is what the server uses.`,
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
        title: `${label} is longer than Alpine keeps`,
        detail: `Alpine cuts it to ${scalar.maxLength} characters, so the end of it never reaches anyone.`,
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
        detail: 'This is a bug in Alpine rather than in your config. Until it is fixed the '
          + 'setting does not behave the way the file reads, whatever you put here.',
        page,
      })
    }
  }
}

/** mutators a scope turns on that its mode will not run */
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
    detail: 'The server prints a warning at startup and carries on without '
      + (blocked.length === 1 ? 'it' : 'them') + '.',
    page: 'rules-mutators',
    items: blocked.map(m => m!.label),
  })
}

/**
 * Keys carried through untouched because nothing here can edit them.
 *
 * Reported per scope rather than as one pile, because the point of saying so is
 * being able to go and look at them, and a key inside one map is not something
 * to go looking for in the game rules.
 */
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
        title: `${known.length} ${plural(known.length, 'setting has', 'settings have')} no editor here yet`,
        detail: 'Alpine supports ' + plural(known.length, 'it', 'them') + ' and this config sets '
          + plural(known.length, 'it', 'them') + '. ' + plural(known.length, 'It is', 'They are')
          + ' written back out exactly as ' + plural(known.length, 'it came', 'they came')
          + ' in, so nothing is lost by editing the rest here.',
        page,
        items: known,
      })
    }

    if (strange.length) {
      out.push({
        id: `carried:strange:${where.kind}${where.map ?? ''}`,
        severity: 'note',
        scope: where,
        title: `${strange.length} ${plural(strange.length, 'key is', 'keys are')} not ${
          plural(strange.length, 'one', 'ones')
        } this tool knows`,
        detail: plural(strange.length, 'It may be', 'They may be')
          + ' from a newer Alpine than this tool was built against, or misspelled. '
          + plural(strange.length, 'It is', 'They are') + ' kept and written back out either way.',
        page,
        items: strange,
      })
    }
  }

  // a [[levels]] entry holds a file name and its rules and nothing else, so
  // anything else in one is a key Alpine itself warns about on the way in
  doc.levels.forEach((level, i) => {
    const misplaced = Object.keys(level.unknown)
    if (!misplaced.length) return
    out.push({
      id: `carried:misplaced:${i}`,
      severity: 'note',
      scope: mapScope(i, level.filename),
      title: `${misplaced.length} ${plural(misplaced.length, 'key', 'keys')} on this map ${
        plural(misplaced.length, 'is', 'are')
      } in the wrong place`,
      detail: 'A map in the rotation holds a file name and its game rules and nothing '
        + 'else. Alpine warns about ' + plural(misplaced.length, 'this', 'these')
        + ' at startup and moves on. ' + plural(misplaced.length, 'It was', 'They were')
        + ' most likely meant for the game rules.',
      page: 'rotation',
      items: misplaced,
    })
  })
}

/** a setting every map repeats that the game rules could say once */
function repeatedFindings(doc: ConfigDocument, out: Finding[]) {
  if (doc.levels.length < 2) return

  const first = doc.levels[0].rules.manual
  for (const path of Object.keys(first)) {
    // a list Alpine seeds per scope has to be repeated on every map, so hoisting
    // it into the game rules is the one thing that would not work
    const schema = schemaFor('rules', path)
    if (schema?.kind === 'array' && schema.seed) continue
    const value = JSON.stringify(first[path])
    const everywhere = doc.levels.every(l => JSON.stringify(l.rules.manual[path]) === value)
    if (!everywhere) continue
    out.push({
      id: `repeated:${path}`,
      severity: 'note',
      scope: BASE_SCOPE,
      title: `Every map sets ${labelOf('rules', path)} to the same thing`,
      detail: 'Setting it once in the game rules would do the same job, and a map added later '
        + 'would pick it up instead of starting without it.',
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
        ? 'A map in the rotation has no file name'
        : `${blank.length} maps in the rotation have no file name`,
      detail: 'The server has nothing to load, so the entry does not become a map.',
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
      detail: 'Unless the file is already sitting on the server, Alpine cannot fetch '
        + (absent.length === 1 ? 'it' : 'them')
        + ' and drops the entry from the rotation at startup. Players who join without the '
        + 'map cannot download it either.',
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
      detail: 'This config does not say which maps to play. That is fine if the server is '
        + 'meant to run on votes alone, and worth a look if it is not.',
      page: 'rotation',
    })
  }
}

/**
 * A map that changes the mode starts with no mutators at all, because rebuilding
 * a mode's defaults would leave a half-applied mutator behind. The source says a
 * scope that changes game_type has to declare its mutators again, and nothing at
 * runtime says so out loud - which makes this the one thing on this page a
 * careful operator is most likely to get wrong.
 */
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
      title: `This map changes the mode, so it runs without ${
        lost.length === 1 ? 'a mutator' : 'mutators'
      } your game rules turn on`,
      detail: 'Changing the mode clears every mutator the game rules set. Anything this map '
        + 'still needs has to be turned on again here. The ordinary settings those mutators '
        + 'wrote are not cleared with them, so the map keeps part of what they did while the '
        + 'mutators themselves are off.',
      page: 'rules-mutators',
      items: lost.map(m => mutatorsByName.get(m.name)?.label ?? m.name),
    })
  })
}

/**
 * A list row the game rules change that Alpine puts back for every map.
 *
 * The parser seeds some rows before reading each scope, so a change made only
 * in the game rules is undone for every map that does not repeat it. Nothing at
 * runtime says so, and the settings page can only show it one map at a time, so
 * it is worth saying plainly here.
 */
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
        title: `What the game rules set for ${name} does not reach ${
          missing.length === doc.levels.length ? 'any map' : 'every map'
        }`,
        detail: `Alpine adds its own ${name} row back at the start of every map, after the game `
          + 'rules have been read, so a map keeps what you set here only if that map sets it too. '
          + 'The weapons page can write it into every map for you.',
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
    // only what this map turns on itself. a mutator it inherits runs under the
    // base mode, which the base scope already reported, and a map that changes
    // the mode inherits none at all
    mutatorFindings(level.rules.mutators, modeOf(i), where, out)
  })

  repeatedFindings(doc, out)
  carriedFindings(doc, out)

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity])
}
