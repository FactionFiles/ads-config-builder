# Alpine Faction ADS Config Builder - Rebuild Plan

A web tool for building and editing Alpine Faction dedicated server config files
(`ads.toml`). This replaces `old.html`, a single 7,664-line file that has drifted
badly from what the server actually supports.

## Why rebuild

The old builder writes `ads_version = 1`; the server is on 2. The gap is not a few
missing checkboxes:

| In the server today | In `old.html` |
| --- | --- |
| 20 mutators, each with options, a game type mask, and a minimum client version | absent |
| 14 game types (adds `bag`, `tbag`, `pit`, `wo`, `gg`, `sal`) | 8 |
| `bot_profiles` - personality/skill presets, per-field overrides, quirks | absent |
| `rcon_profiles` - named passwords with per-command grants | absent |
| `rounds`, `delayed_items`, `sprays`, `gibbing`, salvage and bagman scoring | absent |
| `auto_team_balance`, `rf2_geo_limit`, `allow_outlines`, `allow_footsteps`, `force_rail_reload`, `geo_chunk_physics` | absent |

Four structural problems in the old tool, all of which the new architecture removes:

1. The rules form exists twice - base rules and per-level overrides are independent
   copies of the same fourteen sections, ~1,300 lines of markup each.
2. Nothing shows where a value came from, so the export is always a surprise.
3. Three nav links for ~130 settings, with no search.
4. Rotations are edited one level at a time.

## Locked decisions

### Design

- **Frame**: sidebar + one page at a time + a config file pane on the right that
  can be hidden. You are always in a named scope: the whole server, all maps, or
  one map.
- **Rotation is a table**, not a form. Clicking a row drops into that one map,
  which reuses the same pages scoped smaller.
- **Provenance dots**: every setting carries a small colored dot. Clicking it opens
  a popover showing every layer that touched the value and which one won.
  Default / from a preset / from a mutator / you set it / just for one map.
- **Plain language throughout.** Labels are human names ("Round length", "15 minutes"),
  not TOML keys. The tool converts units, so `time_limit = 900` displays as 15 minutes.
- **The only fixed-width type in the tool is the config file pane.** The audience is
  mostly non-technical.
- **Preset authoring is an export option, not a mode.** Download offers the whole
  server config or just the game rules. Opening a preset file lands in Game rules
  with the rest of the sidebar dimmed. No up-front decision, nothing to undo.

Approved prototype: https://claude.ai/code/artifact/dca8eb94-71f3-47de-9f09-8c671cfc4857

### Technical

- **Stack**: Vite + Svelte + TypeScript.
  - runtime: `smol-toml` (TOML 1.0 parse and serialize)
  - build: `svelte`, `vite`, `typescript`
  - The schema generator is a Node script reusing `smol-toml`. No other deps.
- **Host**: deferred. Build host-agnostic (`npm run build` -> `dist/`), add the CI
  config as the last step. See "Blocked" below - this also defers the CORS origin.
- **AlpineFaction is a git submodule pinned to an exact commit**, never to a
  moving branch. Bumping that pin is the entire manual update process.
  - Currently pinned to `68a101c1` on `master` (1.4.0-dev), *not* to a release tag.
    The latest release, `v1.3.0_Bakeapple` (2026-04-22), predates mutators entirely
    (they landed 2026-07-29), ships 8 game types rather than 14, and has no
    `sprays` or `auto_team_balance`. Pinning there would reproduce `old.html`'s
    coverage almost exactly and defeat the point of the rebuild. Switch the pin to
    the 1.4.0 tag as soon as it ships; a submodule pin is a commit either way, so
    this is a one-command change.
  - The upstream default branch is `master`, not `main`.
- **The schema generator lives in this repo and runs in this repo's CI.** Alpine
  devs do nothing, add nothing, and verify nothing. If the source changes shape,
  our build breaks, not theirs.
- **The generator parses the Alpine source, it does not run it.** `apply_instagib`
  and friends read runtime globals like `rf::rail_gun_weapon_type`, and the codebase
  is a Windows game patch that will not build on a plain CI runner.
- **The tool resolves values**, but only by merging generated tables in a fixed
  order. No reimplementation of Alpine's game logic in JavaScript.
- **The map picker queries FactionFiles live.** No baked snapshot. Typing an `.rfl`
  file name stays a permanent first-class option next to search, not a fallback
  shown after a failure.
- **Weapon/item/character names are extracted once from `tables.vpp`** and checked in.
  If a TC mod uses different weapons the names will not match - that is acceptable,
  running a TC is already an advanced case.

## Repo layout

```
ads-config-builder/
  vendor/AlpineFaction/        submodule, pinned to a release tag
  schema/
    authored/*.toml            labels, help text, page grouping, units - written by hand
    mutator-effects.toml       what each mutator changes - written by hand, ~20 entries
    generated/                 gitignored, produced at build time
  gamedata/
    weapons.json               extracted from tables.vpp, checked in
    items.json
    characters.json
  tools/
    gen-schema.ts              parses the pinned Alpine source
    extract-tables.mjs         one-shot, unpacks tables.vpp and parses the .tbl files
  src/                         the Svelte app
  old.html                     kept as a parity reference until M8, then deleted
```

