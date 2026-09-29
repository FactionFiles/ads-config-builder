# ADS Config Builder

A web tool for building and editing Alpine Faction dedicated server config files
(`ads.toml`). Read `PLAN.md` first: it holds the design and technical decisions,
milestones and status, and reference notes on the Alpine source.

## Core idea

Alpine resolves a server's rules in layers: built-in default, game type
defaults, mutators, then keys set by hand. This runs once for the base rules and
again for each map in the rotation. The old builder used two duplicate flat
forms, which is why it drifted. This tool models the layering directly and
records which layer set each value. That record is the interface: a colored dot
per setting and a popover showing the full trail.

## Build

`schema/generated/` is not checked in. It is generated from the pinned Alpine
source, so `npm run schema` must run before the app builds. `npm run dev` and
`npm run build` do this automatically.

```
npm run gen            parse the pinned Alpine source -> schema/generated/
npm run check:schema   validate the authored layer against it, compile authored.json
npm run schema         both of the above
npm run check          svelte-check plus tsc
```

## Layout

- `vendor/AlpineFaction/` - git submodule pinned to an exact commit, never a
  branch. Bumping the pin is the whole update process.
- `tools/gen-schema.mjs` - parses (does not build or run) the pinned C++ into the
  generated schema. Every extractor fails loudly with the pattern that stopped
  matching rather than silently emitting less.
- `tools/check-schema.mjs` - the anti-drift check. Fails on a setting with no
  authored entry, an authored entry for a setting that no longer exists, a
  mutator with no effects entry, a source-allowed value with no name, a list
  column with no heading, or a name the source states that the game's tables no
  longer hold.
- `tools/extract-tables.mjs` - one-shot, run by hand. Produces `gamedata/*.json`
  from the game's `tables.vpp`, since those names are not in the Alpine repo.
- `schema/authored/` - the hand-written layer (TOML): labels, optional help text,
  page assignment, names for enumerated values, list column headings, and
  mutator effects.
- `src/schema/` - types and the loader the UI imports.
- `src/lib/resolve.ts` - the layering and the provenance trail. Some list keys
  fold across layers by a key field instead of being replaced, so a scope can
  change one entry without restating the list. A scope that changes the game
  type restarts from built-in defaults plus the base scope's hand-set keys, with
  the new mode's defaults on top.
- `src/lib/config.ts` - the edited document, and reading and writing `ads.toml`.
  Anything it cannot model is kept verbatim.
- `src/lib/maps.ts` - the FactionFiles archive, queried live from the browser;
  the only module that knows its wire shapes or caches its responses.
  `src/lib/mapcheck.svelte.ts` holds autodownloader results for the rotation.
  Every call fails soft: an unreachable archive must never look like a broken
  config.
- `src/lib/format.ts` - the single place a stored value becomes display text, so
  a setting reads the same everywhere.

## Conventions

- Plain language in the UI means human labels instead of TOML keys, and unit
  conversion (a value stored in seconds can display in minutes). The audience is
  mostly non-technical server operators.
- User-facing text is terse, factual and professional. Give a setting one short
  help sentence, or none if the label is self-explanatory. Use the Red Faction
  community's established terms, as the Alpine changelog does, rather than
  invented plain-language substitutes. No justifications, asides or hedging.
- The only fixed-width type in the UI is the config file pane.
- Color means provenance and nothing else. UI chrome uses `--graphite`. The
  exceptions are `--err` for problems and `--warn` for warning banners.
- The tool is dark only, with a single palette; no light-mode tokens or branches.
- American English throughout, including generated and authored text.
- No unicode special characters in code, comments or authored text. Use `->`.
- Code comments are lowercase, short, and explain why rather than what.

## Working with the Alpine source

Do not guess what a config key does or what type it takes. The parser in
`vendor/AlpineFaction/game_patch/multi/dedi_cfg.cpp` is the authority on key
names. Config names and code names diverge: `flag_return_time` is seconds in the
file but `ctf_flag_return_time_ms` in the struct, and `spawn_armor` is
`spawn_armour` in the code. Key off the `t["..."]` lookups, never struct member
names.
