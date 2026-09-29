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
    /** how many maps this scope edits at once */
    maps?: number
    /** the maps in scope hold different values */
    mixed?: boolean
    /** set by hand on only some of the maps in scope */
    partial?: boolean
    /** the value cannot be left empty */
    required?: boolean
    onchange?: (path: string, value: unknown) => void
    onreset?: (path: string) => void
    onprovenance?: (path: string, anchor: HTMLElement) => void
  }

  const {
    scope, path, resolved, levelScope = false, offMode, bare = false, showHelp = true,
    maps = 1, mixed = false, partial = false, required = false, onchange, onreset, onprovenance,
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
    typeof value === 'string' && !mixed ? choiceBlurbFor(scope, path, value) : undefined
  )
  const empty = $derived(required && (value === undefined || value === null || String(value).trim() === ''))
  const canReset = $derived(current !== undefined && (current.layer === 'manual'))
  const setLabel = $derived(
    maps > 1 ? (partial ? 'Set on some maps' : 'Set for these maps')
      : levelScope ? 'Set for this map' : 'Changed'
  )

  // an unsigned identifier: digits only, and clearing the box removes the key
  const digitsMax = $derived(scalar?.max ?? (scalar?.cppType === 'uint32_t' ? 2 ** 32 - 1 : Number.MAX_SAFE_INTEGER))
  const digitsShown = $derived(
    mixed || value === undefined || (value === 0 && current?.layer !== 'manual') ? '' : String(value)
  )

  function setDigits(raw: string) {
    if (raw === '') { onreset?.(path); return }
    onchange?.(path, Math.min(Number(raw), digitsMax))
  }

  function setBool(next: boolean) { onchange?.(path, next) }
  function setNumber(raw: string) {
    const n = Number(raw)
    if (Number.isFinite(n)) onchange?.(path, toFile(text, n))
  }
</script>

<div class="fr" class:inert class:offmode={offMode}>
  <div>
    <div class="lab">
      {text.label}
      {#if required}<span class="req">Required</span>{/if}
    </div>
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
          class:on={value === true && !mixed}
          class:mixed
          role="switch"
          aria-checked={mixed ? 'mixed' : value === true}
          aria-label={text.label}
          disabled={inert}
          onclick={() => setBool(mixed || !(value === true))}
        ></button>
      {:else if options}
        <select
          class="ctl"
          value={mixed ? '' : String(shown ?? '')}
          disabled={inert}
          aria-label={text.label}
          onchange={e => onchange?.(path, e.currentTarget.value)}
        >
          {#if mixed}<option value="" disabled>Mixed</option>{/if}
          {#each options as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      {:else if scalar?.type === 'int' && text.digits}
        <input
          class="ctl"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          value={digitsShown}
          placeholder={mixed ? 'Mixed' : text.emptyLabel}
          disabled={inert}
          aria-label={text.label}
          oninput={e => {
            const clean = e.currentTarget.value.replace(/\D/g, '')
            if (clean !== e.currentTarget.value) e.currentTarget.value = clean
          }}
          onchange={e => setDigits(e.currentTarget.value)}
        />
      {:else if scalar?.type === 'int' || scalar?.type === 'float'}
        <span class="ctl">
          <input
            type="number"
            value={mixed ? '' : shown as number}
            placeholder={mixed ? 'Mixed' : undefined}
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
          class:need={empty}
          type="text"
          value={mixed ? '' : (shown as string) ?? ''}
          placeholder={mixed ? 'Mixed' : undefined}
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

    {#if mixed}
      <div class="src">Differs across the selected maps</div>
    {/if}

    {#if bare}
      <!-- the caller shows its own explanation -->
    {:else if canReset}
      <div class="src {levelScope ? 'map' : 'you'}">
        <i class="pd {levelScope ? 'map' : 'you'}"></i>
        {setLabel}
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
