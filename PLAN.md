# Alpine Faction ADS Config Builder - Rebuild Plan

A web tool for building and editing Alpine Faction dedicated server config files
(`ads.toml`). It replaces `old.html`, a single 7,664-line file that no longer
matches what the server supports. `old.html` has been removed from the repo; a
local, gitignored copy is kept as the parity reference.

## Why rebuild

The old builder writes `ads_version = 1`; the server is on 2.

| In the server today | In `old.html` |
| --- | --- |
| 20 mutators, each with options, a game type mask, and a minimum client version | absent |
| 14 game types (adds `bag`, `tbag`, `pit`, `wo`, `gg`, `sal`) | 8 |
| `bot_profiles` - personality/skill presets, per-field overrides, quirks | absent |
| `rcon_profiles` - named passwords with per-command grants | absent |
| `rounds`, `delayed_items`, `sprays`, `gibbing`, salvage and bagman scoring | absent |
| `auto_team_balance`, `rf2_geo_limit`, `allow_outlines`, `allow_footsteps`, `force_rail_reload`, `geo_chunk_physics` | absent |

The old tool also has four structural problems, all addressed by the new
architecture:

1. The rules form exists twice: base rules and per-level overrides are
   independent copies of the same fourteen sections (~1,300 lines of markup each).
2. Nothing shows where a value came from, so the export is unpredictable.
3. Three nav links for ~130 settings, with no search.
4. Rotations are edited one level at a time.

## Decisions

### Design

- **Frame**: sidebar, one page at a time, and a hideable config file pane on the
  right. The user is always in a named scope: the whole server, all maps, or one
  map.
- **The rotation is a table**, not a form. Clicking a row scopes the same pages to
  that one map.
- **Provenance dots**: every setting has a colored dot for the layer that set it
  (default, game mode, mutator, set by the user, or set for one map). Clicking it
  opens a popover listing every layer that touched the value and which one won.
- **Plain language.** Labels are human names ("Round length", "15 minutes"), not
  TOML keys. Units are converted, so `time_limit = 900` displays as 15 minutes.
- **The only fixed-width type is the config file pane.** The audience is mostly
  non-technical.
- ~~**Preset authoring is an export option, not a mode.**~~ Dropped: Alpine 1.4
  removed rules presets. Download offers the whole server config only.

Approved prototype: https://claude.ai/code/artifact/dca8eb94-71f3-47de-9f09-8c671cfc4857
(the local copy, `design/prototype.html`, has been removed).

### Technical

- **Stack**: Vite + Svelte + TypeScript.
  - runtime: `smol-toml` (TOML 1.0 parse and serialize)
  - build: `svelte`, `vite`, `typescript`
  - The schema tools are Node scripts that reuse `smol-toml`. No other deps.
- **Host**: deferred. The build is host-agnostic (`npm run build` -> `dist/`);
  CI config is added last (M10).
- **AlpineFaction is a git submodule pinned to an exact commit**, never a moving
  branch. Bumping the pin is the entire update process. It is currently pinned to
  the `v1.4.0_Lupin` tag. The upstream default branch is `master`, not `main`.
- **The schema generator lives and runs in this repo.** Alpine developers do
  nothing for it. If the source changes shape, our build breaks, not theirs.
- **The generator parses the Alpine source; it does not run it.** Functions like
  `apply_instagib` read runtime globals such as `rf::rail_gun_weapon_type`, and the
  codebase is a Windows game patch that will not build on a plain CI runner.
- **The tool resolves values only by merging generated tables in a fixed order.**
  No reimplementation of Alpine's game logic in JavaScript.
- **The map picker queries FactionFiles live**, with no baked snapshot. Typing an
  `.rfl` file name is a permanent first-class option next to search, not a
  fallback.
- **Weapon, item and character names are extracted once from `tables.vpp`** and
  checked in. Total conversion mods with different weapons will not match; that
  is acceptable.

## Repo layout

```
ads-config-builder/
  vendor/AlpineFaction/        submodule, pinned to an exact commit
  schema/
    authored/*.toml            labels, help text, page grouping, units - hand-written
    authored/mutator-effects.toml   what each mutator changes - hand-written
    generated/                 gitignored, produced at build time
  gamedata/
    weapons.json               extracted from tables.vpp, checked in
    items.json
    characters.json
  tools/
    gen-schema.mjs             parses the pinned Alpine source
    check-schema.mjs           validates the authored layer, compiles authored.json
    extract-tables.mjs         one-shot: unpacks tables.vpp and parses the .tbl files
  src/                         the Svelte app
```

