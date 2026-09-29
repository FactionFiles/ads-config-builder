<script lang="ts">
  // list settings: each row is a record, a bare value, or (for the gun game
  // ladder) a group of weapons

  import { schemaFor, textFor, type Scope } from '../../schema'
  import type {
    ArrayKey, AuthoredField, LookupTable, ScalarType,
  } from '../../schema/types'
  import { toDisplay, toFile, unitFor } from '../format'
  import { tableFor } from '../gamedata'
  import { rowSources, type ResolvedRules, type RowOrigin } from '../resolve'
  import ProvenanceDot, { labelFor, toneFor } from './ProvenanceDot.svelte'

  interface Props {
    scope: Scope
    path: string
    resolved: ResolvedRules
    /** the rows this scope sets itself, which edits are written into */
    manual?: unknown
    levelScope?: boolean
    /** shown when the active game type ignores this setting */
    offMode?: string
    /** each map's manual keys, for rows alpine reseeds per scope */
    mapManual?: Record<string, unknown>[]
    /** how many maps this scope edits at once */
    maps?: number
    /** the maps in scope hold different lists */
    mixed?: boolean
    /** set by hand on only some of the maps in scope */
    partial?: boolean
    onchange?: (path: string, value: unknown) => void
    /** write one row into every map */
    onapplytoall?: (path: string, row: Record<string, unknown>) => void
    onreset?: (path: string) => void
    onprovenance?: (path: string, anchor: HTMLElement) => void
  }

  const {
    scope, path, resolved, manual, levelScope = false, offMode, mapManual = [],
    maps = 1, mixed = false, partial = false, onchange, onreset, onprovenance, onapplytoall,
  }: Props = $props()

  interface Column {
    key: string
    type: ScalarType
    lookup?: LookupTable
    text: AuthoredField
  }

  const schema = $derived(schemaFor(scope, path) as ArrayKey)
  const text = $derived(textFor(scope, path))
  const current = $derived(resolved.get(path))
  const rows = $derived(Array.isArray(current?.value) ? (current.value as unknown[]) : [])

  const columns = $derived<Column[]>(
    (schema.item ?? []).map(field => ({
      key: field.key,
      type: field.type ?? 'string',
      // prefer the parser's lookup, then fall back to the authored one
      lookup: field.lookup ?? text.fields?.[field.key]?.lookup,
      text: text.fields?.[field.key] ?? { label: field.key },
    }))
  )

  /** a list of bare values has one unnamed column */
  const loose = $derived<Column>({
    key: '',
    type: schema.itemType ?? 'string',
    lookup: schema.lookup,
    text: { label: text.label },
  })

  const canReset = $derived(current?.layer === 'manual')

  // merged lists show rows from every layer; editing an inherited row adds an
  // entry to this scope keyed by the merge field
  const mergeKey = $derived(schema.mergeKey)
  const mine = $derived(Array.isArray(manual) ? (manual as Record<string, unknown>[]) : [])
  const origins = $derived<RowOrigin[]>(rowSources(current, mergeKey))

  const sameId = (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b

  function isMine(row: unknown): boolean {
    if (!mergeKey) return true
    const id = (row as Record<string, unknown>)?.[mergeKey]
    return mine.some(r => sameId(r[mergeKey], id))
  }

  function rowTone(row: unknown, origin: RowOrigin | undefined) {
    return toneFor(origin?.by?.layer, isMine(row) && levelScope)
  }

  function rowTitle(row: unknown, origin: RowOrigin | undefined) {
    const by = origin?.by
    return 'Set by ' + labelFor(by?.layer, isMine(row) && levelScope)
      + (by?.source ? `: ${by.source}` : '')
  }

  // removing an override of an inherited row reverts it rather than deleting it
  function removeLabel(origin: RowOrigin | undefined) {
    return origin?.first && origin.first !== origin.by ? 'Reset' : 'Remove'
  }

  // the parser seeds some rows (like the fusion weapon stay rule) once per scope,
  // so a base rules change is undone on every map that does not repeat it.
  // returns how many maps lose the row.
  function reseededOn(row: unknown): number {
    if (levelScope || !mergeKey || !onapplytoall) return 0
    const seed = (schema.seed ?? []).find(s => sameId(s[mergeKey], (row as Record<string, unknown>)?.[mergeKey]))
    if (!seed || !isMine(row)) return 0
    // a row that matches the seed loses nothing
    const differs = Object.entries(seed).some(
      ([field, value]) => field !== mergeKey && cellValue(row, field) !== value
    )
    if (!differs) return 0
    const id = (row as Record<string, unknown>)[mergeKey]
    return mapManual.filter(map => {
      const held = map[path]
      return !Array.isArray(held) || !held.some(r => sameId((r as Record<string, unknown>)?.[mergeKey], id))
    }).length
  }

  // an empty list is the same as no list, so drop the key instead
  function set(next: unknown[]) {
    if (next.length === 0) onreset?.(path)
    else onchange?.(path, next)
  }

  function blank(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const column of columns) {
      out[column.key] = column.lookup
        ? unusedName(column)
        : column.type === 'bool' ? true : column.type === 'string' ? '' : 0
    }
    return out
  }

  /** the first name not already in the list, since names must be unique */
  function unusedName(column: Column): string {
    const table = tableFor(column.lookup!)
    const taken = rows.map(row => String(cellValue(row, column.key) ?? '').toLowerCase())
    return (table.find(e => !taken.includes(e.name.toLowerCase())) ?? table[0])?.name ?? ''
  }

  function editRow(index: number, key: string, value: unknown) {
    if (!mergeKey) {
      set(rows.map((row, i) => (i === index ? { ...(row as object), [key]: value } : row)))
      return
    }
    const id = (rows[index] as Record<string, unknown>)[mergeKey]
    const at = mine.findIndex(r => sameId(r[mergeKey], id))
    // write only the changed field so the rest stay inherited
    if (at === -1) set([...mine, { [mergeKey]: id, [key]: value }])
    else set(mine.map((row, i) => (i === at ? { ...row, [key]: value } : row)))
  }

  function removeRow(index: number) {
    if (!mergeKey) {
      set(rows.filter((_, i) => i !== index))
      return
    }
    const id = (rows[index] as Record<string, unknown>)[mergeKey]
    set(mine.filter(row => !sameId(row[mergeKey], id)))
  }

  function addRow() {
    set(mergeKey ? [...mine, blank()] : [...rows, blank()])
  }

  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= rows.length) return
    const next = [...rows]
    const [taken] = next.splice(index, 1)
    next.splice(to, 0, taken)
    set(next)
  }

  function cellValue(row: unknown, key: string): unknown {
    return key ? (row as Record<string, unknown>)?.[key] : row
  }

  /** display name for a read-only lookup cell */
  function nameOf(column: Column, value: unknown): string {
    const shown = typeof value === 'string' ? value : ''
    if (!column.lookup) return shown
    return tableFor(column.lookup).find(e => e.name === shown)?.display ?? shown
  }

  /** lookup options, keeping an unknown current value rather than dropping it */
  function optionsFor(column: Column, value: unknown) {
    const entries = tableFor(column.lookup!).map(e => ({ value: e.name, label: e.display }))
    const shown = typeof value === 'string' ? value : ''
    if (shown && !entries.some(e => e.value === shown)) {
      entries.unshift({ value: shown, label: `${shown} (unknown)` })
    }
    if (column.text.emptyLabel) entries.unshift({ value: '', label: column.text.emptyLabel })
    return entries
  }

  function setNumber(column: Column, raw: string, apply: (value: number) => void) {
    const n = Number(raw)
    if (Number.isFinite(n)) apply(toFile(column.text, n))
  }

  // gun game ladder: each row is a group of weapons given together
  function editTier(index: number, next: string[]) {
    if (next.length === 0) { removeRow(index); return }
    set(rows.map((row, i) => (i === index ? next : row)))
  }

  function tierOf(row: unknown): string[] {
    return Array.isArray(row) ? (row as string[]) : []
  }

  const firstName = $derived(
    schema.lookup ? tableFor(schema.lookup)[0]?.name ?? '' : ''
  )
