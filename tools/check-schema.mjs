// fails the build when the authored schema drifts from the generated one.
// run after tools/gen-schema.mjs.

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

// weapon names in the alpine source must still resolve against the game data
const weapons = JSON.parse(readFileSync(join(ROOT, 'gamedata/weapons.json'), 'utf8'))
const weaponNamed = name =>
  weapons.find(w => normalName(w.name) === normalName(String(name ?? '')))
const normalName = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const pagesFile = loadAuthored('pages.toml')
const authoredRules = loadAuthored('rules.toml')
const authoredServer = loadAuthored('server.toml')
const effects = loadAuthored('mutator-effects.toml')

const pageIds = new Set((pagesFile?.page ?? []).map(p => p.id))
if (pagesFile && pageIds.size === 0) problem('no pages', 'pages.toml declares no [[page]] entries')

// keys whose game type gating is derived from the source; authored gating on them is rejected
const modeNames = new Set(gametypes.gametypes.map(g => g.name))
const derivedModeKeys = new Map()
for (const g of gametypes.gametypes) {
  if (g.scoreLimitKey) derivedModeKeys.set(g.scoreLimitKey, 'per-mode score limit')
}
for (const path of rules.flat) {
  if (path === 'rounds' || path.startsWith('rounds.')) {
    derivedModeKeys.set(path, 'gated by gt_type_uses_rounds')
  }
}

function checkModes(label, path, entry) {
  const given = ['modes', 'notModes', 'teamOnly'].filter(f => entry[f] !== undefined)
  if (given.length === 0) return
  if (given.length > 1) {
    problem(`${label}: conflicting mode gating`, `${path} - has ${given.join(' and ')}`)
    return
  }
  if (label === 'rules' && derivedModeKeys.has(path)) {
    problem(`${label}: ${given[0]} set on a generator-gated key`,
      `${path} - ${derivedModeKeys.get(path)}, remove the authored gating`)
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
      problem(`${label}: ${field} names an unknown game type`,
        `${path} -> "${mode}" (known: ${[...modeNames].join(', ')})`)
    }
  }
  if (list.length === modeNames.size) {
    problem(`${label}: ${field} lists every game type`, `${path} - remove it`)
  }
}

// every choice the source states needs an authored label
function choicesByPath(keys, prefix = '', into = new Map()) {
  for (const key of keys) {
    const path = prefix + key.key
    if (key.choices) into.set(path, key.choices)
    if (key.keys) choicesByPath(key.keys, path + '.', into)
  }
  return into
}

const generatedChoices = {
  rules: choicesByPath(rules.keys),
  server: choicesByPath([...server.keys, ...server.tables, ...server.arrays]),
}

// every list column needs an authored heading
function itemFieldsByPath(keys, prefix = '', into = new Map()) {
  for (const key of keys) {
    const path = prefix + key.key
    if (key.item?.length) into.set(path, key.item)
    if (key.keys) itemFieldsByPath(key.keys, path + '.', into)
  }
  return into
}

const generatedFields = {
  rules: itemFieldsByPath(rules.keys),
  server: itemFieldsByPath([...server.keys, ...server.tables, ...server.arrays]),
}

const lookupTables = ['weapon', 'item', 'character']

function checkFieldLabels(label, path, entry) {
  const fields = generatedFields[label]?.get(path)
  const authoredFields = entry.fields ?? {}
  if (!fields) {
    if (entry.fields) problem(`${label}: column names on a setting with no columns`, path)
    return
  }
  for (const field of fields) {
    const named = authoredFields[field.key]
    if (!named?.label) { problem(`${label}: list column has no heading`, `${path} -> ${field.key}`); continue }
    if (named.lookup === undefined) continue
    // an authored lookup is only allowed where the source does not state one
    if (field.lookup) {
      problem(`${label}: redundant lookup, the source already states one`, `${path} -> ${field.key}`)
    } else if (!lookupTables.includes(named.lookup)) {
      problem(`${label}: column has an unknown lookup table`,
        `${path} -> ${field.key} -> "${named.lookup}" (known: ${lookupTables.join(', ')})`)
    }
  }
  for (const named of Object.keys(authoredFields)) {
    if (!fields.some(f => f.key === named)) {
      problem(`${label}: heading for a list column that no longer exists`, `${path} -> "${named}"`)
    }
  }
}

