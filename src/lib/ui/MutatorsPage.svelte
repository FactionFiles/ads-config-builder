<script lang="ts">
  import {
    appliesToMode, modeTitles, modesForMutator, mutatorAllowsMode, mutatorEffects,
    mutators as mutatorSchema,
  } from '../../schema'
  import type { Mutator } from '../../schema/types'
  import { weaponsWithPickup } from '../gamedata'
  import {
    activeMutators, disabledMutators, effectiveMutators, optionValue, roundsToWin, type MutatorDeclaration, type ResolvedRules,
  } from '../resolve'

  interface Props {
    declared: MutatorDeclaration[]
    /** true on a single map's page */
    levelScope?: boolean
    /** mutators enabled in the base rules, on a map's page */
    inherited?: MutatorDeclaration[]
    /** the maps in scope declare different mutators */
    mixed?: boolean
    /** how many maps this scope edits at once */
    maps?: number
    resolved: ResolvedRules
    gameType: string
    onchange: (next: MutatorDeclaration[]) => void
  }

  const {
    declared, levelScope = false, inherited = [], mixed = false,
    maps = 1, resolved, gameType, onchange,
  }: Props = $props()

  const all = mutatorSchema.mutators
  const applyRank = new Map(mutatorSchema.applyOrder.map((id, i) => [id, i]))

  const running = $derived(effectiveMutators(inherited, declared))
  // a map's enabled = false entries only switch off base mutators
  const declaredBy = $derived(new Map(declared.filter(d => d.enabled !== false).map(d => [d.name, d])))
  const runningBy = $derived(new Map(running.map(d => [d.name, d])))
  const turnedOff = $derived(
    levelScope
      ? all.filter(m => !runningBy.has(m.name) && disabledMutators(declared).includes(m.name)
          && activeMutators(inherited).some(d => d.name === m.name))
      : []
  )
  // active mutators are sorted by apply order so the cards match the note below
  const on = $derived(
    all.filter(m => runningBy.has(m.name))
      .sort((a, b) => (applyRank.get(a.id) ?? 0) - (applyRank.get(b.id) ?? 0))
  )
  const available = $derived(
    all.filter(m => !runningBy.has(m.name) && !turnedOff.includes(m) && mutatorAllowsMode(m, gameType))
  )
  const blocked = $derived(
    all.filter(m => !runningBy.has(m.name) && !turnedOff.includes(m) && !mutatorAllowsMode(m, gameType))
  )

  function fromBase(m: Mutator) {
    return !declaredBy.has(m.name) && runningBy.has(m.name)
  }

  function effect(m: Mutator) {
    return mutatorEffects[m.name]
  }

  function add(m: Mutator) {
    onchange([...declared.filter(d => d.name !== m.name), { name: m.name }])
  }

  function remove(m: Mutator) {
    onchange(declared.filter(d => d.name !== m.name))
  }

  function turnOff(m: Mutator) {
    onchange([...declared.filter(d => d.name !== m.name), { name: m.name, enabled: false }])
  }

  function setOption(m: Mutator, option: string, value: unknown) {
    onchange(declared.map(d =>
      d.name === m.name ? { ...d, options: { ...d.options, [option]: value } } : d
    ))
  }

  function resetOption(m: Mutator, option: string) {
    onchange(declared.map(d => {
      if (d.name !== m.name || !d.options) return d
      const { [option]: _dropped, ...rest } = d.options
      return Object.keys(rest).length ? { ...d, options: rest } : { name: d.name }
    }))
  }

  function isSet(m: Mutator, option: string) {
    return declaredBy.get(m.name)?.options?.[option] !== undefined
  }

  const tone = $derived(levelScope ? 'map' : 'you')
  const setLabel = $derived(
    maps > 1 ? 'Set for these maps' : levelScope ? 'Set for this map' : 'Changed'
  )

  // some options default to the current setting value, so they need the resolved rules
  function shown(m: Mutator, option: string) {
    const decl = runningBy.get(m.name) ?? { name: m.name }
    // an option can target a different setting per game type, like the score limit
    const set = effect(m)?.sets
      ?.filter(s => s.fromOption === option && (!s.modes || s.modes.includes(gameType)))
      .find(s => s.modes || appliesToMode('rules', s.key, gameType))
    const current = set ? resolved.get(set.key)?.value : undefined
    return optionValue(m, decl, option, set?.transform ? roundsToWin(current) : current)
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

{#snippet card(m: Mutator, state: 'on' | 'off' | 'blocked' | 'turnedOff')}
  {@const base = state === 'on' && fromBase(m)}
  {@const skipped = state === 'on' && !mutatorAllowsMode(m, gameType)}
  <div class="mcard" class:on={state === 'on'} class:off={state === 'blocked' || state === 'turnedOff' || skipped}>
    <div class="top">
      <span class="nm">{m.label}</span>
      {#if state === 'blocked'}
        <span class="add">&mdash;</span>
      {:else if base}
        <button type="button" class="add plain" onclick={() => turnOff(m)}>Turn off here</button>
      {:else if state === 'turnedOff'}
        <button type="button" class="add" onclick={() => remove(m)}>Turn on</button>
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

    {#if skipped}
      <div class="rq base">Does nothing in {modeTitles([gameType])}. The server skips it.</div>
    {/if}
    {#if base}
      <div class="rq base">Enabled in the base rules.</div>
    {:else if state === 'turnedOff'}
      <div class="rq base">Enabled in the base rules and turned off for {maps > 1 ? 'these maps' : 'this map'}.</div>
    {/if}

    {#if state === 'on' && !base && m.options.length}
      <div class="opts">
        {#each m.options as option (option.name)}
          <div class="opt">
            <label class="row">
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
              {:else if option.choices}
                <select
                  class="ctl"
                  value={String(shown(m, option.name) ?? '')}
                  onchange={e => setOption(m, option.name, e.currentTarget.value)}
                >
                  {#each option.choices as choice (choice)}
                    <option value={choice}>{option.choiceLabels?.[choice] ?? choice}</option>
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
            {#if isSet(m, option.name)}
              <div class="src {tone}">
                <i class="pd {tone}"></i>
                {setLabel}
                <button type="button" class="rst" onclick={() => resetOption(m, option.name)}>undo</button>
              </div>
            {/if}
          </div>
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

{#if turnedOff.length}
  <h3 class="gh">Turned off on {maps > 1 ? 'these maps' : 'this map'}</h3>
  <div class="mutgrid">
    {#each turnedOff as m (m.name)}{@render card(m, 'turnedOff')}{/each}
  </div>
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

  .opt .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .opt .row > span { flex: 1; }

  .opt .src {
    font-size: 11.5px;
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }

  .opt .src.you { color: var(--p-you); }
  .opt .src.map { color: var(--p-map); }

  .opt .rst {
    color: var(--ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    font-size: 11.5px;
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
  }
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
