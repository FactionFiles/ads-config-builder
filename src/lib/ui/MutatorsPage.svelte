<script lang="ts">
  import {
    appliesToMode, modeTitles, modesForMutator, mutatorAllowsMode, mutatorEffects,
    mutators as mutatorSchema,
  } from '../../schema'
  import type { Mutator } from '../../schema/types'
  import { weaponsWithPickup } from '../gamedata'
  import {
    effectiveMutators, optionValue, type MutatorDeclaration, type ResolvedRules,
  } from '../resolve'

  interface Props {
    declared: MutatorDeclaration[]
    /** true on a single map's page */
    levelScope?: boolean
    /** mutators enabled in the base rules, on a map's page */
    inherited?: MutatorDeclaration[]
    /** this map changed game type, which clears the base rules' mutators */
    modeCleared?: boolean
    /** the maps in scope declare different mutators */
    mixed?: boolean
    resolved: ResolvedRules
    gameType: string
    onchange: (next: MutatorDeclaration[]) => void
  }

  const {
    declared, levelScope = false, inherited = [], modeCleared = false, mixed = false,
    resolved, gameType, onchange,
  }: Props = $props()

  const all = mutatorSchema.mutators
  const applyRank = new Map(mutatorSchema.applyOrder.map((id, i) => [id, i]))

  const running = $derived(effectiveMutators(inherited, declared, modeCleared))
  const declaredBy = $derived(new Map(declared.map(d => [d.name, d])))
  const runningBy = $derived(new Map(running.map(d => [d.name, d])))
  // active mutators are sorted by apply order so the cards match the note below
  const on = $derived(
    all.filter(m => runningBy.has(m.name))
      .sort((a, b) => (applyRank.get(a.id) ?? 0) - (applyRank.get(b.id) ?? 0))
  )
  const available = $derived(
    all.filter(m => !runningBy.has(m.name) && mutatorAllowsMode(m, gameType))
  )
  const blocked = $derived(
    all.filter(m => !runningBy.has(m.name) && !mutatorAllowsMode(m, gameType))
  )

  function fromBase(m: Mutator) {
    return !declaredBy.has(m.name) && runningBy.has(m.name)
  }

  const cleared = $derived(
    modeCleared ? inherited.filter(d => !declaredBy.has(d.name)) : []
  )

  function effect(m: Mutator) {
    return mutatorEffects[m.name]
  }

  function label(name: string) {
    return all.find(m => m.name === name)?.label ?? name
  }

  function add(m: Mutator) {
    onchange([...declared, { name: m.name }])
  }

  function remove(m: Mutator) {
    onchange(declared.filter(d => d.name !== m.name))
  }

  function setOption(m: Mutator, option: string, value: unknown) {
    onchange(declared.map(d =>
      d.name === m.name ? { ...d, options: { ...d.options, [option]: value } } : d
    ))
  }

  // some options default to the current setting value, so they need the resolved rules
  function shown(m: Mutator, option: string) {
    const decl = runningBy.get(m.name) ?? { name: m.name }
    // an option can target a different setting per game type, like the score limit
    const target = effect(m)?.sets
      ?.filter(s => s.fromOption === option)
      .find(s => appliesToMode('rules', s.key, gameType))?.key
    return optionValue(m, decl, option, target ? resolved.get(target)?.value : undefined)
  }

  function requirement(m: Mutator) {
    if (m.minClientMinorVersion === 0) return null
    return `Players need Alpine 1.${m.minClientMinorVersion} or newer`
  }

  // name the requirement rather than listing every game type it allows
  function blockedReason(m: Mutator) {
    switch (m.gametypeReq) {
      case 'TeamOnly': return 'Team game types only.'
      case 'GunGameOnly': return 'Gun Game only.'
      case 'HasScoreLimit': return 'Only in game types with a score limit.'
      case 'BotsSupported': return 'Only in game types that support bots.'
      default: return `Only in ${modeTitles(modesForMutator(m))}.`
    }
  }

</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    Mutators are applied <b>before</b> manual settings, so manual settings take
    priority. Settings changed by a mutator are marked with a
    <i class="pd mut"></i> dot.
  </div>
</div>

