<script lang="ts">
  import type { LevelEntry } from '../config'
  import type { Finding, Severity } from '../checks'
  import { rotationCheck } from '../mapcheck.svelte'

  interface Props {
    /** passed in so the sidebar count and this page always agree */
    findings: Finding[]
    levels: LevelEntry[]
    onopen: (page: string, map: number | null) => void
  }

  const { findings, levels, onopen }: Props = $props()

  const SECTIONS: { severity: Severity; title: string; blurb: string }[] = [
    {
      severity: 'error',
      title: 'Errors',
      blurb: 'The server cannot apply these and will start without them.',
    },
    {
      severity: 'warning',
      title: 'Warnings',
      blurb: 'The server ignores or overrides these, or the setup is likely unintended.',
    },
    {
      severity: 'note',
      title: 'Notes',
      blurb: 'For information only.',
    },
  ]

  const sections = $derived(
    SECTIONS.map(s => ({ ...s, found: findings.filter(f => f.severity === s.severity) }))
      .filter(s => s.found.length > 0)
  )

  const count = (severity: Severity) => findings.filter(f => f.severity === severity).length
  const errors = $derived(count('error'))
  const warnings = $derived(count('warning'))
  const notes = $derived(count('note'))

  function open(finding: Finding) {
    if (finding.page) onopen(finding.page, finding.scope.map)
  }
</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    Checks cover the config file only, not the behavior of a running server.
  </div>
</div>

{#if !findings.length}
  <div class="clean">
    <strong>No problems found.</strong>
    <span>
      Every changed setting applies to its game type, the rotation is valid, and
      all values are in range.
    </span>
  </div>
{:else}
  <p class="count">
    {#if errors || warnings}
      {#if errors}<strong>{errors}</strong> {errors === 1 ? 'error' : 'errors'}{warnings ? ',' : '.'}{/if}
      {#if warnings}<strong>{warnings}</strong> {warnings === 1 ? 'warning' : 'warnings'}.{/if}
    {:else}
      No problems found.
    {/if}
    {#if notes}
      {notes} {notes === 1 ? 'note' : 'notes'}.
    {/if}
  </p>

  {#each sections as section (section.severity)}
    <h3 class="gh">{section.title}</h3>
    <p class="sb">{section.blurb}</p>

    {#each section.found as finding (finding.id)}
      <div class="f" class:bad={finding.severity === 'error'} class:warn={finding.severity === 'warning'}>
        <div class="ft">{finding.title}</div>
        <div class="fd">{finding.detail}</div>

        {#if finding.items?.length}
          <div class="items">
            {#each finding.items as item (item)}
              <span class="chip">{item}</span>
            {/each}
          </div>
        {/if}

        <div class="fw">
          <span class="where">{finding.scope.label}</span>
          {#if finding.page}
            <button type="button" class="btn" onclick={() => open(finding)}>Open</button>
          {/if}
        </div>
      </div>
    {/each}
  {/each}
{/if}

{#if rotationCheck.offline && levels.length}
  <p class="quiet">
    Could not reach FactionFiles. Maps were not checked against the archive.
    <button type="button" class="link" onclick={() => rotationCheck.retry(levels.map(l => l.filename))}>
      Retry
    </button>
  </p>
{/if}

<style>
  .count {
    font-size: 13.5px;
    color: var(--ink-2);
    margin: 0 0 6px;
  }

  .sb {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: -2px 0 10px;
  }

  .clean {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-2);
    padding: 16px 18px;
    display: grid;
    gap: 4px;
    font-size: 13px;
    color: var(--ink-2);
    max-width: 62ch;
  }

  .clean strong {
    color: var(--ink);
    font-size: 14px;
  }

  .f {
    border: 1px solid var(--line);
    border-left: 3px solid var(--line-2);
    border-radius: 8px;
    background: var(--surface-2);
    padding: 12px 14px;
    margin-bottom: 8px;
  }

  .f.bad {
    border-left-color: var(--err);
    background: var(--err-b);
  }

  .f.warn { border-left-color: var(--warn); }

  .ft {
    font-size: 14px;
    font-weight: 500;
  }

  .fd {
    font-size: 12.5px;
    color: var(--ink-2);
    margin-top: 3px;
    max-width: 68ch;
  }

  .items {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
  }

  .chip {
    font-size: 11.5px;
    padding: 1px 7px;
    border-radius: 4px;
    border: 1px solid var(--line-2);
    color: var(--ink-2);
  }

  .fw {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }

  .where {
    font-size: 11.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  .quiet {
    font-size: 12.5px;
    color: var(--ink-3);
    margin-top: 18px;
  }

  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    font-size: 12.5px;
  }
</style>
