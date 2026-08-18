<script lang="ts">
  import { allEntries, appliesToMode, modesFor, modeTitles, schemaFor, textFor, type Scope } from '../../schema'
  import type { ResolvedRules } from '../resolve'
  import Field from './Field.svelte'

  interface Props {
    page: string
    /** resolved values per scope, since a page can hold settings from both */
    resolved: Record<Scope, ResolvedRules>
    /** the game mode in play, which decides which settings have any effect */
    gameType: string
    levelScope?: boolean
    onchange?: (scope: Scope, path: string, value: unknown) => void
    onreset?: (scope: Scope, path: string) => void
    onprovenance?: (scope: Scope, path: string, anchor: HTMLElement) => void
  }

  const { page, resolved, gameType, levelScope = false, onchange, onreset, onprovenance }: Props = $props()

  interface Entry { scope: Scope; path: string; offMode?: string }

  // a setting the mode in play ignores. it is hidden unless this scope sets it
  // by hand, because a value that is in the file must never be invisible - it
  // is shown with a note instead, so it can be found and cleared.
  function offMode(scope: Scope, path: string): string | undefined {
    if (appliesToMode(scope, path, gameType)) return undefined
    const modes = modesFor(scope, path)
    return modes ? `Only applies in ${modeTitles(modes)}.` : undefined
  }

  // ads_version and friends are written by the tool, not chosen by the user, so
  // they get an authored entry for completeness but never a field
  function isToolOwned(scope: Scope, path: string) {
    const key = schemaFor(scope, path)
    return key?.kind === 'scalar' && (key as { global?: boolean }).global === true
  }

  interface Group { key: string; title: string; help: string; entries: Entry[] }

  // settings on this page, gathered under the group they belong to. the group is
  // just the parent path, so the layout follows the config file's own shape
  // instead of being maintained by hand a second time.
  const groups = $derived.by(() => {
    const out: Group[] = []
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
      // a path that other paths hang off is a group heading, not a field
      if ([...paths].some(p => p.startsWith(entry.path + '.'))) {
        const g = group(entry.path, entry.scope)
        const text = textFor(entry.scope, entry.path)
        g.title = text.label
        g.help = text.help
        continue
      }
      const cut = entry.path.lastIndexOf('.')
      group(cut === -1 ? '' : entry.path.slice(0, cut), entry.scope).entries.push(entry)
    }

    return out.filter(g => g.entries.length > 0)
  })
</script>

{#each groups as group (group.key)}
  {#if group.title}
    <h3 class="gh">{group.title}</h3>
  {/if}
  {#each group.entries as entry (entry.path)}
    <Field
      scope={entry.scope}
      path={entry.path}
      resolved={resolved[entry.scope]}
      {levelScope}
      offMode={entry.offMode}
      onchange={(path, value) => onchange?.(entry.scope, path, value)}
      onreset={path => onreset?.(entry.scope, path)}
      onprovenance={(path, anchor) => onprovenance?.(entry.scope, path, anchor)}
    />
  {/each}
{/each}
