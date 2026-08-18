<script lang="ts">
  // Presets are separate files, so this page is about naming them and making
  // one - the list of presets a scope uses lives with that scope's rules.

  import { untrack } from 'svelte'
  import { textFor } from '../../schema'

  interface Props {
    aliases: Record<string, string>
    /** true when the game rules have something worth saving as a preset */
    canSave: boolean
    onchange: (next: Record<string, string>) => void
    onsave: () => void
  }

  const { aliases, canSave, onchange, onsave }: Props = $props()

  const aliasText = textFor('server', 'rules_preset_aliases')

  // edited as a list because a table has no order and two rows can hold the same
  // name for as long as it takes to finish typing the second one. seeded once:
  // an empty row has to survive being typed into, and it has no name to key off
  // until it is finished.
  let rows = $state(untrack(() => Object.entries(aliases).map(([name, file]) => ({ name, file }))))

  function push() {
    const out: Record<string, string> = {}
    for (const row of rows) {
      if (row.name.trim()) out[row.name.trim()] = row.file
    }
    onchange(out)
  }

  function set(index: number, field: 'name' | 'file', value: string) {
    rows[index][field] = value
    push()
  }

  function add() {
    rows = [...rows, { name: '', file: '' }]
  }

  function remove(index: number) {
    rows = rows.filter((_, i) => i !== index)
    push()
  }

  const duplicate = $derived(
    new Set(rows.map(r => r.name.trim()).filter(n => n)).size
      !== rows.filter(r => r.name.trim()).length
  )
</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    A preset is a file of game rules kept on its own, so several servers - or
    several maps - can share one set of rules. Presets live next to your config
    file on the server. Add one to your rules on <b>Mode &amp; scoring</b>, or to
    a single map from that map's own pages.
  </div>
</div>

<h3 class="gh">{aliasText.label}</h3>
<p class="lead">
  {aliasText.help} A shortcut is also what an in-game vote needs, since nobody
  wants to type a path into chat.
</p>

{#each rows as row, i (i)}
  <div class="row">
    <input
      class="ctl name"
      type="text"
      value={row.name}
      placeholder="classic"
      aria-label="Shortcut name"
      oninput={e => set(i, 'name', e.currentTarget.value)}
    />
    <span class="arrow">stands for</span>
    <input
      class="ctl file"
      type="text"
      value={row.file}
      placeholder="presets/classic.toml"
      aria-label="Preset file"
      oninput={e => set(i, 'file', e.currentTarget.value)}
    />
    <button type="button" class="btn" onclick={() => remove(i)}>Remove</button>
  </div>
{:else}
  <p class="none">No shortcuts yet. Presets can still be used by file name without one.</p>
{/each}

{#if duplicate}
  <p class="flag">
    Two shortcuts have the same name. The server keeps the last one it reads, so
    the other does nothing.
  </p>
{/if}

<button type="button" class="btn addbtn" onclick={add}>Add a shortcut</button>

<h3 class="gh">Save your rules as a preset</h3>
<p class="lead">
  Writes everything you have set in <b>Game rules</b> to a preset file of its
  own, mutators included. Nothing is removed from this config - the rules stay
  where they are, and you get a copy other servers can pull in.
</p>

{#if canSave}
  <button type="button" class="btn pri" onclick={onsave}>Download a preset file</button>
{:else}
  <p class="none">
    Your game rules are all still at their defaults, so a preset made now would
    be empty. Change something on the rules pages first.
  </p>
{/if}

<p class="lead foot">
  This tool does not read preset files, so anything a preset sets shows on the
  settings pages as the default it would have without one. What you see here is
  what this config says, not the sum of it and its presets.
</p>

<style>
  .lead {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 0 0 12px;
    max-width: 64ch;
  }

  .foot {
    margin-top: 26px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 4px 0;
  }

  .row .name { width: 170px; }
  .row .file { flex: 1; max-width: 320px; }

  .arrow {
    font-size: 12px;
    color: var(--ink-3);
  }

  .none {
    font-size: 13px;
    color: var(--ink-3);
    margin: 0 0 4px;
    max-width: 60ch;
  }

  .flag {
    font-size: 12px;
    color: var(--err);
    background: var(--err-b);
    border-radius: 6px;
    padding: 7px 10px;
    margin: 8px 0 0;
    max-width: 60ch;
  }

  .addbtn { margin-top: 10px; }
</style>
