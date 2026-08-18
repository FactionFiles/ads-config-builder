// Generates schema/generated/*.json by parsing the pinned Alpine Faction source.
//
// It parses rather than runs: the mutator apply functions read runtime globals,
// and the codebase is a Windows game patch that will not build on a CI runner.
// The tradeoff is that every pattern this relies on is a shape in the upstream
// source that a refactor could break, so every extractor fails loudly with the
// pattern that stopped matching rather than quietly emitting less.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'vendor/AlpineFaction')
const OUT = join(ROOT, 'schema/generated')

class SchemaError extends Error {}

function fail(what, detail) {
  throw new SchemaError(
    `${what}\n  ${detail}\n\n` +
    `  The upstream source shape this generator relies on has changed.\n` +
    `  Fix the extractor in tools/gen-schema.mjs, or roll the vendor/AlpineFaction pin back.`
  )
}

export function expect(cond, what, detail) {
  if (!cond) fail(what, detail)
}

export function read(rel) {
  const p = join(SRC, rel)
  expect(existsSync(p), `Source file missing: ${rel}`, `Expected it at ${p}`)
  return readFileSync(p, 'utf8')
}

// strip // and /* */ comments without eating them out of string literals
export function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'") {
      const quote = c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

// body of `<intro>{ ... }`, brace-matched from the first { after the match index
export function bodyAt(src, fromIndex) {
  const open = src.indexOf('{', fromIndex)
  expect(open !== -1, 'Brace-matching failed', `No opening brace after index ${fromIndex}`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  fail('Brace-matching failed', `Unbalanced braces starting at index ${open}`)
}

export function funcBody(src, signaturePattern, label) {
  const m = src.match(signaturePattern)
  expect(m, `Could not find ${label}`, `Pattern: ${signaturePattern}`)
  return bodyAt(src, m.index + m[0].length - 1)
}

// ---------------------------------------------------------------------------
// C++ literals
// ---------------------------------------------------------------------------

const INT_TYPES = new Set([
  'int', 'unsigned', 'unsigned int', 'short', 'long', 'size_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
])

export function normalizeType(cppType) {
  const t = cppType.replace(/\bconst\b/g, '').replace(/[&]/g, '').trim()
  if (t === 'bool') return 'bool'
  if (t === 'float' || t === 'double') return 'float'
  if (INT_TYPES.has(t)) return 'int'
  if (t === 'std::string' || t === 'std::string_view') return 'string'
  return null // a struct, container, enum or something else we do not treat as a scalar
}

// returns {ok:true, value} for literals we understand, {ok:false} otherwise
export function parseLiteral(raw) {
  const s = raw.trim().replace(/^\{|\}$/g, '').trim()
  if (s === '') return { ok: false }
  if (s === 'true') return { ok: true, value: true }
  if (s === 'false') return { ok: true, value: false }
  const str = s.match(/^"((?:[^"\\]|\\.)*)"$/)
  if (str) return { ok: true, value: str[1].replace(/\\(.)/g, '$1') }
  const num = s.match(/^-?(?:\d+\.?\d*|\.\d+)(?:[fF]|[uU]?[lL]*)?$/)
  if (num) return { ok: true, value: Number(s.replace(/[fFuUlL]+$/, '')) }
  return { ok: false }
}

// ---------------------------------------------------------------------------
// struct table: members, their defaults, and what each setter writes
// ---------------------------------------------------------------------------

