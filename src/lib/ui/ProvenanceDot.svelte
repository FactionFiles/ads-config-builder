<script lang="ts">
  import type { Layer, Resolved } from '../resolve'

  interface Props {
    resolved: Resolved | undefined
    /** a level scope's own edits read as "just for this map" rather than "you" */
    levelScope?: boolean
    onopen?: (anchor: HTMLElement) => void
  }

  const { resolved, levelScope = false, onopen }: Props = $props()

  function toneFor(layer: Layer | undefined, level: boolean) {
    if (layer === 'preset') return 'preset'
    if (layer === 'mutator') return 'mut'
    if (layer === 'manual') return level ? 'map' : 'you'
    return ''
  }

  function labelFor(layer: Layer | undefined, level: boolean) {
    if (layer === 'preset') return 'a preset'
    if (layer === 'mutator') return 'a mutator'
    if (layer === 'manual') return level ? 'this map only' : 'you'
    if (layer === 'gametype') return "the game mode's defaults"
    if (layer === 'inherited') return 'the base rules'
    return 'the Alpine default'
  }

  const tone = $derived(toneFor(resolved?.layer, levelScope))
  const description = $derived(
    `Set by ${labelFor(resolved?.layer, levelScope)}${resolved?.source ? `: ${resolved.source}` : ''}`
  )
</script>

<button
  class="prov"
  type="button"
  title={description}
  aria-label="Where this value comes from. {description}"
  onclick={e => onopen?.(e.currentTarget)}
>
  <i class="pd {tone}"></i>
</button>

<style>
  .prov {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
    border: 1px solid transparent;
    background: none;
    padding: 0;
    cursor: pointer;
  }

  .prov:hover {
    border-color: var(--line-2);
    background: var(--sunk);
  }

  .pd {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
    flex: none;
    background: var(--p-def);
  }

  .pd.preset { background: var(--p-preset); }
  .pd.mut    { background: var(--p-mut); }
  .pd.you    { background: var(--p-you); }
  .pd.map    { background: var(--p-map); }
</style>
