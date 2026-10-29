<template>
  <div v-if="open" class="opts" role="dialog" aria-label="Game options">
    <!--
      @keydown.stop / @keyup.stop — keep the keyboard away from the GAME.

      The engine registers its key listener on `window` in the BUBBLE
      phase (measured with CDP's DOMDebugger.getEventListeners). A key
      typed into the name field bubbles up to `window` and the engine's
      HUD_Key_Event runs its bind table: typing "seal" would walk the
      player forward on the "s", reload on the "e" and duck on the "l".

      `stopPropagation()` (not `preventDefault`) is the right tool: it
      stops the event BEFORE it reaches `window`, so the engine never
      sees it, and the input's own default action — putting the
      character in the field — still happens. `preventDefault()` would
      stop the character from being typed at all.

      The capture-phase `keydown` on the panel is the belt to that
      braces: a key pressed while the panel has focus but not in a
      field must not reach the engine either.
    -->
    <div
      class="opts__panel"
      @keydown.stop
      @keyup.stop
      @keypress.stop
    >
      <header class="opts__head">
        <div class="opts__brand">
          <span class="opts__brand-mark" aria-hidden="true" />
          <h2 class="opts__title">Options</h2>
        </div>
        <button class="opts__close" type="button" aria-label="Close" @click="closeOverlay">✕</button>
      </header>

      <!--
        THE FOCUS FIX (the bug: "typing in the input is not captured by
        the input").

        Measured against production on 2026-10-27: the DOM input was
        fine, and typing into it worked — but only AFTER a click. Open
        the overlay and type without clicking, and every keystroke went
        to <body> instead: the input never had focus, so the text went
        nowhere and the ENGINE ate the keys as game commands (a name
        containing "w" would walk the player forward).

        So the input is focused when the overlay opens, and the engine's
        view of the keyboard is suspended while it is open. The second
        half matters as much as the first: the engine's key listeners
        are on `window` (measured with CDP's DOMDebugger.getEventListeners
        — the engine registers keydown/keyup/keypress there), so a
        focused input does NOT stop the game from receiving the keys.
        `setBridgeSuspended` already exists for exactly this.
      -->
      <section class="opts__group">
        <h3 class="opts__legend">Identity</h3>
        <label class="opts__row">
          <span class="opts__label">Name</span>
          <input
            ref="nameInput"
            v-model="name"
            class="opts__input"
            type="text"
            maxlength="24"
            spellcheck="false"
            autocomplete="off"
            @keyup.enter="applyName"
          />
        </label>
        <button class="opts__btn" type="button" :disabled="!name.trim()" @click="applyName">
          Set name
        </button>

        <!--
          The character picker. TS's own options menu has one (the
          screenshot Kyle sent), and the models are the server's
          `mp_teammodels` list — see player-identity.ts for how the
          server treats a chosen model.
        -->
        <div class="opts__row opts__row--models">
          <span class="opts__label">Character</span>
          <div class="opts__models" role="group" aria-label="Character model">
            <button
              v-for="m in models"
              :key="m"
              class="opts__model"
              type="button"
              :class="{ 'opts__model--on': model === m }"
              :aria-pressed="model === m"
              @click="chooseModel(m)"
            >
              <!--
                The picture is the GAME'S OWN PORTRAIT: the .bmp that
                ships beside the model, with its flat backdrop made
                transparent so the character sits on the panel.

                It was a 3D render once. The renderer applied each
                bone's bind-pose world matrix to vertices that already
                carried their bind position, so the position was added
                twice: one gordon vertex moved 67.7 units on a 22-unit
                character, and the heads floated with the hands detached
                from the arms. The portrait is correct and it is free.
              -->
              <img
                class="opts__model-img"
                :src="`/models/${m}.png`"
                :alt="`${m} character preview`"
                width="72"
                height="72"
                loading="lazy"
              />
              <span class="opts__model-name">{{ m }}</span>
            </button>
          </div>
        </div>
        <p class="opts__note">
          The server picks the final model from your team's list — it is
          the one that decides who you spawn as.
        </p>
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

      <!--
        THE BUY MENU.

        Two menus, one set of loadouts. 'Classic' is the game's own
        canvas menu, drawn by the client library. 'Modern' is the DOM
        panel: it reads the game's own prices, budget and slot count
        from the port and sends the game's own key presses, so a
        purchase behaves exactly as it does in the classic menu.

        The saved loadouts are the game's (`tsbuylist.tsa`), so
        switching never forks what the player has bought.
      -->
      <section class="opts__group">
        <h3 class="opts__legend">Buy menu</h3>
        <div class="opts__row">
          <span class="opts__label">Buy menu</span>
          <div class="opts__switch" role="radiogroup" aria-label="Buy menu style">
            <button
              v-for="mode in buyMenuModes"
              :key="mode"
              class="opts__switch-btn"
              :class="{ 'opts__switch-btn--on': buyMenu === mode }"
              type="button"
              role="radio"
              :aria-checked="buyMenu === mode"
              @click="setBuyMenu(mode)"
            >
              {{ mode === 'classic' ? 'Classic' : 'Modern' }}
            </button>
          </div>
        </div>
        <p class="opts__note">
          Classic is the game's own canvas menu. Modern is a panel in the browser that reads
          the game's own prices. Both use the same saved loadouts.
        </p>
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
import { ref, watch, nextTick, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useXashStore } from '/@/stores/store.ts';
import { overlayOpen, closeOverlay } from '/@/services/escape-gate';
import { readCvar, writeCvar, runCommand } from '/@/services/engine-cvars';
import { logDebug } from '/@/services/debug-log';
import { setBridgeSuspended } from '/@/services/keyboard-bridge';
import { applyBuyMenuMode, type BuyMenuMode } from '/@/services/buy-menu';
import {
  TS_MODELS,
  applyModel,
  applyName as applyEngineName,
  displayName,
  engineModel,
  refreshIdentity,
} from '/@/services/player-identity';

const open = overlayOpen;

const name = ref('');
const model = ref('');
const sensitivity = ref<number | null>(null);
const fov = ref<number | null>(null);
const volume = ref<number | null>(null);

const models = TS_MODELS;
const nameInput = ref<HTMLInputElement | null>(null);

// The buy menu's style. It lives in the store (and is persisted), but
// it is NOT a cvar: it is the port's `ts_buy_hide` flag, a client
// library switch, so it never reaches the launch args.
const store = useXashStore();
const { tsConfig } = storeToRefs(store);
const buyMenuModes: BuyMenuMode[] = ['classic', 'modern'];
const buyMenu = computed<BuyMenuMode>(() =>
  tsConfig.value?.buyMenu === 'modern' ? 'modern' : 'classic',
);

/**
 * Switch the buy menu.
 *
 * The store keeps the choice; the port is told immediately, because a
 * player who switches to Modern expects the canvas menu to go away
 * now, not at the next session. The flag is idempotent, so repeating
 * it is harmless.
 */
function setBuyMenu(mode: BuyMenuMode): void {
  if (!tsConfig.value) return;
  tsConfig.value.buyMenu = mode;
  applyBuyMenuMode(mode);
  logDebug(`[opts] buy menu -> ${mode}`);
}

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

  // The identity, too: the field starts with the name the player is
  // actually playing under, and the picker shows the current model.
  await refreshIdentity();
  name.value = displayName.value;
  model.value = engineModel.value;
}