## The schema, in three tiers

Split by how the data is obtained, since confidence differs per tier.

**Tier 1 - parsed from the Alpine source, trusted.** Setting names, types and
defaults; the 14 game types; the full mutator table with options, labels, client
version floors and game type masks. These are flat literals and regular
declarations. The generator fails loudly if a pattern stops matching.

> Config names and code names diverge. `flag_return_time` is seconds in the file
> but `ctf_flag_return_time_ms` in the struct; `spawn_armor` is `spawn_armour` in
> the code. The parser keys off the `t["..."]` lookups in `dedi_cfg.cpp`, not the
> struct member names.

**Tier 2 - hand-written, checked for completeness.** What each mutator changes.
This lives inside C++ function bodies, so parsing it would be guesswork. Entries
are in `schema/authored/mutator-effects.toml`. The check fails on a mutator with
no entry but cannot verify correctness. A stale entry produces an incomplete
popover, not a broken config, since the file only contains what the user set.

**Tier 3 - not in the Alpine repo.** Weapon, item and character names, which the
game loads from its own table files at runtime. Extracted once from `tables.vpp`
and checked in.

**Also hand-written: labels and help text.** Each setting needs a name, a unit
where relevant, and a page assignment. Help text is optional: a setting gets one
short help line, or none when the label is self-explanatory. `print_rules` in
`dedi_cfg.cpp` already carries a human label (and often a unit) for 83 of the 84
rules settings; the generator lifts these into `console-labels.json`, so the
authored layer mainly adds help text, page assignment, group titles, and better
wording where the console phrasing is jargon. A setting added upstream shows a
real name immediately instead of a raw key.

## Resolution model

From `parse_scope_rules` in `dedi_cfg.cpp`, the layering per scope is:

```
Alpine built-in default
  -> game type defaults      (apply_defaults_for_game_type)
  -> mutators                (fixed apply order, before manual keys)
  -> manual keys in scope
```

This is applied once for `[base]`, then again for each `[[levels]]` entry. Manual
keys always win over mutators in the same scope.

**Game type rebase.** A scope that names a different game type than the one it
inherited does not layer onto the inherited rules. It restarts from the built-in
defaults plus `base_rules_keys_only` (the keys `[base]` set by hand), so neither
the old mode's defaults nor the base mutators survive. The new mode's defaults
land on top of those base keys, then the scope's own mutators and keys apply.
`gameTypeRebase` in `rules.json` is read from the source rather than assumed, so
the popover trail cannot drift from server behavior.

The resolver merges tier 1 and tier 2 tables in this order and records which
layer set each value; that record drives the dots and the popover. Where a
mutator does something that is not a value (Instagib removing pickups), the
effects file carries a sentence and the tool displays it instead of computing it.

**Folded lists.** Some list keys are not replaced layer by layer. Alpine hands
each entry to the existing list keyed by one field, so a later layer that names
one entry changes only that entry. The generator reads which lists behave this
way and their key field from the parse block. Three keys qualify: the two spawn
kits and the weapon stay exemptions. A mutator's list replaces rather than
folds, matching the source.

**Seeded rows.** Some list rows are added by the parser before it reads the file
(`add("shoulder_cannon", true)` for weapon stay exemptions). The resolver applies
them where the source does: after mutators, before the scope's own rows, once per
scope.

### Mode relevance

A setting that does nothing in the current mode is hidden. The answer comes from
two layers:

- **Generated**, where Alpine states it: per-mode score limits from
  `get_score_limit`, and rounds settings from `gt_type_uses_rounds`.
  `check-schema` rejects a hand-written hint on those keys.
- **Authored** everywhere else, determined from the code that consumes the
  setting, not the key name. At most one of three forms per entry: `modes` (the
  modes it works in), `notModes` (the modes it does nothing in, when shorter), or
  `teamOnly = true` (gated on the mode having teams). `notModes` and `teamOnly`
  mean a mode added upstream is included by default instead of silently dropped.

A setting the mode ignores is still shown, greyed and annotated, if the current
scope sets it by hand. A value in the file must never be invisible.

Some of Alpine's gating is behavioral rather than an explicit guard: Gun Game
hides every level item, so the pickup settings do nothing there. These cases are
gated too, and each records the source file and line in the research notes.

