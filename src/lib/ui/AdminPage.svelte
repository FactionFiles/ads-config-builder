<script lang="ts">
  // profiles are not layered, so fields render bare with no provenance

  import { choiceLabelsFor, rconCommandAliases, schemaFor, server, textFor } from '../../schema'
  import type { ArrayKey, ScalarKey } from '../../schema/types'
  import { emptyRconProfile, withCommandAliases, type RconProfile } from '../config'
  import { resolveEntry } from '../resolve'
  import Field from './Field.svelte'

  interface Props {
    profiles: RconProfile[]
    /** the legacy single admin password, which alpine turns into its own profile */
    legacyPassword?: string
    onchange: (next: RconProfile[]) => void
  }

  const { profiles, legacyPassword = '', onchange }: Props = $props()

  const root = schemaFor('server', 'rcon_profiles') as ArrayKey
  const fields = (root.keys ?? []).filter(k => k.kind === 'scalar') as ScalarKey[]
  const commandsKey = (root.keys ?? []).find(k => k.key === 'allowed_commands') as ArrayKey | undefined
  const commands = commandsKey?.choices ?? []
  // aliases follow their command, so they get no checkbox of their own
  const shownCommands = commands.filter(c => !(c in rconCommandAliases))
  const commandLabels = choiceLabelsFor('server', 'rcon_profiles.allowed_commands') ?? {}
  const commandsText = textFor('server', 'rcon_profiles.allowed_commands')

  const resolvedFor = $derived(profiles.map(p => resolveEntry(root, p.fields)))

  function commandsOf(profile: RconProfile): string[] {
    const value = profile.fields.allowed_commands
    return Array.isArray(value) ? (value as string[]) : []
  }

  function nameOf(profile: RconProfile, index: number) {
    const given = profile.fields.name
    return typeof given === 'string' && given.trim() ? given : `Profile ${index + 1}`
  }

  // the server skips a profile with no name or no password
  const REQUIRED = new Set(['name', 'password'])

  function incomplete(profile: RconProfile): boolean {
    const name = profile.fields.name
    const password = profile.fields.password
    return typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password
  }

  // full admins can run every command, so the list does not apply
  function unrestricted(index: number) {
    return (commandsKey?.requires ?? []).some(
      g => g.key !== undefined
        && resolvedFor[index].get(`rcon_profiles.${g.key}`)?.value !== (g.equals ?? true)
    )
  }

  function edit(index: number, change: (profile: RconProfile) => RconProfile) {
    onchange(profiles.map((p, i) => (i === index ? change(p) : p)))
  }

  function setField(index: number, path: string, value: unknown) {
    const key = path.slice(path.indexOf('.') + 1)
    edit(index, p => ({ ...p, fields: { ...p.fields, [key]: value } }))
  }

  function setCommands(index: number, next: string[]) {
    // canonical order keeps the file stable regardless of click order
    const ordered = withCommandAliases(next.filter(c => !(c in rconCommandAliases)))
    edit(index, p => ({ ...p, fields: { ...p.fields, allowed_commands: ordered } }))
  }

  function toggleCommand(index: number, command: string) {
    const have = commandsOf(profiles[index])
    setCommands(index, have.includes(command) ? have.filter(c => c !== command) : [...have, command])
  }

  function add() {
    onchange([...profiles, emptyRconProfile()])
  }

  function remove(index: number) {
    onchange(profiles.filter((_, i) => i !== index))
  }

  // alpine only adds the legacy profile when no other profile uses that password
  const legacyTaken = $derived(
    legacyPassword !== '' && profiles.some(p => p.fields.password === legacyPassword)
  )
  const legacyCommands = server.legacyRconCommands.filter(c => !(c in rconCommandAliases))
</script>

<div class="banner">
  <span class="ic">i</span>
  <div>
    Each profile pairs an rcon password with the commands it can run.
    <br />For a single password with full access, set the <b>Rcon password</b>
    on <b>Passwords &amp; access</b> instead.
  </div>
</div>

