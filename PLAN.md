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
- **M6 done.** `src/lib/ui/MutatorsPage.svelte` is the card grid: add and remove,
  per-mutator options, the client version floor, and the mutators the mode in play
  cannot use shown greyed with the reason. A mutator option that feeds a setting
  names it with `fromOption`, so Score Limit Override and Ideal Player Count
  Override resolve to real numbers with proper provenance instead of prose - and
  the score limit follows the mode, since each mode is scored by its own key.
- **M5 done.** `src/lib/ui/RotationPage.svelte` is the sheet: a pinned row for the
  base rules and one row per map, every cell reading "same" or the value this map
  substitutes. Any setting can be a column, picked through `SettingPicker.svelte`,
  which the multi-map editor reuses so the two lists cannot drift. Add a map,
  paste a list, reorder, remove, select several and change one setting across all
  of them. Clicking a row scopes every rules page to that map, which is the whole
  point of the shell: the same pages, a smaller scope, no second form.

  The sheet also has to teach the layering, because the top row looks editable
  and is not: it is a picture of the base rules, and clicking it goes to the
  pages that own them. Selecting every map and setting a value there produces a
  working but much worse config - the same key repeated in every `[[levels]]`,
  and no inheritance for a map added later - so that case is caught and offered
  the base rules instead rather than being silently allowed.
- **M7 done.** `fromToml` in `src/lib/config.ts` opens a config somebody else
  wrote. Nothing is thrown away: a key with no editor here and a key from a newer
  Alpine both land in a per-scope `unknown` bucket and are written back out.
  Verified on a fixture carrying an unknown root table, an unknown key inside a
  known table, an unknown rules key, an unknown key inside `[[levels]]`, and the
  arrays with no editor yet - the file comes back byte-identical apart from key
  order, and is stable on a second pass.

- **M8 started: admin profiles and presets are in.**
  - *Advanced admin access* is `src/lib/ui/AdminPage.svelte`. The page is named
    that way because most servers want the single `rcon_password` on Passwords &
    access instead, and the two pages now point at each other rather than leaving
    an operator to guess which one they need. It is: a card per profile, the
    fields rendered by the shared renderer off the schema, and the grants as a
    checkbox grid. The command names are generated - the config parser only
    checks a name against `g_rcon_cmd_masterlist` in `multi/server.cpp`, so that
    list is now extracted and the authored layer owes each command a plain-English
    name, which `check-schema` enforces the same way it enforces labels. The page
    also shows the profile the server invents for you when `rcon_password` is
    set, since a page listing only the written ones would be describing a
    different server.
  - *Presets* split in two, because a preset applies to a scope but is named
    globally. The list of presets a scope pulls in sits at the top of Mode &
    scoring, where it works for the game rules and for one map alike, and it
    replaces the stray text box the page used to render for `base`. The Presets
    page itself carries the shortcuts, the export, and the honest note that this
    tool does not read preset files - so a setting a preset changes still shows
    its default here.
  - Both are out of the `unknown` bucket now: `rcon_profiles` and
    `rules_preset_aliases` are modeled, and anything inside them the tool does not
    know is still kept verbatim per entry.
  - A settings page now renders only a scalar this file holds. It had been giving
    a text box to every array with no editor yet, and to the keys the authored
    layer describes for other documents - a bot profile's fields, a preset's -
    so editing the bots page wrote a table where Alpine wants a list of file
    names. Those settings are hidden until their editors land rather than
    editable into a broken config; an imported config still carries them
    verbatim, and the import banner still names them.

- **M8: the list settings are editable.** One component, `ListEditor.svelte`,
  covers every list in the tool, because the three shapes differ only in what one
  row holds: a small record per row (seven rules arrays), a bare name per row
  (the bot profile files), and a group of names per row (the Gun Game ladder,
  which is the only key in the config that is a list of lists). The generator now
  reads which shape an array is rather than assuming the first, and an array
  whose shape it cannot read stops the build - the old extractor quietly emitted
  an empty field list, which is how `gg_tiers` had gone unnoticed.
  - A name field is a picker, not a text box, because the generator now finds the
    game data lookup that validates it. The check is at the call site for the
    spawn loadouts and inside the struct method the value is handed to for the
    rest, so the parser follows a call into the method and traces which parameter
    is checked. `gg_tiers` is the exception in the other direction: nothing checks
    it until the game builds the tiers, so that one lookup is read from
    `multi/gungame.cpp` and fails loudly if that code stops resolving them.
  - The authored layer owes every column a heading, enforced the same way labels
    are. A column may also name a game data table itself, for the one field the
    parser takes on trust - the replacement in `item_replacements`, which is an
    item name the server never checks. `check-schema` rejects an authored lookup
    on a column the source already answers for.
  - Bots came along with it: the page is the join code and the list of profile
    file names, which is the whole of what `ads.toml` holds about bots. The
    profile files themselves stay out of scope.
  - Everything above is out of `unknown` now, so opening a config no longer
    reports these as carried-through-but-uneditable.