function checkChoiceLabels(label, path, entry) {
  const choices = generatedChoices[label]?.get(path)
  if (!choices) return
  const labels = entry.choiceLabels ?? {}
  const missing = choices.filter(c => !labels[c])
  if (missing.length) {
    problem(`${label}: choices with no label`, `${path} -> ${missing.join(', ')}`)
  }
  for (const named of Object.keys(labels)) {
    if (!choices.includes(named)) {
      problem(`${label}: label for a choice that no longer exists`, `${path} -> "${named}"`)
    }
  }
  for (const [alias, target] of Object.entries(entry.aliases ?? {})) {
    for (const name of [alias, target]) {
      if (!choices.includes(name)) {
        problem(`${label}: alias names a choice that no longer exists`, `${path} -> "${name}"`)
      }
    }
  }
}

function crossCheck(label, generatedPaths, authored) {
  if (!authored) return
  const have = new Set(Object.keys(authored))
  for (const path of generatedPaths) {
    if (!have.has(path)) { problem(`${label}: unlabeled setting`, path); continue }
    const entry = authored[path]
    if (!entry.label) problem(`${label}: entry has no label`, path)
    if (entry.link && !/^https:\/\//.test(entry.link)) {
      problem(`${label}: entry link is not an https url`, `${path} -> "${entry.link}"`)
    }
    if (entry.linkLabel && !entry.link) {
      problem(`${label}: entry has linkLabel but no link`, path)
    }
    if (!entry.page) problem(`${label}: entry has no page`, path)
    else if (pageIds.size && !pageIds.has(entry.page)) {
      problem(`${label}: entry points at an unknown page`, `${path} -> "${entry.page}"`)
    }
    checkModes(label, path, entry)
    if (label === 'rules' && path === 'game_type') {
      if (entry.choiceLabels) {
        problem('rules: game_type has authored choiceLabels',
          'names come from multi_gametype_help_text, remove game_type.choiceLabels')
      }
    } else {
      checkChoiceLabels(label, path, entry)
    }
    checkFieldLabels(label, path, entry)
  }
  const generated = new Set(generatedPaths)
  for (const path of have) {
    if (!generated.has(path)) problem(`${label}: describes a setting that no longer exists`, path)
  }
}

crossCheck('rules', rules.flat, authoredRules)

crossCheck('server', server.flat, authoredServer)

// with advanced settings hidden, a basic setting must be reachable and a settings
// page must not render empty
if (pagesFile) {
  const advancedPages = new Set(pagesFile.page.filter(p => p.advanced).map(p => p.id))
  const basicPages = new Set()
  for (const [label, entries] of [['rules', authoredRules], ['server', authoredServer]]) {
    for (const [path, entry] of Object.entries(entries ?? {})) {
      if (!entry.basic) continue
      if (advancedPages.has(entry.page)) {
        problem(`${label}: basic setting on an advanced page`, `${path} -> "${entry.page}"`)
      }
      basicPages.add(entry.page)
    }
  }
  for (const p of pagesFile.page) {
    if (p.scope !== 'other' && !p.advanced && !basicPages.has(p.id)) {
      problem('page has no basic settings and is not marked advanced', p.id)
    }
  }
}

