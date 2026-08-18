// The schema the UI runs on. Everything here is produced by `npm run schema`:
// tools/gen-schema.mjs parses the pinned Alpine source, then
// tools/check-schema.mjs validates the hand-authored layer and compiles it.
//
// schema/generated/ is gitignored - if these imports fail to resolve, run
// `npm run schema`.

import rulesJson from '../../schema/generated/rules.json'
import serverJson from '../../schema/generated/server.json'
import gametypesJson from '../../schema/generated/gametypes.json'
import mutatorsJson from '../../schema/generated/mutators.json'
import metaJson from '../../schema/generated/meta.json'
import consoleLabelsJson from '../../schema/generated/console-labels.json'
import authoredJson from '../../schema/generated/authored.json'

import type {
  AuthoredEntry, ConsoleLabel, GameTypesSchema, MutatorEffect, MutatorsSchema,
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

/**
 * What the user reads for a setting. The authored layer wins; the server's own
 * console wording is the fallback so a setting added upstream still shows a real
 * name rather than a raw key while its help text is being written.
 */
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

export function pagesForScope(scope: Page['scope']): Page[] {
  return pages.filter(p => p.scope === scope)
}

/**
 * Every setting in the tool, tagged with the scope it belongs to. A setting's
 * scope is a property of the setting, not of the page it is shown on - a handful
 * of server-level settings genuinely belong next to the rules they affect, and a
 * page that assumed otherwise would route their edits into the wrong place.
 */
export const allEntries: { scope: Scope; path: string }[] = [
  ...rules.flat.map(path => ({ scope: 'rules' as const, path })),
  ...server.flat.map(path => ({ scope: 'server' as const, path })),
]

export function entriesForPage(page: string) {
  return allEntries.filter(e => textFor(e.scope, e.path).page === page)
}

export const gametypesByName = new Map(gametypes.gametypes.map(g => [g.name, g]))

/**
 * Every setting that is some mode's score limit. Alpine keeps one key per mode
 * and reads only the one belonging to the mode in play, so showing all nine at
 * once - which is what the old builder did - asks the user to work out which of
 * them matters. Only the live one is shown.
 */
export const scoreLimitKeys = new Set(
  gametypes.gametypes.map(g => g.scoreLimitKey).filter((k): k is string => k !== null)
)

export function scoreLimitKeyFor(mode: string): string | null {
  return gametypesByName.get(mode)?.scoreLimitKey ?? null
}
export const mutatorsByName = new Map(mutators.mutators.map(m => [m.name, m]))