/**
 * Open the overlay with the keyboard in the right place.
 *
 * The focus is the fix for "typing in the input is not captured by the
 * input" (measured: without a click, every keystroke went to <body>).
 * `nextTick` waits for the field to exist before focusing it.
 */
watch(open, async (isOpen) => {
  if (!isOpen) {
    // Hand the keyboard back to the game.
    setBridgeSuspended(false);
    return;
  }
  // Take the keyboard away from the game: the engine's key listeners
  // are on `window`, so a focused DOM input does NOT stop the engine
  // from receiving the keys.
  setBridgeSuspended(true);
  void refresh();
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
});

function applySettings() {
  if (sensitivity.value !== null) writeCvar('sensitivity', sensitivity.value);
  if (fov.value !== null) writeCvar('fov', fov.value);
  if (volume.value !== null) writeCvar('volume', volume.value);
}

function toggleThirdPerson() {
  runCommand('thirdperson');
}

function applyName() {
  const n = name.value.trim();
  if (!n) return;
  if (applyEngineName(n)) {
    logDebug(`[opts] name set to "${n}"`);
  }
}

function chooseModel(m: string) {
  if (applyModel(m)) {
    model.value = m;
    logDebug(`[opts] model set to "${m}"`);
  }
}

/**
 * Leave the match and go back to the site.
 *
 * A full page load, not a state toggle: the engine's state lives in WASM
 * memory and on the server, and the honest way out of a match is to leave
 * it. The landing page is the site root.
 */