// A setter is the only place the config-file value and the stored value can
// differ, so it is where the UI gets its bounds and its units. Setter bodies are
// short but not always a single statement, so follow the argument through any
// locals it passes through rather than only matching `member = f(arg)`.
function analyzeSetter(body, argName, members) {
  const tainted = new Set([argName])
  const result = { scale: 1 }

  // locals carrying the argument forward, e.g. `int value_int = static_cast<int>(in_value * 1000);`
  for (const m of body.matchAll(/(?:^|\n)\s*(?:[A-Za-z_][\w:<>\s*&]*\s+)?([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) {
    const [, name, expr] = m
    if (members[name]) continue
    if ([...tainted].some(t => new RegExp(`\\b${t}\\b`).test(expr))) tainted.add(name)
  }

  // the assignment into a member that carries the argument
  let target = null
  for (const m of body.matchAll(/(?:^|\n|\{|;)\s*([a-z_]\w*)\s*(?:=\s*([^;]+)|\.assign\s*\(([^;]+)\))\s*;/g)) {
    const [, name, rhs, assigned] = m
    if (!members[name]) continue
    const expr = rhs ?? assigned
    if ([...tainted].some(t => new RegExp(`\\b${t}\\b`).test(expr))) target = name
  }
  if (!target) return null
  result.target = target

  // unit conversion between the config value and the stored value
  for (const t of tainted) {
    const mul = body.match(new RegExp(`\\b${t}\\s*\\*\\s*(-?[\\d.]+)f?`))
    if (mul) { result.scale = Number(mul[1]); break }
    const div = body.match(new RegExp(`\\b${t}\\s*/\\s*(-?[\\d.]+)f?`))
    if (div) { result.scale = 1 / Number(div[1]); break }
  }

  const clamp = callArgs(body, 'std::clamp')
  if (clamp && clamp.length === 3) {
    const lo = parseLiteral(clamp[1])
    const hi = parseLiteral(clamp[2])
    if (lo.ok) result.min = lo.value / result.scale
    if (hi.ok) result.max = hi.value / result.scale
  } else {
    const max = callArgs(body, 'std::max')
    if (max && max.length === 2) {
      const lo = parseLiteral(max[1])
      if (lo.ok) result.min = lo.value / result.scale
    }
    const min = callArgs(body, 'std::min')
    if (min && min.length === 2) {
      const hi = parseLiteral(min[1])
      if (hi.ok) result.max = hi.value / result.scale
    }
  }

  // string length caps show up as a trim rather than a clamp
  const trim = body.match(/\.substr\s*\(\s*0\s*,\s*(\d+)\s*\)/) ?? body.match(/\.size\(\)\s*>\s*(\d+)/)
  if (trim) result.maxLength = Number(trim[1])

  // a name resolved against a game data table rather than stored as given
  const lookup = body.match(/rf::weapon_lookup_type|rf::multi_find_character|item_lookup_type/)
  if (lookup) {
    result.lookup = lookup[0].includes('weapon') ? 'weapon'
      : lookup[0].includes('character') ? 'character' : 'item'
  }

  return result
}

// arguments of the first `name(...)` call in expr, paren-balanced
function callArgs(expr, name) {
  const at = expr.indexOf(name + '(')
  if (at === -1) return null
  const open = at + name.length
  let depth = 0
  for (let i = open; i < expr.length; i++) {
    if (expr[i] === '(') depth++
    else if (expr[i] === ')') {
      depth--
      if (depth === 0) return splitTopLevelArgs(expr.slice(open + 1, i))
    }
  }
  return null
}

export function splitTopLevelArgs(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '<' || ch === '[') depth++
    else if (ch === ')' || ch === '>' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur)
  return out.map(x => x.trim())
}

export function parseStructs(src) {
  const structs = {}
  const re = /\bstruct\s+([A-Za-z_]\w*)\s*(?::[^{;]*)?\{/g
  let m
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    const body = bodyAt(src, m.index + m[0].length - 1)
    structs[name] = { name, members: {}, setters: {} }

    // members: `Type name = literal;` or `Type name;`, at any nesting depth of
    // template args but not inside a nested function body
    const flat = stripNestedBraces(body)
    const memRe = /(^|\n)\s*((?:const\s+)?(?:[A-Za-z_]\w*(?:::\w+)*)(?:\s*<[^;{}]*>)?)\s+([a-z_]\w*)\s*(?:=\s*([^;]+?))?\s*;/g
    let mm
    while ((mm = memRe.exec(flat)) !== null) {
      const [, , type, member, init] = mm
      if (['return', 'else', 'case', 'using', 'typedef', 'friend'].includes(type.trim())) continue
      const entry = { type: type.trim(), scalar: normalizeType(type) }
      if (init !== undefined) {
        const lit = parseLiteral(init)
        if (lit.ok) entry.default = lit.value
        else entry.defaultExpr = init.trim()
      } else if (entry.scalar) {
        // an uninitialized scalar member; C++ leaves it indeterminate, so flag it
        entry.uninitialized = true
      }
      structs[name].members[member] = entry
    }

    // setters: `void set_x(Type arg) { ... }`
    const setRe = /\bvoid\s+(set_\w+)\s*\(([^)]*)\)\s*\{/g
    let sm
    while ((sm = setRe.exec(body)) !== null) {
      const setter = sm[1]
      const params = splitTopLevelArgs(sm[2])
      const argName = params.length === 1 ? (params[0].match(/([A-Za-z_]\w*)\s*$/)?.[1] ?? null) : null
      const setBody = bodyAt(body, sm.index + sm[0].length - 1)
      const analyzed = argName ? analyzeSetter(setBody, argName, structs[name].members) : null
      structs[name].setters[setter] = analyzed ?? { opaque: true }
    }
  }
  return structs
}

// blank out anything inside a nested { } so member scanning does not walk into
// method bodies, while keeping character offsets intact
function stripNestedBraces(body) {
  let out = ''
  let depth = 0
  for (const ch of body) {
    if (ch === '{') { depth++; out += ' '; continue }
    if (ch === '}') { depth--; out += ' '; continue }
    out += depth > 0 ? (ch === '\n' ? '\n' : ' ') : ch
  }
  return out
}

// ---------------------------------------------------------------------------
// TOML key extraction from the parser functions in dedi_cfg.cpp
// ---------------------------------------------------------------------------

// every `if (<cond>) <consequent>` in a function body, with parens and braces matched
export function scanIfStatements(body) {
  const out = []
  let i = 0
  while (i < body.length) {
    const at = body.indexOf('if', i)
    if (at === -1) break
    // must be the keyword, not part of an identifier
    const before = body[at - 1]
    const after = body.slice(at + 2).match(/^\s*\(/)
    if ((before && /[\w]/.test(before)) || !after) { i = at + 2; continue }

    const openParen = body.indexOf('(', at)
    let depth = 0
    let closeParen = -1
    for (let k = openParen; k < body.length; k++) {
      if (body[k] === '(') depth++
      else if (body[k] === ')') { depth--; if (depth === 0) { closeParen = k; break } }
    }
    if (closeParen === -1) { i = at + 2; continue }

    const cond = body.slice(openParen + 1, closeParen)
    const rest = body.slice(closeParen + 1)
    const lead = rest.match(/^\s*/)[0]
    let consequent
    if (rest[lead.length] === '{') {
      consequent = bodyAt(rest, lead.length)
      i = closeParen + 1 + lead.length + consequent.length + 2
    } else {
      const semi = rest.indexOf(';')
      consequent = semi === -1 ? '' : rest.slice(lead.length, semi)
      i = closeParen + 1 + (semi === -1 ? lead.length : semi + 1)
    }
    out.push({ cond, consequent, start: at, end: i })
  }
  return out
}

const ACCESSOR = /\[\s*"([\w.]+)"\s*\]\s*\.\s*(value<([^>]+)>|value_or<([^>]+)>|as_table|as_array)/

// resolve a member/setter path such as `bagman.set_bag_score_limit` against the
// struct table, returning the default plus any bounds and unit scale
function resolveTarget(structs, structName, path) {
  const parts = path.split('.')
  let cur = structs[structName]
  if (!cur) return null

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const last = i === parts.length - 1

    if (last && cur.setters[part]) {
      const setter = cur.setters[part]
      if (setter.opaque) return { via: 'setter', opaque: true, struct: cur.name, setter: part }
      const member = cur.members[setter.target]
      const res = { via: 'setter', struct: cur.name, setter: part, member: setter.target, scale: setter.scale }
      if (setter.min !== undefined) res.min = setter.min
      if (setter.max !== undefined) res.max = setter.max
      if (member) {
        if (typeof member.default === 'number') res.default = member.default / (setter.scale ?? 1)
        else if (member.default !== undefined) res.default = member.default
        else if (member.scalar === 'string') res.default = ''
      }
      if (setter.maxLength !== undefined) res.maxLength = setter.maxLength
      if (setter.lookup) res.lookup = setter.lookup
      if (member?.scalar) res.storedType = member.scalar
      return res
    }

    const member = cur.members[part]
    if (!member) return null
    if (last) {
      const res = { via: 'member', struct: cur.name, member: part, scale: 1 }
      if (member.default !== undefined) res.default = member.default
      else if (member.scalar === 'string') res.default = ''
      else if (member.uninitialized) res.uninitialized = true
      if (member.scalar) res.storedType = member.scalar
      return res
    }
    cur = structs[member.type]
    if (!cur) return null
  }
  return null
}

// walk one parser function, recursing into the nested `parse_*_config` helpers
export function extractKeys(cpp, structs, fnName, structName, seen = new Set()) {
  expect(!seen.has(fnName), 'Recursive parser function', `${fnName} calls itself`)
  seen = new Set(seen).add(fnName)

  const body = funcBody(cpp, new RegExp(`\\b\\w[\\w:<>&\\s*]*\\b${fnName}\\s*\\([^)]*\\)\\s*\\{`), fnName)

  // a parser can start by delegating to a more general one and then add its own
  // keys, so those inherited keys have to come along
  const inherited = []
  for (const m of body.matchAll(/\b\w+\s+\w+\s*=\s*(parse_\w+)\s*\(\s*\w+\s*\)\s*;/g)) {
    if (seen.has(m[1])) continue
    inherited.push(...extractKeys(cpp, structs, m[1], structName, seen))
  }

  const own = walkBody(cpp, structs, body, structName, seen, null)
  const ownKeys = new Set(own.map(k => k.key))
  return [...inherited.filter(k => !ownKeys.has(k.key)), ...own]
}

// a parser body is a tree of `if`s: some test a TOML key, others gate a group of
// keys on a value already read (`if (v.enabled) { ... }`). The second kind is the
// dependency information the UI needs to grey out fields, so it is kept.
function walkBody(cpp, structs, body, structName, seen, requires) {
  const keys = []

  // some array keys are read by a local lambda called once per key, so the key
  // name lives at the call site rather than in the accessor
  const lambdas = []
  for (const m of body.matchAll(/auto\s+(\w+)\s*=\s*\[[^\]]*\]\s*\(([^)]*)\)\s*\{/g)) {
    lambdas.push({ name: m[1], body: bodyAt(body, m.index + m[0].length - 1) })
  }

  // scan around the lambda bodies - their keys come from the call sites below,
  // so scanning into them would emit the item fields as loose top-level keys
  let scanText = body
  for (const l of lambdas) scanText = scanText.replace(l.body, ' '.repeat(l.body.length))
  const ifs = scanIfStatements(scanText)

  for (const { cond, consequent } of ifs) {
    const acc = cond.match(ACCESSOR)

    if (!acc) {
      // not a key test - a guard around a group of keys
      const inner = walkBody(cpp, structs, consequent, structName, seen, normalizeGuard(cond, requires))
      keys.push(...inner)
      continue
    }

    const [, key, kind, valueType, valueOrType] = acc
    const base = requires ? { requires } : {}

    if (kind === 'as_array') {
      keys.push({ key, kind: 'array', item: extractItemFields(consequent), ...base })
      continue
    }

    if (kind === 'as_table') {
      const call = consequent.match(/=\s*(parse_\w+)\s*\(/)
      if (call) {
        const sub = subStructFor(cpp, structs, consequent, structName)
        const lhs = consequent.match(/[A-Za-z_]\w*((?:\.\w+)+)\s*=/)
        const memberPath = lhs ? lhs[1].replace(/^\./, '') : undefined
        keys.push({ key, kind: 'table', memberPath, keys: extractKeys(cpp, structs, call[1], sub, seen), ...base })
      } else {
        keys.push({ key, kind: 'table', complex: true, ...base })
      }
      continue
    }

    const cppType = (valueType ?? valueOrType).trim()
    const entry = { key, kind: 'scalar', cppType, type: normalizeType(cppType), ...base }

    const assign = consequent.match(/([A-Za-z_]\w*)((?:\.\w+)+)\s*(?:=|\()/)
    if (assign) {
      const path = assign[2].replace(/^\./, '')
      const target = resolveTarget(structs, structName, path)
      const inline = readInlineConstraints(consequent)
      if (target) {
        Object.assign(target, inline)
        Object.assign(entry, target, { target: path })
        // the config file is read as one type and stored as another. usually a
        // deliberate unit conversion, but a bool stored from a float read is an
        // upstream bug the UI must not paper over.
        if (target.storedType && entry.type && target.storedType !== entry.type &&
            !(entry.type === 'float' && target.storedType === 'int') &&
            !(entry.type === 'int' && target.storedType === 'float')) {
          entry.typeMismatch = { readAs: entry.type, storedAs: target.storedType }
        }
      }
      else entry.unresolved = path
    } else {
      entry.unresolved = consequent.trim().slice(0, 80)
    }
    keys.push(entry)
  }

  for (const l of lambdas) {
    for (const call of body.matchAll(new RegExp(`\\b${l.name}\\s*\\(\\s*"(\\w+)"`, 'g'))) {
      keys.push({
        key: call[1],
        kind: 'array',
        item: extractItemFields(l.body),
        ...(requires ? { requires } : {}),
      })
    }
  }

  // accessors outside any `if` - rare, but silently dropping one would lose a key
  const covered = ifs.map(x => scanText.slice(x.start, x.end)).join('\n')
  for (const m of scanText.matchAll(new RegExp(ACCESSOR.source, 'g'))) {
    if (covered.includes(m[0])) continue
    const cppType = (m[3] ?? m[4] ?? '').trim()
    keys.push({
      key: m[1],
      kind: m[2] === 'as_array' ? 'array' : m[2] === 'as_table' ? 'table' : 'scalar',
      cppType: cppType || undefined,
      type: cppType ? normalizeType(cppType) : undefined,
      bare: true,
      ...(requires ? { requires } : {}),
    })
  }

  return keys
}

// some keys are clamped where they are read rather than in a setter
function readInlineConstraints(consequent) {
  const out = {}
  const clamp = callArgs(consequent, 'std::clamp')
  if (clamp && clamp.length === 3) {
    const lo = parseLiteral(clamp[1])
    const hi = parseLiteral(clamp[2])
    if (lo.ok) out.min = lo.value
    if (hi.ok) out.max = hi.value
  } else {
    const max = callArgs(consequent, 'std::max')
    if (max && max.length === 2) {
      const lo = parseLiteral(max[1])
      if (lo.ok) out.min = lo.value
    }
    const min = callArgs(consequent, 'std::min')
    if (min && min.length === 2) {
      const hi = parseLiteral(min[1])
      if (hi.ok) out.max = hi.value
    }
  }
  return out
}

// `v.enabled` -> depends on the sibling key `enabled`. Anything less obvious is
// kept verbatim so it shows up rather than being silently dropped.
function normalizeGuard(cond, outer) {
  const c = cond.trim()
  const simple = c.match(/^!?\s*[A-Za-z_]\w*\.(\w+)$/)
  const negated = c.startsWith('!')
  const g = simple ? { key: simple[1], equals: !negated } : { expr: c }
  return outer ? [...(Array.isArray(outer) ? outer : [outer]), g] : [g]
}

// which struct a nested `x.y = parse_foo(...)` writes into, so the sub-parser's
// keys resolve against the right member table
function subStructFor(cpp, structs, consequent, structName) {
  const lhs = consequent.match(/([A-Za-z_]\w*)((?:\.\w+)+)\s*=/)
  if (lhs) {
    const target = resolveTarget(structs, structName, lhs[2].replace(/^\./, ''))
    if (target && target.member) {
      const parent = structs[target.struct]
      const t = parent?.members[target.member]?.type
      if (t && structs[t]) return t
    }
  }
  // a sub-parser that builds its own value, e.g. `VoteConfig v;` then returns it
  const call = consequent.match(/=\s*(parse_\w+)\s*\(/)
  if (call) {
    const decl = cpp.match(new RegExp(`\\b(\\w+)\\s+${call[1]}\\s*\\(`))
    if (decl && structs[decl[1]]) return decl[1]
  }
  return structName
}

// fields read off each element of an array-of-tables
function extractItemFields(block) {
  const fields = []
  const re = /\[\s*"(\w+)"\s*\]\s*\.\s*(?:value<([^>]+)>|value_or<([^>]+)>)/g
  let m
  while ((m = re.exec(block)) !== null) {
    const cppType = (m[2] ?? m[3]).trim()
    if (!fields.some(f => f.key === m[1])) {
      fields.push({ key: m[1], cppType, type: normalizeType(cppType) })
    }
  }
  return fields
}

// ---------------------------------------------------------------------------
// game types
// ---------------------------------------------------------------------------

export function extractGameTypes(sources, structs) {
  const enumBody = funcBody(sources.multiH, /\benum\s+NetGameType\s*\{/, 'the NetGameType enum')
  const byId = {}
  const order = []
  for (const m of enumBody.matchAll(/\bNG_TYPE_(\w+)\s*=\s*(\d+)/g)) {
    const gt = { id: Number(m[2]), enum: `NG_TYPE_${m[1]}`, names: [], isTeam: false, botsSupported: true }
    byId[gt.enum] = gt
    order.push(gt)
  }
  expect(order.length >= 14, 'Too few game types', `Found ${order.length} in the NetGameType enum, expected at least 14`)

  // config names and aliases, in the order the resolver tests them
  const resolver = funcBody(sources.serverCpp, /\bresolve_gametype_from_name\s*\([^)]*\)\s*\{/, 'resolve_gametype_from_name')
  let pending = []
  for (const line of resolver.split('\n')) {
    for (const m of line.matchAll(/string_iequals\s*\(\s*\w+\s*,\s*"(\w+)"\s*\)/g)) pending.push(m[1])
    const ret = line.match(/return\s+rf::NetGameType::(NG_TYPE_\w+)/)
    if (ret) {
      expect(byId[ret[1]], 'Unknown game type in resolver', `${ret[1]} is not in the NetGameType enum`)
      byId[ret[1]].names.push(...pending)
      pending = []
    }
  }
  const named = order.filter(g => g.names.length > 0)
  expect(named.length >= 14, 'Too few named game types',
    `resolve_gametype_from_name yielded names for ${named.length} types, expected at least 14`)

  // team types
  const teamFn = funcBody(sources.gametypeCpp, /\bmulti_game_type_is_team_type\s*\([^)]*\)\s*\{/, 'multi_game_type_is_team_type')
  const upToTrue = teamFn.slice(0, teamFn.indexOf('return true'))
  for (const m of upToTrue.matchAll(/case\s+rf::(NG_TYPE_\w+)/g)) {
    if (byId[m[1]]) byId[m[1]].isTeam = true
  }
  expect(order.some(g => g.isTeam), 'No team game types found', 'multi_game_type_is_team_type matched nothing')

  // which limit key each type is scored by, straight off get_score_limit
  const scoreFn = funcBody(sources.serverInternalH, /std::optional<int>\s+get_score_limit\s*\([^)]*\)\s*const\s*\{/, 'get_score_limit')
  let cases = []
  for (const line of scoreFn.split('\n')) {
    const c = line.match(/case\s+rf::NetGameType::(NG_TYPE_\w+)\s*:/)
    if (c) cases.push(c[1])
    const isDefault = /^\s*default\s*:/.test(line)
    const ret = line.match(/return\s+([\w.]+|std::nullopt)\s*;/)
    if (!ret) continue
    const target = ret[1] === 'std::nullopt' ? null : ret[1]
    if (isDefault) {
      for (const g of order) if (g.scoreLimitTarget === undefined) g.scoreLimitTarget = target
    } else {
      for (const name of cases) if (byId[name]) byId[name].scoreLimitTarget = target
    }
    cases = []
  }

  // rounds gating, so the rounds settings can hide in the modes that ignore them
  const roundsFn = funcBody(sources.gametypeCpp,
    /\bgt_type_uses_rounds\s*\([^)]*\)\s*\{/, 'gt_type_uses_rounds')
  for (const g of order) g.usesRounds = false
  let roundTypes = 0
  for (const m of roundsFn.matchAll(/rf::NetGameType::(NG_TYPE_\w+)/g)) {
    expect(byId[m[1]], 'Unknown game type in gt_type_uses_rounds', `${m[1]} is not in the NetGameType enum`)
    byId[m[1]].usesRounds = true
    roundTypes++
  }
  expect(roundTypes > 0, 'No game types use rounds', 'gt_type_uses_rounds names no NetGameType values')

  // the one-line mode descriptions the game itself shows
  const helpFn = funcBody(sources.gametypeCpp,
    /\bmulti_gametype_help_text\s*\([^)]*\)\s*\{/, 'multi_gametype_help_text')
  let helpCase = null
  for (const line of helpFn.split('\n')) {
    const c = line.match(/case\s+rf::(NG_TYPE_\w+)\s*:/)
    if (c) helpCase = c[1]
    const ret = line.match(/return\s+"([^"]+)"\s*;/)
    if (!ret || !helpCase) continue
    const gt = byId[helpCase]
    expect(gt, 'Unknown game type in multi_gametype_help_text', `${helpCase} is not in the NetGameType enum`)
    const split = ret[1].indexOf(': ')
    expect(split > 0, 'Game type help text lost its title',
      `Expected "Title: description", got "${ret[1]}" for ${helpCase}`)
    gt.title = ret[1].slice(0, split)
    gt.blurb = ret[1].slice(split + 2)
    helpCase = null
  }
  const described = order.filter(g => g.title).length
  expect(described >= 14, 'Too few described game types',
    `multi_gametype_help_text yielded ${described} descriptions, expected at least 14`)

  // bots: everything the mutator mask does not exclude
  const maskFn = funcBody(sources.mutatorsCpp, /\bgametype_mask_for_req\s*\([^)]*\)\s*\{/, 'gametype_mask_for_req')
  for (const m of maskFn.matchAll(/~\s*\(\s*1u?\s*<<\s*static_cast<int>\s*\(\s*rf::(NG_TYPE_\w+)\s*\)\s*\)/g)) {
    if (byId[m[1]]) byId[m[1]].botsSupported = false
  }

  return named
}

// ---------------------------------------------------------------------------
// per game type defaults
// ---------------------------------------------------------------------------

// apply_defaults_for_game_type is a preamble applied to every type followed by
// one switch case per type. Both are plain assignments, so they read out as a
// list of operations rather than having to be executed.
export function extractGameTypeDefaults(sources, structs) {
  const body = funcBody(sources.dediCpp, /\bapply_defaults_for_game_type\s*\([^)]*\)\s*\{/, 'apply_defaults_for_game_type')
  const switchAt = body.search(/\bswitch\s*\(/)
  expect(switchAt !== -1, 'apply_defaults_for_game_type has no switch',
    'Expected a preamble followed by `switch (game_type)`')

  const common = readDefaultOps(body.slice(0, switchAt), structs)
  expect(common.length > 0, 'No common game type defaults', 'The preamble before the switch produced no operations')

  const switchBody = bodyAt(body, switchAt)
  const perType = {}
  const caseRe = /case\s+rf::NetGameType::(NG_TYPE_\w+)\s*:\s*\{/g
  let m
  while ((m = caseRe.exec(switchBody)) !== null) {
    perType[m[1]] = readDefaultOps(bodyAt(switchBody, m.index + m[0].length - 1), structs)
  }
  expect(Object.keys(perType).length > 0, 'No game type default cases',
    'The switch in apply_defaults_for_game_type matched no `case rf::NetGameType::X: {`')

  return { common, perType }
}

function readDefaultOps(block, structs) {
  const ops = []
  for (const stmt of block.split(';')) {
    const s = stmt.trim()
    if (!s.startsWith('rules.')) continue
    const path = s.slice('rules.'.length)

    const add = path.match(/^spawn_loadout\.add\s*\((.*)\)$/s)
    if (add) {
      const args = splitTopLevelArgs(add[1])
      const weapon = parseLiteral(args[0] ?? '')
      ops.push({
        op: 'loadoutAdd',
        weapon: weapon.ok ? weapon.value : null,
        ammoExpr: args[1]?.trim() ?? null,
        blueTeam: args[2]?.trim() === 'true',
        enabled: args[3]?.trim() !== 'false',
      })
      continue
    }
    if (/^spawn_loadout\.\w+\.clear\s*\(\s*\)$/.test(path)) { ops.push({ op: 'loadoutClear' }); continue }

    const call = path.match(/^([\w.]*?)\.?(\w+)\s*\((.*)\)$/s)
    if (call && call[2].startsWith('set_')) {
      const target = (call[1] ? call[1] + '.' : '') + call[2]
      const lit = parseLiteral(call[3])
      ops.push({ op: 'set', target, value: lit.ok ? lit.value : null, expr: lit.ok ? undefined : call[3].trim() })
      continue
    }

    const assign = path.match(/^([\w.]+)\s*=\s*(.+)$/s)
    if (assign) {
      const lit = parseLiteral(assign[2])
      ops.push({ op: 'set', target: assign[1], value: lit.ok ? lit.value : null, expr: lit.ok ? undefined : assign[2].trim() })
      continue
    }
  }
  return ops
}

// ---------------------------------------------------------------------------
// mutators
// ---------------------------------------------------------------------------

export function extractMutators(sources) {
  // named constants used as option defaults
  const consts = {}
  for (const m of sources.mutatorsCpp.matchAll(/\bstatic\s+constexpr\s+[\w:]+\s+(\w+)\s*=\s*([^;]+);/g)) {
    const lit = parseLiteral(m[2])
    if (lit.ok) consts[m[1]] = lit.value
  }

  const optionTypes = {}
  const optEnum = funcBody(sources.serverInternalH, /\benum\s+class\s+MutatorOptionType\s*:\s*\w+\s*\{/, 'the MutatorOptionType enum')
  for (const m of optEnum.matchAll(/(\w+)\s*=\s*(\d+)/g)) optionTypes[`MutatorOptionType::${m[1]}`] = m[1].toLowerCase()

  const ids = {}
  const idEnum = funcBody(sources.mutatorsH, /\benum\s+class\s+MutatorId\s*:\s*\w+\s*\{/, 'the MutatorId enum')
  for (const m of idEnum.matchAll(/(\w+)\s*=\s*(\d+)/g)) ids[`MutatorId::${m[1]}`] = Number(m[2])
  expect(Object.keys(ids).length >= 20, 'Too few mutator ids',
    `Found ${Object.keys(ids).length} in the MutatorId enum, expected at least 20`)

  // option tables, keyed by their C++ array name
  const optionArrays = {}
  for (const m of sources.mutatorsCpp.matchAll(/\bstatic\s+const\s+MutatorOptionDef\s+(\w+)\s*\[\s*\]\s*=\s*\{/g)) {
    const body = bodyAt(sources.mutatorsCpp, m.index + m[0].length - 1)
    optionArrays[m[1]] = braceRows(body).map(cells => {
      expect(cells.length >= 4, 'Malformed MutatorOptionDef row',
        `In ${m[1]}: expected {id, name, label, type}, got ${cells.length} fields`)
      const type = optionTypes[cells[3]]
      expect(type, 'Unknown MutatorOptionType', `${cells[3]} in ${m[1]}`)
      return {
        id: Number(cells[0]),
        name: parseLiteral(cells[1]).value,
        label: parseLiteral(cells[2]).value,
        type,
      }
    })
  }

  const defsBody = funcBody(sources.mutatorsCpp, /\bstatic\s+const\s+MutatorDef\s+MUTATORS\s*\[\s*\]\s*=\s*\{/, 'the MUTATORS table')
  const mutators = braceRows(defsBody).map(cells => {
    expect(cells.length >= 7, 'Malformed MutatorDef row',
      `Expected at least 7 fields, got ${cells.length}: ${cells.join(' | ')}`)
    const id = ids[cells[0]]
    expect(id !== undefined, 'Unknown MutatorId', `${cells[0]} is not in the MutatorId enum`)

    const minClient = cells[3] === 'MUTATOR_NO_CLIENT_REQUIREMENT' ? 0 : Number(cells[3])
    expect(Number.isFinite(minClient), 'Unparsable min client version', `${cells[3]} for ${cells[1]}`)

    const optionsRef = cells[5]
    let options = []
    if (optionsRef !== 'nullptr') {
      expect(optionArrays[optionsRef], 'Unknown mutator option table', `${optionsRef} for ${cells[1]}`)
      options = optionArrays[optionsRef].map(o => ({ ...o }))
    }

    const req = (cells[7] ?? 'MutatorGametypeReq::Any').replace('MutatorGametypeReq::', '')
    return {
      id,
      name: parseLiteral(cells[1]).value,
      label: parseLiteral(cells[2]).value,
      minClientMinorVersion: minClient,
      gametypeReq: req,
      options,
      voteLabel: cells[8] && cells[8] !== 'nullptr' ? parseLiteral(cells[8]).value : null,
      voteDetailOption: cells[9] && cells[9] !== 'nullptr' ? parseLiteral(cells[9]).value : null,
    }
  })
  expect(mutators.length >= 20, 'Too few mutators',
    `Found ${mutators.length} rows in MUTATORS, expected at least 20`)

  // option defaults, assigned in mutators_get_registry
  const registry = funcBody(sources.mutatorsCpp, /const\s+std::vector<MutatorInfo>&\s+mutators_get_registry\s*\(\s*\)\s*\{/, 'mutators_get_registry')
  for (const m of registry.matchAll(
    /def\.id\s*==\s*MutatorId::(\w+)\s*&&\s*opt\.name\s*==\s*"(\w+)"\s*\)\s*\{([\s\S]*?)\n\s*\}/g)) {
    const mut = mutators.find(x => x.id === ids[`MutatorId::${m[1]}`])
    const opt = mut?.options.find(o => o.name === m[2])
    if (!opt) continue
    const boolDefault = m[3].match(/opt\.default_bool\s*=\s*(\w+)\s*;/)
    if (boolDefault) {
      const lit = parseLiteral(boolDefault[1])
      opt.default = lit.ok ? lit.value : consts[boolDefault[1]]
      if (opt.default === undefined) opt.defaultExpr = boolDefault[1]
      continue
    }
    // a default read off live server state rather than a constant. the UI has to
    // show the current value, so record why instead of inventing a number.
    if (/g_alpine_server_config_active_rules|get_score_limit/.test(m[3])) {
      opt.defaultFrom = 'currentValue'
      continue
    }
    if (/build_featured_weapon_choices/.test(m[3])) {
      // choices are the weapons that have a pickup item; default is the rail gun
      opt.choicesFrom = 'weaponsWithPickup'
      opt.defaultFrom = 'railGun'
    }
  }

  const orderBody = funcBody(sources.mutatorsCpp, /\bstatic\s+const\s+MutatorId\s+MUTATOR_APPLY_ORDER\s*\[\s*\]\s*=\s*\{/, 'MUTATOR_APPLY_ORDER')
  const applyOrder = [...orderBody.matchAll(/MutatorId::(\w+)/g)].map(m => {
    const id = ids[`MutatorId::${m[1]}`]
    expect(id !== undefined, 'Unknown MutatorId in apply order', m[1])
    return id
  })
  expect(applyOrder.length === mutators.length, 'Apply order is incomplete',
    `MUTATOR_APPLY_ORDER lists ${applyOrder.length} entries but MUTATORS has ${mutators.length}`)

  return { mutators, applyOrder }
}

// rows of a `{...}, {...},` initializer list, each split into its top-level fields
function braceRows(body) {
  const rows = []
  let depth = 0
  let start = -1
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') { if (depth === 0) start = i + 1; depth++ }
    else if (body[i] === '}') { depth--; if (depth === 0) rows.push(body.slice(start, i)) }
  }
  return rows.map(r => splitTopLevelArgs(r))
}

// ---------------------------------------------------------------------------
// top-level server keys
// ---------------------------------------------------------------------------

// The top level is dispatched by name rather than parsed positionally:
//   if (key == "server_name") { if (auto v = node.value<std::string>()) cfg.server_name = *v; }
function extractDispatch(cpp, structs, fnName, structName, handle) {
  const body = funcBody(cpp, new RegExp(`\\bstatic\\s+void\\s+${fnName}\\s*\\(`), fnName)
  const keys = []
  for (const { cond, consequent } of scanIfStatements(body)) {
    const named = cond.match(/\bkey\s*==\s*"([\w.]+)"/)
    if (!named) continue
    const entry = handle(named[1], consequent, structs, structName)
    if (entry) keys.push(entry)
  }
  expect(keys.length > 0, `No keys found in ${fnName}`,
    'Expected a chain of `if (key == "...")` branches')
  return keys
}

export function extractServerKeys(sources, structs) {
  const scalars = extractDispatch(sources.dediCpp, structs, 'apply_known_key_in_order', 'AlpineServerConfig',
    (key, consequent, structs, structName) => {
      const acc = consequent.match(/\.\s*(?:value<([^>]+)>|value_or<([^>]+)>)/)
      if (!acc) return { key, kind: 'scalar', complex: true }
      const cppType = (acc[1] ?? acc[2]).trim()
      const entry = { key, kind: 'scalar', cppType, type: normalizeType(cppType) }
      const assign = consequent.match(/\bcfg\s*((?:\.\w+)+)\s*(?:=|\()/)
      if (assign) {
        const path = assign[1].replace(/^\./, '')
        const target = resolveTarget(structs, structName, path)
        if (target) Object.assign(entry, target, { target: path })
        else entry.unresolved = path
      } else if (/g_ads_loaded_version/.test(consequent)) {
        entry.target = 'ads_version'
        entry.global = true
      } else {
        entry.unresolved = consequent.trim().slice(0, 80)
      }
      return entry
    })

  const tables = extractDispatch(sources.dediCpp, structs, 'apply_known_table_in_order', 'AlpineServerConfig',
    (key, consequent, structs, structName) => {
      const call = consequent.match(/=\s*(parse_\w+)\s*\(/)
      if (!call) return { key, kind: 'table', complex: true }
      const sub = subStructFor(sources.dediCpp, structs, consequent, structName)
      return { key, kind: 'table', keys: extractKeys(sources.dediCpp, structs, call[1], sub) }
    })

  const arrays = extractDispatch(sources.dediCpp, structs, 'apply_known_array_in_order', 'AlpineServerConfig',
    (key, consequent, structs, structName) => {
      const call = consequent.match(/\b(parse_\w+|add_\w+_from_table)\s*\(/)
      if (!call) return { key, kind: 'array', complex: true }
      if (call[1].startsWith('parse_')) {
        const decl = sources.dediCpp.match(new RegExp(`\\b(?:std::optional<)?(\\w+)>?\\s+${call[1]}\\s*\\(`))
        const sub = decl && structs[decl[1]] ? decl[1] : structName
        return { key, kind: 'array', keys: extractKeys(sources.dediCpp, structs, call[1], sub) }
      }
      return { key, kind: 'array', via: call[1] }
    })

  return { scalars, tables, arrays }
}

// Not every top-level array goes through apply_known_array_in_order - some are
// handled inline in the dispatcher, and missing one loses a whole config key.
function extractInlineArrays(sources, known) {
  const body = funcBody(sources.dediCpp, /\bstatic\s+void\s+apply_config_table_in_order\s*\(/, 'apply_config_table_in_order')
  const arrayAt = body.search(/if\s*\(\s*auto\*?\s+arr\s*=\s*v\.as_array\s*\(\s*\)\s*\)/)
  expect(arrayAt !== -1, 'The array branch of apply_config_table_in_order is gone',
    'Expected `if (auto* arr = v.as_array())`')
  const arrayBlock = bodyAt(body, arrayAt)

  const out = []
  for (const { cond, consequent } of scanIfStatements(arrayBlock)) {
    const named = cond.match(/\bkey\s*==\s*"([\w.]+)"/)
    if (!named || known.has(named[1])) continue
    // delegated ones are already covered by the array dispatcher
    if (/apply_known_array_in_order/.test(consequent)) continue
    const elem = consequent.match(/\belem\s*\.\s*value<([^>]+)>/)
    out.push({
      key: named[1],
      kind: 'array',
      itemType: elem ? normalizeType(elem[1].trim()) : null,
      inline: true,
    })
  }
  return out
}

// [[levels]] entries accept a fixed, explicitly listed set of keys
export function extractLevelKeys(sources) {
  const body = funcBody(sources.dediCpp, /\bstatic\s+void\s+add_level_entry_from_table\s*\(/, 'add_level_entry_from_table')
  const guard = body.match(/if\s*\(([^)]*key\s*!=[^)]*)\)/)
  expect(guard, 'Could not find the [[levels]] key whitelist',
    'Expected an `if (key != "filename" && ...)` unknown-key warning in add_level_entry_from_table')
  const keys = [...guard[1].matchAll(/key\s*!=\s*"(\w+)"/g)].map(m => m[1])
  expect(keys.length >= 3, 'Too few [[levels]] keys', `Found ${keys.join(', ')}`)
  return keys
}

// how a rules scope pulls in preset files before its own keys are applied
export function extractPresetKeys(sources) {
  const body = funcBody(sources.dediCpp, /\bstatic\s+AlpineServerConfigRules\s+apply_rules_presets_and_overrides\s*\(/, 'apply_rules_presets_and_overrides')
  const keys = [...body.matchAll(/\[\s*"(\w+)"\s*\]/g)].map(m => m[1])
  const uniq = [...new Set(keys)]
  expect(uniq.includes('rules'), 'The `rules` key vanished from apply_rules_presets_and_overrides', `Saw: ${uniq.join(', ')}`)
  expect(uniq.includes('rules_presets'), 'The `rules_presets` key vanished from apply_rules_presets_and_overrides', `Saw: ${uniq.join(', ')}`)
  return uniq
}

// ---------------------------------------------------------------------------
// labels the server already uses
// ---------------------------------------------------------------------------

// print_rules writes the active rules to the console, so upstream already has a
// human label for nearly every setting. Taking them from there beats inventing
// our own and keeps the wording in step with what an operator sees in console.
function extractPrintLabels(sources, targetIndex) {
  const body = funcBody(sources.dediCpp, /\bvoid\s+print_rules\s*\(/, 'print_rules')
  const labels = {}
  let matched = 0

  for (const m of body.matchAll(/format_to\s*\(\s*iter\s*,\s*"((?:[^"\\]|\\.)*)"\s*,([\s\S]*?)\)\s*;/g)) {
    // "  Time limit:      {} min\n" -> label "Time limit", unit "min"
    const fmt = m[1].replace(/\\n/g, '')
    const ph = fmt.indexOf('{')
    const label = (ph === -1 ? fmt : fmt.slice(0, ph)).trim().replace(/:$/, '')
    if (!label) continue
    const tail = ph === -1 ? '' : fmt.slice(fmt.indexOf('}', ph) + 1).trim()
    const unit = /^(min|sec|ms|s|%|hp|x)$/i.test(tail) ? tail : null

    // every rules.<path> the printed value depends on
    const refs = [...m[2].matchAll(/\brules\.([\w.]+)/g)].map(x => x[1])
    for (const ref of refs) {
      const key = targetIndex[ref]
      if (!key || labels[key]) continue
      labels[key] = unit ? { label, unit } : { label }
      matched++
    }
  }

  expect(matched > 20, 'print_rules yielded almost no labels',
    `Only matched ${matched} settings; the std::format_to shape has probably changed`)
  return labels
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

// dotted config path -> entry, for the completeness check and the label files
function flatten(keys, prefix = '') {
  const out = []
  for (const k of keys) {
    const path = prefix + k.key
    if (k.kind === 'table' && k.keys) {
      out.push({ path, kind: 'table' })
      out.push(...flatten(k.keys, path + '.'))
    } else {
      out.push({ ...k, path })
    }
  }
  return out
}

// C++ target path -> config key path, so the per-game-type defaults can be
// reported against the key the user actually sees
function buildTargetIndex(keys, keyPrefix = '', targetPrefix = '') {
  const index = {}
  for (const k of keys) {
    if (k.kind === 'table' && k.keys) {
      Object.assign(index, buildTargetIndex(k.keys, keyPrefix + k.key + '.',
        k.memberPath ? targetPrefix + k.memberPath + '.' : targetPrefix))
      continue
    }
    if (k.kind !== 'scalar') continue
    if (k.target) index[targetPrefix + k.target] = keyPrefix + k.key
    // also index the member the setter writes through, which is what the game
    // type defaults assign to. qualify it with the setter's own path, or
    // `cap_limit` on the rules and `cap_limit` on salvage collide.
    if (k.member) {
      const owner = (k.target ?? '').split('.').slice(0, -1)
      index[targetPrefix + [...owner, k.member].join('.')] = keyPrefix + k.key
    }
  }
  return index
}

function writeJson(name, value) {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + '\n')
  return name
}

function main() {
  const S = f => stripComments(read(f))
  const sources = {
    serverInternalH: S('game_patch/multi/server_internal.h'),
    dediCpp: S('game_patch/multi/dedi_cfg.cpp'),
    mutatorsCpp: S('game_patch/multi/mutators.cpp'),
    mutatorsH: S('game_patch/multi/mutators.h'),
    serverCpp: S('game_patch/multi/server.cpp'),
    gametypeCpp: S('game_patch/multi/gametype.cpp'),
    multiH: S('game_patch/rf/multi.h'),
    versionH: read('common/include/common/version/version.h'),
  }

  const structs = parseStructs(sources.serverInternalH)
  expect(structs.AlpineServerConfigRules, 'AlpineServerConfigRules is gone',
    'server_internal.h no longer declares the rules struct')

  const version = {}
  for (const key of ['VERSION_MAJOR', 'VERSION_MINOR', 'VERSION_PATCH', 'ADS_VERSION']) {
    const m = sources.versionH.match(new RegExp(`#define\\s+${key}\\s+(\\d+)`))
    expect(m, `${key} not found`, 'Expected it in common/include/common/version/version.h')
    version[key] = Number(m[1])
  }

  const rulesKeys = extractKeys(sources.dediCpp, structs, 'parse_server_rules', 'AlpineServerConfigRules')
  const gametypes = extractGameTypes(sources, structs)
  const gametypeDefaults = extractGameTypeDefaults(sources, structs)
  const { mutators, applyOrder } = extractMutators(sources)
  const server = extractServerKeys(sources, structs)
  const levelKeys = extractLevelKeys(sources)
  const presetKeys = extractPresetKeys(sources)
  const botKeys = extractKeys(sources.dediCpp, structs, 'parse_bot_config_table', 'ServerBotConfig')
  server.arrays.push(...extractInlineArrays(sources, new Set(server.arrays.map(a => a.key))))

  // game_type is the one rules key resolved by a lookup rather than a member
  const gt = rulesKeys.find(k => k.key === 'game_type')
  expect(gt, 'The game_type key is gone', 'Expected it at the top of parse_server_rules')
  delete gt.unresolved
  gt.choices = gametypes.map(g => g.names[0])
  gt.default = gametypes[0].names[0]

  const targetIndex = buildTargetIndex(rulesKeys)
  const printLabels = extractPrintLabels(sources, targetIndex)
  const resolveOps = ops => ops.map(op => {
    if (op.op !== 'set') return op
    return { ...op, key: targetIndex[op.target] ?? null }
  })

  const scoreLimitKeys = {}
  for (const g of gametypes) {
    scoreLimitKeys[g.names[0]] = g.scoreLimitTarget ? (targetIndex[g.scoreLimitTarget] ?? null) : null
  }

  mkdirSync(OUT, { recursive: true })
  const written = [
    writeJson('meta.json', {
      adsVersion: version.ADS_VERSION,
      alpineVersion: `${version.VERSION_MAJOR}.${version.VERSION_MINOR}.${version.VERSION_PATCH}`,
      alpineCommit: pinnedCommit(),
    }),
    writeJson('rules.json', { keys: rulesKeys, flat: flatten(rulesKeys).map(k => k.path) }),
    writeJson('console-labels.json', printLabels),
    writeJson('gametypes.json', {
      gametypes: gametypes.map(g => ({
        name: g.names[0],
        aliases: g.names.slice(1),
        id: g.id,
        title: g.title,
        blurb: g.blurb,
        isTeam: g.isTeam,
        botsSupported: g.botsSupported,
        usesRounds: g.usesRounds,
        scoreLimitKey: scoreLimitKeys[g.names[0]],
      })),
      defaults: {
        common: resolveOps(gametypeDefaults.common),
        perType: Object.fromEntries(
          gametypes
            .filter(g => gametypeDefaults.perType[g.enum])
            .map(g => [g.names[0], resolveOps(gametypeDefaults.perType[g.enum])])
        ),
      },
    }),
    writeJson('mutators.json', { mutators, applyOrder }),
    writeJson('server.json', {
      keys: server.scalars,
      tables: server.tables,
      arrays: server.arrays,
      levelKeys,
      presetKeys,
      botKeys,
      // one canonical path per authored entry. the nested key sets live under
      // the key that carries them, so a bot profile's `player_name` cannot
      // collide with a top-level setting of the same name.
      flat: [...new Set([
        ...flatten(server.scalars).map(k => k.path),
        ...flatten(server.tables).map(k => k.path),
        ...server.arrays.map(a => a.key),
        ...server.arrays.flatMap(a => (a.keys ?? []).map(k => `${a.key}.${k.key}`)),
        ...levelKeys.map(k => `levels.${k}`),
        ...presetKeys.map(k => `presets.${k}`),
        ...botKeys.map(k => `bot_profiles.${k.key}`),
      ])],
    }),
  ]

  const scalarCount = flatten(rulesKeys).filter(k => k.kind === 'scalar').length
  console.log(`Alpine ${version.alpineVersion ?? `${version.VERSION_MAJOR}.${version.VERSION_MINOR}.${version.VERSION_PATCH}`}, ads_version ${version.ADS_VERSION}`)
  console.log(`  ${scalarCount} rules settings, ${server.scalars.length} server settings`)
  console.log(`  ${gametypes.length} game types, ${mutators.length} mutators`)
  console.log(`  ${Object.keys(printLabels).length} labels lifted from print_rules`)
  console.log(`  wrote ${written.length} files to schema/generated/`)
}

function pinnedCommit() {
  try {
    const head = readFileSync(join(SRC, '.git'), 'utf8').match(/gitdir:\s*(.+)/)
    const dir = head ? join(SRC, head[1].trim()) : join(SRC, '.git')
    const ref = readFileSync(join(dir, 'HEAD'), 'utf8').trim()
    if (!ref.startsWith('ref:')) return ref
    return readFileSync(join(dir, ref.slice(4).trim()), 'utf8').trim()
  } catch {
    return null
  }
}

// importable for tests without running the generator
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
try {
  main()
} catch (err) {
  if (err instanceof SchemaError) {
    console.error(`\ngen-schema failed.\n\n${err.message}\n`)
    process.exit(1)
  }
  throw err
}
}
