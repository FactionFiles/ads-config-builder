<script lang="ts">
  import { configNameMax, defaultPort, sanitizeConfigName } from '../config'

  interface Props {
    /** empty means named after the server */
    configName: string
    autoName: string
    port: number
    onname?: (name: string) => void
    onport?: (port: number) => void
  }

  const { configName, autoName, port, onname, onport }: Props = $props()

  function setPort(input: HTMLInputElement) {
    const n = Math.trunc(Number(input.value))
    const next = input.value === '' ? defaultPort : n >= 1 && n <= 65535 ? n : port
    // rewritten even when unchanged, so a rejected entry does not linger in the box
    input.value = String(next)
    onport?.(next)
  }
</script>

<!-- launcher arguments rather than config keys, so they have no provenance -->
<section class="grp">
  <div class="fr">
    <div>
      <div class="lab">ADS config name</div>
      <div class="help">File name used with -ads. Defaults to the server name.</div>
    </div>
    <div class="ctlwrap">
      <span class="ctl">
        <input
          type="text"
          value={configName}
          placeholder={autoName}
          maxlength={configNameMax + 5}
          autocomplete="off"
          spellcheck="false"
          aria-label="ADS config name"
          onchange={e => {
            const clean = sanitizeConfigName(e.currentTarget.value)
            e.currentTarget.value = clean
            onname?.(clean)
          }}
        />
        <span class="unit">.toml</span>
      </span>
      <span class="gap"></span>
    </div>
  </div>

  <div class="fr">
    <div>
      <div class="lab">Port</div>
      <div class="help">UDP port used with -port.</div>
    </div>
    <div class="ctlwrap">
      <span class="ctl">
        <input
          type="number"
          value={port}
          min="1"
          max="65535"
          step="1"
          aria-label="Port"
          onchange={e => setPort(e.currentTarget)}
        />
      </span>
      <span class="gap"></span>
    </div>
  </div>
</section>

<style>
  /* the width of a provenance dot, so these controls line up with the fields below */
  .gap { width: 18px; flex: none; }

  .grp { margin-bottom: 30px; }
</style>