## The schema, in three tiers

Split by how the data is obtained, because the confidence differs.

**Tier 1 - parsed from the Alpine source, trusted.**
Setting names, types and defaults; the 14 game types; the full mutator table with
options, labels, client version floors and game type masks. These are flat literals
and regular declarations. CI fails loudly if a pattern stops matching.

> Trap: config names and code names diverge. `flag_return_time` is seconds in the
> file but `ctf_flag_return_time_ms` in the struct; `spawn_armor` is `spawn_armour`
> in the code. The parser must key off the `t["..."]` lookups in `dedi_cfg.cpp`,
> not off the struct member names.

**Tier 2 - written by hand here, checked by CI for completeness.**
What each mutator actually changes. These live inside C++ function bodies, so
parsing them is guesswork. ~20 short entries in `schema/mutator-effects.toml`.
CI compares them against the parsed mutator list and fails on a new mutator with
no entry. It cannot verify correctness - but a stale entry costs an
under-explaining popover, not a broken config, since the file only ever contains
what the user set.

**Tier 3 - not in the Alpine repo at all.**
Weapon, item and character names, which the game loads from its own table files at
runtime. Extracted once from `tables.vpp` and checked in.

**Also written by hand: every label and help sentence.** ~150 settings each need a
plain-English name, a help line, a unit, and a page assignment. This is the single
largest chunk of human work in the project. I will draft them from the source
comments and struct context for review rather than leaving them blank.

## Resolution model

From `dedi_cfg.cpp:566-570`, the layering per scope is:

```
Alpine built-in default
  -> game type defaults      (apply_defaults_for_game_type)
  -> rules_presets           (files, chainable, alias-able)
  -> mutators                (fixed apply order, before manual keys)
  -> manual keys in scope
```

applied once for `[base]`, then again for each `[[levels]]` entry. Manual keys
always win over mutators in the same scope.

The resolver merges tier 1 and tier 2 tables in that order and records which layer
set each value. That record is what the provenance dots and the popover render.
Where a mutator does something that is not a value (Instagib removing pickups),
the effects file carries a sentence and the tool prints it instead of pretending
to compute it.

## Milestones

**M0 - Repo setup.** `git init` (see below). Scaffold Vite + Svelte + TS. Add the
AlpineFaction submodule pinned to the current release tag. `npm run build` produces
`dist/`.

**M1 - Schema pipeline.** `tools/gen-schema.ts` parses the pinned source into
`schema/generated/`. Authored label files alongside. A completeness check that fails
on an unlabeled key, a label pointing at a dead key, or a mutator with no effects
entry. This is the anti-drift mechanism and should land before any UI.

**M2 - Game data.** `tools/extract-tables.ts`. `vendor/AlpineFaction/tools/vpp` is a
prebuilt Linux unpacker, so this is mostly parsing the `.tbl` text. Produces
`gamedata/*.json`. Delegate to a subagent.

**M3 - App shell.** Console frame, sidebar, settings pages rendered from the schema,
config file pane, TOML export. One shared field renderer driven by type - this is
what stops the form ever existing twice.

**M4 - Resolution engine and provenance.** The merge described above, the dots, the
popover, reset-to-default, reset-to-base.

**M5 - Rotation sheet.** Table view, inherited vs overridden cells, column picker,
multi-select edit, paste a level list. Clicking a row scopes the settings pages to
that map.

**M6 - Mutators page.** Cards, options, game type gating, client version warnings.

**M7 - Import round-trip.** Open an existing config, preserve unknown keys on
export so we never eat something a newer Alpine added.

**M8 - Remaining pages.** Bots, admin/rcon profiles, voting, idle, presets,
problems/diagnostics. Parity pass against `old.html`, then delete it.

**M9 - Map picker.** Blocked on FactionFiles. See below.

**M10 - CI and deploy.** Pick a host, ~30 lines of pipeline config, deploy `dist/`.

## Blocked

**M9 depends on FactionFiles adding API surface.** In priority order:

1. **A CORS header allowing the built page's origin.** Nothing else matters without
   it - the page is static, so the browser makes the request directly and will
   refuse to read the response otherwise. This is the difference between the feature
   existing and not existing.
2. A search endpoint returning JSON per map: `.rfl` file name, display name, author,
   description, file size, upload date, thumbnail URL, download URL.
3. The mode a map was built for, and its intended player count, if known. This is
   what lets the builder warn that a CTF map is scheduled as Deathmatch.
4. Pagination, so a broad search does not pull the whole archive.

The origin in (1) cannot be finalized until the host is picked in M10.

## Risks

- **C++ parsing brittleness.** A refactor upstream breaks our build. Mitigation:
  fail loudly with the exact pattern that stopped matching, and pin to tags so it
  only ever happens on a deliberate bump.
- **The label backlog.** ~150 settings needing human text is easy to underestimate
  and easy to leave half-done. Front-load drafting into M1 rather than trailing it.
- **Tier 2 going stale silently.** Accepted; bounded blast radius.
- **Resolution correctness.** If our merge order is wrong the dots lie confidently.
  Worth a test fixture: a handful of configs with known resolved outputs.

