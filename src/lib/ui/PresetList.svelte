<script lang="ts">
  // The preset files one scope pulls in. Order is the whole meaning here: they
  // are applied in the order listed, before anything set by hand in this scope.

  interface Props {
    presets: string[]
    /** short names that stand for a file, from the presets page */
    aliases: Record<string, string>
    /** true when this is one map's rules rather than the game rules */
    levelScope?: boolean
    onchange: (next: string[]) => void
  }

  const { presets, aliases, levelScope = false, onchange }: Props = $props()

  const aliasNames = $derived(Object.keys(aliases))

  function set(index: number, value: string) {
    onchange(presets.map((p, i) => (i === index ? value : p)))
  }

  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= presets.length) return
    const next = [...presets]
    const [taken] = next.splice(index, 1)
    next.splice(to, 0, taken)
    onchange(next)
  }

  function remove(index: number) {
    onchange(presets.filter((_, i) => i !== index))
  }
</script>

<h3 class="gh">Rules presets</h3>

<p class="lead">
  {#if levelScope}
    Files of ready-made rules, applied to this map before its own changes. The
    ones your game rules use still apply; these are on top of them.
  {:else}
    Files of ready-made rules, applied before anything you set by hand. Later
    ones in the list win where two of them set the same thing.
  {/if}
</p>

{#each presets as preset, i (i)}
  {@const target = aliases[preset]}
  <div class="row">
    <span class="num">{i + 1}</span>
    <span class="grow">
      <input
        class="ctl"
        type="text"
        list="preset-aliases"
        value={preset}
        placeholder="ruleset.toml"
        aria-label="Preset {i + 1}"
        onchange={e => set(i, e.currentTarget.value)}
      />
      {#if target}
        <span class="note">a shortcut for {target}</span>
      {:else if preset}
        <span class="note">a file next to your config</span>
      {/if}
    </span>
    <button type="button" class="btn" disabled={i === 0} onclick={() => move(i, -1)} aria-label="Move up">Up</button>
    <button type="button" class="btn" disabled={i === presets.length - 1} onclick={() => move(i, 1)} aria-label="Move down">Down</button>
    <button type="button" class="btn" onclick={() => remove(i)}>Remove</button>
  </div>
{:else}
  <p class="none">
    None. {levelScope ? 'This map' : 'The server'} plays by the rules on these pages alone.
  </p>
{/each}

<datalist id="preset-aliases">
  {#each aliasNames as name (name)}
    <option value={name}></option>
  {/each}
</datalist>

<button type="button" class="btn addbtn" onclick={() => onchange([...presets, ''])}>
  Add a preset
</button>

<style>
  .lead {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 0 0 12px;
    max-width: 62ch;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 0;
  }

  .row .num {
    width: 18px;
    color: var(--ink-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .row .grow {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }

  .row .grow .ctl { width: 260px; }

  .note {
    font-size: 12px;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .none {
    font-size: 13px;
    color: var(--ink-3);
    margin: 0 0 4px;
  }

  .addbtn { margin-top: 8px; }
</style>
