<script lang="ts">
  import { meta, pages, schemaFor, textFor, type Scope } from './schema'
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


  // page and maps live in the URL so links and the back button work
  interface Route { page: string; maps: number[] }

  function routeFromHash(): Route {
    const raw = location.hash.replace(/^#/, '')
    const scoped = raw.match(/^maps?\/([\d,]+)\/(.*)$/)
    const page = scoped ? scoped[2] : raw
    return {
      page: pages.some(p => p.id === page) ? page : (pages[0]?.id ?? ''),
      maps: scoped ? [...new Set(scoped[1].split(',').filter(Boolean).map(Number))] : [],
    }
  }

  let route = $state(routeFromHash())

  function go(page: string, maps: number[] = []) {
    location.hash = maps.length === 0 ? page
      : maps.length === 1 ? `map/${maps[0]}/${page}`
      : `maps/${maps.join(',')}/${page}`
  }

  // rotation rows ticked in the sheet, kept here so they survive leaving the page
  let selection = $state<number[]>([])

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
      selection = []
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

  // the same key can appear in several scopes
  function once(paths: string[]) {
    return [...new Set(paths)]
  }

  // a map only has game rules, so a server page falls back to the first rules page
  const rulesPages = $derived(pages.filter(p => p.scope === 'rules'))
  // the maps being edited; empty means the base rules
  const targets = $derived(route.maps.filter(i => i >= 0 && i < doc.levels.length))
  const level = $derived(targets.length === 1 ? doc.levels[targets[0]] : undefined)
  const multi = $derived(targets.length > 1)
  const page = $derived.by(() => {
    const found = pages.find(p => p.id === route.page)
    if (!targets.length) return found
    return found?.scope === 'rules' ? found : rulesPages[0]
  })

  function resolve(scope: RulesScope, base?: ResolvedRules): ResolvedRules {
    return resolveScope({
      base,
      // a map that changes game type restarts from the base scope's manual keys
      baseManual: base ? doc.base.manual : undefined,
      gameType: scope.manual.game_type as string | undefined,
      mutators: scope.mutators,
      manual: scope.manual,
    })
  }

  const baseRules = $derived<ResolvedRules>(resolve(doc.base))
  const levelRules = $derived<ResolvedRules[]>(doc.levels.map(l => resolve(l.rules, baseRules)))
  const serverSettings = $derived<ResolvedRules>(resolveServer(doc.server))

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

  // several maps read as one: each setting shows a map that sets it by hand if
  // any does, and is flagged when the maps disagree
  const combined = $derived.by(() => {
    const rules: ResolvedRules = new Map()
    const manual: Record<string, unknown> = {}
    const mixed = new Set<string>()
    const partial = new Set<string>()
    const scopes = targets.map(i => doc.levels[i].rules)
    const each = targets.map(i => levelRules[i] ?? baseRules)
    for (const path of new Set(each.flatMap(r => [...r.keys()]))) {
      const found = each.map(r => r.get(path))
      const byHand = found.filter(r => r?.layer === 'manual').length
      const shown = found.find(r => r?.layer === 'manual') ?? found.find(r => r)
      if (shown) rules.set(path, shown)
      if (found.some(r => !same(r?.value, found[0]?.value))) mixed.add(path)
      if (byHand > 0 && byHand < found.length) partial.add(path)
    }
    for (const scope of scopes) {
      for (const [path, value] of Object.entries(scope.manual)) {
        if (!(path in manual)) manual[path] = value
      }
    }
    const declared = scopes.find(s => s.mutators.length)?.mutators ?? []
    const mutatorsMixed = scopes.some(s => !same(s.mutators, scopes[0].mutators))
    return { rules, manual, mixed, partial, declared, mutatorsMixed }
  })

  const activeScope = $derived<RulesScope>(
    level ? level.rules
      : multi ? { ...doc.levels[targets[0]].rules, manual: combined.manual, mutators: combined.declared }
      : doc.base
  )
  const activeRules = $derived<ResolvedRules>(
    level ? levelRules[targets[0]] ?? baseRules : multi ? combined.rules : baseRules
  )

  const resolved = $derived<Record<Scope, ResolvedRules>>({ rules: activeRules, server: serverSettings })
  const manual = $derived<Record<Scope, Record<string, unknown>>>({
    rules: activeScope.manual, server: doc.server,
  })
  const gameType = $derived((activeRules.get('game_type')?.value as string) ?? '')
  const gameTypes = $derived(
    multi
      ? [...new Set(targets.map(i => (levelRules[i]?.get('game_type')?.value as string) ?? ''))]
      : [gameType]
  )
  const baseGameType = $derived((baseRules.get('game_type')?.value as string) ?? '')
  const fileText = $derived(toToml(doc))

  // checked here so the header count and the problems page always agree
  $effect(() => {
    rotationCheck.schedule(doc.levels.map(level => level.filename))
  })

  const absentMaps = $derived(rotationCheck.absentAmong(doc.levels.map(level => level.filename)))

  const findings = $derived(
    findProblems({ doc, baseRules, levelRules, server: serverSettings, absentMaps })
  )

  // notes are excluded, since a badge that is always lit gets ignored
  const problems = $derived(findings.filter(f => f.severity !== 'note').length)

  function editScope(edit: (scope: RulesScope) => RulesScope) {
    if (!targets.length) doc.base = edit(doc.base)
    for (const i of targets) doc.levels[i] = { ...doc.levels[i], rules: edit(doc.levels[i].rules) }
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

  // alpine reseeds some list rows per scope, so the base rules alone cannot override them
  function applyRowToAllMaps(path: string, row: Record<string, unknown>) {
    const key = schemaFor('rules', path)
    const mergeKey = key?.kind === 'array' ? key.mergeKey : undefined
    if (!mergeKey) return
    doc.levels = withRowOnEveryLevel(doc.levels, path, mergeKey, row)
  }

  function setMutators(next: MutatorDeclaration[]) {
    editScope(s => ({ ...s, mutators: next }))
  }

  // settings any open map overrides, per rules page
  const overrideCounts = $derived.by(() => {
    const counts = new Map<string, number>()
    const scopes = targets.map(i => doc.levels[i].rules)
    for (const path of new Set(scopes.flatMap(s => Object.keys(s.manual)))) {
      const id = textFor('rules', path).page
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const mutators = new Set(scopes.flatMap(s => s.mutators.map(m => m.name)))
    if (mutators.size) counts.set('rules-mutators', mutators.size)
    return counts
  })

  function groupsOf(kind: 'server' | 'rules') {
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
    <button
      type="button"
      class="btn"
      class:pressed={page?.id === 'checks'}
      onclick={() => go('checks')}
    >
      Problems
      {#if problems}<span class="ct">{problems}</span>{/if}
    </button>
    <button type="button" class="btn" onclick={() => fileInput?.click()}>Open</button>
    <button type="button" class="btn pri" onclick={download}>Download</button>
    <button type="button" class="btn" onclick={() => (fileOpen = !fileOpen)}>
      {fileOpen ? 'Hide' : 'Show'} config file
    </button>
  </header>

  <nav class="nav">
    <div class="sec">
      <div class="scope">Server</div>
      {#each groupsOf('server') as p (p.id)}
        <button
          type="button"
          class="ni"
          class:on={!targets.length && p.id === route.page}
          onclick={() => go(p.id)}
        >{p.title}</button>
      {/each}
    </div>

    <div class="sec">
      <div class="scope">Game rules</div>
      {#each groupsOf('rules') as p (p.id)}
        <button
          type="button"
          class="ni"
          class:on={!targets.length && p.id === page?.id}
          onclick={() => go(p.id)}
        >{p.title}</button>
      {/each}
    </div>

    <div class="sec">
      <div class="scope">Map rotation</div>
      <button
        type="button"
        class="ni"
        class:on={!targets.length && route.page === 'rotation'}
        onclick={() => go('rotation')}
      >
        Edit map rotation
        {#if doc.levels.length}<span class="ct">{doc.levels.length}</span>{/if}
      </button>
    </div>

    {#if targets.length}
      <div class="sec">
        <div class="scope">
          Map overrides &middot;
          {#if level}
            <span class="file">#{targets[0] + 1} {level.filename}</span>
          {:else}
            {targets.length} maps
          {/if}
        </div>
        {#each groupsOf('rules') as p (p.id)}
          {@const count = overrideCounts.get(p.id)}
          <button
            type="button"
            class="ni"
            class:on={p.id === page?.id}
            onclick={() => go(p.id, targets)}
          >
            {p.title}
            {#if count}<span class="ct">{count}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </nav>

  <main class="main">
    {#if importError}
      <div class="notice bad">
        <div>
          <b>Could not read file.</b>
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
            File uses ads_version {imported.fromVersion} and will be saved as
            version {meta.adsVersion}.
          {/if}
          {#if kept.length}
            <br />{kept.length}
            {kept.length === 1 ? 'setting is' : 'settings are'} not editable here and
            {kept.length === 1 ? 'was' : 'were'} kept unchanged:
            <span class="keys">{kept.join(', ')}</span>.
          {/if}
          {#if strange.length}
            <br />{strange.length}
            unrecognized {strange.length === 1 ? 'key was' : 'keys were'} kept:
            <span class="keys">{strange.join(', ')}</span>.
          {/if}
          {#if removed.length}
            <br /><b>Rules presets were removed from Alpine.</b>
            Alpine {meta.alpineVersion} no longer supports
            <span class="keys">{removed.join(', ')}</span>, so
            {removed.length === 1 ? 'it was' : 'they were'} dropped. Set those rules
            in the base rules or on individual maps instead.
          {/if}
          <br />Comments and key order are not preserved on download.
        </div>
        <button type="button" class="x" aria-label="Dismiss" onclick={() => (imported = null)}>
          &times;
        </button>
      </div>
    {/if}

    {#if level}
      <h2>{level.filename}</h2>
      <p class="blurb">
        Map {targets[0] + 1} in the rotation. Settings not changed here
        use the base <b>Game rules</b>.
      </p>
    {:else if multi}
      <h2>{targets.length} maps</h2>
      <div class="banner warn">
        <span class="ic">!</span>
        <div>
          <b>Editing {targets.length} maps at once.</b> Changes apply to
          {targets.map(i => `#${i + 1} ${doc.levels[i].filename}`).join(', ')}.
          {#if targets.length === doc.levels.length}
            <br />All maps are selected. Changing the base rules instead applies the
            value once, including to maps added later.
            <button type="button" class="link" onclick={() => go(page?.id ?? rulesPages[0].id)}>
              Edit base rules
            </button>
          {/if}
        </div>
      </div>
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
        {selection}
        onchange={next => (doc.levels = next)}
        onselect={next => (selection = next)}
        onopen={maps => go(rulesPages[0].id, maps)}
        onopenbase={() => go(rulesPages[0].id)}
      />
    {:else if page?.id === 'checks'}
      <ProblemsPage
        {findings}
        levels={doc.levels}
        onopen={(target, map) => go(target, map === null ? [] : [map])}
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
        levelScope={targets.length > 0}
        inherited={targets.length ? doc.base.mutators : []}
        modeCleared={targets.length > 0 && gameType !== baseGameType}
        mixed={multi && combined.mutatorsMixed}
        maps={targets.length}
        resolved={activeRules}
        {gameType}
        onchange={setMutators}
      />
    {:else if page}
      <SettingsPage
        page={page.id}
        {gameTypes}
        {resolved}
        {manual}
        levelScope={targets.length > 0}
        maps={targets.length}
        mixed={multi ? combined.mixed : undefined}
        partial={multi ? combined.partial : undefined}
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

  .sec + .sec {
    border-top: 1px solid var(--line);
    margin-top: 10px;
  }

  .scope {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .09em;
    text-transform: uppercase;
    color: var(--ink);
    padding: 14px 16px 6px;
    overflow-wrap: anywhere;
  }

  .sec:first-child .scope { padding-top: 2px; }

  /* filenames read as written, not uppercased */
  .scope .file { text-transform: none; letter-spacing: normal; }

  .ni {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    padding: 6px 16px 6px 24px;
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

  .topbar .btn .ct {
    margin-left: 4px;
    font-size: 11.5px;
    color: var(--err);
    background: var(--err-b);
    border-radius: 4px;
    padding: 0 5px;
    font-variant-numeric: tabular-nums;
  }

  .ni .ct {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
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

  .link {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
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
