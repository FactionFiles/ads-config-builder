<script lang="ts">
  import { meta, pages, type Scope } from './schema'
  import {
    emptyDocument, fromToml, toToml, type ImportReport, type RulesScope,
  } from './lib/config'
  import { resolveScope, resolveServer, type MutatorDeclaration, type ResolvedRules } from './lib/resolve'
  import SettingsPage from './lib/ui/SettingsPage.svelte'
  import MutatorsPage from './lib/ui/MutatorsPage.svelte'
  import RotationPage from './lib/ui/RotationPage.svelte'
  import ProvenancePopover from './lib/ui/ProvenancePopover.svelte'

  let doc = $state(emptyDocument())

  // the page and the map being edited both live in the URL, so a link can point
  // at one and the back button does what people expect
  interface Route { page: string; map: number | null }

  function routeFromHash(): Route {
    const raw = location.hash.replace(/^#/, '')
    const scoped = raw.match(/^map\/(\d+)\/(.*)$/)
    const page = scoped ? scoped[2] : raw
    return {
      page: pages.some(p => p.id === page) ? page : (pages[0]?.id ?? ''),
      map: scoped ? Number(scoped[1]) : null,
    }
  }

  let route = $state(routeFromHash())

  function go(page: string, map: number | null = null) {
    location.hash = map === null ? page : `map/${map}/${page}`
  }

  let fileOpen = $state(true)
  let popover = $state<{ scope: Scope; path: string; anchor: HTMLElement } | null>(null)

  let fileName = $state('ads.toml')
  let fileInput = $state<HTMLInputElement | null>(null)
  let imported = $state<ImportReport | null>(null)
  let importError = $state<string | null>(null)

  async function openFile(e: Event & { currentTarget: HTMLInputElement }) {
    const picked = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!picked) return
    try {
      const report = fromToml(await picked.text())
      doc = report.doc
      fileName = picked.name
      imported = report
      importError = null
      location.hash = pages[0].id
    } catch (err) {
      imported = null
      importError = err instanceof Error ? err.message : String(err)
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([fileText], { type: 'application/toml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  /** the same key can turn up in several scopes, and saying so twice helps nobody */
  function once(paths: string[]) {
    return [...new Set(paths)]
  }

  // a map only has game rules, so scoping into one from a server page lands on
  // the first rules page rather than on a page that does not exist there
  const rulesPages = $derived(pages.filter(p => p.scope === 'rules'))
  const level = $derived(route.map !== null ? doc.levels[route.map] : undefined)
  const page = $derived.by(() => {
    const found = pages.find(p => p.id === route.page)
    if (!level) return found
    return found?.scope === 'rules' ? found : rulesPages[0]
  })

  function resolve(scope: RulesScope, base?: ResolvedRules): ResolvedRules {
    return resolveScope({
      base,
      gameType: scope.manual.game_type as string | undefined,
      mutators: scope.mutators,
      manual: scope.manual,
    })
  }

  const baseRules = $derived<ResolvedRules>(resolve(doc.base))
  const levelRules = $derived<ResolvedRules[]>(doc.levels.map(l => resolve(l.rules, baseRules)))
  const serverSettings = $derived<ResolvedRules>(resolveServer(doc.server))

  const activeScope = $derived<RulesScope>(level ? level.rules : doc.base)
  const activeRules = $derived<ResolvedRules>(
    level && route.map !== null ? levelRules[route.map] ?? baseRules : baseRules
  )

  const resolved = $derived<Record<Scope, ResolvedRules>>({ rules: activeRules, server: serverSettings })
  const gameType = $derived((activeRules.get('game_type')?.value as string) ?? '')
  const baseGameType = $derived((baseRules.get('game_type')?.value as string) ?? '')
  const fileText = $derived(toToml(doc))

  function editScope(edit: (scope: RulesScope) => RulesScope) {
    if (route.map === null) doc.base = edit(doc.base)
    else doc.levels[route.map] = { ...doc.levels[route.map], rules: edit(doc.levels[route.map].rules) }
  }

  function change(scope: Scope, path: string, value: unknown) {
    if (scope === 'server') doc.server = { ...doc.server, [path]: value }
    else editScope(s => ({ ...s, manual: { ...s.manual, [path]: value } }))
  }

  function reset(scope: Scope, path: string) {
    if (scope === 'server') {
      const { [path]: _dropped, ...rest } = doc.server
      doc.server = rest
      return
    }
    editScope(s => {
      const { [path]: _dropped, ...rest } = s.manual
      return { ...s, manual: rest }
    })
  }

  function setMutators(next: MutatorDeclaration[]) {
    editScope(s => ({ ...s, mutators: next }))
  }

  // how many maps get their own sidebar entry before the list is cut short
  const NAV_MAPS = 4
  const navMaps = $derived(doc.levels.slice(0, NAV_MAPS))

  function groupsOf(kind: 'server' | 'rules' | 'other') {
    return pages.filter(p => p.scope === kind && p.id !== 'rotation')
  }
</script>

<svelte:window
  onhashchange={() => (route = routeFromHash())}
  onclick={e => {
    const el = e.target as HTMLElement
    if (!el.closest('.pop') && !el.closest('.prov')) popover = null
  }}
/>

<div class="app">
  <header class="topbar">
    <strong>Alpine Faction server config</strong>
    <span class="sp"></span>
    <span class="ver">Alpine {meta.alpineVersion} &middot; ads_version {meta.adsVersion}</span>
    <input
      type="file"
      accept=".toml,text/plain"
      bind:this={fileInput}
      onchange={openFile}
      hidden
    />
    <button type="button" class="ghost" onclick={() => fileInput?.click()}>Open a config</button>
    <button type="button" class="ghost" onclick={download}>Download</button>
    <button type="button" class="ghost" onclick={() => (fileOpen = !fileOpen)}>
      {fileOpen ? 'Hide' : 'Show'} config file
    </button>
  </header>

  <nav class="nav">
    <div class="scope">The whole server</div>
    {#each groupsOf('server') as p (p.id)}
      <button
        type="button"
        class="ni"
        class:on={!level && p.id === route.page}
        onclick={() => go(p.id)}
      >{p.title}</button>
    {/each}

    <div class="scope">
      Game rules &middot; {level ? level.filename : 'all maps'}
    </div>
    {#each groupsOf('rules') as p (p.id)}
      <button
        type="button"
        class="ni"
        class:on={p.id === page?.id}
        onclick={() => go(p.id, route.map)}
      >{p.title}</button>
    {/each}

    <div class="scope">Map rotation</div>
    <button
      type="button"
      class="ni"
      class:on={!level && route.page === 'rotation'}
      onclick={() => go('rotation')}
    >
      All maps
      {#if doc.levels.length}<span class="ct">{doc.levels.length}</span>{/if}
    </button>
    {#each navMaps as map, i (map.filename + i)}
      <button
        type="button"
        class="ni sub"
        class:on={route.map === i}
        onclick={() => go(page?.scope === 'rules' ? route.page : rulesPages[0].id, i)}
      >{map.filename}</button>
    {/each}
    {#if doc.levels.length > NAV_MAPS}
      <button type="button" class="ni sub more" onclick={() => go('rotation')}>
        {doc.levels.length - NAV_MAPS} more...
      </button>
    {/if}

    {#if groupsOf('other').length}
      <div class="scope">Everything else</div>
      {#each groupsOf('other') as p (p.id)}
        <button
          type="button"
          class="ni"
          class:on={!level && p.id === route.page}
          onclick={() => go(p.id)}
        >{p.title}</button>
      {/each}
    {/if}
  </nav>

  <main class="main">
    {#if importError}
      <div class="notice bad">
        <div>
          <b>That file could not be read.</b>
          {importError}
        </div>
        <button type="button" class="x" aria-label="Dismiss" onclick={() => (importError = null)}>
          &times;
        </button>
      </div>
    {/if}

    {#if imported}
      {@const kept = once(imported.kept)}
      {@const strange = once(imported.unrecognized)}
      <div class="notice">
        <div>
          <b>Opened {fileName}.</b>
          {#if imported.fromVersion !== null && imported.fromVersion !== meta.adsVersion}
            It was written for ads_version {imported.fromVersion}; downloading
            writes version {meta.adsVersion}.
          {/if}
          {#if kept.length}
            <br />{kept.length}
            {kept.length === 1 ? 'setting has' : 'settings have'} no editor here yet
            and {kept.length === 1 ? 'was' : 'were'} kept exactly as {kept.length === 1 ? 'it' : 'they'} came in:
            <span class="keys">{kept.join(', ')}</span>.
          {/if}
          {#if strange.length}
            <br />{strange.length}
            {strange.length === 1 ? 'key was' : 'keys were'} not recognized, and
            {strange.length === 1 ? 'is' : 'are'} kept too:
            <span class="keys">{strange.join(', ')}</span>.
          {/if}
          <br />Downloading writes the file out fresh, so comments and the order
          you had things in are not kept.
        </div>
        <button type="button" class="x" aria-label="Dismiss" onclick={() => (imported = null)}>
          &times;
        </button>
      </div>
    {/if}

    {#if level}
      <h2>{level.filename}</h2>
      <p class="blurb">
        Number {(route.map ?? 0) + 1} in the rotation. These are the same pages as
        <b>Game rules</b>, for this one map. Anything you leave alone stays the
        same as every other map.
      </p>
    {:else if page}
      <h2>{page.title}</h2>
      {#if page.blurb}<p class="blurb">{page.blurb}</p>{/if}
    {/if}

    {#if page?.id === 'rotation'}
      <RotationPage
        levels={doc.levels}
        base={doc.base}
        {baseRules}
        {levelRules}
        onchange={next => (doc.levels = next)}
        onopen={i => go(rulesPages[0].id, i)}
        onopenbase={() => go(rulesPages[0].id)}
      />
    {:else if page?.id === 'rules-mutators'}
      <MutatorsPage
        declared={activeScope.mutators}
        levelScope={level !== undefined}
        inherited={level ? doc.base.mutators : []}
        modeCleared={level !== undefined && gameType !== baseGameType}
        resolved={activeRules}
        {gameType}
        onchange={setMutators}
      />
    {:else if page}
      <SettingsPage
        page={page.id}
        {gameType}
        {resolved}
        levelScope={level !== undefined}
        onchange={change}
        onreset={reset}
        onprovenance={(scope, path, anchor) => (popover = { scope, path, anchor })}
      />
    {/if}
  </main>

  {#if fileOpen}
    <aside class="filepane">
      <div class="fp-h">ads.toml</div>
      <pre class="fp-b">{fileText}</pre>
    </aside>
  {/if}
</div>

{#if popover}
  <ProvenancePopover
    scope={popover.scope}
    path={popover.path}
    resolved={resolved[popover.scope].get(popover.path)}
    anchor={popover.anchor}
    onclose={() => (popover = null)}
    onreset={path => reset(popover!.scope, path)}
  />
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: var(--nav-w) minmax(0, 1fr) auto;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
  }

  .topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 18px;
    height: 48px;
    background: var(--graphite);
    color: var(--on-graphite);
    font-size: 14px;
  }

  .topbar .sp { flex: 1; }
  .topbar .ver { font-size: 12px; opacity: .7; }

  .ghost {
    border: 1px solid rgba(255, 255, 255, .25);
    background: none;
    color: inherit;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12.5px;
    cursor: pointer;
  }

  .ghost:hover { background: rgba(255, 255, 255, .1); }

  .nav {
    border-right: 1px solid var(--line);
    background: var(--surface-2);
    padding: 16px 12px;
    overflow-y: auto;
  }

  .scope {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .09em;
    text-transform: uppercase;
    color: var(--ink-3);
    margin: 18px 8px 6px;
    overflow-wrap: anywhere;
  }

  .scope:first-child { margin-top: 0; }

  .ni {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    background: none;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 13.5px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .ni:hover { background: var(--sunk); }

  .ni.on {
    background: var(--graphite);
    color: var(--on-graphite);
    font-weight: 500;
  }

  .ni.sub {
    padding-left: 18px;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .ni.more { color: var(--ink-3); }

  .ni .ct {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .ni.on .ct { color: inherit; opacity: .7; }

  .main {
    overflow-y: auto;
    padding: 28px 32px 80px;
    max-width: 900px;
  }

  .main h2 {
    font-size: 21px;
    margin-bottom: 4px;
    overflow-wrap: anywhere;
  }

  .notice {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    border: 1px solid var(--line-2);
    background: var(--surface);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 20px;
    font-size: 12.5px;
    color: var(--ink-2);
    line-height: 1.6;
  }

  .notice.bad { border-color: var(--err); background: var(--err-b); }

  .notice .keys {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .notice .x {
    margin-left: auto;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }

  .blurb {
    color: var(--ink-2);
    font-size: 14px;
    margin: 0 0 22px;
    max-width: 60ch;
  }

  .filepane {
    width: var(--file-w);
    border-left: 1px solid var(--line);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .fp-h {
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-3);
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  .fp-b {
    margin: 0;
    padding: 12px 14px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink-2);
    white-space: pre;
  }
</style>
