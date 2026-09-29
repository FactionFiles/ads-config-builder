<script lang="ts">
  // only the level file name is used; the rest of the card helps tell similar
  // maps apart. a full file name can be added directly, since the autodownloader
  // carries maps the site does not list

  import { mapCategories, searchMaps, type MapCategory, type MapResult } from '../maps'

  interface Props {
    /** level names already in the rotation, lowercased */
    taken: Set<string>
    /** a level file name, from a search result or typed in full */
    onpick: (rfl: string) => void
  }

  const { taken, onpick }: Props = $props()

  /** search debounce in ms */
  const SETTLE = 300
  const PAGE = 25

  let query = $state('')
  let category = $state<number | null>(null)
  let results = $state<MapResult[]>([])
  let total = $state(0)
  let loading = $state(false)
  let problem = $state('')
  let categories = $state<MapCategory[]>([])
  let searched = $state(false)
  /** the archive ran out before the estimated total */
  let ended = $state(false)

  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: AbortController | null = null
  let run = 0

  async function fetchPage(offset: number) {
    inflight?.abort()
    const mine = ++run
    const controller = new AbortController()
    inflight = controller
    loading = true
    if (!offset) problem = ''

    try {
      const found = await searchMaps({
        query, category, limit: PAGE, offset, signal: controller.signal,
      })
      if (mine !== run) return
      // the total counts files rather than levels and runs high, so a short page
      // marks the real end
      const seen = new Set(offset ? results.map(m => m.fileId) : [])
      const fresh = found.results.filter(map => !seen.has(map.fileId))
      results = offset ? [...results, ...fresh] : fresh
      total = found.total
      ended = found.results.length < PAGE
      searched = true
    } catch (failure) {
      if (mine !== run || (failure instanceof DOMException && failure.name === 'AbortError')) return
      problem = failure instanceof Error ? failure.message : 'Could not reach FactionFiles.'
      results = []
      total = 0
      ended = true
      searched = true
    } finally {
      if (mine === run) loading = false
    }
  }

  function search() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fetchPage(0), SETTLE)
  }

  $effect(() => {
    // read both so either change starts a new search
    query
    category
    search()
  })

  $effect(() => {
    mapCategories()
      .then(list => (categories = list.filter(c => c.game.id === 1)))
      .catch(() => (categories = []))
    return () => {
      if (timer) clearTimeout(timer)
      inflight?.abort()
    }
  })

  const typed = $derived(query.trim())
  const typedRfl = $derived(/^[^\s,]+\.rfl$/i.test(typed) ? typed : '')
  const typedTaken = $derived(typedRfl !== '' && taken.has(typedRfl.toLowerCase()))

  const shown = $derived(results.length)
  const more = $derived(!ended && total > shown)

  function sizeOf(bytes: number) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  }

  // strip the "Maps - " prefix the site puts on every category
  const shortName = (name: string) => name.replace(/^Maps\s*-\s*/i, '')
</script>

<div class="picker">
  <div class="find">
    <input
      class="ctl grow"
      type="search"
      placeholder="Search by name, or enter a full .rfl file name"
      aria-label="Search FactionFiles for a map"
      bind:value={query}
      onkeydown={e => {
        if (e.key === 'Enter' && typedRfl && !typedTaken) onpick(typedRfl)
      }}
    />
    {#if typedRfl}
      <button
        type="button"
        class="btn pri"
        disabled={typedTaken}
        title={typedTaken ? `${typedRfl} is already in the rotation` : `Add ${typedRfl}`}
        onclick={() => onpick(typedRfl)}
      >{typedTaken ? 'Added' : 'Add RFL'}</button>
    {/if}
    {#if categories.length}
      <select class="ctl" aria-label="Category" bind:value={category}>
        <option value={null}>All categories</option>
        {#each categories as option (option.id)}
          <option value={option.id}>{shortName(option.name)} ({option.maps})</option>
        {/each}
      </select>
    {/if}
  </div>

  {#if problem}
    <div class="miss">
      <strong>{problem}</strong>
      Search is unavailable. Enter a full .rfl file name to add a map.
    </div>
  {:else if loading && !shown}
    <p class="ph">Searching...</p>
  {:else if searched && !shown}
    <p class="ph">
      No matches. Maps not listed on FactionFiles can be added by entering the full
      .rfl file name.
    </p>
  {:else if shown}
    <p class="ph count">
      {ended ? shown : total} {(ended ? shown : total) === 1 ? 'map' : 'maps'}{more ? `, showing ${shown}` : ''}
    </p>

    <ul class="hits">
      {#each results as map (map.fileId)}
        {@const already = taken.has(map.rfl.toLowerCase())}
        <li class="hit">
          <img class="shot" src={map.thumbUrl} alt="" loading="lazy" />
          <div class="about">
            <div class="line">
              <strong class="title">{map.title}</strong>
              <span class="rfl">{map.rfl}</span>
            </div>
            <div class="line meta">
              <span>{map.author || 'Unknown author'}</span>
              <span>{shortName(map.category.name)}</span>
              <span>{sizeOf(map.size)}</span>
            </div>
          </div>
          <div class="pick">
            <button
              type="button"
              class="btn pri"
              disabled={already}
              onclick={() => onpick(map.rfl)}
            >{already ? 'Added' : 'Add'}</button>
            {#if map.siteUrl}
              <a class="link" href={map.siteUrl} target="_blank" rel="noreferrer noopener">View on FactionFiles</a>
            {/if}
          </div>
        </li>
      {/each}

      {#if more}
        <li class="hit more">
          <button type="button" class="btn" disabled={loading} onclick={() => fetchPage(shown)}>
            {loading ? 'Loading...' : `Show ${Math.min(PAGE, total - shown)} more`}
          </button>
        </li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .ph {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 0 0 10px;
    max-width: 62ch;
  }

  .link {
    color: var(--ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link:hover { color: var(--ink); }

  .find {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .find .grow { flex: 1; }

  .count { margin: 11px 0 6px; }

  .hits {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 420px;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
  }

  .hit {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: start;
    padding: 11px 12px;
    border-bottom: 1px solid var(--line);
  }

  .hit:last-child { border-bottom: none; }
  .hit:hover { background: var(--surface-2); }

  /* sits in the list itself so it appears right where scrolling ends */
  .hit.more {
    display: block;
    text-align: center;
    padding: 9px 12px;
  }

  .hit.more:hover { background: none; }

  .shot {
    width: 96px;
    height: 60px;
    object-fit: cover;
    border-radius: 5px;
    background: var(--sunk);
    border: 1px solid var(--line);
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .title { font-size: 13.5px; }

  .rfl {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .meta {
    margin-top: 3px;
    font-size: 12px;
    color: var(--ink-3);
    gap: 10px;
  }


  .pick {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    text-align: center;
  }

  .pick .link { font-size: 11.5px; }

  .miss {
    margin-top: 11px;
    padding: 10px 12px;
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--surface-2);
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .miss strong { display: block; }
</style>
