<script lang="ts">
  import {
    appliesToMode, modeTitles, modesForMutator, mutatorAllowsMode, mutatorEffects,
    mutators as mutatorSchema,
  } from '../../schema'
  import type { Mutator } from '../../schema/types'
  import { weaponsWithPickup } from '../gamedata'
  import { optionValue, type MutatorDeclaration, type ResolvedRules } from '../resolve'

  interface Props {
    declared: MutatorDeclaration[]
    resolved: ResolvedRules
    gameType: string
    onchange: (next: MutatorDeclaration[]) => void
  }

  const { declared, resolved, gameType, onchange }: Props = $props()

  const all = mutatorSchema.mutators
  const applyRank = new Map(mutatorSchema.applyOrder.map((id, i) => [id, i]))

  const declaredBy = $derived(new Map(declared.map(d => [d.name, d])))
  // the active ones read in the server's apply order, so the note under them
  // matches the order on the cards. the rest keep the game's own listing order.
  const on = $derived(
    all.filter(m => declaredBy.has(m.name))
      .sort((a, b) => (applyRank.get(a.id) ?? 0) - (applyRank.get(b.id) ?? 0))
  )
  const available = $derived(
    all.filter(m => !declaredBy.has(m.name) && mutatorAllowsMode(m, gameType))
  )
  const blocked = $derived(
    all.filter(m => !declaredBy.has(m.name) && !mutatorAllowsMode(m, gameType))
  )

  function effect(m: Mutator) {
    return mutatorEffects[m.name]
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

  /**
   * What an option shows right now. Two options default to the setting's current
   * value rather than to a constant, so they need the resolved rules to answer.
   */
  function shown(m: Mutator, option: string) {
    const decl = declaredBy.get(m.name) ?? { name: m.name }
    // an option can feed a different setting per mode - the score limit does -
    // so read the current value from the one the mode in play actually uses
    const target = effect(m)?.sets
      ?.filter(s => s.fromOption === option)
      .find(s => appliesToMode('rules', s.key, gameType))?.key
    return optionValue(m, decl, option, target ? resolved.get(target)?.value : undefined)
  }

  function requirement(m: Mutator) {
    if (m.minClientMinorVersion === 0) return null
    return `Players need Alpine 1.${m.minClientMinorVersion} or newer`
  }

  // the requirement itself reads better than the list of modes it expands to,
  // which for team modes is nine names long
  function blockedReason(m: Mutator) {
    switch (m.gametypeReq) {
      case 'TeamOnly': return 'Only works in modes that have teams.'
      case 'GunGameOnly': return 'Only works in Gun Game.'
      case 'HasScoreLimit': return 'Only works in modes that have a score limit.'
      case 'BotsSupported': return 'Only works in modes that can run bots.'
      default: return `Only works in ${modeTitles(modesForMutator(m))}.`
    }
  }

</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    Mutators are applied <b>before</b> anything you set by hand, so your own
    settings always win. Anything a mutator changes is marked with a
    <i class="pd mut"></i> dot elsewhere in the tool.
  </div>
</div>

{#snippet card(m: Mutator, state: 'on' | 'off' | 'blocked')}
  <div class="mcard" class:on={state === 'on'} class:off={state === 'blocked'}>
    <div class="top">
      <span class="nm">{m.label}</span>
      {#if state === 'blocked'}
        <span class="add">&mdash;</span>
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

    {#if state === 'on' && m.options.length}
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
  <h3 class="gh">On for every map</h3>
  <div class="mutgrid">
    {#each on as m (m.name)}{@render card(m, 'on')}{/each}
  </div>
  {#if on.length > 1}
    <p class="order">
      The order you add them in does not matter. These are always applied in this
      order: {on.map(m => m.label).join(', ')}. Where two of them change the same
      setting, the one later in that list wins.
    </p>
  {/if}
{/if}

<h3 class="gh">Available{gameType ? ` in ${modeTitles([gameType])}` : ''}</h3>
<div class="mutgrid">
  {#each available as m (m.name)}{@render card(m, 'off')}{/each}
  {#each blocked as m (m.name)}{@render card(m, 'blocked')}{/each}
</div>

<style>
  .banner {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 11px 13px;
    font-size: 12.5px;
    color: var(--ink-2);
    line-height: 1.5;
    margin-bottom: 20px;
  }

  .banner .ic {
    flex: none;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--graphite);
    color: var(--on-graphite);
    font-size: 11px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }

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
    color: #fff;
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