## Milestones

- **M0 - Repo setup.** Scaffold Vite + Svelte + TS, add the pinned submodule,
  `npm run build` produces `dist/`. **Done.**
- **M1 - Schema pipeline.** Generator, authored layer, and the completeness check.
  This is the anti-drift mechanism and lands before any UI. **Done.**
- **M2 - Game data.** `tools/extract-tables.mjs` produces `gamedata/*.json`.
  **Done.**
- **M3 - App shell.** Frame, sidebar, schema-driven settings pages, config file
  pane, TOML export. One shared field renderer driven by type, so the form never
  exists twice. **Substantially done.**
- **M4 - Resolution engine and provenance.** The merge, the dots, the popover,
  reset-to-default, reset-to-base. **Substantially done.**
- **M5 - Rotation sheet.** Table view, inherited vs overridden cells, column
  picker, multi-select edit, paste a level list. Clicking a row scopes the settings
  pages to that map. **Done.**
- **M6 - Mutators page.** Cards, options, game type gating, client version
  warnings. **Done.**
- **M7 - Import round-trip.** Open an existing config; preserve unknown keys on
  export. **Done.**
- **M8 - Remaining pages.** Bots, admin/rcon profiles, voting, idle, demo
  recording, problems/diagnostics, then a parity pass against `old.html`.
  **Everything except the parity pass is done.**
- **M9 - Map picker.** Search the archive, add a map by name, flag rotation
  entries the autodownloader cannot serve. **Done.**
- **M10 - CI and deploy.** Pick a host, add pipeline config, deploy `dist/`.
  Nothing blocks it.

## Status log

### M0

Repo initialized on `main`. Vite 8 + Svelte 5 + TypeScript 6, `smol-toml`
installed, `npm run build` and `npm run check` clean.

### M1

`npm run schema` is green end to end. `tools/gen-schema.mjs` produces 84 rules
settings and 21 server settings with defaults, bounds, unit scales and dependency
guards; 14 game types with their defaults and score-limit keys; and all 20
mutators with options and apply order. `tools/check-schema.mjs` cross-checks the
authored layer and compiles it to `authored.json`. The authored layer covers all
207 settings across 16 pages, plus effects for all 20 mutators (50 key overrides,
45 prose effects).

### M2

`gamedata/weapons.json` (44), `items.json` (45), `characters.json` (20).
Identifier fields are verified against the source: weapons match `weapons.tbl
$Name`, items match `items.tbl $Class Name`, characters match `pc_multi.tbl
$Name`. Output is byte-stable across reruns.

### M3 and M4

App shell with sidebar, config file pane and hash routing. `src/lib/ui/Field.svelte`
renders every setting from the schema. TOML output round-trips identically and
matches Alpine's shape. `src/lib/resolve.ts` implements the layering with a full
per-setting trail; `ProvenancePopover.svelte` renders it.

### M5

`src/lib/ui/RotationPage.svelte`: a pinned row for the base rules and one row per
map, each cell reading "same" or the map's override. Any setting can be a column,
chosen through `SettingPicker.svelte`, which the multi-map editor also uses. Maps
can be added, pasted as a list, reordered, removed, and multi-selected to change
one setting across all of them.

The base row is read-only and links to the pages that own the base rules. Setting
a value on every selected map is caught and redirected to the base rules, since
it would otherwise repeat the key in every `[[levels]]` entry and give no
inheritance to maps added later.

### M6

`src/lib/ui/MutatorsPage.svelte`: a card grid with add/remove, per-mutator
options, the client version floor, and mutators the current mode cannot use shown
greyed with the reason. A mutator option that feeds a setting names it with
`fromOption`, so Score Limit Override and Ideal Player Count Override resolve to
real numbers with provenance. The score limit follows the mode, since each mode
uses its own key.

### M7

`fromToml` in `src/lib/config.ts` opens an existing config. Keys with no editor
and keys from a newer Alpine go into a per-scope `unknown` bucket and are written
back out. Verified on a fixture with an unknown root table, an unknown key in a
known table, an unknown rules key, an unknown key in `[[levels]]`, and arrays with
no editor: the output is byte-identical apart from key order, and stable on a
second pass.

### M8