{#each profiles as profile, i (i)}
  {@const restricted = !unrestricted(i)}
  {@const chosen = commandsOf(profile)}
  <section class="pcard">
    <header>
      <h3>{nameOf(profile, i)}</h3>
      <button type="button" class="btn" onclick={() => remove(i)}>Remove</button>
    </header>

    {#if incomplete(profile)}
      <p class="flag">
        A profile name and password are both required. The server ignores this
        profile until both are set.
      </p>
    {/if}

    {#each fields as field (field.key)}
      <Field
        scope="server"
        path={`rcon_profiles.${field.key}`}
        resolved={resolvedFor[i]}
        bare
        required={REQUIRED.has(field.key)}
        showHelp={i === 0}
        onchange={(path, value) => setField(i, path, value)}
      />
    {/each}

    <div class="cmds" class:off={!restricted}>
      <h4 class="gh">
        {commandsText.label}
        <span class="count">
          {chosen.filter(c => shownCommands.includes(c)).length} of {shownCommands.length}
        </span>
      </h4>

      {#if !restricted}
        <p class="hint">
          This profile can run every command. The list below is ignored.
        </p>
      {:else if i === 0}
        <p class="hint">{commandsText.help}</p>
      {/if}

      <div class="grid">
        {#each shownCommands as command (command)}
          <label class="cmd">
            <input
              type="checkbox"
              checked={chosen.includes(command)}
              disabled={!restricted}
              onchange={() => toggleCommand(i, command)}
            />
            <span>{commandLabels[command] ?? command}</span>
          </label>
        {/each}
      </div>

      {#if restricted}
        <div class="bulk">
          <button type="button" class="btn" onclick={() => setCommands(i, commands)}>Allow all</button>
          <button type="button" class="btn" onclick={() => setCommands(i, [])}>Allow none</button>
        </div>
      {/if}
    </div>
  </section>
{:else}
  <p class="none">
    No profiles. Rcon is disabled unless you add a profile or set the
    <b>Rcon password</b> on <b>Passwords &amp; access</b>.
  </p>
{/each}

<button type="button" class="btn pri addbtn" onclick={add}>Add profile</button>

{#if legacyPassword}
  <section class="pcard legacy">
    <header>
      <h3>legacy</h3>
      <span class="tag">Automatic</span>
    </header>
    {#if legacyTaken}
      <p class="hint">
        A profile above already uses the <b>Rcon password</b> from
        <b>Passwords &amp; access</b>, so no legacy profile is created.
      </p>
    {:else}
      <p class="hint">
        The <b>Rcon password</b> on <b>Passwords &amp; access</b> creates this
        profile, which can run these {legacyCommands.length} commands.
      </p>
      <div class="grid read">
        {#each legacyCommands as command (command)}
          <span class="cmd">{commandLabels[command] ?? command}</span>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .pcard {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    padding: 4px 16px 14px;
    margin-bottom: 14px;
  }

  .pcard header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0 4px;
  }

  .pcard h3 {
    font-size: 14.5px;
    flex: 1;
  }

  .pcard .tag {
    font-size: 11.5px;
    color: var(--ink-3);
    border: 1px solid var(--line-2);
    border-radius: 999px;
    padding: 1px 9px;
  }

  .pcard.legacy {
    background: var(--surface-2);
  }

  .flag {
    font-size: 12px;
    color: var(--err);
    background: var(--err-b);
    border-radius: 6px;
    padding: 7px 10px;
    margin: 0 0 4px;
  }

  .cmds {
    margin-top: 16px;
    padding-top: 4px;
    border-top: 1px solid var(--line);
  }

  .cmds .count {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink-3);
  }

  .cmds.off .grid { opacity: .5; }

  .hint {
    font-size: 12.5px;
    color: var(--ink-3);
    margin: 0 0 10px;
    max-width: 62ch;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 4px 14px;
  }

  .cmd {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 3px 0;
  }

  .grid.read .cmd {
    color: var(--ink-2);
    font-size: 12.5px;
  }

  .bulk {
    display: flex;
    gap: 7px;
    margin-top: 11px;
  }

  .none {
    font-size: 13.5px;
    color: var(--ink-3);
    max-width: 60ch;
  }

  .addbtn { margin-bottom: 22px; }
</style>
