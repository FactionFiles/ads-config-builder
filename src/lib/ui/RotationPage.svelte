<script lang="ts">
  // one row per map; each cell shows whether the map inherits the base rules
  // or sets its own value

  import { gametypesByName, mutatorsByName, textFor } from '../../schema'
  import { emptyLevel, parseLevelList, type LevelEntry, type RulesScope } from '../config'
  import { formatValue } from '../format'
  import { effectiveMutators, type Resolved, type ResolvedRules } from '../resolve'
  import { rotationCheck } from '../mapcheck.svelte'
  import Field from './Field.svelte'
  import MapPicker from './MapPicker.svelte'
  import SettingPicker from './SettingPicker.svelte'

  interface Props {
    levels: LevelEntry[]
    base: RulesScope
    baseRules: ResolvedRules
    /** resolved rules per level, in rotation order */
    levelRules: ResolvedRules[]
    onchange: (next: LevelEntry[]) => void
    onopen: (index: number) => void
    /** opens the base rules pages, where the top row is edited */
    onopenbase: () => void
  }

  const {
    levels, base, baseRules, levelRules, onchange, onopen, onopenbase,
  }: Props = $props()

  // columns that are not a single setting: score limit follows each row's game
  // type, and mutators are a list
  const PSEUDO = [
    { id: '@score', label: 'Score limit', group: 'Rotation sheet' },
    { id: '@mutators', label: 'Mutators', group: 'Rotation sheet' },
  ]

  let columns = $state(['game_type', 'time_limit', '@score', '@mutators'])
  let panel = $state<'columns' | 'paste' | 'add' | 'bulk' | null>(null)
  let pasteText = $state('')
  let newMap = $state('')
  let selection = $state(new Set<number>())
  let bulkPath = $state<string | null>(null)

  const baseMode = $derived((baseRules.get('game_type')?.value as string) ?? '')
  const baseScoreKey = $derived(gametypesByName.get(baseMode)?.scoreLimitKey ?? null)

  type CellKind = 'inherited' | 'plain' | 'map' | 'mut' | 'muted'
  interface Cell { text: string; kind: CellKind }

  interface Row {
    /** -1 for the row that stands for the base rules */
    index: number
    name: string
    level?: LevelEntry
    rules: ResolvedRules
    mode: string
    modeChanged: boolean
    changed: number
  }

  const rows = $derived.by<Row[]>(() =>
    levels.map((level, i) => {
      const rules = levelRules[i] ?? baseRules
      const mode = (rules.get('game_type')?.value as string) ?? baseMode
      return {
        index: i,
        name: level.filename,
        level,
        rules,
        mode,
        modeChanged: mode !== baseMode,
        changed: Object.keys(level.rules.manual).length + level.rules.mutators.length,
      }
    })
  )

  const totalChanged = $derived(rows.filter(r => r.changed > 0).length)

  const taken = $derived(new Set(levels.map(level => level.filename.toLowerCase())))

  // flag maps the autodownloader does not carry as the rotation is edited
  $effect(() => {
    rotationCheck.schedule(levels.map(level => level.filename))
  })

  const absent = $derived(rotationCheck.absentAmong(levels.map(level => level.filename)))

  // example names use stock maps; bagman modes play on the ctf maps
  const CTF_MAPS = new Set(['ctf', 'bag', 'tbag'])
  const stock = $derived(CTF_MAPS.has(baseMode) ? 'ctf' : 'dm')

  function headerFor(col: string) {
    return PSEUDO.find(p => p.id === col)?.label ?? textFor('rules', col).label
  }

  function layerKind(r: Resolved, isBase: boolean): CellKind {
    if (r.layer === 'mutator') return 'mut'
    if (r.layer === 'manual') return isBase ? 'plain' : 'map'
    return 'plain'
  }

  function settingCell(row: Row, path: string, neverInherited = false): Cell {
    const r = row.rules.get(path)
    if (!r) return { text: 'n/a', kind: 'muted' }
    if (r.layer === 'inherited' && !neverInherited) return { text: 'same', kind: 'inherited' }
    return { text: formatValue('rules', path, r.value), kind: layerKind(r, row.index < 0) }
  }

  function mutatorLabel(name: string) {
    return mutatorsByName.get(name)?.label ?? name
  }

  function mutatorCell(row: Row): Cell {
    if (!row.level) {
      const names = base.mutators.map(m => mutatorLabel(m.name))
      return names.length ? { text: names.join(', '), kind: 'mut' } : { text: 'none', kind: 'muted' }
    }
    const own = row.level.rules.mutators
    const effective = effectiveMutators(base.mutators, own, row.modeChanged)
    // changing game type clears the base rules' mutators
    const differs = own.length > 0 || (row.modeChanged && base.mutators.length > 0)
    if (!differs) {
      return base.mutators.length
        ? { text: 'same', kind: 'inherited' }
        : { text: 'none', kind: 'muted' }
    }
    if (!effective.length) return { text: 'none (game type changed)', kind: 'map' }
    return { text: effective.map(m => mutatorLabel(m.name)).join(', '), kind: 'mut' }
  }

  function scoreCell(row: Row): Cell {
    const key = gametypesByName.get(row.mode)?.scoreLimitKey
    if (!key) return { text: 'no score limit', kind: 'muted' }
    // a different game type uses a different score key, so "same" would be misleading
    return settingCell(row, key, row.level !== undefined && key !== baseScoreKey)
  }

  function cellFor(row: Row, col: string): Cell {
    if (col === '@mutators') return mutatorCell(row)
    if (col === '@score') return scoreCell(row)
    return settingCell(row, col)
  }

  function toggleColumn(id: string) {
    columns = columns.includes(id) ? columns.filter(c => c !== id) : [...columns, id]
  }

  function addMaps(names: string[]) {
    if (!names.length) return
    onchange([...levels, ...names.map(emptyLevel)])
  }

  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= levels.length) return
    const next = [...levels]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    selection = new Set()
    onchange(next)
  }

  function removeAt(indexes: number[]) {
    const drop = new Set(indexes)
    selection = new Set()
    onchange(levels.filter((_, i) => !drop.has(i)))
  }

  function toggleRow(index: number) {
    const next = new Set(selection)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    selection = next
  }

  function toggleAll() {
    selection = selection.size === levels.length ? new Set() : new Set(levels.map((_, i) => i))
  }

  const selected = $derived([...selection].sort((a, b) => a - b))

  // starts from the base rules and only shows a manual value once every
  // selected map agrees on it
  const bulkResolved = $derived.by<ResolvedRules>(() => {
    const out = new Map(baseRules)
    if (!bulkPath) return out
    const values = selected.map(i => levels[i].rules.manual[bulkPath!])
    if (!values.length || values.some(v => v === undefined || v !== values[0])) return out
    const inherited = baseRules.get(bulkPath)
    out.set(bulkPath, {
      value: values[0],
      layer: 'manual',
      trail: [...(inherited?.trail ?? []), { layer: 'manual', value: values[0] }],
    })
    return out
  })

  // current values across the selection, since the shared control can hide differences
  const bulkSummary = $derived.by(() => {
    if (!bulkPath) return ''
    const counts = new Map<string, number>()
    for (const i of selected) {
      const r = levelRules[i]?.get(bulkPath)
      const text = r ? formatValue('rules', bulkPath, r.value) : 'not set'
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
    return [...counts]
      .map(([text, n]) => `${text} on ${n} ${n === 1 ? 'map' : 'maps'}`)
      .join(', ')
  })

  function bulkSet(path: string, value: unknown) {
    onchange(levels.map((level, i) => selection.has(i)
      ? { ...level, rules: { ...level.rules, manual: { ...level.rules.manual, [path]: value } } }
      : level))
  }

  function bulkClear(path: string) {
    onchange(levels.map((level, i) => {
      if (!selection.has(i)) return level
      const { [path]: _dropped, ...rest } = level.rules.manual
      return { ...level, rules: { ...level.rules, manual: rest } }
    }))
  }

  function openPanel(which: typeof panel) {
    panel = panel === which ? null : which
  }
</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    The top row shows the base <b>game rules</b>, which apply to every map. Click
    a map to override settings for that map.
  </div>
</div>

<div class="sheetbar">
  <span class="ct">
    {levels.length} in rotation
    {#if totalChanged}&middot; {totalChanged} changed{/if}
  </span>
  <span class="sp"></span>
  <button type="button" class="btn" class:pressed={panel === 'columns'} onclick={() => openPanel('columns')}>
    Columns
  </button>
  <button type="button" class="btn" class:pressed={panel === 'paste'} onclick={() => openPanel('paste')}>
    Paste list
  </button>
  <button type="button" class="btn pri" class:pressed={panel === 'add'} onclick={() => openPanel('add')}>
    Add map
  </button>
</div>

{#if panel === 'columns'}
  <div class="panel">
    <h4>Columns</h4>
    <p class="ph">Choose settings to show for each map.</p>
    <SettingPicker extra={PSEUDO} selected={columns} onpick={toggleColumn} />
  </div>
{:else if panel === 'paste'}
  <div class="panel">
    <h4>Paste map list</h4>
    <p class="ph">
      One file name per line. Numbering, quotes, and commas are removed, and
      <code>.rfl</code> is added if missing.
    </p>
    <textarea class="ctl area" rows="7" bind:value={pasteText}
      placeholder={`${stock}02.rfl\n${stock}03\n${stock}04`}></textarea>
    <div class="acts">
      <span class="ph">{parseLevelList(pasteText).length} maps</span>
      <span class="sp"></span>
      <button type="button" class="btn" onclick={() => (panel = null)}>Cancel</button>
      <button
        type="button"
        class="btn pri"
        onclick={() => { addMaps(parseLevelList(pasteText)); pasteText = ''; panel = null }}
      >Add to rotation</button>
    </div>
  </div>
{:else if panel === 'add'}
  <div class="panel">
    <h4>Add map</h4>
    <MapPicker {taken} onpick={map => addMaps([map.rfl])} />
    <div class="byhand">
      <p class="ph">
        Or enter a file name, such as <code>{stock}02.rfl</code>. The
        autodownloader includes maps not listed on the site.
      </p>
      <div class="acts">
        <input
          class="ctl grow"
          type="text"
          placeholder="Map file name"
          bind:value={newMap}
          onkeydown={e => {
            if (e.key !== 'Enter') return
            addMaps(parseLevelList(newMap))
            newMap = ''
          }}
        />
        <button
          type="button"
          class="btn pri"
          onclick={() => { addMaps(parseLevelList(newMap)); newMap = '' }}
        >Add</button>
      </div>
    </div>
  </div>
{/if}

{#if levels.length === 0}
  <div class="empty">
    <p><strong>No maps yet.</strong></p>
    <p>
      With an empty rotation, the server repeats its starting map. Add maps or
      paste a list above.
    </p>
  </div>
{:else}
  <div class="sheetwrap">
    <table class="sheet">
      <thead>
        <tr>
          <th class="tick">
            <button
              type="button"
              class="box"
              class:ticked={selection.size === levels.length}
              aria-label="Select all maps"
              onclick={toggleAll}
            ></button>
          </th>
          <th class="n"></th>
          <th>Map</th>
          {#each columns as col (col)}<th>{headerFor(col)}</th>{/each}
          <th class="acts"></th>
        </tr>
      </thead>
      <tbody>
        <tr class="baserow" onclick={onopenbase}>
          <td class="tick"></td>
          <td class="n"></td>
          <td class="mapname">
            All maps
            <span class="sub">base rules</span>
          </td>
          {#each columns as col (col)}
            {@const cell = cellFor({ index: -1, name: '', rules: baseRules, mode: baseMode, modeChanged: false, changed: 0 }, col)}
            <td><span class="v {cell.kind}">{cell.text}</span></td>
          {/each}
          <td class="acts"><span class="sm go">Edit</span></td>
        </tr>

        {#each rows as row (row.index)}
          <tr class="lvl" class:sel={selection.has(row.index)} onclick={() => onopen(row.index)}>
            <td class="tick">
              <button
                type="button"
                class="box"
                class:ticked={selection.has(row.index)}
                aria-label="Select {row.name}"
                onclick={e => { e.stopPropagation(); toggleRow(row.index) }}
              ></button>
            </td>
            <td class="n">{row.index + 1}</td>
            <td class="mapname">
              {row.name}
              {#if rotationCheck.statusOf(row.name) === 'absent'}
                <span class="nodl" title="Not available on FactionFiles. Players without this map cannot download it.">
                  no auto-download
                </span>
              {/if}
            </td>
            {#each columns as col (col)}
              {@const cell = cellFor(row, col)}
              <td><span class="v {cell.kind}">{cell.text}</span></td>
            {/each}
            <td class="acts">
              <button type="button" class="sm" title="Move up" aria-label="Move {row.name} up"
                onclick={e => { e.stopPropagation(); move(row.index, -1) }}>&uarr;</button>
              <button type="button" class="sm" title="Move down" aria-label="Move {row.name} down"
                onclick={e => { e.stopPropagation(); move(row.index, 1) }}>&darr;</button>
              <button type="button" class="sm" title="Remove" aria-label="Remove {row.name}"
                onclick={e => { e.stopPropagation(); removeAt([row.index]) }}>&times;</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="sheetfoot">
    <span><strong>same</strong>: inherited from the base rules.</span>
    {#if absent.length}
      <span class="nodlnote">
        <strong>{absent.length}</strong>
        {absent.length === 1 ? 'map is' : 'maps are'} not available on the FactionFiles
        autodownloader. Players without {absent.length === 1 ? 'it' : 'them'} cannot
        download {absent.length === 1 ? 'it' : 'them'} when joining.
      </span>
    {:else if rotationCheck.offline}
      <span class="quiet">Could not reach FactionFiles. Maps were not checked against the archive.</span>
    {/if}
  </div>
{/if}

{#if selected.length}
  <div class="bulkbar">
    <strong>{selected.length} {selected.length === 1 ? 'map' : 'maps'} selected</strong>
    <span class="sp"></span>
    <button type="button" class="btn" class:pressed={panel === 'bulk'} onclick={() => openPanel('bulk')}>
      Change setting
    </button>
    <button type="button" class="btn" onclick={() => removeAt(selected)}>Remove from rotation</button>
    <button type="button" class="btn" onclick={() => (selection = new Set())}>Clear selection</button>
  </div>

  {#if panel === 'bulk'}
    <div class="panel">
      <h4>Change setting on {selected.length} maps</h4>
      {#if selected.length === levels.length && levels.length > 1}
        <div class="banner warn">
          <span class="ic">!</span>
          <div>
            All maps are selected. Changing the base rules instead applies the value
            once, including to maps added later.
            <button type="button" class="link" onclick={onopenbase}>
              Edit base rules
            </button>
          </div>
        </div>
      {/if}
      {#if bulkPath}
        <p class="ph">
          {selected.map(i => levels[i].filename).join(', ')}.
          <br />Current: {bulkSummary}.
        </p>
        <Field
          scope="rules"
          path={bulkPath}
          resolved={bulkResolved}
          bare
          onchange={(path, value) => bulkSet(path, value)}
        />
        <div class="acts">
          <button type="button" class="btn" onclick={() => (bulkPath = null)}>Choose another setting</button>
          <span class="sp"></span>
          <button type="button" class="btn" onclick={() => bulkClear(bulkPath!)}>
            Use base rules value
          </button>
        </div>
      {:else}
        <SettingPicker onpick={id => (bulkPath = id)} placeholder="Search settings" />
      {/if}
    </div>
  {/if}
{/if}

<style>
  .sheetbar {
    display: flex;
    align-items: center;
    gap: 9px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line);
  }

  .sheetbar .ct { font-size: 12.5px; color: var(--ink-3); }
  .sp { flex: 1; }

  .panel {
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--surface);
    padding: 14px 15px;
    margin: 12px 0;
    box-shadow: var(--sh);
  }

  .panel h4 { font-size: 14px; margin-bottom: 3px; }

  .ph {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 0 0 10px;
    max-width: 62ch;
  }

  .panel .acts {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 11px;
  }

  .area {
    width: 100%;
    display: block;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.6;
    resize: vertical;
  }

  .grow { flex: 1; }

  code {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--sunk);
    border-radius: 3px;
    padding: 1px 4px;
  }

  .empty {
    border: 1px dashed var(--line-2);
    border-radius: 8px;
    padding: 26px;
    margin-top: 18px;
    text-align: center;
    color: var(--ink-3);
    font-size: 13.5px;
  }

  .empty p { margin: 0 0 6px; }
  .empty p:last-child { margin: 0; max-width: 48ch; margin-inline: auto; }

  .sheetwrap {
    overflow-x: auto;
    margin-top: 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }

  table.sheet {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    background: var(--surface);
  }

  table.sheet th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .07em;
    text-transform: uppercase;
    color: var(--ink-3);
    padding: 8px 12px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line-2);
    white-space: nowrap;
  }

  table.sheet td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  table.sheet tr:last-child td { border-bottom: 0; }

  table.sheet tr.baserow {
    cursor: pointer;
  }

  table.sheet tr.baserow td {
    background: var(--surface-2);
    font-weight: 600;
    border-bottom: 2px solid var(--line-2);
  }

  table.sheet tr.baserow:hover td { background: var(--sunk); }
  table.sheet tr.baserow:hover .go { opacity: 1; }

  td.mapname .sub {
    display: block;
    font-weight: 400;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  table.sheet tr.lvl { cursor: pointer; }
  table.sheet tr.lvl:hover td { background: var(--sunk); }
  table.sheet tr.lvl.sel td { background: var(--p-map-b); }

  td.n, th.n {
    color: var(--ink-3);
    width: 34px;
    text-align: right;
    font-size: 12px;
    padding-right: 4px;
  }

  td.tick, th.tick { width: 34px; padding-right: 0; }
  td.mapname { font-weight: 500; }

  td.acts, th.acts { width: 84px; text-align: right; }

  td.acts .sm {
    border: 0;
    background: none;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 4px;
    font-size: 13px;
    border-radius: 4px;
    opacity: 0;
  }

  tr.lvl:hover .sm { opacity: 1; }

  /* always visible, since this row is the main path to the base rules */
  td.acts .sm.go {
    opacity: 1;
    font-size: 11.5px;
    padding-right: 8px;
  }

  td.acts .sm:hover { background: var(--surface-2); color: var(--ink); }
  td.acts .sm:focus-visible { opacity: 1; }

  .v.inherited { color: var(--ink-3); }
  .v.muted { color: var(--ink-3); font-style: italic; }
  .v.mut { color: var(--p-mut); }

  .v.map {
    color: var(--p-map);
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .v.map::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--p-map);
  }

  .sheetfoot {
    padding: 10px 2px;
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .sheetfoot strong { color: var(--ink); }

  .byhand {
    margin-top: 14px;
    padding-top: 13px;
    border-top: 1px solid var(--line);
  }

  .nodl {
    display: inline-block;
    margin-left: 7px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--err-b);
    color: var(--err);
    font-size: 11px;
    white-space: nowrap;
  }

  .sheetfoot .nodlnote,
  .sheetfoot .quiet {
    display: block;
    margin-top: 5px;
  }

  .sheetfoot .nodlnote,
  .sheetfoot .nodlnote strong { color: var(--err); }

  .sheetfoot .quiet { color: var(--ink-3); }

  .link {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .bulkbar {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 14px;
    border: 1px solid var(--p-map);
    background: var(--p-map-b);
    border-radius: 8px;
    font-size: 13px;
    margin-top: 6px;
  }

  .box {
    width: 15px;
    height: 15px;
    border: 1px solid var(--line-2);
    border-radius: 3px;
    background: var(--surface);
    padding: 0;
    cursor: pointer;
    display: block;
    position: relative;
  }

  .box.ticked { background: var(--p-map); border-color: var(--p-map); }

  .box.ticked::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 4px;
    height: 8px;
    border: solid var(--on-accent);
    border-width: 0 2px 2px 0;
    transform: translate(-50%, -60%) rotate(42deg);
  }
</style>