- **Advanced admin access** (`src/lib/ui/AdminPage.svelte`). Named so because most
  servers only need the single `rcon_password` on Passwords & access; the two
  pages link to each other. A card per profile, fields rendered from the schema,
  and grants as a checkbox grid. Command names are extracted from
  `g_rcon_cmd_masterlist` in `multi/server.cpp` (the only thing the config parser
  validates a name against), and `check-schema` requires a human name for each.
  The page also shows the `legacy` profile the server creates from
  `rcon_password`.
- **`rcon_profiles` is modeled**; unknown fields inside a profile are kept
  verbatim per entry.
- **Settings pages render only scalars this file holds.** Arrays without an
  editor and keys belonging to other documents (bot profile fields) had been
  given text boxes, which wrote invalid config. They stay hidden until an editor
  exists; imports still carry them verbatim and the import banner names them.
- **List editing.** `ListEditor.svelte` covers every list shape: a small record
  per row (seven rules arrays), a bare name per row (bot profile files), and a
  group of names per row (the Gun Game ladder, the only list of lists). The
  generator reads each array's shape and stops the build on one it cannot read.
  - A name field is a picker when the generator finds the game data lookup that
    validates it: at the call site for spawn loadouts, or by following the value
    into the struct method that checks it for the rest. `gg_tiers` is only checked
    when the game builds the tiers, so that lookup is read from
    `multi/gungame.cpp` and fails loudly if it stops resolving.
  - `check-schema` requires a heading for every column. A column may name a game
    data table itself only where the source does not (the replacement in
    `item_replacements`, which the server never checks); an authored lookup on a
    column the source already covers is rejected.
- **Bots page**: the join code and the list of profile file names, which is all
  `ads.toml` holds about bots. Profile files themselves are out of scope.
- **Spawn kits as layered values.** Folded lists (see Resolution model) make the
  kit a game mode hands out visible: the mode's rows show as inherited and greyed
  with the mode's dot. Disabling a weapon or changing its ammo writes an entry for
  just that weapon and field, so the kit is never copied into the file. The row
  button reads Reset when a lower layer would show through and Remove otherwise.
  - Reserve ammo in the modes' kits is an expression. Two values are constants
    declared beside the call; the third reads the weapon table at runtime, so the
    generator emits which column to read, and `check-schema` fails if that column
    or weapon disappears. The spawn weapon's reserve (spare clips) uses the same
    reference.
  - The extractor now handles the `default:` arm of the game type switch (used by
    deathmatch, CTF, team deathmatch and bagman) and the code after the switch
    that adds the mode's spawn weapon. A deathmatch kit now reads Control Baton
    and 12mm pistol.
  - The three mutators with their own kit state it as rows, and replace rather
    than fold: Instagib on deathmatch shows one rail driver.
  - The generator marks fields an entry may omit, from the parser checking whether
    the entry carried one. This distinguishes "no spare ammo" from "keep existing
    ammo", so disabling a weapon does not pin its ammo.
  - `spawn_loadout_blue` replaces the blue team's kit rather than adding to it;
    the authored text was corrected.
- **Problems page.** `src/lib/checks.ts` returns findings from the document and
  resolver; `ProblemsPage.svelte` renders them. The one check needing outside data
  takes it as an argument, so the module stays pure and testable without a
  browser.
  - A problem is something the server will not do, or will do differently from
    what the file says. A deliberate choice is never a problem: a map played twice
    in a rotation and an Alpine-clients-only config are not flagged, and neither
    are the client requirements from `server_features_require_alpine_client`.
  - Three tiers, with wording taken from the source. A level Alpine cannot
    download is dropped from the rotation. A number out of bounds is clamped (the
    bounds are `std::clamp` calls), so the file keeps a value the server replaced.
    A mutator the mode cannot run produces a server warning and is skipped.
  - The most valuable check: a map that changes the mode runs without the base
    rules' mutators but keeps the ordinary keys those mutators wrote.
  - The guard test (a setting read only when a sibling is on) is `unsatisfiedGuard`
    beside the resolver; the field renderer and problems page share it.
  - The sidebar shows a count of problems, excluding notes. The count and the page
    read the same derived list.
