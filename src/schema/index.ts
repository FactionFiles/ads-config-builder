// schema/generated/ is gitignored. if these imports fail, run `npm run schema`.

import rulesJson from '../../schema/generated/rules.json'
import serverJson from '../../schema/generated/server.json'
import gametypesJson from '../../schema/generated/gametypes.json'
import mutatorsJson from '../../schema/generated/mutators.json'
import metaJson from '../../schema/generated/meta.json'
import consoleLabelsJson from '../../schema/generated/console-labels.json'
import authoredJson from '../../schema/generated/authored.json'

import type {
  AuthoredEntry, ConsoleLabel, GameTypesSchema, Mutator, MutatorEffect, MutatorsSchema,
  Page, RulesSchema, SchemaKey, SchemaMeta, ServerSchema,
} from './types'

export const rules = rulesJson as unknown as RulesSchema
export const server = serverJson as unknown as ServerSchema
export const gametypes = gametypesJson as unknown as GameTypesSchema
export const mutators = mutatorsJson as unknown as MutatorsSchema
export const meta = metaJson as unknown as SchemaMeta

const consoleLabels = consoleLabelsJson as unknown as Record<string, ConsoleLabel>
const authored = authoredJson as unknown as {
  pages: Page[]
  rules: Record<string, AuthoredEntry>
  server: Record<string, AuthoredEntry>
  mutatorEffects: Record<string, MutatorEffect>
}

export const pages = [...authored.pages].sort((a, b) => a.order - b.order)
export const mutatorEffects = authored.mutatorEffects

/** flat path -> schema entry, for both scopes */
function index(keys: SchemaKey[], prefix = '', into = new Map<string, SchemaKey>()) {
  for (const key of keys) {
    const path = prefix + key.key
    into.set(path, key)
    if ('keys' in key && key.keys) index(key.keys, path + '.', into)
  }
  return into
}

export const rulesIndex = index(rules.keys)
export const serverIndex = index([...server.keys, ...server.tables, ...server.arrays])

export type Scope = 'rules' | 'server'

export function schemaFor(scope: Scope, path: string): SchemaKey | undefined {
  return (scope === 'rules' ? rulesIndex : serverIndex).get(path)
}

// falls back to alpine's console labels so a new upstream setting still gets a name
export function textFor(scope: Scope, path: string): AuthoredEntry {
  const entry = (scope === 'rules' ? authored.rules : authored.server)[path]
  if (entry) return entry
  const fallback = consoleLabels[path]
  return {
    page: '',
    label: fallback?.label ?? path,
    help: '',
    unit: fallback?.unit,
  }
}

// a setting with no authored entry is new upstream, so it starts out advanced
export function isBasic(scope: Scope, path: string): boolean {
  return textFor(scope, path).basic === true
}

// game type names come from the generated list so new upstream game types are named
export function choiceLabelsFor(scope: Scope, path: string): Record<string, string> | undefined {
  if (scope === 'rules' && path === 'game_type') {
    return Object.fromEntries(gametypes.gametypes.map(g => [g.name, g.title]))
  }
  return textFor(scope, path).choiceLabels
}

export function choiceBlurbFor(scope: Scope, path: string, choice: string): string | undefined {
  if (scope === 'rules' && path === 'game_type') return gametypesByName.get(choice)?.blurb
  return undefined
}

export const rconCommandAliases: Record<string, string> =
  textFor('server', 'rcon_profiles.allowed_commands').aliases ?? {}

export function pagesForScope(scope: Page['scope']): Page[] {
  return pages.filter(p => p.scope === scope)
}

// scope belongs to the setting, not the page, since some pages mix server and rules settings
export const allEntries: { scope: Scope; path: string }[] = [
  ...rules.flat.map(path => ({ scope: 'rules' as const, path })),
  ...server.flat.map(path => ({ scope: 'server' as const, path })),
]

export function entriesForPage(page: string) {
  return allEntries.filter(e => textFor(e.scope, e.path).page === page)
}

export const gametypesByName = new Map(gametypes.gametypes.map(g => [g.name, g]))

export const allModes = gametypes.gametypes.map(g => g.name)

// score limits and rounds settings get their game types from the generated schema
// to avoid drift. everything else comes from the authored layer.
const derivedModes = new Map<string, string[]>()
for (const g of gametypes.gametypes) {
  if (g.scoreLimitKey) {
    derivedModes.set(g.scoreLimitKey, [...(derivedModes.get(g.scoreLimitKey) ?? []), g.name])
  }
}
const roundModes = gametypes.gametypes.filter(g => g.usesRounds).map(g => g.name)
for (const path of rules.flat) {
  if (path === 'rounds' || path.startsWith('rounds.')) derivedModes.set(path, roundModes)
}

const teamModes = gametypes.gametypes.filter(g => g.isTeam).map(g => g.name)

export function modesFor(scope: Scope, path: string): string[] | null {
  const derived = scope === 'rules' ? derivedModes.get(path) : undefined
  if (derived) return derived
  const entry = textFor(scope, path)
  if (entry.teamOnly) return teamModes
  if (entry.modes) return entry.modes
  if (entry.notModes) return allModes.filter(m => !entry.notModes!.includes(m))
  return null
}

export function appliesToMode(scope: Scope, path: string, mode: string): boolean {
  const modes = modesFor(scope, path)
  return modes === null || modes.includes(mode)
}

export function modeTitles(modes: string[]): string {
  const titles = modes.map(m => gametypesByName.get(m)?.title ?? m)
  if (titles.length <= 1) return titles.join('')
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`
}

// derived from the requirement rather than copying alpine's game type mask
export function modesForMutator(m: Mutator): string[] {
  switch (m.gametypeReq) {
    case 'TeamOnly': return gametypes.gametypes.filter(g => g.isTeam).map(g => g.name)
    case 'GunGameOnly': return gametypes.gametypes.filter(g => g.name === 'gg').map(g => g.name)
    case 'HasScoreLimit': return gametypes.gametypes.filter(g => g.scoreLimitKey).map(g => g.name)
    case 'BotsSupported': return gametypes.gametypes.filter(g => g.botsSupported).map(g => g.name)
    default: return allModes
  }
}

export function mutatorAllowsMode(m: Mutator, mode: string): boolean {
  return modesForMutator(m).includes(mode)
}

export const mutatorsByName = new Map(mutators.mutators.map(m => [m.name, m]))
