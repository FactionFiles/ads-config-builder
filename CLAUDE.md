# ADS Config Builder

A web tool for building and editing Alpine Faction dedicated server config files
(`ads.toml`). Read `PLAN.md` first - it holds the locked design and technical
decisions, the milestone list, and the reference notes about the Alpine source.

## The idea in one paragraph

Alpine resolves a server's rules in layers: built-in default, then game type
defaults, then rules presets, then mutators, then keys set by hand, applied once
for the base rules and again for each map in the rotation. The old builder
modelled this as two flat duplicate forms, which is why it drifted. This one
models the layering directly, so every setting can say which layer set it. That
record is the interface: a colored dot per setting, and a popover showing the
whole trail.

## Build order

Nothing under `schema/generated/` is checked in. It is produced from the pinned
Alpine source at build time, so `npm run schema` must run before the app builds.
`npm run dev` and `npm run build` both do this for you.

```
npm run gen            parse the pinned Alpine source -> schema/generated/
npm run check:schema   validate the authored layer against it, compile authored.json
npm run schema         both of the above
npm run check          svelte-check plus tsc
```

## Where things live

- `vendor/AlpineFaction/` - git submodule, pinned to an exact commit. Bumping
  that pin is the whole update process. Never point it at a branch.
- `tools/gen-schema.mjs` - parses the pinned C++ into the generated schema. It
  parses, it does not run: the mutator apply functions read runtime globals and
  the codebase is a Windows game patch. Every extractor fails loudly with the
  pattern that stopped matching rather than quietly emitting less.
- `tools/check-schema.mjs` - the anti-drift check. Fails on a setting with no
  authored entry, an authored entry for a setting that no longer exists, a
  mutator with no effects entry, a value the source allows with no name, a
  column of a list setting with no heading, or a name the source states that the
  game's own tables no longer hold.
- `tools/extract-tables.mjs` - one-shot, run by hand. Produces `gamedata/*.json`
  from the game's own `tables.vpp`. Those names are not in the Alpine repo.
- `schema/authored/` - the hand-written layer: labels, help text, page
  assignment, a name for each value a setting can take, a heading for each column
  of a list setting, and what each mutator does. TOML because a human edits it.
- `src/schema/` - types and the loader the UI imports.
- `src/lib/resolve.ts` - the layering, and the trail the provenance UI renders.
  Some list keys are folded together rather than replaced, keyed by one field the
  generator reads out of the parser, so a scope can change one entry of a list an
  earlier layer built without restating the list.
- `src/lib/config.ts` - the document the user edits, plus reading and writing
  `ads.toml`. Anything it cannot model is kept verbatim rather than dropped.
- `src/lib/maps.ts` - the FactionFiles archive, queried live from the browser.
  The only place that knows their wire shapes, and the only place that caches
  them. `src/lib/mapcheck.svelte.ts` holds what the autodownloader said about the
  rotation, for the sheet to mark and the problems page to read. Every call fails
  soft: an unreachable archive must never read as a broken config.
- `src/lib/format.ts` - the one place a stored value becomes words, so a setting
  shown in a table and the same setting shown in its own field always agree.
- `design/prototype.html` - the approved prototype, kept as a port reference.
  Delete it once the app reaches parity.

## Conventions

- Plain language in anything the user reads. Labels are human names, not TOML
  keys, and the tool converts units so a value stored in seconds can be shown in
  minutes. The audience is mostly non-technical server operators.
- The only fixed-width type in the UI is the config file pane.
- Color means provenance and nothing else. UI chrome uses `--graphite`.
- American English throughout, including in generated and authored text.
- No unicode special characters in code, comments, or authored text. Use `->`.
- Code comments are lowercase, short, and explain why rather than what.

## Working with the Alpine source

Do not guess what a config key does or what type it takes. The parser in
`vendor/AlpineFaction/game_patch/multi/dedi_cfg.cpp` is the authority on key
names, and config names and code names diverge in places - `flag_return_time` is
seconds in the file but `ctf_flag_return_time_ms` in the struct, `spawn_armor` is
`spawn_armour` in the code. Key off the `t["..."]` lookups, never the struct
member names.