// every mutator needs an effects entry pointing at existing keys
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
        problem('mutator effect targets an unknown setting', `${m.name} -> "${set.key}"`)
      }
      if (set.value === undefined && set.fromOption === undefined) {
        problem('mutator effect has no value or fromOption', `${m.name} -> "${set.key}"`)
      }
      if (Array.isArray(set.value)) checkReplacementList(m.name, set)
      if (set.fromOption !== undefined && !optionNames.has(set.fromOption)) {
        problem('mutator effect reads an unknown option',
          `${m.name} -> "${set.key}" reads "${set.fromOption}"` +
          (optionNames.size ? ` (known: ${[...optionNames].join(', ')})` : ' (mutator has no options)'))
      }
    }
  }
  const names = new Set(mutators.mutators.map(m => m.name))
  for (const name of Object.keys(effects)) {
    if (name === 'meta') continue
    if (!names.has(name)) problem('effects entry for a mutator that no longer exists', name)
  }
}

// list entries are written as in the config file, so they need the merge key and real names
function checkReplacementList(name, set) {
  const key = rules.keys.find(k => k.key === set.key)
  const mergeKey = key?.kind === 'array' ? key.mergeKey : undefined
  if (!mergeKey) {
    problem('mutator effect replaces a list with no merge key', `${name} -> "${set.key}"`)
    return
  }
  const lookup = key.item.find(f => f.key === mergeKey)?.lookup
  for (const row of set.value) {
    const id = row?.[mergeKey]
    if (typeof id !== 'string' || id === '') {
      problem('mutator effect list entry has no merge key',
        `${name} -> "${set.key}" wants a ${mergeKey}`)
      continue
    }
    if (lookup === 'weapon' && !weaponNamed(id)) {
      problem('mutator effect list entry names an unknown weapon', `${name}: ${id}`)
    }
  }
}

// seeded rows restore stock behavior alpine patched out, so their names must still resolve
function checkSeedRows(key) {
  const mergeKey = key.mergeKey
  for (const row of key.seed) {
    if (!mergeKey || row[mergeKey] === undefined) {
      problem('seeded list row has no merge key', `${key.key} wants a ${mergeKey ?? 'merge key'}`)
      continue
    }
    for (const [field, value] of Object.entries(row)) {
      const column = key.item?.find(f => f.key === field)
      if (!column) {
        problem('seeded list row sets an unknown column', `${key.key} -> ${field}`)
        continue
      }
      if (column.lookup === 'weapon' && !weaponNamed(value)) {
        problem('seeded list row names an unknown weapon', `${key.key}: ${value}`)
      }
    }
  }
}

function checkLoadoutOps(label, ops) {
  for (const op of ops ?? []) {
    if (op.op === 'loadoutAdd') {
      if (!weaponNamed(op.weapon)) {
        problem('game type loadout names an unknown weapon', `${label}: ${op.weapon}`)
        continue
      }
      if (op.ammo === null && !op.ammoFrom) {
        problem('game type loadout entry has no reserve ammo', `${label}: ${op.weapon}`)
      }
    }
    if (!op.ammoFrom) continue
    const source = op.ammoFrom.weapon ? weaponNamed(op.ammoFrom.weapon) : weapons[0]
    if (!source) {
      problem('reserve ammo read from an unknown weapon',
        `${label}: ${op.ammoFrom.weapon}`)
    }
    else if (source[op.ammoFrom.field] === undefined) {
      problem('reserve ammo read from a missing weapon table column',
        `${label}: ${op.ammoFrom.field}`)
    }
  }
}

for (const key of rules.keys) if (key.kind === 'array' && key.seed) checkSeedRows(key)

checkLoadoutOps('common', gametypes.defaults.common)
checkLoadoutOps('fallback', gametypes.defaults.fallback)
checkLoadoutOps('after', gametypes.defaults.after)
for (const [mode, ops] of Object.entries(gametypes.defaults.perType)) checkLoadoutOps(mode, ops)

const modeRestricted = [
  ...Object.values(authoredRules ?? {}),
  ...Object.values(authoredServer ?? {}),
].filter(e => e.modes || e.notModes || e.teamOnly).length + derivedModeKeys.size

if (problems.length === 0) {
  // compiled only on success so the app never imports an unchecked layer
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
