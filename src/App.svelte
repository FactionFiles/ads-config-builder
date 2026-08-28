<script lang="ts">
  import { meta, pages, schemaFor, type Scope } from './schema'
  import {
    emptyDocument, fromToml, toToml, withRowOnEveryLevel,
    type ImportReport, type RulesScope,
  } from './lib/config'
  import { resolveScope, resolveServer, type MutatorDeclaration, type ResolvedRules } from './lib/resolve'
  import { findProblems } from './lib/checks'
  import { rotationCheck } from './lib/mapcheck.svelte'
  import SettingsPage from './lib/ui/SettingsPage.svelte'
  import MutatorsPage from './lib/ui/MutatorsPage.svelte'
  import RotationPage from './lib/ui/RotationPage.svelte'
  import AdminPage from './lib/ui/AdminPage.svelte'
  import ProblemsPage from './lib/ui/ProblemsPage.svelte'
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

  function save(text: string, name: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/toml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }

  function download() {
    save(fileText, fileName)
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
      // a map that changes the mode is rebuilt from the base rules' own keys
      // rather than from the resolved base rules, so they travel together
      baseManual: base ? doc.base.manual : undefined,
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
  const manual = $derived<Record<Scope, Record<string, unknown>>>({
    rules: activeScope.manual, server: doc.server,
  })
  const gameType = $derived((activeRules.get('game_type')?.value as string) ?? '')
  const baseGameType = $derived((baseRules.get('game_type')?.value as string) ?? '')
  const fileText = $derived(toToml(doc))

  // the archive is asked here rather than on the problems page, so the sidebar
  // count and the page itself are always answering with the same information
  $effect(() => {
    rotationCheck.schedule(doc.levels.map(level => level.filename))
  })

  const absentMaps = $derived(rotationCheck.absentAmong(doc.levels.map(level => level.filename)))

  const findings = $derived(
    findProblems({ doc, baseRules, levelRules, server: serverSettings, absentMaps })
  )

  // the sidebar count, so a problem is visible from whichever page you are on.
  // notes are left out of it - a badge that is always lit stops being read.
  const problems = $derived(findings.filter(f => f.severity !== 'note').length)

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

  /**
   * Write one row of a list into every map.
   *
   * Repeating a key across every map is normally the worse config and the tool
   * says so - but a row Alpine seeds per scope is put back for each map, so the
   * base rules cannot hold it on their own and this is the only thing that works.
   */
  function applyRowToAllMaps(path: string, row: Record<string, unknown>) {
    const key = schemaFor('rules', path)
    const mergeKey = key?.kind === 'array' ? key.mergeKey : undefined
    if (!mergeKey) return
    doc.levels = withRowOnEveryLevel(doc.levels, path, mergeKey, row)
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
    <button type="button" class="btn" onclick={() => fileInput?.click()}>Open a config</button>
    <button type="button" class="btn pri" onclick={download}>Download</button>
    <button type="button" class="btn" onclick={() => (fileOpen = !fileOpen)}>
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
        >
          {p.title}
          {#if p.id === 'checks' && problems}<span class="ct warn">{problems}</span>{/if}
        </button>
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
      {@const removed = once(imported.removed)}
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
          {#if removed.length}
            <br /><b>Rules presets have been removed from Alpine.</b>
            Alpine {meta.alpineVersion} no longer applies
            <span class="keys">{removed.join(', ')}</span>, so
            {removed.length === 1 ? 'that key was' : 'those keys were'} dropped rather than
            written back out. Anything a preset used to set has to be set here instead,
            in the base rules or on the map that needs it.
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
    {:else if page?.id === 'checks'}
      <ProblemsPage
        {findings}
        levels={doc.levels}
        onopen={(target, map) => go(target, map)}
      />
    {:else if page?.id === 'admin'}
      <AdminPage
        profiles={doc.rconProfiles}
        legacyPassword={(doc.server.rcon_password as string) ?? ''}
        onchange={next => (doc.rconProfiles = next)}
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
        {manual}
        levelScope={level !== undefined}
        mapManual={doc.levels.map(l => l.rules.manual)}
        onchange={change}
        onreset={reset}
        onprovenance={(scope, path, anchor) => (popover = { scope, path, anchor })}
        onapplytoall={applyRowToAllMaps}
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
    background: var(--surface);
    display: grid;
    grid-template-columns: var(--nav-w) minmax(0, 1fr) auto;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
  }

  .topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    height: 48px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }

  .topbar .sp { flex: 1; }

  .topbar .ver {
    font-size: 12px;
    color: var(--ink-3);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 1px 9px;
  }

  .nav {
    border-right: 1px solid var(--line);
    background: var(--surface-2);
    padding: 14px 0 20px;
    overflow-y: auto;
  }

  .scope {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .09em;
    text-transform: uppercase;
    color: var(--ink-3);
    padding: 16px 16px 6px;
    overflow-wrap: anywhere;
  }

  .scope:first-child { padding-top: 2px; }

  .ni {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    padding: 6px 16px;
    font-size: 13.5px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .ni:hover {
    background: var(--sunk);
    color: var(--ink);
  }

  .ni.on {
    background: var(--surface);
    border-left-color: var(--graphite);
    color: var(--ink);
    font-weight: 600;
  }

  .ni.sub {
    padding-left: 28px;
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

  /* a count of things that will not work, which is not a count of maps */
  .ni .ct.warn {
    color: var(--err);
    background: var(--err-b);
    border-radius: 4px;
    padding: 0 5px;
  }

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
    background: var(--surface-2);
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
    background: var(--sunk);
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
