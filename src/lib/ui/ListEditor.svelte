<script lang="ts">
  // A setting that holds a list rather than one value. Three shapes share this
  // component because they differ only in what one row holds: a small record
  // per row, a bare name per row, or - for the Gun Game ladder - a whole group
  // of names per row.

  import { schemaFor, textFor, type Scope } from '../../schema'
  import type {
    ArrayKey, AuthoredField, LookupTable, ScalarType,
  } from '../../schema/types'
  import { toDisplay, toFile, unitFor } from '../format'
  import { tableFor } from '../gamedata'
  import type { ResolvedRules } from '../resolve'
  import ProvenanceDot from './ProvenanceDot.svelte'

  interface Props {
    scope: Scope
    path: string
    resolved: ResolvedRules
    levelScope?: boolean
    /** set when the mode in play ignores this setting, worded for the user */
    offMode?: string
    onchange?: (path: string, value: unknown) => void
    onreset?: (path: string) => void
    onprovenance?: (path: string, anchor: HTMLElement) => void
  }

  const {
    scope, path, resolved, levelScope = false, offMode, onchange, onreset, onprovenance,
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
      // the parser's own check first, then a name the authored layer offers for
      // a field the parser takes on trust
      lookup: field.lookup ?? text.fields?.[field.key]?.lookup,
      text: text.fields?.[field.key] ?? { label: field.key },
    }))
  )

  /** a list of bare values has one unnamed column, which is the setting itself */
  const loose = $derived<Column>({
    key: '',
    type: schema.itemType ?? 'string',
    lookup: schema.lookup,
    text: { label: text.label },
  })

  const canReset = $derived(current?.layer === 'manual')

  // an empty list means the same thing as no list at all, so clearing the last
  // row takes the key out of the file rather than writing an empty one
  function set(next: unknown[]) {
    if (next.length === 0) onreset?.(path)
    else onchange?.(path, next)
  }

  function blank(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const column of columns) {
      out[column.key] = column.type === 'bool' ? true : column.type === 'string' ? '' : 0
    }
    return out
  }

  function editRow(index: number, key: string, value: unknown) {
    set(rows.map((row, i) => (i === index ? { ...(row as object), [key]: value } : row)))
  }

  function removeRow(index: number) {
    set(rows.filter((_, i) => i !== index))
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

  /** the names this column offers, with anything unknown kept rather than lost */
  function optionsFor(column: Column, value: unknown) {
    const entries = tableFor(column.lookup!).map(e => ({ value: e.name, label: e.display }))
    const shown = typeof value === 'string' ? value : ''
    if (shown && !entries.some(e => e.value === shown)) {
      entries.unshift({ value: shown, label: `${shown} (not a name the game knows)` })
    }
    if (column.text.emptyLabel) entries.unshift({ value: '', label: column.text.emptyLabel })
    return entries
  }

  function setNumber(column: Column, raw: string, apply: (value: number) => void) {
    const n = Number(raw)
    if (Number.isFinite(n)) apply(toFile(column.text, n))
  }

  // the Gun Game ladder: each row is a group of weapons handed out together
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

  {#if !rows.length}
    <p class="none">None yet.</p>
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
            <tr>
              {#each columns as column (column.key)}
                <td>
                  {@render cell(
                    column,
                    cellValue(row, column.key),
                    value => editRow(i, column.key, value),
                    `${column.text.label}, row ${i + 1}`,
                  )}
                </td>
              {/each}
              <td class="acts">
                <button type="button" class="btn" onclick={() => removeRow(i)}>Remove</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    <button type="button" class="btn addbtn" onclick={() => set([...rows, blank()])}>
      Add a row
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
            Add a weapon
          </button>
        </div>
      </div>
    {/each}
    <button type="button" class="btn addbtn" onclick={() => set([...rows, [firstName]])}>
      Add a level
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
      Add one
    </button>
  {/if}

  {#if canReset}
    <div class="src {levelScope ? 'map' : 'you'}">
      <i class="pd {levelScope ? 'map' : 'you'}"></i>
      {levelScope ? 'Just for this map' : 'You changed this'}
      <button type="button" class="rst" onclick={() => onreset?.(path)}>clear the list</button>
    </div>
  {/if}
</div>

<style>
  .le {
    padding-bottom: 18px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 18px;
  }

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

  .rows td.acts { padding-right: 0; }

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
