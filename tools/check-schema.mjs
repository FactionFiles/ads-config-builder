// Fails the build when the hand-authored schema layer and the generated one have
// drifted apart. The generated half tracks the Alpine source automatically; this
// is what stops the authored half silently falling behind it.
//
// Run after tools/gen-schema.mjs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GEN = join(ROOT, 'schema/generated')
const AUTHORED = join(ROOT, 'schema/authored')

const problems = []
const problem = (kind, detail) => problems.push({ kind, detail })

function loadGenerated(name) {
  const p = join(GEN, name)
  if (!existsSync(p)) {
    console.error(`\nschema/generated/${name} is missing. Run: npm run gen\n`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(p, 'utf8'))
}

function loadAuthored(name) {
  const p = join(AUTHORED, name)
  if (!existsSync(p)) {
    problem('missing authored file', `schema/authored/${name} does not exist`)
    return null
  }
  try {
    return parseToml(readFileSync(p, 'utf8'))
  } catch (err) {
    problem('unparsable authored file', `schema/authored/${name}: ${err.message}`)
    return null
  }
}

const rules = loadGenerated('rules.json')
const server = loadGenerated('server.json')
const mutators = loadGenerated('mutators.json')
const gametypes = loadGenerated('gametypes.json')

const pagesFile = loadAuthored('pages.toml')
const authoredRules = loadAuthored('rules.toml')
const authoredServer = loadAuthored('server.toml')
const effects = loadAuthored('mutator-effects.toml')

const pageIds = new Set((pagesFile?.page ?? []).map(p => p.id))
if (pagesFile && pageIds.size === 0) problem('no pages', 'pages.toml declares no [[page]] entries')

// every generated key needs an authored entry, and every authored entry needs a
// generated key. the first catches an Alpine setting we have not described yet;
// the second catches a description left behind after upstream removed a setting.
// mode names, plus the keys whose mode gating the generated schema already
// answers. an authored `modes` on one of those would be a second copy of a fact
// the Alpine source states, so it is rejected rather than merged.
const modeNames = new Set(gametypes.gametypes.map(g => g.name))
const derivedModeKeys = new Map()
for (const g of gametypes.gametypes) {
  if (g.scoreLimitKey) derivedModeKeys.set(g.scoreLimitKey, 'it is a per-mode score limit')
}
for (const path of rules.flat) {
  if (path === 'rounds' || path.startsWith('rounds.')) {
    derivedModeKeys.set(path, 'gt_type_uses_rounds already says which modes use rounds')
  }
}

function checkModes(label, path, entry) {
  const given = ['modes', 'notModes', 'teamOnly'].filter(f => entry[f] !== undefined)
  if (given.length === 0) return
  if (given.length > 1) {
    problem(`${label}: mode gating is set more than one way`, `${path} - has ${given.join(' and ')}`)
    return
  }
  if (label === 'rules' && derivedModeKeys.has(path)) {
    problem(`${label}: ${given[0]} is set on a key the generator already gates`,
      `${path} - ${derivedModeKeys.get(path)}, so drop the authored gating`)
    return
  }
  if (entry.teamOnly !== undefined) {
    if (entry.teamOnly !== true) problem(`${label}: teamOnly must be true or absent`, path)
    return
  }
  const field = given[0]
  const list = entry[field]
  if (!Array.isArray(list) || list.length === 0) {
    problem(`${label}: ${field} must be a non-empty list`, path)
    return
  }
  for (const mode of list) {
    if (!modeNames.has(mode)) {
      problem(`${label}: ${field} names a game type that does not exist`,
        `${path} -> "${mode}" (known: ${[...modeNames].join(', ')})`)
    }
  }
  if (list.length === modeNames.size) {
    problem(`${label}: ${field} lists every game type`, `${path} - drop it instead`)
  }
}

function crossCheck(label, generatedPaths, authored) {
  if (!authored) return
  const have = new Set(Object.keys(authored))
  for (const path of generatedPaths) {
    if (!have.has(path)) { problem(`${label}: unlabeled setting`, path); continue }
    const entry = authored[path]
    if (!entry.label) problem(`${label}: entry has no label`, path)
    if (!entry.help) problem(`${label}: entry has no help text`, path)
    if (!entry.page) problem(`${label}: entry has no page`, path)
    else if (pageIds.size && !pageIds.has(entry.page)) {
      problem(`${label}: entry points at an unknown page`, `${path} -> "${entry.page}"`)
    }
    checkModes(label, path, entry)
    if (label === 'rules' && path === 'game_type' && entry.choiceLabels) {
      problem('rules: game_type carries hand-written mode names',
        'the mode names come from multi_gametype_help_text, so drop game_type.choiceLabels')
    }
  }
  const generated = new Set(generatedPaths)
  for (const path of have) {
    if (!generated.has(path)) problem(`${label}: describes a setting that no longer exists`, path)
  }
}

crossCheck('rules', rules.flat, authoredRules)

crossCheck('server', server.flat, authoredServer)

// tier 2: every mutator needs an effects entry, and every effect must point at a
// config key that still exists
if (effects) {
  const rulePaths = new Set(rules.flat)
  for (const m of mutators.mutators) {
    const entry = effects[m.name]
    if (!entry) { problem('mutator has no effects entry', `${m.name} ("${m.label}")`); continue }
    if (!entry.summary) problem('mutator effects entry has no summary', m.name)
    const optionNames = new Set(m.options.map(o => o.name))
    for (const set of entry.sets ?? []) {
      if (!set.key) problem('mutator effect has no key', m.name)
      else if (!rulePaths.has(set.key)) {
        problem('mutator effect points at a setting that does not exist', `${m.name} -> "${set.key}"`)
      }
      if (set.value === undefined && set.fromOption === undefined) {
        problem('mutator effect has neither a value nor a fromOption', `${m.name} -> "${set.key}"`)
      }
      if (set.fromOption !== undefined && !optionNames.has(set.fromOption)) {
        problem('mutator effect reads an option that does not exist',
          `${m.name} -> "${set.key}" reads "${set.fromOption}"` +
          (optionNames.size ? ` (known: ${[...optionNames].join(', ')})` : ' (it has no options)'))
      }
    }
  }
  const names = new Set(mutators.mutators.map(m => m.name))
  for (const name of Object.keys(effects)) {
    if (name === 'meta') continue
    if (!names.has(name)) problem('effects entry for a mutator that no longer exists', name)
  }
}

const modeRestricted = [
  ...Object.values(authoredRules ?? {}),
  ...Object.values(authoredServer ?? {}),
].filter(e => e.modes || e.notModes || e.teamOnly).length + derivedModeKeys.size

if (problems.length === 0) {
  // TOML is the hand-editing format; the app gets JSON. Compiling it here rather
  // than in gen-schema means the app can only ever import a layer that passed.
  writeFileSync(join(GEN, 'authored.json'), JSON.stringify({
    pages: pagesFile.page,
    rules: authoredRules,
    server: authoredServer,
    mutatorEffects: effects,
  }, null, 2) + '\n')

  const counts = [
    `${rules.flat.length} rules settings`,
    `${server.flat.length} server settings`,
    `${mutators.mutators.length} mutators`,
    `${pageIds.size} pages`,
    `${modeRestricted} mode-specific settings`,
  ]
  console.log(`schema check passed: ${counts.join(', ')}`)
  console.log('wrote schema/generated/authored.json')
  process.exit(0)
}

const byKind = new Map()
for (const { kind, detail } of problems) {
  if (!byKind.has(kind)) byKind.set(kind, [])
  byKind.get(kind).push(detail)
}

console.error(`\nschema check failed: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`)
for (const [kind, details] of byKind) {
  console.error(`  ${kind} (${details.length}):`)
  for (const d of details.slice(0, 25)) console.error(`    ${d}`)
  if (details.length > 25) console.error(`    ... and ${details.length - 25} more`)
  console.error('')
}
process.exit(1)