- **Seeded rows and weapon stay.** The generator reads seeded rows from the same
  `add` call the merge key comes from; a seeding call that changes shape stops the
  build, and `check-schema` validates the seeded name against the weapon table.
  `setRows` records nothing when a layer changes nothing, so the seed only appears
  in the trail where it overrode something.
  - Because of the re-seeding bug (see Upstream findings), turning the exemption
    off in the base rules still shows it on for every map. That row explains this
    and offers to write the setting into every map, and the problems page repeats
    it. The "every map sets this" note is skipped for seeded lists.
  - "Weapon stay" is the game's term and is now used throughout; the exemption
    column was previously "Disappears when taken".

### M9

`src/lib/maps.ts` is the only module that knows the FactionFiles wire shapes. It
caches per query and per level name for the session, so checking a rotation after
adding one map asks about one name. Search results also count as availability
answers, since everything the picker offers is served by the autodownloader.

The picker is a panel in the rotation sheet. The text box for typing a name stays
below the results, with a note that the archive carries maps the site does not
list.

A rotation entry the autodownloader does not carry is marked in the sheet and
counted beneath it. The check fails quiet: an unreachable archive shows nothing
rather than reading as a broken config.

### Alpine 1.4.0 (`v1.4.0_Lupin`)

The pin moved from a commit 95 past `v1.3.0_Bakeapple` to the 1.4.0 tag. Four of
the 45 commits in between touched the schema surface, and `npm run gen` stopped
on each, as designed.

- **Rules presets removed.** `Revamp level rules layering (#435)` deleted
  `apply_rules_presets_and_overrides`, preset chaining, the cycle check,
  `[rules_preset_aliases]` and `load_rules_preset_alias`. `rules_presets` remains
  only in the `[[levels]]` key whitelist, accepted and ignored. This removed a
  provenance layer, its color, two pages, and the rules-only download.
  `deadLevelKeys` derives ignored keys from that whitelist, so the generator
  reports it if Alpine drops the key or restores presets.
- **Imported presets are warned about and stripped.** This is the one exception
  to keeping unmodeled keys verbatim: the server no longer acts on them, so
  writing them back would misrepresent the config. The import banner names what
  was dropped and where those settings belong now.
- **Game type rebase** (see Resolution model). Both halves are read from the
  source by `extractGameTypeRebase`, and the popover explains it in the trail.
- **Critical hits became a mutator.** `[critical_hits]` and its five keys are
  gone; `crits` is a no-option mutator that triples the damage of a rolled shot.
  Its effects entry describes the new mechanic.
- **Six demo recording keys** on a new page, and the 12mm handgun the Bagman modes
  now spawn with.
- **Generator bug fixed.** `case NG_TYPE_BAG:` falls through to
  `case NG_TYPE_TBAG: {`, and the case reader only matched labels with a brace, so
  Bagman had been getting the default arm since the mode landed.
  `location_pinging = (game_type == NG_TYPE_TBAG)` was also emitted as null.
  Shared arms are now read once per label, mode comparisons inside one are
  evaluated for that label, and a default expression that reaches a config key
  without a value fails the generator.

## Next

1. Parity pass against `old.html`. That closes M8.
2. M10 CI and deploy.
3. Bump the `vendor/AlpineFaction` pin when 1.5.0 is tagged (`master` already
   carries 1.5.0 work), as its own commit so `check-schema` findings are reviewed
   separately from feature work.

Known gaps: `gg_final_weapon` is a weapon name in a plain text box, for the same
reason `gg_tiers` was (the check is in game code, not the parser), and the
authored layer can name a table for a list column but not for a scalar.

## FactionFiles map API

`autodl.factionfiles.com/maps/v1/` serves `search.php`, `have.php` and
`categories.php`. All are readable cross-origin (wildcard CORS) and need no key,
custom header or user agent. The authoritative contract is `site/doc/map-api.md`
in the FactionFiles repo.

- Search only returns maps the site lists, while `have.php` answers for
  everything the autodownloader serves (about 10% more). A name the picker never
  showed can still be valid in a rotation.
- Categories are the site's own, not game types; half the modes have no category
  and maps are reusable across modes. A map's category is displayed next to its
  scheduled mode for reference and never drives a warning.

## Risks

- **C++ parsing brittleness.** An upstream refactor breaks our build. Mitigated by
  failing loudly with the exact pattern that stopped matching, and by only bumping
  the pin deliberately.
- **Tier 2 going stale silently.** Accepted; the impact is bounded.
- **Resolution correctness.** A wrong merge order makes the dots wrong with full
  confidence. Mitigation: a resolver fixture set of configs with known resolved
  outputs (not yet written).

## Testing