</script>

{#snippet cell(column: Column, value: unknown, apply: (value: unknown) => void, label: string)}
  {#if column.type === 'bool'}
    <button
      type="button"
      class="sw"
      class:on={value === true}
      role="switch"
      aria-checked={value === true}
      aria-label={label}
      onclick={() => apply(!(value === true))}
    ></button>
  {:else if column.lookup}
    <select
      class="ctl"
      value={typeof value === 'string' ? value : ''}
      aria-label={label}
      onchange={e => apply(e.currentTarget.value)}
    >
      {#each optionsFor(column, value) as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  {:else if column.type === 'int' || column.type === 'float'}
    <span class="ctl">
      <input
        type="number"
        value={toDisplay(column.text, value) as number}
        step={column.type === 'int' ? 1 : 'any'}
        aria-label={label}
        onchange={e => setNumber(column, e.currentTarget.value, apply)}
      />
      {#if unitFor(column.text)}<span class="unit">{unitFor(column.text)}</span>{/if}
    </span>
  {:else}
    <input
      class="ctl"
      type="text"
      value={typeof value === 'string' ? value : ''}
      aria-label={label}
      onchange={e => apply(e.currentTarget.value)}
    />
  {/if}
{/snippet}

<div class="le" class:offmode={offMode}>
  <h3 class="gh">
    {text.label}
    <ProvenanceDot
      resolved={current}
      {levelScope}
      onopen={anchor => onprovenance?.(path, anchor)}
    />
  </h3>

  {#if text.help}<p class="lead">{text.help}</p>{/if}
  {#if offMode}<p class="warn">{offMode}</p>{/if}
  {#if mixed}
    <p class="warn">
      Differs across the selected maps. Editing replaces this list on all of them.
    </p>
  {/if}

  {#if !rows.length}
    <p class="none">None.</p>
  {/if}

  {#if columns.length}
    {#if rows.length}
      <table class="rows">
        <thead>
          <tr>
            {#each columns as column (column.key)}
              <th title={column.text.help}>{column.text.label}</th>
            {/each}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, i (i)}
            {@const own = isMine(row)}
            <tr>
              {#each columns as column (column.key)}
                <td>
                  {#if !own && column.key === mergeKey}
                    <span class="held">{nameOf(column, cellValue(row, column.key))}</span>
                  {:else}
                    {@render cell(
                      column,
                      cellValue(row, column.key),
                      value => editRow(i, column.key, value),
                      `${column.text.label}, row ${i + 1}`,
                    )}
                  {/if}
                </td>
              {/each}
              <td class="acts">
                {#if mergeKey}
                  <i class="pd {rowTone(row, origins[i])}" title={rowTitle(row, origins[i])}></i>
                {/if}
                {#if own}
                  <button type="button" class="btn" onclick={() => removeRow(i)}>
                    {removeLabel(origins[i])}
                  </button>
                {/if}
              </td>
            </tr>
            {@const missing = reseededOn(row)}
            {#if missing}
              <tr class="reseed">
                <td colspan={columns.length + 1}>
                  Alpine resets this row on every map, so this change does not apply to
                  {missing === mapManual.length ? 'any map' : 'every map'}.
                  <button
                    type="button"
                    class="btn"
                    onclick={() => onapplytoall?.(path, row as Record<string, unknown>)}
                  >
                    Apply to {missing === 1 ? '1 map' : `all ${mapManual.length} maps`}
                  </button>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/if}
    <button type="button" class="btn addbtn" onclick={addRow}>
      Add row
    </button>
  {:else if schema.itemsAreLists}
    {#each rows as row, i (i)}
      {@const tier = tierOf(row)}
      <div class="tier">
        <div class="thead">
          <span class="num">Level {i + 1}</span>
          <button type="button" class="btn" disabled={i === 0} onclick={() => move(i, -1)}>Up</button>
          <button type="button" class="btn" disabled={i === rows.length - 1} onclick={() => move(i, 1)}>Down</button>
          <button type="button" class="btn" onclick={() => removeRow(i)}>Remove</button>
        </div>
        <div class="chips">
          {#each tier as entry, j (j)}
            <span class="chip">
              {@render cell(
                loose,
                entry,
                value => editTier(i, tier.map((e, k) => (k === j ? String(value) : e))),
                `Level ${i + 1} weapon ${j + 1}`,
              )}
              <button
                type="button"
                class="x"
                aria-label="Remove weapon {j + 1} from level {i + 1}"
                onclick={() => editTier(i, tier.filter((_, k) => k !== j))}
              >&times;</button>
            </span>
          {/each}
          <button type="button" class="btn" onclick={() => editTier(i, [...tier, firstName])}>
            Add weapon
          </button>
        </div>
      </div>
    {/each}
    <button type="button" class="btn addbtn" onclick={() => set([...rows, [firstName]])}>
      Add level
    </button>
  {:else}
    {#each rows as row, i (i)}
      <div class="row">
        {@render cell(
          loose,
          row,
          value => set(rows.map((r, k) => (k === i ? value : r))),
          `${text.label} ${i + 1}`,
        )}
        <button type="button" class="btn" onclick={() => removeRow(i)}>Remove</button>
      </div>
    {/each}
    <button
      type="button"
      class="btn addbtn"
      onclick={() => set([...rows, schema.lookup ? firstName : ''])}
    >
      Add
    </button>
  {/if}

  {#if canReset}
    <div class="src {levelScope ? 'map' : 'you'}">
      <i class="pd {levelScope ? 'map' : 'you'}"></i>
      {maps > 1 ? (partial ? 'Set on some maps' : 'Set for these maps')
        : levelScope ? 'Set for this map' : 'Changed'}
      <button type="button" class="rst" onclick={() => onreset?.(path)}>
        {mergeKey ? 'undo all changes' : 'clear list'}
      </button>
    </div>
  {/if}
</div>

<style>
  .rows tr.reseed td {
    border-top: 0;
    padding: 0 0 10px;
    font-size: 12px;
    color: var(--err);
    max-width: 60ch;
  }

  .rows tr.reseed .btn { margin-left: 8px; }

  .le { margin: 30px 0; }
  .le:first-child { margin-top: 0; }
  .le:last-child { margin-bottom: 0; }

  .le.offmode { opacity: .75; }

  .lead {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 0 0 12px;
    max-width: 64ch;
  }

  .warn {
    font-size: 12px;
    color: var(--ink-3);
    margin: -6px 0 12px;
  }

  .rows {
    border-collapse: collapse;
    margin-bottom: 10px;
  }

  .rows th {
    text-align: left;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--ink-3);
    padding: 0 12px 6px 0;
  }

  .rows td {
    padding: 3px 12px 3px 0;
    vertical-align: middle;
  }

  .rows td.acts {
    padding-right: 0;
    white-space: nowrap;
  }

  .rows td.acts .pd { margin-right: 8px; }

  /* inherited row: the name is fixed here but its other fields are editable */
  .held {
    font-size: 13px;
    color: var(--ink-3);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }

  .tier {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px 12px;
    margin-bottom: 10px;
  }

  .tier .thead {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 9px;
  }

  .tier .num {
    flex: 1;
    font-size: 12.5px;
    font-weight: 600;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .chip .x {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--ink-3);
    font-size: 15px;
    line-height: 1;
    padding: 2px 4px;
  }

  .chip .x:hover { color: var(--ink); }

  .none {
    font-size: 13px;
    color: var(--ink-3);
    margin: 0 0 8px;
  }

  .addbtn { margin-top: 4px; }

  .src {
    font-size: 11.5px;
    color: var(--ink-3);
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .src.you { color: var(--p-you); }
  .src.map { color: var(--p-map); }

  .rst {
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    color: var(--ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    font-size: 11.5px;
  }
</style>
