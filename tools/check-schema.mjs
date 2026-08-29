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

// the game data tables, which the loadout the game types hand out is stated in
// terms of - a weapon name in the Alpine source that no longer names a weapon
// would leave the tool showing a kit the server does not give out
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

// generated choices, by the same dotted path the authored layer keys off. a key
// whose valid values the source states is not free text, so the authored layer
// owes each of them a name the user can read.
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

// generated array item fields, keyed the same way. a list is drawn as a table,
// so every column the file can hold owes the user a heading.
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
    if (entry.fields) problem(`${label}: names columns on a setting that has none`, path)
    return
  }
  for (const field of fields) {
    const named = authoredFields[field.key]
    if (!named?.label) { problem(`${label}: list column with no name`, `${path} -> ${field.key}`); continue }
    if (named.lookup === undefined) continue
    // the parser already says which table a name is checked against, so an
    // authored one is either a second copy of that or a claim about a field the
    // source does not check - only the second is worth having
    if (field.lookup) {
      problem(`${label}: restates a lookup the source already states`, `${path} -> ${field.key}`)
    } else if (!lookupTables.includes(named.lookup)) {
      problem(`${label}: column names an unknown game data table`,
        `${path} -> ${field.key} -> "${named.lookup}" (known: ${lookupTables.join(', ')})`)
    }
  }
  for (const named of Object.keys(authoredFields)) {
    if (!fields.some(f => f.key === named)) {
      problem(`${label}: names a list column that no longer exists`, `${path} -> "${named}"`)
    }
  }
}

function checkChoiceLabels(label, path, entry) {
  const choices = generatedChoices[label]?.get(path)
  if (!choices) return
  const labels = entry.choiceLabels ?? {}
  const missing = choices.filter(c => !labels[c])
  if (missing.length) {
    problem(`${label}: choices with no name`, `${path} -> ${missing.join(', ')}`)
  }
  for (const named of Object.keys(labels)) {
    if (!choices.includes(named)) {
      problem(`${label}: names a choice that no longer exists`, `${path} -> "${named}"`)
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
    if (!entry.help) problem(`${label}: entry has no help text`, path)
    if (entry.link && !/^https:\/\//.test(entry.link)) {
      problem(`${label}: entry link is not an https url`, `${path} -> "${entry.link}"`)
    }
    if (entry.linkLabel && !entry.link) {
      problem(`${label}: entry names a link it does not have`, path)
    }
    if (!entry.page) problem(`${label}: entry has no page`, path)
    else if (pageIds.size && !pageIds.has(entry.page)) {
      problem(`${label}: entry points at an unknown page`, `${path} -> "${entry.page}"`)
    }
    checkModes(label, path, entry)
    if (label === 'rules' && path === 'game_type') {
      if (entry.choiceLabels) {
        problem('rules: game_type carries hand-written mode names',
          'the mode names come from multi_gametype_help_text, so drop game_type.choiceLabels')
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
      if (Array.isArray(set.value)) checkReplacementList(m.name, set)
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

// a mutator that replaces a list rather than setting a value. the entries are
// written the way the config file writes them, so they have to key off the same
// field and name things the game has.
function checkReplacementList(name, set) {
  const key = rules.keys.find(k => k.key === set.key)
  const mergeKey = key?.kind === 'array' ? key.mergeKey : undefined
  if (!mergeKey) {
    problem('mutator effect replaces a list that does not merge by a key', `${name} -> "${set.key}"`)
    return
  }
  const lookup = key.item.find(f => f.key === mergeKey)?.lookup
  for (const row of set.value) {
    const id = row?.[mergeKey]
    if (typeof id !== 'string' || id === '') {
      problem('mutator effect list entry with nothing to key it by',
        `${name} -> "${set.key}" wants a ${mergeKey}`)
      continue
    }
    if (lookup === 'weapon' && !weaponNamed(id)) {
      problem('mutator effect list entry names a weapon the game does not have', `${name}: ${id}`)
    }
  }
}

/**
 * A row the parser seeds into a list before reading the file. The name has to
 * still be a weapon, for the same reason a kit's does: Alpine patches the stock
 * fusion behavior out of the game and puts it back through this row, so a name
 * that stopped resolving would leave the tool describing a weapon stay rule the
 * server does not apply.
 */
function checkSeedRows(key) {
  const mergeKey = key.mergeKey
  for (const row of key.seed) {
    if (!mergeKey || row[mergeKey] === undefined) {
      problem('seeded list row with nothing to key it by', `${key.key} wants a ${mergeKey ?? 'merge key'}`)
      continue
    }
    for (const [field, value] of Object.entries(row)) {
      const column = key.item?.find(f => f.key === field)
      if (!column) {
        problem('seeded list row sets a column the list does not have', `${key.key} -> ${field}`)
        continue
      }
      if (column.lookup === 'weapon' && !weaponNamed(value)) {
        problem('seeded list row names a weapon the game does not have', `${key.key}: ${value}`)
      }
    }
  }
}

function checkLoadoutOps(label, ops) {
  for (const op of ops ?? []) {
    if (op.op === 'loadoutAdd') {
      if (!weaponNamed(op.weapon)) {
        problem('game type kit names a weapon the game does not have', `${label}: ${op.weapon}`)
        continue
      }
      if (op.ammo === null && !op.ammoFrom) {
        problem('game type kit entry with no reserve ammo', `${label}: ${op.weapon}`)
      }
    }
    if (!op.ammoFrom) continue
    const source = op.ammoFrom.weapon ? weaponNamed(op.ammoFrom.weapon) : weapons[0]
    if (!source) {
      problem('reserve ammo read from a weapon the game does not have',
        `${label}: ${op.ammoFrom.weapon}`)
    }
    else if (source[op.ammoFrom.field] === undefined) {
      problem('reserve ammo read from a weapon table column that is gone',
        `${label}: ${op.ammoFrom.field}`)
    }
  }
}

for (const key of rules.keys) if (key.kind === 'array' && key.seed) checkSeedRows(key)

checkLoadoutOps('every mode', gametypes.defaults.common)
checkLoadoutOps('modes with no case of their own', gametypes.defaults.fallback)
checkLoadoutOps('after the mode', gametypes.defaults.after)
for (const [mode, ops] of Object.entries(gametypes.defaults.perType)) checkLoadoutOps(mode, ops)

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
