<script lang="ts">
  import { choiceBlurbFor, choiceLabelsFor, schemaFor, textFor, type Scope } from '../../schema'
  import type { ScalarKey } from '../../schema/types'
  import { tableFor } from '../gamedata'
  import { toDisplay, toFile, unitFor } from '../format'
  import type { Resolved, ResolvedRules } from '../resolve'
  import ProvenanceDot from './ProvenanceDot.svelte'

  interface Props {
    scope: Scope
    path: string
    resolved: ResolvedRules
    levelScope?: boolean
    /** set when the mode in play ignores this setting, worded for the user */
    offMode?: string
    /** the control alone, for editing several maps at once where no single
     *  provenance answer exists */
    bare?: boolean
    /** false on repeats of the same field, where the help was already read once */
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

  // a setting the server only reads when a sibling is on. it stays visible but
  // inert, so nobody sets a value that will be silently ignored.
  const inert = $derived(
    (scalar?.requires ?? []).some(
      g => g.key !== undefined && resolved.get(siblingPath(path, g.key))?.value !== (g.equals ?? true)
    )
  )

  function siblingPath(full: string, key: string) {
    const parts = full.split('.')
    parts[parts.length - 1] = key
    return parts.join('.')
  }

  const choiceLabels = $derived(choiceLabelsFor(scope, path))
  const options = $derived(
    scalar?.choices?.map(c => ({ value: c, label: choiceLabels?.[c] ?? c }))
      ?? (scalar?.lookup
        ? tableFor(scalar.lookup).map(e => ({ value: e.name, label: e.display }))
        : undefined)
  )

  // the unit the file stores, and what to show instead when they differ
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
    {#if offMode}
      <div class="warn">{offMode}</div>
    {/if}
    {#if scalar?.typeMismatch}
      <div class="warn">
        The server reads this as {scalar.typeMismatch.readAs} but stores it as
        {scalar.typeMismatch.storedAs}, so it may not take effect.
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
      <!-- the caller owns the explanation -->
    {:else if canReset}
      <div class="src {levelScope ? 'map' : 'you'}">
        <i class="pd {levelScope ? 'map' : 'you'}"></i>
        {levelScope ? 'Just for this map' : 'You changed this'}
        <button type="button" class="rst" onclick={() => onreset?.(path)}>undo</button>
      </div>
    {:else if current?.layer === 'preset' || current?.layer === 'mutator'}
      <div class="src {current.layer === 'preset' ? 'preset' : 'mut'}">
        <i class="pd {current.layer === 'preset' ? 'preset' : 'mut'}"></i>
        {current.source}
      </div>
    {/if}
  </div>
</div>
