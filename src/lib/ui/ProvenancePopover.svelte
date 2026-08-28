<script lang="ts">
  import { schemaFor, textFor, type Scope } from '../../schema'
  import type { Contribution, Layer, Resolved } from '../resolve'

  interface Props {
    scope: Scope
    path: string
    resolved: Resolved | undefined
    anchor: HTMLElement | null
    levelScope?: boolean
    onclose?: () => void
    onreset?: (path: string) => void
  }

  const { scope, path, resolved, anchor, levelScope = false, onclose, onreset }: Props = $props()

  const text = $derived(textFor(scope, path))

  const position = $derived.by(() => {
    if (!anchor) return { top: 0, left: 0 }
    const box = anchor.getBoundingClientRect()
    return { top: box.bottom + 8, left: Math.max(12, box.right - 322) }
  })

  function toneFor(layer: Layer) {
    if (layer === 'mutator') return 'mut'
    if (layer === 'manual') return levelScope ? 'map' : 'you'
    return ''
  }

  function describe(c: Contribution) {
    if (c.layer === 'default') return 'Alpine default'
    if (c.layer === 'gametype') return `${c.source} defaults`
    if (c.layer === 'mutator') return `Mutator: ${c.source}`
    if (c.layer === 'inherited') return 'Base rules'
    return levelScope ? 'You, for this map' : 'You'
  }

  function show(value: unknown) {
    if (value === true) return 'on'
    if (value === false) return 'off'
    if (value === '' || value === undefined) return 'not set'
    // a list is too long to print in a popover, and a row of it is a record
    if (Array.isArray(value)) return value.length === 1 ? '1 entry' : `${value.length} entries`
    return String(value)
  }

  // a list that is folded together rather than replaced has no layer whose value
  // was thrown away, so nothing in its trail is crossed out
  const schema = $derived(schemaFor(scope, path))
  const merged = $derived(schema?.kind === 'array' && schema.mergeKey !== undefined)

  const trail = $derived(resolved?.trail ?? [])
  const canReset = $derived(resolved?.layer === 'manual')
</script>

<svelte:window onkeydown={e => e.key === 'Escape' && onclose?.()} />

<div class="pop" style="top:{position.top}px; left:{position.left}px" role="dialog" aria-label="Where this value comes from">
  <h5>Where this comes from</h5>
  <div class="pk">{path}</div>

  {#each trail as contribution, i (i)}
    <div class="tr" class:win={i === trail.length - 1}>
      <i class="pd {toneFor(contribution.layer)}"></i>
      <span>{describe(contribution)}</span>
      <span class="v">
        {#if i === trail.length - 1 || merged}
          {show(contribution.value)}
        {:else}
          <s>{show(contribution.value)}</s>
        {/if}
      </span>
    </div>
    {#if contribution.description}
      <div class="note">{contribution.description}</div>
    {/if}
  {/each}

  {#if text.help}
    <div class="note">{text.help}</div>
  {/if}

  {#if canReset}
    <div class="acts">
      <button type="button" class="rst" onclick={() => { onreset?.(path); onclose?.() }}>
        {levelScope ? 'Use the base rules value' : 'Reset to default'}
      </button>
    </div>
  {/if}
</div>

<style>
  .pop {
    position: fixed;
    z-index: 40;
    width: 322px;
    background: var(--surface);
    border: 1px solid var(--line-2);
    border-radius: 9px;
    box-shadow: var(--sh);
    padding: 14px 15px;
    font-size: 13px;
  }

  h5 {
    margin: 0 0 2px;
    font-size: 13.5px;
    font-weight: 600;
  }

  .pk {
    font-size: 11.5px;
    color: var(--ink-3);
    margin-bottom: 11px;
    font-family: var(--mono);
  }

  .tr {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    gap: 9px;
    align-items: center;
    padding: 5px 0;
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .tr .v { font-variant-numeric: tabular-nums; }
  .tr s { opacity: .6; }

  .tr.win {
    color: var(--ink);
    font-weight: 600;
  }

  .note {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--ink-3);
  }

  .acts {
    display: flex;
    gap: 8px;
    margin-top: 11px;
  }

  .rst {
    border: 1px solid var(--line-2);
    background: var(--surface);
    border-radius: 6px;
    padding: 5px 11px;
    font-size: 12.5px;
    cursor: pointer;
  }

  .rst:hover { background: var(--sunk); }
</style>
