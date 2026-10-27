<template>
  <div class="window no-resize" name="Launch Options">
    <div class="box">
      <div class="options">
        <label for="fullscreen">
          <input
            id="fullscreen"
            v-model="fullScreen"
            name="fullscreen"
            type="checkbox"
          />
          Fullscreen
        </label>
        <label for="cheats">
          <input
            id="cheats"
            v-model="enableCheats"
            name="cheats"
            type="checkbox"
          />
          sv_cheats 1
        </label>
        <label for="console">
          <input
            id="console"
            v-model="enableConsole"
            name="console"
            type="checkbox"
          />
          Console
        </label>

        <!--
          THE RENDER RESOLUTION.

          The engine draws at the browser viewport's resolution, and the
          frame cost is the pixel count. Measured against production on
          2026-10-28:

              viewport      engine render res   engine frames/s
              640x480       640x480             69.5
              1280x720      1280x720            30.2
              1920x1080     1920x1080            8.6
              2560x1440     2560x1440            4.5

          So going fullscreen on a 1440p display is a 4x hit. The
          browser upscales the canvas for free (the canvas is
          `width: 100vw; height: 100vh`), so rendering smaller and
          letting the browser scale it up is the trade every modern
          game makes.
        -->
        <label class="opt-resolution" for="render-resolution">
          <span class="opt-label">Render resolution</span>
          <select
            id="render-resolution"
            v-model="renderResolution"
            name="render-resolution"
          >
            <option v-for="choice in choices" :key="choice" :value="choice">
              {{ labelFor(choice) }}
            </option>
          </select>
          <span class="opt-help">
            Engine draws {{ effectiveRender }}; the browser scales it to
            the window.
          </span>
        </label>
      </div>
      <input v-model="launchOptions" class="xash-launch-options" type="text" />

      <!-- D.7.26 TS-specific cvars panel -->
      <!-- Shown only when selectedGameKey is "TS" so the launcher adapts -->
      <div v-if="selectedGameKey === 'TS'" class="ts-opts">
        <h3>THE SPECIALISTS — Game Options</h3>
        <div class="ts-opts__grid">
          <label>
            <span class="opt-label">Round time</span>
            <input
              v-model.number="tsConfig.roundtime"
              class="opt-num"
              type="number"
              min="60"
              max="900"
              step="30"
            />
            <span class="opt-unit">sec</span>
          </label>
          <label>
            <span class="opt-label">Slow-match</span>
            <input
              id="ts-slowmatch"
              v-model.number="tsConfig.slowmatch"
              type="checkbox"
              :true-value="1"
              :false-value="0"
            />
            <span class="opt-help">Slow-mo deaths</span>
          </label>
          <label>
            <span class="opt-label">Last man standing</span>
            <input
              id="ts-lms"
              v-model.number="tsConfig.lastmanstanding"
              type="checkbox"
              :true-value="1"
              :false-value="0"
            />
          </label>
          <label>
            <span class="opt-label">HUD overlay</span>
            <input
              id="ts-hud"
              v-model="tsConfig.hudOverlay"
              type="checkbox"
            />
            <span class="opt-help">Cash / class / buy</span>
          </label>
          <label>
            <span class="opt-label">Killfeed overlay</span>
            <input
              id="ts-kf"
              v-model="tsConfig.killfeedOverlay"
              type="checkbox"
            />
          </label>
          <label class="ts-opts__models">
            <span class="opt-label">Per-team models</span>
            <input
              v-model="tsConfig.teammodels"
              class="opt-text"
              type="text"
            />
            <span class="opt-help">(pipe-separated)</span>
          </label>
        </div>

        <div class="ts-opts__launch">
          <span class="opt-label">Effective launch args:</span>
          <code class="ts-opts__preview">{{ effectiveArgs }}</code>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue';
  import { storeToRefs } from 'pinia';
  import { useXashStore } from '/@/stores/store';
  import {
    RESOLUTION_CHOICES,
    describeResolutionChoice,
    detectDisplay,
    resolveRenderResolution,
    type ResolutionChoice,
  } from '/@/services/video-settings.ts';

  const store = useXashStore();
  const {
    launchOptions,
    fullScreen,
    enableConsole,
    enableCheats,
    renderResolution,
    selectedGameKey,
    tsConfig,
  } = storeToRefs(store);

  // The display, read once: it cannot change without the player moving
  // the window to another monitor, and re-reading it on every render
  // would be noise.
  const display = detectDisplay();
  const choices = RESOLUTION_CHOICES;

  const labelFor = (choice: ResolutionChoice) =>
    describeResolutionChoice(choice, display);

  const effectiveRender = computed(() => {
    const res = resolveRenderResolution(renderResolution.value, display);
    return `${res.width}\u00d7${res.height}`;
  });

  // Build the effective launch string by splicing TS cvars into the base
  // options. The cvar splice happens BEFORE +map so the engine's argv
  // parser doesn't consume the map name (D.7.18 quirk).
  const effectiveArgs = computed(() => {
    const base = launchOptions.value ?? '';
    const tsCvars: string[] = [];
    if (tsConfig.value?.roundtime) tsCvars.push(`+roundtime ${tsConfig.value.roundtime}`);
    if (tsConfig.value?.slowmatch !== undefined) tsCvars.push(`+slowmatch ${tsConfig.value.slowmatch}`);
    if (tsConfig.value?.lastmanstanding) tsCvars.push(`+lastmanstanding ${tsConfig.value.lastmanstanding}`);
    if (tsConfig.value?.teammodels) tsCvars.push(`+mp_teammodels "${tsConfig.value.teammodels}"`);
    if (tsCvars.length === 0) return base;
    // Splice before +map if present
    const idx = base.indexOf('+map');
    if (idx >= 0) {
      return `${base.slice(0, idx)} ${tsCvars.join(' ')} ${base.slice(idx)}`.trim();
    }
    return `${base} ${tsCvars.join(' ')}`.trim();
  });
