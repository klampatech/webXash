<template>
  <div v-if="open" class="opts" role="dialog" aria-label="Game options">
    <div class="opts__panel">
      <header class="opts__head">
        <h2 class="opts__title">Options</h2>
        <button class="opts__close" type="button" aria-label="Close" @click="closeOverlay">✕</button>
      </header>

      <section class="opts__group">
        <h3 class="opts__legend">Identity</h3>
        <label class="opts__row">
          <span class="opts__label">Name</span>
          <input
            v-model="name"
            class="opts__input"
            type="text"
            maxlength="24"
            spellcheck="false"
            @keyup.enter="applyName"
          />
        </label>
        <button class="opts__btn" type="button" :disabled="!name.trim()" @click="applyName">
          Set name
        </button>
      </section>

      <section class="opts__group">
        <h3 class="opts__legend">Controls</h3>
        <label class="opts__row">
          <span class="opts__label">Sensitivity</span>
          <input
            v-model.number="sensitivity"
            class="opts__input opts__input--num"
            type="number"
            min="0.1"
            max="20"
            step="0.1"
          />
        </label>
        <label class="opts__row">
          <span class="opts__label">Field of view</span>
          <input
            v-model.number="fov"
            class="opts__input opts__input--num"
            type="number"
            min="30"
            max="160"
            step="1"
          />
        </label>
        <label class="opts__row">
          <span class="opts__label">Volume</span>
          <input
            v-model.number="volume"
            class="opts__input opts__input--num"
            type="number"
            min="0"
            max="1"
            step="0.05"
          />
        </label>
        <button class="opts__btn" type="button" @click="applySettings">Apply</button>
      </section>

      <section class="opts__group">
        <h3 class="opts__legend">Camera</h3>
        <button class="opts__btn" type="button" @click="toggleThirdPerson">Toggle third person</button>
        <p class="opts__note">Third person needs you alive — spawn with a left click first.</p>
      </section>

      <section class="opts__group">
        <h3 class="opts__legend">Session</h3>
        <button class="opts__btn opts__btn--danger" type="button" @click="quitToWebUi">
          Quit to web UI
        </button>
        <p class="opts__note">
          Leaves the match and returns to the site. You can rejoin from the server list.
        </p>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { overlayOpen, closeOverlay } from '/@/services/escape-gate';
import { readCvar, writeCvar, runCommand } from '/@/services/engine-cvars';
import { logDebug } from '/@/services/debug-log';

const open = overlayOpen;

const name = ref('');
const sensitivity = ref<number | null>(null);
const fov = ref<number | null>(null);
const volume = ref<number | null>(null);

/** Load the current values from the engine when the overlay opens. */
async function refresh() {
  const [s, f, v] = await Promise.all([
    readCvar('sensitivity'),
    readCvar('fov'),
    readCvar('volume'),
  ]);
  if (s !== null) sensitivity.value = Number(s);
  if (f !== null) fov.value = Number(f);
  if (v !== null) volume.value = Number(v);
  logDebug(`[opts] loaded sensitivity=${s} fov=${f} volume=${v}`);
}

watch(open, (isOpen) => {
  if (isOpen) {
    void refresh();
  }
});

function applySettings() {
  if (sensitivity.value !== null) writeCvar('sensitivity', sensitivity.value);
  if (fov.value !== null) writeCvar('fov', fov.value);
  if (volume.value !== null) writeCvar('volume', volume.value);
}

function applyName() {
  const n = name.value.trim();
  if (!n) return;
  runCommand(`name "${n.replace(/"/g, '')}"`);
}

function toggleThirdPerson() {
  runCommand('thirdperson');
}

/**
 * Leave the match and go back to the site.
 *
 * A full page load, not a state toggle: the engine's state lives in WASM
 * memory and on the server, and the honest way out of a match is to leave
 * it. The landing page is the site root.
 */
function quitToWebUi() {
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }
  // Leave fullscreen as well: the landing page is a page to read and
  // click, not something to stare at edge to edge.
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  closeOverlay();
  window.location.href = '/';
}
</script>

<style scoped lang="scss">
.opts {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(1, 10, 4, 0.9);
  z-index: 30;

  &__panel {
    width: min(28rem, 92vw);
    max-height: 88vh;
    overflow-y: auto;
    padding: 1.1rem 1.2rem 1.3rem;
    background: var(--ts-panel, #06150a);
    border: 1px solid rgba(0, 255, 65, 0.3);
    box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.6);
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.9rem;
  }

  &__title {
    margin: 0;
    font-family: var(--ts-font-display);
    font-size: 1.1rem;
    letter-spacing: 0.08em;
    color: var(--ts-lime);
  }

  &__close {
    background: none;
    border: 1px solid rgba(0, 255, 65, 0.32);
    color: var(--ts-ink);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.1rem 0.4rem;

    &:hover {
      border-color: var(--ts-lime);
      color: var(--ts-lime);
    }
  }

  &__group {
    padding: 0.7rem 0 0.5rem;
    border-top: 1px solid rgba(0, 255, 65, 0.14);
  }

  &__legend {
    margin: 0 0 0.5rem;
    font-family: var(--ts-font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ts-signal);
  }

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
    margin-bottom: 0.45rem;
  }

  &__label {
    font-size: 0.82rem;
    color: var(--ts-ink);
  }

  &__input {
    width: 9rem;
    padding: 0.28rem 0.45rem;
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(204, 255, 51, 0.25);
    color: var(--ts-ink-bright);
    font-family: var(--ts-font-mono);
    font-size: 0.82rem;

    &:focus {
      outline: none;
      border-color: var(--ts-lime);
    }

    &--num {
      width: 6rem;
    }
  }

  &__btn {
    margin-top: 0.35rem;
    padding: 0.35rem 0.7rem;
    background: rgba(0, 255, 65, 0.08);
    border: 1px solid rgba(0, 255, 65, 0.32);
    color: var(--ts-ink-bright);
    font-family: var(--ts-font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: rgba(0, 255, 65, 0.18);
      border-color: var(--ts-lime);
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }

    &--danger {
      border-color: rgba(255, 92, 92, 0.5);
      color: #ffb4b4;

      &:hover:not(:disabled) {
        background: rgba(255, 92, 92, 0.16);
        border-color: #ff8b8b;
      }
    }
  }

  &__note {
    margin: 0.35rem 0 0;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--ts-ink-dim, rgba(220, 235, 210, 0.6));
  }
}
</style>