- **M8: a spawn kit is a layered value, not a list you write from scratch.** Some
  list keys are not replaced layer by layer the way a single value is. Alpine
  parses them by handing each entry to the list it already has, keyed by one
  field, so a later layer that names one entry changes that entry and leaves the
  rest. The generator now reads which lists work that way and which field they
  are keyed by, straight out of the parse block, so the resolver folds every
  layer together instead of the newest one winning. Three keys qualify: the two
  spawn kits and the weapon-stay exemptions.
  - This is what makes the kit a game mode hands out visible. The mode's rows
    show as inherited, greyed, with the mode's dot and no name field to change;
    turning one off or giving it different ammo writes an entry naming just that
    weapon and the one field, so the kit is never copied into the file. The
    button on your own row says Reset where something underneath would come back
    and Remove where nothing would.
  - The reserve ammo the modes hand out was an expression. Two are constants
    declared beside the call, and the third reads the weapon table, which only
    exists at runtime - so the generator passes on which column to read rather
    than a number, and `check-schema` fails if that column or the weapon it names
    stops existing. The same reference covers the spawn weapon, whose reserve
    counts the spare clips.
  - Two things the extractor had been missing came out of this: the `default:`
    arm of the game type switch, which is what deathmatch, capture the flag,
    team deathmatch and bagman actually run, and the tail after the switch that
    completes the kit with the mode's spawn weapon. Both are applied now, so a
    deathmatch kit reads Control Baton and 12mm pistol rather than the baton
    alone.
  - The three mutators with a kit of their own state it as rows now rather than
    as prose, and a mutator's list replaces rather than folds in, which is what
    the source does. Instagib on a deathmatch server shows one rail driver, not
    the mode's kit with a note beside it.
  - A field an entry may leave out is marked as such by the generator, from the
    parser asking whether the entry carried one at all. That is the difference
    between "no spare ammo" and "the ammo it already had", and it is why turning
    a weapon off does not pin its ammo to whatever it happens to be now.
  - `spawn_loadout_blue` was documented backwards: it replaces the kit for the
    blue team rather than adding to it. Fixed in the authored text.

### Next, in order

1. The rest of M8: problems, then a parity pass.
   - Problems needs no schema work. It reads the document and the resolver.
   - One thing the kit work leaves behind: the weapon-stay exemptions are seeded
     by the parser with the Fusion Rocket Launcher before it reads the array, and
     the tool still says so in help text rather than showing it as an inherited
     row. It is the same shape of fix as the game mode kits and now a small one -
     the generator would capture the seeding call, and the resolver would apply
     it as a layer under everything else.
2. A parity pass against `old.html`, then delete it and `design/prototype.html`.
3. M9 map picker, blocked below. M10 CI and deploy.

Smaller things noticed and not done: `gg_final_weapon` is a weapon name in a
plain text box, for the same reason `gg_tiers` was - the check is in the game
code, not the parser - and the authored layer can now name a table for a list
column but not for a scalar.

### Mode relevance, and where the answer comes from

A setting that does nothing in the mode being played is hidden, and the source of
that answer is layered the same way everything else in this tool is:

- **Generated**, where Alpine states it: the per-mode score limits come from
  `get_score_limit`, and the rounds settings from `gt_type_uses_rounds`. The
  authored layer is forbidden from restating either - `check-schema` rejects a
  hand-written hint on those keys.
- **Authored**, everywhere else, read off the code that consumes the setting
  rather than off the key name. Three forms, at most one per entry: `modes` for
  the modes it works in, `notModes` for the modes it does nothing in when that is
  the shorter list, and `teamOnly = true` for anything gated on the mode having
  teams. `notModes` and `teamOnly` exist so that a game mode added upstream is
  included by default rather than silently dropping out of a stale list.

A setting the mode ignores is still shown, greyed and annotated, when this scope
sets it by hand - a value that is in the file must never be invisible.

Alpine's own gating is sometimes behavioral rather than a guard: Gun Game hides
every level item, so the pickup settings are dead there without any code testing
them. Those cases are gated too, and each one carries the file and line it was
read from in the research notes.

### Upstream findings from that pass

None of these block the builder; they are worth reporting to Alpine.

- **Overtime is silently dead in four modes.** Pit and Wipeout are excluded
  structurally by `gt_uses_rounds`, Gun Game by an explicit "cannot be tied" case,
  and Run by the default branch of `round_is_tied`. Nothing warns an operator who
  sets `overtime.enabled` on a Pit server.
- **`overtime.tie_when_hill_contested` is King of the Hill only**, despite four
  modes having hills and the key name naming none of them. Damage Control's tie
  test is a bare score comparison; Revolt and Escalation ignore the flag.
- **Wipeout and Salvage count as team types** and Gun Game does not, which decides
  every team-gated setting and is not obvious from the mode list.
- **`weapon_stay_exemptions` is never cleared between layers** - the `.clear()` is
  commented out - so Super Rail's exemption accumulates.
- **The Capture the Flag mode description says "Steal the the enemy flag".** The
  tool shows the game's own wording, so the typo shows through.
- **A map that changes the mode silently loses the base rules' mutators.**
  `apply_defaults_for_game_type` clears `MutatorConfig` outright, and the source
  comment says a scope that changes `game_type` must re-declare its mutators.
  Nothing tells the operator, and the effects the mutators wrote into ordinary
  rules keys are not cleared with it, so the map keeps half of what Instagib did
  while Instagib itself is off. The tool models this and warns on the map's
  mutators page and in the rotation sheet's Mutators column.

- **An old-style `rcon_password` conjures a profile nobody wrote.** The server
  builds a profile named `legacy` from it, with a fixed 18-command list, unless a
  written profile already uses that same password. The admin page shows it as a
  card of its own rather than letting the written profiles imply they are the
  whole story.
- **`map` and `gt` are aliases**, of `level` and `sv_gametype`. Both are on the
  rcon master list, so a permissions grid that named them literally would look
  like it was offering four abilities where there are two.

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
