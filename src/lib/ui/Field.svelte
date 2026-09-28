<script lang="ts">
  import { choiceBlurbFor, choiceLabelsFor, schemaFor, textFor, type Scope } from '../../schema'
  import type { ScalarKey } from '../../schema/types'
  import { tableFor } from '../gamedata'
  import { toDisplay, toFile, unitFor } from '../format'
  import { unsatisfiedGuard, type Resolved, type ResolvedRules } from '../resolve'
  import ProvenanceDot from './ProvenanceDot.svelte'

  interface Props {
    scope: Scope
    path: string
    resolved: ResolvedRules
    levelScope?: boolean
    /** shown when the active game type ignores this setting */
    offMode?: string
    /** the control alone, with no provenance */
    bare?: boolean
    /** false on repeats of the same field */
    showHelp?: boolean
    onchange?: (path: string, value: unknown) => void
    onreset?: (path: string) => void
    onprovenance?: (path: string, anchor: HTMLElement) => void
  }

  const {
    scope, path, resolved, levelScope = false, offMode, bare = false, showHelp = true,
    onchange, onreset, onprovenance,
  }: Props = $props()

  const schema = $derived(schemaFor(scope, path))
  const scalar = $derived(schema?.kind === 'scalar' ? (schema as ScalarKey) : undefined)
  const text = $derived(textFor(scope, path))
  const current = $derived<Resolved | undefined>(resolved.get(path))
  const value = $derived(current?.value)

  // disabled rather than hidden when a sibling setting it depends on is off
  const inert = $derived(unsatisfiedGuard(scalar, path, resolved) !== undefined)

  const choiceLabels = $derived(choiceLabelsFor(scope, path))
  const options = $derived(
    scalar?.choices?.map(c => ({ value: c, label: choiceLabels?.[c] ?? c }))
      ?? (scalar?.lookup
        ? tableFor(scalar.lookup).map(e => ({ value: e.name, label: e.display }))
        : undefined)
  )

  const shown = $derived(toDisplay(text, value))
  const unitLabel = $derived(unitFor(text))
  const choiceBlurb = $derived(
    typeof value === 'string' ? choiceBlurbFor(scope, path, value) : undefined
  )
  const canReset = $derived(current !== undefined && (current.layer === 'manual'))

  function setBool(next: boolean) { onchange?.(path, next) }
  function setNumber(raw: string) {
    const n = Number(raw)
    if (Number.isFinite(n)) onchange?.(path, toFile(text, n))
  }
</script>

<div class="fr" class:inert class:offmode={offMode}>
  <div>
    <div class="lab">{text.label}</div>
    {#if text.help && showHelp}<div class="help">{text.help}</div>{/if}
    {#if text.link && showHelp}
      <a class="help" href={text.link} target="_blank" rel="noreferrer noopener">
        {text.linkLabel ?? text.link}
      </a>
    {/if}
    {#if offMode}
      <div class="warn">{offMode}</div>
    {/if}
    {#if scalar?.typeMismatch}
      <div class="warn">
        Read as {scalar.typeMismatch.readAs} but stored as
        {scalar.typeMismatch.storedAs}. May not take effect.
      </div>
    {/if}
  </div>

  <div>
    <div class="ctlwrap">
      {#if scalar?.type === 'bool'}
        <button
          type="button"
          class="sw"
          class:on={value === true}
          role="switch"
          aria-checked={value === true}
          aria-label={text.label}
          disabled={inert}
          onclick={() => setBool(!(value === true))}
        ></button>
      {:else if options}
        <select
          class="ctl"
          value={String(shown ?? '')}
          disabled={inert}
          aria-label={text.label}
          onchange={e => onchange?.(path, e.currentTarget.value)}
        >
          {#each options as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      {:else if scalar?.type === 'int' || scalar?.type === 'float'}
        <span class="ctl">
          <input
            type="number"
            value={shown as number}
            min={scalar.min}
            max={scalar.max}
            step={scalar.type === 'int' ? 1 : 'any'}
            disabled={inert}
            aria-label={text.label}
            onchange={e => setNumber(e.currentTarget.value)}
          />
          {#if unitLabel}<span class="unit">{unitLabel}</span>{/if}
        </span>
      {:else}
        <input
          class="ctl"
          type="text"
          value={(shown as string) ?? ''}
          maxlength={scalar?.maxLength}
          disabled={inert}
          aria-label={text.label}
          onchange={e => onchange?.(path, e.currentTarget.value)}
        />
      {/if}

      {#if !bare}
        <ProvenanceDot
          resolved={current}
          {levelScope}
          onopen={anchor => onprovenance?.(path, anchor)}
        />
      {/if}
    </div>

    {#if choiceBlurb}
      <div class="blurb">{choiceBlurb}</div>
    {/if}

    {#if bare}
      <!-- the caller shows its own explanation -->
    {:else if canReset}
      <div class="src {levelScope ? 'map' : 'you'}">
        <i class="pd {levelScope ? 'map' : 'you'}"></i>
        {levelScope ? 'Set for this map' : 'Changed'}
        <button type="button" class="rst" onclick={() => onreset?.(path)}>undo</button>
      </div>
    {:else if current?.layer === 'mutator'}
      <div class="src mut">
        <i class="pd mut"></i>
        {current.source}
      </div>
    {/if}
  </div>
</div>
