<script lang="ts">
  // one row per map; each cell shows whether the map inherits the base rules
  // or sets its own value

  import { gametypesByName, mutatorsByName, textFor } from '../../schema'
  import { emptyLevel, parseLevelList, type LevelEntry, type RulesScope } from '../config'
  import { formatValue } from '../format'
  import { effectiveMutators, type Resolved, type ResolvedRules } from '../resolve'
  import { rotationCheck } from '../mapcheck.svelte'
  import MapPicker from './MapPicker.svelte'
  import SettingPicker from './SettingPicker.svelte'

  interface Props {
    levels: LevelEntry[]
    base: RulesScope
    baseRules: ResolvedRules
    /** resolved rules per level, in rotation order */
    levelRules: ResolvedRules[]
    /** ticked rows, by rotation index */
    selection: number[]
    onchange: (next: LevelEntry[]) => void
    onselect: (next: number[]) => void
    /** opens the rules pages for one or more maps */
    onopen: (indexes: number[]) => void
    /** opens the base rules pages, where the top row is edited */
    onopenbase: () => void
  }

  const {
    levels, base, baseRules, levelRules, selection, onchange, onselect, onopen, onopenbase,
  }: Props = $props()

  // columns that are not a single setting: score limit follows each row's game
  // type, and mutators are a list
  const PSEUDO = [
    { id: '@score', label: 'Score limit', group: 'Rotation sheet' },
    { id: '@mutators', label: 'Mutators', group: 'Rotation sheet' },
  ]

  let columns = $state(['game_type', 'time_limit', '@score', '@mutators'])
  let panel = $state<'columns' | 'paste' | 'add' | null>(null)
  let pasteText = $state('')

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

  // named in the badge tooltip, since most overrides are not shown as columns
  function overridesOf(level: LevelEntry): string {
    return [
      ...Object.keys(level.rules.manual).map(path => textFor('rules', path).label),
      ...level.rules.mutators.map(m => `${mutatorLabel(m.name)} mutator`),
    ].join(', ')
  }

  function toggleColumn(id: string) {
    columns = columns.includes(id) ? columns.filter(c => c !== id) : [...columns, id]
  }

  function addMaps(names: string[]) {
    if (!names.length) return
    onchange([...levels, ...names.map(emptyLevel)])
  }

  // applies a new order, given as original indexes, keeping the selection on
  // the same maps rather than the same row numbers
  function reorder(order: number[]) {
    if (order.every((from, i) => from === i)) return
    onselect(order.flatMap((from, i) => (ticked.has(from) ? [i] : [])))
    onchange(order.map(from => levels[from]))
  }

  // original indexes after moving a set of rows to an insertion point (0..length)
  function orderAfterMove(moving: number[], target: number): number[] {
    const set = new Set(moving)
    const rest = levels.map((_, i) => i).filter(i => !set.has(i))
    const at = rest.filter(i => i < target).length
    return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
  }

  // grabbing a selected row carries the whole selection
  function movingFor(index: number) {
    return ticked.has(index) ? selection : [index]
  }

  function removeAt(indexes: number[]) {
    const drop = new Set(indexes)
    const keep = levels.map((_, i) => i).filter(i => !drop.has(i))
    onselect(keep.flatMap((from, i) => (ticked.has(from) ? [i] : [])))
    onchange(keep.map(from => levels[from]))
  }

  let rowEls = $state<HTMLTableRowElement[]>([])
  let gripEls = $state<HTMLButtonElement[]>([])

  interface Drag {
    grabbed: number
    moving: number[]
    startY: number
    y: number
    active: boolean
    target: number
    scroller: HTMLElement | null
    frame: number
  }

  let drag = $state<Drag | null>(null)

  const dragMoving = $derived(new Set(drag?.active ? drag.moving : []))

  // insertion point for the drop line, hidden when the drop would change nothing
  const dropAt = $derived.by(() => {
    if (!drag?.active) return -1
    const order = orderAfterMove(drag.moving, drag.target)
    return order.every((from, i) => from === i) ? -1 : drag.target
  })

  function scrollParent(el: HTMLElement | null): HTMLElement | null {
    for (let n = el?.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
    }
    return null
  }

  function targetAt(y: number) {
    let target = 0
    for (let i = 0; i < levels.length; i++) {
      const r = rowEls[i]?.getBoundingClientRect()
      if (r && y > r.top + r.height / 2) target = i + 1
    }
    return target
  }

  // scrolls while the pointer rests near the edge of the scroll area
  function autoScroll() {
    if (!drag) return
    if (drag.active && drag.scroller) {
      const box = drag.scroller.getBoundingClientRect()
      const edge = 48
      const by = drag.y < box.top + edge ? -(box.top + edge - drag.y)
        : drag.y > box.bottom - edge ? drag.y - (box.bottom - edge) : 0
      if (by) {
        drag.scroller.scrollTop += Math.round(by / 3)
        drag.target = targetAt(drag.y)
      }
    }
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function gripDown(e: PointerEvent, index: number) {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag = {
      grabbed: index,
      moving: movingFor(index),
      startY: e.clientY,
      y: e.clientY,
      active: false,
      target: index,
      scroller: scrollParent(rowEls[index]),
      frame: 0,
    }
    drag.frame = requestAnimationFrame(autoScroll)
  }

  function gripMove(e: PointerEvent) {
    if (!drag) return
    drag.y = e.clientY
    if (!drag.active && Math.abs(e.clientY - drag.startY) < 4) return
    drag.active = true
    drag.target = targetAt(e.clientY)
  }

  function endDrag(commit: boolean) {
    if (!drag) return
    const { active, moving, target, frame } = drag
    cancelAnimationFrame(frame)
    drag = null
    if (commit && active) reorder(orderAfterMove(moving, target))
  }

  function gripKey(e: KeyboardEvent, index: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const moving = movingFor(index)
    const target = e.key === 'ArrowUp' ? Math.min(...moving) - 1 : Math.max(...moving) + 2
    if (target < 0 || target > levels.length) return
    const order = orderAfterMove(moving, target)
    reorder(order)
    // keep focus on the grip of the map that was moved
    const to = order.indexOf(index)
    queueMicrotask(() => gripEls[to]?.focus())
  }

  const ticked = $derived(new Set(selection))

  function toggleRow(index: number) {
    onselect(ticked.has(index)
      ? selection.filter(i => i !== index)
      : [...selection, index].sort((a, b) => a - b))
  }

  function toggleAll() {
    onselect(selection.length === levels.length ? [] : levels.map((_, i) => i))
  }

  function openPanel(which: typeof panel) {
    panel = panel === which ? null : which
  }
</script>

<svelte:window onkeydown={e => { if (e.key === 'Escape' && drag) { e.preventDefault(); endDrag(false) } }} />

<div class="banner">
  <span class="ic">i</span>
  <div>
    The top row shows the base <b>game rules</b>, which apply to every map. Use
    <b>Edit</b> on a map to override settings for that map.
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
    <MapPicker
      {taken}
      onpick={name => { addMaps([name]); panel = null }}
    />
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
          <th class="grip"></th>
          <th class="tick">
            <button
              type="button"
              class="box"
              class:ticked={selection.length === levels.length}
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
        <tr class="baserow">
          <td class="grip"></td>
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
          <td class="acts">
            <button type="button" class="sm go" aria-label="Edit base rules" onclick={onopenbase}>Edit</button>
          </td>
        </tr>

        {#each rows as row (row.index)}
          <tr
            class="lvl"
            class:sel={ticked.has(row.index)}
            class:moving={dragMoving.has(row.index)}
            class:dropbefore={dropAt === row.index}
            class:dropafter={dropAt === levels.length && row.index === levels.length - 1}
            bind:this={rowEls[row.index]}
          >
            <td class="grip">
              <button
                type="button"
                class="handle"
                class:grabbing={drag?.active}
                title="Drag to reorder"
                aria-label="Reorder {row.name}. Use arrow keys to move."
                bind:this={gripEls[row.index]}
                onpointerdown={e => gripDown(e, row.index)}
                onpointermove={gripMove}
                onpointerup={() => endDrag(true)}
                onpointercancel={() => endDrag(false)}
                onlostpointercapture={() => endDrag(false)}
                onkeydown={e => gripKey(e, row.index)}
              >
                <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
                  <circle cx="2" cy="2" r="1.3" /><circle cx="6" cy="2" r="1.3" />
                  <circle cx="2" cy="7" r="1.3" /><circle cx="6" cy="7" r="1.3" />
                  <circle cx="2" cy="12" r="1.3" /><circle cx="6" cy="12" r="1.3" />
                </svg>
              </button>
            </td>
            <td class="tick">
              <button
                type="button"
                class="box"
                class:ticked={ticked.has(row.index)}
                aria-label="Select {row.name}"
                onclick={() => toggleRow(row.index)}
              ></button>
            </td>
            <td class="n">{row.index + 1}</td>
            <td class="mapname">
              <button type="button" class="open" onclick={() => onopen([row.index])}>{row.name}</button>
              {#if row.changed && row.level}
                <span class="ovr" title={overridesOf(row.level)}>
                  {row.changed} {row.changed === 1 ? 'override' : 'overrides'}
                </span>
              {/if}
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
              <button type="button" class="sm" title="Remove" aria-label="Remove {row.name}"
                onclick={() => removeAt([row.index])}>&times;</button>
              <button type="button" class="sm go" aria-label="Edit {row.name}"
                onclick={() => onopen([row.index])}>Edit</button>
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

{#if selection.length}
  <div class="bulkbar">
    <strong>{selection.length} {selection.length === 1 ? 'map' : 'maps'} selected</strong>
    <span class="sp"></span>
    <button type="button" class="btn pri" onclick={() => onopen(selection)}>Edit settings</button>
    <button type="button" class="btn" onclick={() => removeAt(selection)}>Remove from rotation</button>
    <button type="button" class="btn" onclick={() => onselect([])}>Clear selection</button>
  </div>
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

  table.sheet tr.baserow td {
    background: var(--surface-2);
    font-weight: 600;
    border-bottom: 2px solid var(--line-2);
  }


  td.mapname .sub {
    display: block;
    font-weight: 400;
    font-size: 11.5px;
    color: var(--ink-3);
  }

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
  td.grip, th.grip { width: 20px; padding-left: 6px; padding-right: 0; }

  .handle {
    display: block;
    border: 0;
    background: none;
    padding: 3px 4px;
    border-radius: 4px;
    color: var(--ink-3);
    opacity: .55;
    cursor: grab;
    touch-action: none;
  }

  .handle svg { display: block; fill: currentColor; }
  tr.lvl:hover .handle, .handle:focus-visible { opacity: 1; }
  .handle:hover { background: var(--surface-2); color: var(--ink); }
  .handle.grabbing { cursor: grabbing; }

  table.sheet tr.lvl.moving td { opacity: .45; }
  table.sheet tr.lvl.dropbefore td { box-shadow: inset 0 2px 0 var(--graphite); }
  table.sheet tr.lvl.dropafter td { box-shadow: inset 0 -2px 0 var(--graphite); }
  td.mapname { font-weight: 500; }

  td.mapname .open {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  td.mapname .open:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  td.acts, th.acts { width: 80px; text-align: right; white-space: nowrap; }

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

  /* always visible, since it is the only way into a map's overrides */
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

  .ovr {
    display: inline-block;
    margin-left: 7px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--p-map-b);
    color: var(--p-map);
    font-size: 11px;
    font-weight: 400;
    white-space: nowrap;
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
