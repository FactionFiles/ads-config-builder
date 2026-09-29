<script lang="ts">
  import { allEntries, appliesToMode, isBasic, modesFor, modeTitles, schemaFor, textFor, type Scope } from '../../schema'
  import type { Resolved, ResolvedRules } from '../resolve'
  import Field from './Field.svelte'
  import ListEditor from './ListEditor.svelte'

  interface Props {
    page: string
    /** per scope, since a page can hold settings from both */
    resolved: Record<Scope, ResolvedRules>
    /** each scope's manual keys, for merged lists */
    manual: Record<Scope, Record<string, unknown>>
    /** several when editing maps with different game types */
    gameTypes: string[]
    levelScope?: boolean
    /** each map's manual keys, for rows alpine reseeds per scope */
    mapManual?: Record<string, unknown>[]
    /** how many maps this scope edits at once */
    maps?: number
    /** settings that differ across the maps in scope */
    mixed?: Set<string>
    /** settings set by hand on only some of the maps in scope */
    partial?: Set<string>
    showAdvanced?: boolean
    onshowadvanced?: () => void
    onchange?: (scope: Scope, path: string, value: unknown) => void
    onapplytoall?: (path: string, row: Record<string, unknown>) => void
    onreset?: (scope: Scope, path: string) => void
    onprovenance?: (scope: Scope, path: string, anchor: HTMLElement) => void
  }

  const {
    page, resolved, manual, gameTypes, levelScope = false, mapManual = [],
    maps = 1, mixed = new Set(), partial = new Set(), showAdvanced = true, onshowadvanced,
    onchange, onreset, onprovenance, onapplytoall,
  }: Props = $props()

  interface Entry { scope: Scope; path: string; offMode?: string; editor?: Editor }

  type Editor = 'field' | 'list'

  // settings the game type ignores are hidden, unless set manually so they can
  // still be found and cleared
  function offMode(scope: Scope, path: string): string | undefined {
    if (gameTypes.some(mode => appliesToMode(scope, path, mode))) return undefined
    const modes = modesFor(scope, path)
    return modes ? `Only applies in ${modeTitles(modes)}.` : undefined
  }

  // keys like ads_version are written by the tool and never get a field
  function isToolOwned(scope: Scope, path: string) {
    const key = schemaFor(scope, path)
    return key?.kind === 'scalar' && (key as { global?: boolean }).global === true
  }

  // tables are group headings, and some authored keys belong to other files
  // (bot profiles), so neither gets an editor
  function editorFor(scope: Scope, path: string): Editor | null {
    const schema = schemaFor(scope, path)
    if (schema?.kind === 'scalar') return 'field'
    if (schema?.kind === 'array' && ((schema.item?.length ?? 0) > 0 || schema.itemType)) return 'list'
    return null
  }

  // hand-set here or in the base rules, so a hidden advanced setting can still be found and cleared
  function handSet(r: Resolved | undefined) {
    return !!r && (r.layer === 'manual' || r.trail.some(c => c.layer === 'manual' || c.layer === 'inherited'))
  }

  interface Group { key: string; title: string; help: string; entries: Entry[] }

  // groups are keyed by parent path so the layout follows the file's structure
  const layout = $derived.by(() => {
    const out: Group[] = []
    let hidden = 0
    const byKey = new Map<string, Group>()
    const onPage: Entry[] = allEntries
      .filter(e => textFor(e.scope, e.path).page === page && !isToolOwned(e.scope, e.path))
      .map(e => ({ ...e, offMode: offMode(e.scope, e.path) }))
      .filter(e => !e.offMode || resolved[e.scope].get(e.path)?.layer === 'manual')
    const paths = new Set(allEntries.map(e => e.path))

    const group = (key: string, scope: Scope): Group => {
      let found = byKey.get(key)
      if (!found) {
        const text = key ? textFor(scope, key) : null
        found = { key, title: text?.label ?? '', help: text?.help ?? '', entries: [] }
        byKey.set(key, found)
        out.push(found)
      }
      return found
    }

    for (const entry of onPage) {
      const editor = editorFor(entry.scope, entry.path)
      // a parent path is a group heading unless it is also a setting itself,
      // like the bot profile list
      if (!editor && [...paths].some(p => p.startsWith(entry.path + '.'))) {
        const g = group(entry.path, entry.scope)
        const text = textFor(entry.scope, entry.path)
        g.title = text.label
        g.help = text.help ?? ''
        continue
      }
      if (!editor) continue
      if (!showAdvanced && !isBasic(entry.scope, entry.path) && !handSet(resolved[entry.scope].get(entry.path))) {
        hidden++
        continue
      }
      const cut = entry.path.lastIndexOf('.')
      group(cut === -1 ? '' : entry.path.slice(0, cut), entry.scope).entries.push({ ...entry, editor })
    }

    return { groups: out.filter(g => g.entries.length > 0), hidden }
  })
</script>

{#each layout.groups as group (group.key)}
  <section class="grp">
  {#if group.title}
    <h3 class="gh">{group.title}</h3>
  {/if}
  {#each group.entries as entry (entry.path)}
    {#if entry.editor === 'list'}
      <ListEditor
        scope={entry.scope}
        path={entry.path}
        resolved={resolved[entry.scope]}
        manual={manual[entry.scope][entry.path]}
        {levelScope}
        {mapManual}
        {maps}
        mixed={mixed.has(entry.path)}
        partial={partial.has(entry.path)}
        offMode={entry.offMode}
        onchange={(path, value) => onchange?.(entry.scope, path, value)}
        onreset={path => onreset?.(entry.scope, path)}
        onprovenance={(path, anchor) => onprovenance?.(entry.scope, path, anchor)}
        {onapplytoall}
      />
    {:else}
      <Field
        scope={entry.scope}
        path={entry.path}
        resolved={resolved[entry.scope]}
        {levelScope}
        {maps}
        mixed={mixed.has(entry.path)}
        partial={partial.has(entry.path)}
        offMode={entry.offMode}
        onchange={(path, value) => onchange?.(entry.scope, path, value)}
        onreset={path => onreset?.(entry.scope, path)}
        onprovenance={(path, anchor) => onprovenance?.(entry.scope, path, anchor)}
      />
    {/if}
  {/each}
  </section>
{/each}

{#if layout.hidden}
  <p class="more">
    {layout.hidden} advanced {layout.hidden === 1 ? 'setting' : 'settings'} hidden.
    <button type="button" class="link" onclick={() => onshowadvanced?.()}>Show</button>
  </p>
{/if}

<style>
  /* each group owns its spacing, so the last row needs no border of its own */
  .grp + .grp { margin-top: 30px; }

  .more {
    margin: 30px 0 0;
    font-size: 13px;
    color: var(--ink-3);
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
</style>
