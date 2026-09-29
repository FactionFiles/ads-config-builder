<script module lang="ts">
  import type { Layer } from '../resolve'

  /** shared, since list rows show their own dots */
  export function toneFor(layer: Layer | undefined, level: boolean) {
    if (layer === 'mutator') return 'mut'
    if (layer === 'manual') return level ? 'map' : 'you'
    return ''
  }

  export function labelFor(layer: Layer | undefined, level: boolean) {
    if (layer === 'mutator') return 'a mutator'
    if (layer === 'manual') return level ? 'this map only' : 'you'
    if (layer === 'gametype') return 'game type defaults'
    return 'Alpine default'
  }
</script>

<script lang="ts">
  import type { Resolved } from '../resolve'

  interface Props {
    resolved: Resolved | undefined
    /** label a map's own edits as "this map only" rather than "you" */
    levelScope?: boolean
    onopen?: (anchor: HTMLElement) => void
  }

  const { resolved, levelScope = false, onopen }: Props = $props()

  // an inherited value shows the color of whatever set it in the base rules
  const inherited = $derived(resolved?.layer === 'inherited')
  const layer = $derived(
    inherited ? resolved!.trail[resolved!.trail.length - 1]?.layer : resolved?.layer
  )

  const tone = $derived(toneFor(layer, inherited ? false : levelScope))
  const description = $derived(
    (inherited ? 'From base rules. Set by ' : 'Set by ')
    + labelFor(layer, inherited ? false : levelScope)
    + (resolved?.source ? `: ${resolved.source}` : '')
  )
</script>

<button
  class="prov"
  type="button"
  title={description}
  aria-label="Value source: {description}"
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
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
  }

  /* the ring is drawn from the dot itself so the two stay concentric at any scale */
  .prov:hover .pd {
    box-shadow: 0 0 0 3.5px var(--sunk), 0 0 0 4.5px var(--line-2);
  }

  .pd {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
    flex: none;
    background: var(--p-def);
  }

  .pd.mut    { background: var(--p-mut); }
  .pd.you    { background: var(--p-you); }
  .pd.map    { background: var(--p-map); }
</style>
