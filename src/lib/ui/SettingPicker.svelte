<script lang="ts">
  // Picking one of a hundred-odd settings by name. Used both for choosing the
  // sheet's columns and for choosing what a multi-map edit changes, so the two
  // stay one list rather than drifting into two.

  import { allEntries, pages, schemaFor, textFor } from '../../schema'

  interface Choice {
    id: string
    label: string
    group: string
  }

  interface Props {
    /** shown above the settings, for the sheet's own pseudo-columns */
    extra?: Choice[]
    /** ids currently chosen; when given, rows are toggles rather than buttons */
    selected?: string[]
    placeholder?: string
    onpick: (id: string) => void
  }

  const { extra = [], selected, placeholder = 'Search settings', onpick }: Props = $props()

  let filter = $state('')

  const pageTitle = new Map(pages.map(p => [p.id, p.title]))

  const settings: Choice[] = allEntries
    .filter(e => e.scope === 'rules' && schemaFor('rules', e.path)?.kind === 'scalar')
    .map(e => {
      const text = textFor('rules', e.path)
      return { id: e.path, label: text.label, group: pageTitle.get(text.page) ?? 'Other' }
    })

  const all = $derived([...extra, ...settings])

  const matches = $derived.by(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return all
    return all.filter(c =>
      c.label.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)
    )
  })
</script>

<div class="picker">
  <input class="ctl find" type="search" {placeholder} bind:value={filter} />
  <div class="list">
    {#each matches as choice (choice.id)}
      <button
        type="button"
        class="row"
        class:chosen={selected?.includes(choice.id)}
        onclick={() => onpick(choice.id)}
      >
        {#if selected}
          <span class="box" class:ticked={selected.includes(choice.id)}></span>
        {/if}
        <span class="nm">{choice.label}</span>
        <span class="gp">{choice.group}</span>
      </button>
    {:else}
      <p class="none">Nothing matches "{filter}".</p>
    {/each}
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .find {
    width: 100%;
    margin-bottom: 8px;
  }

  .list {
    overflow-y: auto;
    max-height: 280px;
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    text-align: left;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    padding: 7px 11px;
    font-size: 13px;
    cursor: pointer;
  }

  .row:last-child { border-bottom: 0; }
  .row:hover { background: var(--sunk); }
  .row.chosen { background: var(--p-map-b); }

  .row .nm { flex: 1; }

  .row .gp {
    font-size: 11.5px;
    color: var(--ink-3);
    white-space: nowrap;
  }

  .box {
    width: 14px;
    height: 14px;
    border: 1px solid var(--line-2);
    border-radius: 3px;
    flex: none;
    background: var(--surface);
  }

  .box.ticked {
    background: var(--p-map);
    border-color: var(--p-map);
    position: relative;
  }

  .box.ticked::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 1px;
    width: 4px;
    height: 8px;
    border: solid var(--on-accent);
    border-width: 0 2px 2px 0;
    transform: rotate(42deg);
  }

  .none {
    padding: 14px;
    margin: 0;
    font-size: 13px;
    color: var(--ink-3);
  }
</style>