</script>

<style scoped lang="scss">
  .xash-launch-options {
    width: 100%;
  }

  .options {
    display: flex;
    flex-direction: column;
    margin-bottom: 16px;

    label {
      cursor: pointer;
    }

    .opt-resolution {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      margin-top: 10px;
    }

    select {
      background: rgba(0, 0, 0, 0.5);
      color: #f4e3b0;
      border: 1px solid rgba(190, 140, 40, 0.55);
      border-radius: 3px;
      padding: 3px 6px;
      font-family: var(--ts-font-mono, monospace);
      font-size: 11px;
    }
  }

  /* TS-specific config block — D.7.26 parity layer */
  .ts-opts {
    margin-top: 16px;
    padding: 14px;
    background: linear-gradient(180deg, rgba(60,40,0,0.4), rgba(20,10,0,0.6));
    border: 1px solid rgba(190,140,40,0.55);
    border-radius: 4px;

    h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      letter-spacing: 2px;
      color: #ffd76e;
      border-bottom: 1px solid rgba(190,140,40,0.3);
      padding-bottom: 6px;
    }
  }

  .ts-opts__grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 14px;
  }

  .ts-opts__grid label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #f4e3b0;
  }
  .ts-opts__models {
    grid-column: 1 / -1;
    flex-direction: column !important;
    align-items: flex-start !important;
    gap: 4px;
  }

  .opt-label {
    color: rgba(255,215,110,0.7);
    letter-spacing: 0.5px;
    flex-shrink: 0;
    min-width: 110px;
  }
  .opt-num { width: 60px; }
  .opt-text { width: 100%; padding: 2px 4px; font-family: monospace; }
  .opt-unit {
    color: rgba(255,215,110,0.5);
    font-size: 10px;
  }
  .opt-help {
    color: rgba(255,215,110,0.45);
    font-size: 10px;
    font-style: italic;
  }

  .ts-opts__launch {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid rgba(190,140,40,0.25);
  }
  .ts-opts__preview {
    display: block;
    margin-top: 4px;
    padding: 6px 8px;
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(190,140,40,0.2);
    color: #ffd76e;
    font-family: monospace;
    font-size: 11px;
    word-break: break-all;
    user-select: all;
  }
</style>