function quitToWebUi() {
  setBridgeSuspended(false);
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
  /* Above the HUD (1000) and the buy panel (1001): the overlay is a
     MODAL, and the panel can be open when the player reaches for the
     options (the game opens its own buy menu when the player becomes
     an observer). The panel's own toggle lives in here, so it has to
     be reachable. */
  z-index: 2000;

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

  &__brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
  }

  /* The BB mark, masked so it takes the accent colour. */
  &__brand-mark {
    width: 9px;
    height: 21px;
    flex: none;
    background-color: var(--ts-signal);
    -webkit-mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
    mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
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

    &:focus-visible {
      outline: none;
      border-color: var(--ts-signal);
      box-shadow: 0 0 0 1px var(--ts-signal);
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

    &--models {
      align-items: flex-start;
      flex-direction: column;
      gap: 0.4rem;
      margin-top: 0.7rem;
    }
  }

  &__label {
    font-size: 0.82rem;
    color: var(--ts-ink);
  }

  &__input {
    width: 9rem;
    padding: 0.28rem 0.45rem;
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(0, 255, 65, 0.25);
    color: var(--ts-ink-bright);
    font-family: var(--ts-font-mono);
    font-size: 0.82rem;

    /* A phosphor focus ring: the field's own colour plus a halo, so the
       focus is unmistakable without a browser-default blue outline. */
    &:focus {
      outline: none;
      border-color: var(--ts-signal);
      box-shadow: 0 0 0 1px var(--ts-signal), 0 0 12px rgba(0, 255, 65, 0.3);
    }

    &--num {
      width: 6rem;
    }
  }

  /* The character picker. A wrapped row of small buttons, so all seven
     models are visible without a dropdown that hides them. */
  &__models {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  &__model {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.5rem;
    background: rgba(0, 255, 65, 0.06);
    border: 1px solid rgba(0, 255, 65, 0.28);
    color: var(--ts-ink-muted);
    font-family: var(--ts-font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;

    &:hover {
      border-color: var(--ts-lime);
      color: var(--ts-ink);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--ts-signal);
      box-shadow: 0 0 0 1px var(--ts-signal);
    }

    &--on {
      background: rgba(0, 255, 65, 0.16);
      border-color: var(--ts-signal);
      color: var(--ts-ink-bright);
    }
  }

  // The character's own portrait, on transparent pixels.
  //
  // The game's portrait art has a flat grey backdrop, which is removed
  // so the character sits on the panel rather than on a grey card.
  // It is sized to the button, and `contain` keeps its aspect.
  //
  // `image-rendering` is `auto`, not `pixelated`: the portrait is
  // 164x200 and the box is 72px, so the nearest-neighbour downscale
  // threw away two thirds of it. The 3D render it replaced was square
  // and scaled cleanly, which is why it was `pixelated` then.
  &__model-img {
    display: block;
    width: 72px;
    height: 72px;
    object-fit: contain;
    image-rendering: auto;
    background: rgba(0, 0, 0, 0.35);
    border-radius: 2px;
  }

  &__model-name {
    line-height: 1;
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

  /* The Classic / Modern switch. Two states, so two buttons — the same
     shape as the character picker above, with the chosen one lit. */
  &__switch {
    display: inline-flex;
    border: 1px solid rgba(0, 255, 65, 0.28);
  }

  &__switch-btn {
    background: rgba(0, 0, 0, 0.35);
    border: none;
    border-right: 1px solid rgba(0, 255, 65, 0.18);
    color: var(--ts-ink-muted, #6fa67c);
    font-family: var(--ts-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.28rem 0.75rem;
    cursor: pointer;

    &:last-child {
      border-right: none;
    }

    &:hover {
      color: var(--ts-lime);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--ts-signal);
      box-shadow: 0 0 0 1px var(--ts-signal);
    }

    &--on {
      background: rgba(0, 255, 65, 0.16);
      color: var(--ts-ink-bright);
    }
  }
}
</style>