Node cannot run the app's TypeScript directly, and adding `vitest` or `tsx` is
not needed: a scratch entry point built with `vite build --lib` and run under
node imports the app's modules with the JSON schema resolved. The problems checks
were developed against fixture configs this way, which caught three wording bugs
and a duplicate finding. The resolver fixture can use the same approach. The
generator tools are `.mjs` and run under plain node.

## Reference notes

Facts established from the Alpine source:

- `game_patch/multi/server_internal.h` - `AlpineServerConfig` (~1011),
  `AlpineServerConfigRules` (~728), `AlpineServerConfigLevelEntry` (~965),
  `AlpineRconProfile` (~977), `ServerBotConfig` (~991).
- `game_patch/multi/dedi_cfg.cpp` - all TOML key lookups;
  `apply_defaults_for_game_type` at ~326 (pure value assignments, one case per
  game type); layering comment at ~566.
- `game_patch/multi/mutators.cpp` - `MutatorDef` struct at ~390 and the
  `MUTATORS` array at ~417 (id, TOML name, label, min client minor version, apply
  fn, options, num options, game type req, vote label, vote detail option), with
  the `MutatorOptionDef` arrays just above; `MUTATOR_APPLY_ORDER` at ~443. 20
  entries. The array is `MUTATORS`, the struct is `MutatorDef`.
- `game_patch/multi/mutators.h` - `MutatorId` enum with frozen wire values,
  `MutatorGametypeReq`, `MutatorOptionType`.
- `game_patch/multi/server.cpp:825` - `resolve_gametype_from_name`, the
  authoritative game type name list and aliases.
- `common/include/common/version/version.h:34` - `ADS_VERSION`, currently 2.
- `tools/vpp` - prebuilt Linux VPP unpacker, used by `extract-tables.mjs`.

## Upstream findings

Worth reporting to Alpine; none block the builder.

- **Overtime is silently dead in four modes.** Pit and Wipeout are excluded by
  `gt_uses_rounds`, Gun Game by an explicit "cannot be tied" case, and Run by the
  default branch of `round_is_tied`. Nothing warns an operator who sets
  `overtime.enabled` on a Pit server.
- **`overtime.tie_when_hill_contested` is King of the Hill only**, although four
  modes have hills and the key name names none of them. Damage Control's tie test
  is a bare score comparison; Revolt and Escalation ignore the flag.
- **Wipeout and Salvage count as team types and Gun Game does not.** This decides
  every team-gated setting and is not obvious from the mode list.
- **`weapon_stay_exemptions` is never cleared between layers** (the `.clear()` is
  commented out), so Super Rail's exemption accumulates.
- **The Fusion Rocket Launcher exemption is re-seeded once per scope, overriding
  the operator.** `parse_server_rules` runs `add("shoulder_cannon", true)` before
  reading the key, for both the scope table and its `[rules]` table. `add`
  overwrites the flag on an existing entry, so `exempt = false` in the base rules
  reverts to `true` for every map that does not repeat it, and a level's resolved
  rules replace the active rules wholesale. Within one scope the operator still
  wins, since the array is read right after seeding. Alpine removed the stock
  hardcoded exemption (`init_alpine_dedicated_server`) specifically to make it
  configurable, so the setting fails at its purpose. Fix: an add-if-absent variant
  for the seeding call, or seed once rather than per layer.
- **The CTF mode description reads "Steal the the enemy flag".** The tool shows
  the game's own wording, so the typo is visible.
- **A map that changes the mode silently loses the base rules' mutators.**
  `apply_defaults_for_game_type` clears `MutatorConfig`, and a source comment says
  such a scope must re-declare its mutators. Nothing tells the operator, and the
  values mutators wrote into ordinary rules keys are not cleared, so the map keeps
  half of Instagib's effects with Instagib off. The tool warns on the map's
  mutators page and in the rotation sheet's Mutators column.
- **`rcon_password` creates a profile nobody wrote.** The server builds a profile
  named `legacy` with a fixed 18-command list, unless a written profile already
  uses that password. The admin page shows it as its own card.
- **`map` and `gt` are aliases** of `level` and `sv_gametype`. Both are on the rcon
  master list, so the permissions grid must not present them as four separate
  abilities.
- ~~**`critical_hits.dynamic_scale` was read as a float but stored in a `bool`.**~~
  Moot since 1.4.0 removed `[critical_hits]`.
