<script lang="ts">
  import type { LevelEntry } from '../config'
  import type { Finding, Severity } from '../checks'
  import { rotationCheck } from '../mapcheck.svelte'

  interface Props {
    /** already gathered, so the sidebar count and this page never disagree */
    findings: Finding[]
    levels: LevelEntry[]
    /** open the page that owns a finding, in the scope it belongs to */
    onopen: (page: string, map: number | null) => void
  }

  const { findings, levels, onopen }: Props = $props()

  const SECTIONS: { severity: Severity; title: string; blurb: string }[] = [
    {
      severity: 'broken',
      title: 'Will not work',
      blurb: 'The server cannot do what this asks, and will start without it.',
    },
    {
      severity: 'ignored',
      title: 'In the file, but not in effect',
      blurb: 'The server reads these and then uses something else, or nothing.',
    },
    {
      severity: 'note',
      title: 'Worth knowing',
      blurb: 'Nothing is wrong here.',
    },
  ]

  const sections = $derived(
    SECTIONS.map(s => ({ ...s, found: findings.filter(f => f.severity === s.severity) }))
      .filter(s => s.found.length > 0)
  )

  const serious = $derived(findings.filter(f => f.severity !== 'note').length)

  function open(finding: Finding) {
    if (finding.page) onopen(finding.page, finding.scope.map)
  }
</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    This page reads the config you have open. It does not run the server, so it
    finds what the file says rather than what happens on the night - a password
    nobody guessed wrong yet is not a problem here.
  </div>
</div>

{#if !findings.length}
  <div class="clean">
    <strong>Nothing here looks wrong.</strong>
    <span>
      Every setting you have changed does something in the mode it is under, the
      rotation is one Alpine can load, and nothing is set past what it accepts.
    </span>
  </div>
{:else}
  <p class="count">
    {#if serious}
      <strong>{serious}</strong>
      {serious === 1 ? 'thing needs' : 'things need'} a look.
    {:else}
      Nothing is broken.
    {/if}
    {#if findings.length > serious}
      {findings.length - serious} more worth knowing about.
    {/if}
  </p>

  {#each sections as section (section.severity)}
    <h3 class="gh">{section.title}</h3>
    <p class="sb">{section.blurb}</p>

    {#each section.found as finding (finding.id)}
      <div class="f" class:bad={finding.severity === 'broken'}>
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
            <button type="button" class="btn" onclick={() => open(finding)}>Take me there</button>
          {/if}
        </div>
      </div>
    {/each}
  {/each}
{/if}

{#if rotationCheck.offline && levels.length}
  <p class="quiet">
    FactionFiles could not be reached, so nothing here was checked against the
    map archive.
    <button type="button" class="link" onclick={() => rotationCheck.retry(levels.map(l => l.filename))}>
      Try again
    </button>
  </p>
{/if}

<style>
  .count {
    font-size: 13.5px;
    color: var(--ink-2);
    margin: 0 0 6px;
  }

  /* a heading's blurb sits under it, where the group heading rule leaves room */
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

  /* the only color on this page: something the server will not do at all */
  .f.bad {
    border-left-color: var(--err);
    background: var(--err-b);
  }

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