## Reference notes

Facts established from the Alpine source, worth not re-deriving:

- `game_patch/multi/server_internal.h` - `AlpineServerConfig` (~1011),
  `AlpineServerConfigRules` (~728), `AlpineServerConfigLevelEntry` (~965),
  `AlpineRconProfile` (~977), `ServerBotConfig` (~991).
- `game_patch/multi/dedi_cfg.cpp` - all TOML key lookups; `apply_defaults_for_game_type`
  at ~326 (pure value assignments, one case per game type); layering comment at ~566.
- `game_patch/multi/mutators.cpp` - the `MutatorDef` struct at ~390 and the
  `MUTATORS` array at ~417 (id, toml name, label, min client minor version, apply
  fn, options, num options, gametype req, vote label, vote detail option); the
  `MutatorOptionDef` arrays sit just above it; `MUTATOR_APPLY_ORDER` at ~443.
  20 entries. Note the names: the array is `MUTATORS`, the struct is `MutatorDef`.
- `game_patch/multi/mutators.h` - `MutatorId` enum with frozen wire values,
  `MutatorGametypeReq`, `MutatorOptionType`.
- `game_patch/multi/server.cpp:825` - `resolve_gametype_from_name`, the authoritative
  game type name list and aliases.
- `common/include/common/version/version.h:34` - `ADS_VERSION`, currently 2.
- `tools/vpp` - prebuilt Linux VPP unpacker, usable for M2.

## Status

- **M0 done.** Repo initialized on `main`. Vite 8 + Svelte 5 + TypeScript 6
  scaffolded, `smol-toml` installed, `npm run build` produces `dist/`,
  `npm run check` is clean. Submodule added at `vendor/AlpineFaction`, pinned as
  described above. `design/prototype.html` holds the approved prototype as a port
  reference for M3-M6; delete it at parity.
- **M2 done.** `tools/extract-tables.mjs` unpacks `tables.vpp` and produces
  `gamedata/weapons.json` (44), `items.json` (45), `characters.json` (20).
  Identifier fields proven against the source rather than guessed: weapons match
  `weapons.tbl $Name`, items match `items.tbl $Class Name`, characters match
  `pc_multi.tbl $Name`. Output is byte-stable across reruns.
- **M1 done.** `npm run schema` is green end to end. `tools/gen-schema.mjs` parses the pinned source into
  `schema/generated/`: 84 rules settings and 21 server settings with defaults,
  bounds, unit scales and dependency guards; 14 game types with their defaults
  and score-limit keys; all 20 mutators with options and apply order.
  `tools/check-schema.mjs` cross-checks the authored layer and compiles it to
  `authored.json`. The authored layer covers all 207 settings across 16 pages:
  labels, help text, units, page assignment, and what each of the 20 mutators
  does (50 key overrides, 45 prose effects).
- **M3 substantially done.** App shell: sidebar, one page at a time, config file
  pane, hash routing. One shared field renderer (`src/lib/ui/Field.svelte`)
  drives every setting from the schema, which is what stops the rules form ever
  existing twice. TOML emit round-trips identically and matches Alpine's shape.
- **M4 substantially done.** `src/lib/resolve.ts` implements the layering with a
  full per-setting trail, and `ProvenancePopover.svelte` renders it.
- Nothing is committed yet.

### Next, in order

1. **Mode relevance.** Settings that only apply to one game mode (the Bagman and
   Salvage timings, the CTF flag rules, the Gun Game ladder) currently show in
   every mode. The score limits are already filtered, because `scoreLimitKey` in
   `gametypes.json` says which one is live - but the rest cannot be derived
   without guessing from key prefixes, which is exactly the kind of guess this
   project avoids. It needs a `modes = ["bag", "tbag"]` hint per authored entry,
   plus a check that every named mode exists.
2. M5 rotation sheet, M6 mutators page, M7 import round-trip.

### Things worth knowing that the plan did not anticipate

- **The label backlog shrank from ~150 to ~25.** `print_rules` in `dedi_cfg.cpp`
  already carries a human label, and often a unit, for 83 of the 84 rules
  settings. The generator lifts them into `console-labels.json`, so the authored
  layer only has to add help text, page assignment, group titles, and better
  wording where the console phrasing is jargon. It also means a setting added
  upstream shows a real name immediately instead of a raw key.
- **An upstream bug the generator surfaced.** `critical_hits.dynamic_scale` is
  read from the config as a float (`dedi_cfg.cpp`) but stored in a `bool`
  (`server_internal.h`). Writing `dynamic_scale = true` does nothing, and
  `dynamic_scale = 1.0` sets a bool from a float. The generated schema flags this
  as `typeMismatch` rather than hiding it. Worth reporting upstream.
- **Testing needs a decision.** Node 20 cannot run TypeScript directly, so a test
  fixture for the resolver (the "resolution correctness" risk below) needs either
  `vitest` or `tsx` as a dev dependency. Deferred pending your call - the
  generator tools are `.mjs` and run under plain node, so only the app-side tests
  are affected.
