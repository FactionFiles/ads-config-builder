<script lang="ts">
  import { meta, pages, type Scope } from './schema'
  import { emptyDocument, toToml } from './lib/config'
  import { resolveScope, resolveServer, type ResolvedRules } from './lib/resolve'
  import SettingsPage from './lib/ui/SettingsPage.svelte'
  import ProvenancePopover from './lib/ui/ProvenancePopover.svelte'

  let doc = $state(emptyDocument())
  // the page lives in the URL so a link can point at one, and the back button
  // does what people expect
  const pageFromHash = () => {
    const id = location.hash.replace(/^#/, '')
    return pages.some(p => p.id === id) ? id : (pages[0]?.id ?? '')
  }

  let currentPage = $state(pageFromHash())

  function go(id: string) {
    currentPage = id
    location.hash = id
  }
  let fileOpen = $state(true)
  let popover = $state<{ scope: Scope; path: string; anchor: HTMLElement } | null>(null)

  const page = $derived(pages.find(p => p.id === currentPage))

  const baseRules = $derived<ResolvedRules>(
    resolveScope({
      gameType: doc.base.gameType,
      mutators: doc.base.mutators,
      manual: doc.base.manual,
    })
  )

  const serverSettings = $derived<ResolvedRules>(resolveServer(doc.server))

  const resolved = $derived<Record<Scope, ResolvedRules>>({ rules: baseRules, server: serverSettings })
  const fileText = $derived(toToml(doc))

  function change(scope: Scope, path: string, value: unknown) {
    if (scope === 'rules') doc.base.manual = { ...doc.base.manual, [path]: value }
    else doc.server = { ...doc.server, [path]: value }
  }

  function reset(scope: Scope, path: string) {
    if (scope === 'rules') {
      const { [path]: _dropped, ...rest } = doc.base.manual
      doc.base.manual = rest
    } else {
      const { [path]: _dropped, ...rest } = doc.server
      doc.server = rest
    }
  }

  function groupsOf(kind: 'server' | 'rules' | 'other') {
    return pages.filter(p => p.scope === kind)
  }
</script>

<svelte:window
  onhashchange={() => (currentPage = pageFromHash())}
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
    <button type="button" class="ghost" onclick={() => (fileOpen = !fileOpen)}>
      {fileOpen ? 'Hide' : 'Show'} config file
    </button>
  </header>

  <nav class="nav">
    <div class="scope">The whole server</div>
    {#each groupsOf('server') as p (p.id)}
      <button type="button" class="ni" class:on={p.id === currentPage} onclick={() => go(p.id)}>
        {p.title}
      </button>
    {/each}

    <div class="scope">All maps</div>
    {#each groupsOf('rules') as p (p.id)}
      <button type="button" class="ni" class:on={p.id === currentPage} onclick={() => go(p.id)}>
        {p.title}
      </button>
    {/each}

    {#if groupsOf('other').length}
      <div class="scope">Everything else</div>
      {#each groupsOf('other') as p (p.id)}
        <button type="button" class="ni" class:on={p.id === currentPage} onclick={() => go(p.id)}>
          {p.title}
        </button>
      {/each}
    {/if}
  </nav>

  <main class="main">
    {#if page}
      <h2>{page.title}</h2>
      {#if page.blurb}<p class="blurb">{page.blurb}</p>{/if}
      <SettingsPage
        page={page.id}
        gameType={(baseRules.get('game_type')?.value as string) ?? ''}
        {resolved}
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
  }

  .scope:first-child { margin-top: 0; }

  .ni {
    display: block;
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

  .main {
    overflow-y: auto;
    padding: 28px 32px 80px;
    max-width: 860px;
  }

  .main h2 {
    font-size: 21px;
    margin-bottom: 4px;
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