{#if mixed}
  <div class="banner warn">
    <span class="ic">!</span>
    <div>
      Mutators differ across the selected maps. Editing replaces them on all of them.
    </div>
  </div>
{/if}

{#if cleared.length}
  <div class="banner warn">
    <span class="ic">!</span>
    <div>
      This map uses a different game type, which clears mutators set in the base
      rules. <b>{cleared.map(d => label(d.name)).join(', ')}</b>
      {cleared.length === 1 ? 'is' : 'are'} not active here. Add
      {cleared.length === 1 ? 'it' : 'them'} below to re-enable.
    </div>
  </div>
{/if}

{#snippet card(m: Mutator, state: 'on' | 'off' | 'blocked')}
  {@const base = state === 'on' && fromBase(m)}
  <div class="mcard" class:on={state === 'on'} class:off={state === 'blocked'}>
    <div class="top">
      <span class="nm">{m.label}</span>
      {#if state === 'blocked'}
        <span class="add">&mdash;</span>
      {:else if base}
        <span class="add plain">All maps</span>
      {:else}
        <button
          type="button"
          class="add"
          onclick={() => (state === 'on' ? remove(m) : add(m))}
        >{state === 'on' ? 'On' : 'Add'}</button>
      {/if}
    </div>

    <div class="dd">
      {state === 'blocked' ? blockedReason(m) : (effect(m)?.summary ?? '')}
    </div>

    {#if base}
      <div class="rq base">
        Enabled in the base rules. Disable it there, or change this map's game type.
      </div>
    {/if}

    {#if state === 'on' && !base && m.options.length}
      <div class="opts">
        {#each m.options as option (option.name)}
          <label class="opt">
            <span>{option.label}</span>
            {#if option.type === 'bool'}
              <button
                type="button"
                class="sw"
                class:on={shown(m, option.name) === true}
                role="switch"
                aria-checked={shown(m, option.name) === true}
                aria-label={option.label}
                onclick={() => setOption(m, option.name, !(shown(m, option.name) === true))}
              ></button>
            {:else if option.choicesFrom === 'weaponsWithPickup'}
              <select
                class="ctl"
                value={String(shown(m, option.name) ?? '')}
                onchange={e => setOption(m, option.name, e.currentTarget.value)}
              >
                {#each weaponsWithPickup as weapon (weapon.name)}
                  <option value={weapon.name}>{weapon.display}</option>
                {/each}
              </select>
            {:else}
              <input
                class="ctl"
                type="number"
                min="1"
                step="1"
                value={shown(m, option.name) as number}
                onchange={e => setOption(m, option.name, Number(e.currentTarget.value))}
              />
            {/if}
          </label>
        {/each}
      </div>
    {/if}

    {#if state !== 'blocked' && requirement(m)}
      <div class="rq">{requirement(m)}</div>
    {/if}
  </div>
{/snippet}

{#if on.length}
  <h3 class="gh">{levelScope ? 'Active on this map' : 'Active on all maps'}</h3>
  <div class="mutgrid">
    {#each on as m (m.name)}{@render card(m, 'on')}{/each}
  </div>
  {#if on.length > 1}
    <p class="order">
      Applied in this order: {on.map(m => m.label).join(', ')}. When two change
      the same setting, the later one wins.
    </p>
  {/if}
{/if}

<h3 class="gh">Available{gameType ? ` in ${modeTitles([gameType])}` : ''}</h3>
<div class="mutgrid">
  {#each available as m (m.name)}{@render card(m, 'off')}{/each}
  {#each blocked as m (m.name)}{@render card(m, 'blocked')}{/each}
</div>

<style>
  .mutgrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
  }

  .mcard {
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 11px 13px;
    background: var(--surface-2);
  }

  .mcard.on {
    border-color: var(--p-mut);
    background: var(--p-mut-b);
  }

  .mcard.off { opacity: .5; }

  .mcard .top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mcard .nm {
    font-weight: 600;
    font-size: 13.5px;
  }

  .mcard .add {
    margin-left: auto;
    font-size: 12px;
    color: var(--ink-3);
    background: none;
    border: 1px solid var(--line-2);
    border-radius: 5px;
    padding: 2px 9px;
    cursor: pointer;
  }

  .mcard .add:hover { background: var(--sunk); }

  .mcard.on .add {
    background: var(--p-mut);
    border-color: var(--p-mut);
    color: var(--on-accent);
  }

  .mcard .dd {
    font-size: 12px;
    color: var(--ink-3);
    margin-top: 3px;
    line-height: 1.4;
  }

  .mcard .rq {
    font-size: 11.5px;
    color: var(--p-you);
    margin-top: 6px;
  }

  .mcard .rq.base { color: var(--ink-3); }

  .mcard .add.plain {
    background: none;
    border-color: var(--line-2);
    color: var(--ink-3);
  }


  .mcard .opts {
    margin-top: 9px;
    padding-top: 9px;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 7px;
    font-size: 12.5px;
  }

  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .opt > span { flex: 1; }
  .opt :global(.ctl) { padding: 3px 8px; font-size: 12.5px; }
  .opt input.ctl { width: 92px; }

  .order {
    font-size: 12px;
    color: var(--ink-3);
    margin: 10px 0 22px;
    max-width: 60ch;
    line-height: 1.5;
  }
</style>
