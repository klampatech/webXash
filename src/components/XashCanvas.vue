<template>
  <div v-if="showConnecting" class="connecting">
    <div class="connecting__mark" aria-hidden="true" />
    <p class="connecting__label">{{ connectingLabel }}</p>
  </div>
  <canvas
    ref="xashCanvasElement"
    id="canvas"
    class="emscripten"
    tabindex="0"
    @pointerdown="engageInput"
    oncontextmenu="event.preventDefault()"
  ></canvas>
  <!--
    The Vue HUD is hidden for now (D.7.37): its cash, timer and team pills
    are JS-simulated, so it shows values that do not match the live game
    state and it sits on top of the engine's own (correct) HUD. Toggle it
    back with ?hud=vue to A/B, or ?hud=engine to force it off.
  -->
  <TSHud v-if="showVueHud" />
  <!--
    The modern buy menu, when the player asked for it.

    It is its own mount because the HUD above is off by default: the
    panel is a MENU (it reads the game's own state and sends the
    game's own keys), not one of the HUD's simulated readouts, so it
    does not go dark with them.
  -->
  <TSHud v-else-if="showModernBuyPanel" buy-panel-only />
  <!--
    The options overlay: Escape #2 opens it. It is DOM, so the keyboard
    inside it is real DOM keyboard — a text field here types, it does not
    fire a game hotkey.
  -->
  <XashOptionsOverlay />
  <!--
    Shown when the transport to the game server goes away.

    The engine does not notice this on its own: a closed WebSocket just
    stops delivering packets, so the last frame stays on the canvas
    forever. A player left alone with that has no idea whether the game
    hung, their connection dropped, or they are supposed to wait. Saying
    so — and offering the one action that can actually help — is the
    difference between a bug and a message.
  -->
  <div v-if="connectionLost" class="lost">
    <div class="lost__panel">
      <p class="lost__title">CONNECTION LOST</p>
      <p class="lost__body">{{ connectionLostReason }}</p>
      <p class="lost__countdown">Reconnecting in {{ countdown }}s</p>
      <button class="lost__btn" @click="reconnect">Reconnect now</button>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { storeToRefs } from 'pinia';
  import { useXashStore } from '/@/stores/store.ts';
  import {onMounted,onBeforeUnmount,ref, computed, watch } from 'vue';
  import TSHud from '/@/components/TSHud.vue';
  import XashOptionsOverlay from '/@/components/XashOptionsOverlay.vue';
  import { notePointerLocked } from '/@/services/escape-gate';
  import {
    startKeyboardBridge,
    tryAttachMouseBridge,
  } from '/@/services/keyboard-bridge.ts';
  import { logDebug } from '/@/services/debug-log.ts';
  import XashLoader from '/@/services/xash-loader.ts';

  // Dependencies

  const store = useXashStore();
  const { loading, xashCanvas, launching, connectionLost, connectionLostReason, tsConfig } =
    storeToRefs(store);

  /**
   * Reconnect = reload the page.
   *
   * There is no cheaper option. The engine's state — the map, the
   * player, the round — lives in the server and in WASM memory that a
   * reload discards; the browser would have to re-establish the socket
   * and re-run the whole handshake against a server that no longer knows
   * this client. A reload is the honest "try again", and the archive is
   * cached in IndexedDB, so it is quick.
   */
  function reconnect() {
    // `autoplay=1` puts the player straight back into a game on reload.
    // A plain reload drops them on the landing page, which read
    // literally is not a reconnect — it is "click Play again", and if
    // the thing that broke was the connect address, clicking Play
    // again would break it again.
    //
    // The app's "are you sure you want to leave?" guard has to come
    // off first: it fires on this navigation too, and the browser's
    // confirmation dialog would stand between the player and the
    // recovery (and in some browsers it silently cancels the
    // navigation, leaving them on the frozen screen).
    XashLoader.allowUnload();
    const url = new URL(window.location.href);
    url.searchParams.set('autoplay', '1');
    window.location.href = url.toString();
  }

  /**
   * Count down and reconnect on our own.
   *
   * A player staring at a frozen screen needs to click something to be
   * told what to do, and most will not. The server is coming back in
   * about a minute, so the useful thing to do is wait it out and put
   * them straight back in.
   */
  const RECONNECT_SECONDS = 12;
  const countdown = ref(RECONNECT_SECONDS);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  watch(connectionLost, (lost) => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    if (!lost) return;
    countdown.value = RECONNECT_SECONDS;
    countdownTimer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0) {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
        reconnect();
      }
    }, 1000);
  });

  onBeforeUnmount(() => {
    if (countdownTimer) clearInterval(countdownTimer);
  });

// The connecting splash shows only after the themed boot screen has
// handed off, i.e. while the engine paints its first frames.
//
// It used to be Valve's spinning Half-Life lambda. That was our own
// frontend asset behind the WASM canvas, not the engine's — but it was
// still Valve's logo in our product, and a fan project shipping the
// publisher's mark is a licence-posture problem as well as a brand one.
// It is the BulletBallet mark now.
const showConnecting = computed(() => !loading.value && launching.value);
const connectingLabel = computed(() => 'Connecting to server');

  // Data

  const xashCanvasElement = ref<HTMLCanvasElement>();

  /**
   * The Vue HUD is off unless explicitly asked for. Its values are
   * JS-simulated (see TSHud.vue), so while the real client is live it
   * contradicts the engine's own HUD. `?hud=vue` brings it back for an
   * A/B; anything else hides it.
   */
  const showVueHud =
    new URLSearchParams(window.location.search).get('hud') === 'vue';

  /**
   * The modern buy menu's own mount.
   *
   * The player chooses the menu in the ESC options overlay, and the
   * choice is persisted, so this is read from the store rather than
   * from the URL. `?nohud=1` is the isolation switch for the
   * keyboard: the panel takes keys from the game, so it stays out of
   * that test too.
   */
  const modernBuyMenu = computed(() => tsConfig.value?.buyMenu === 'modern');
  const hudIsolation =
    new URLSearchParams(window.location.search).get('nohud') === '1';
  const showModernBuyPanel = computed(
    () => modernBuyMenu.value && !hudIsolation,
  );

  /**
   * Focus the canvas and grab pointer lock on first press.
   *
   * Both are required for engine input and neither happens on their own:
   *
   *  - Without `tabindex` the canvas is not focusable, so
   *    `document.activeElement` stays `<body>` and keyboard events never
   *    reach the WASM module. The player can't press W/A/S/D.
   *
   *  - Pointer lock has to be requested from inside a user gesture.
   *    Browsers reject it from a timer or a promise chain, and xash's
   *    engine calls `emscripten_request_pointerlock` from C, which is
   *    never a gesture context. Doing it here — on the DOM pointerdown
   *    — is the only place it reliably succeeds. Without lock the
   *    engine gets absolute mouse coordinates instead of relative
   *    deltas, so look-aim is unusable.
   *
   * Buy-menu open/close still re-balances lock in TSHud's
   * `syncPointerLock()`; this just establishes the baseline.
   */
  function engageInput() {
    const canvas = xashCanvasElement.value
    if (!canvas) return
    canvas.focus()
    // Re-engaging the game restarts the Escape sequence: the next Escape
    // releases the mouse again rather than opening the overlay.
    notePointerLocked()
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.().catch(() => {
        // Rejection just means the next click will do it.
      })
    }
    // Single line on every canvas pointer-down. Distinguishes
    // "click never reached the canvas DOM" from "click reached the
    // canvas but the engine dropped it" in one round. Cheap enough
    // to keep on permanently — keeps the console legible because it
    // only fires on a real press.
    console.log(
      '[bridge-input] canvas pointerdown activeEl=',
      document.activeElement?.id ?? document.activeElement?.tagName ?? null,
      'lock=',
      document.pointerLockElement?.id ?? 'free'
    )
  }

  // Hooks

  /**
   * Input bridge installation.
   *
   * D.7.37: this used to live in TSHud.vue's onMounted, which meant
   * hiding the Vue HUD (`?hud=engine`, the default now) silently
   * disabled ALL keyboard and mouse-button input. Input is not the HUD's
   * job, so it is installed here instead — the component that owns the
   * canvas.
   *
   * `?nohud=1` still skips it, for the isolation test that tells us
   * whether the HUD is implicated in any remaining input problem.
   */
  let stopKeyboardBridge: (() => void) | null = null;

  onMounted(() => {
    if (new URLSearchParams(window.location.search).get('nohud') !== '1') {
      // `give` and friends are gated behind sv_cheats; TS's own rules
      // enable it anyway (TSGameRules.enabledCheats).
      XashLoader.exec('sv_cheats 1');
      stopKeyboardBridge = startKeyboardBridge();
      tryAttachMouseBridge();
      logDebug('[input] keyboard + mouse bridges installed');
    } else {
      logDebug('[input] ?nohud=1 — input bridges NOT installed');
    }
  });

  onBeforeUnmount(() => {
    stopKeyboardBridge?.();
    stopKeyboardBridge = null;
  });

  onMounted(() => {
    xashCanvas.value = xashCanvasElement.value;
  });
</script>

<style scoped lang="scss">
  .lost {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(1, 10, 4, 0.94);
    z-index: 20;

    &__panel {
      text-align: center;
      padding: 2rem 2.5rem;
      border: 1px solid rgba(255, 92, 92, 0.4);
      background: rgba(1, 10, 4, 0.88);
      max-width: 30rem;
    }

    &__title {
      margin: 0 0 0.75rem;
      font-family: var(--ts-font-mono, monospace);
      font-size: 1.05rem;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--ts-error, #ff5c5c);
    }

    &__body {
      margin: 0 0 1.5rem;
      font-family: var(--ts-font-mono, monospace);
      font-size: 0.8rem;
      line-height: 1.5;
      letter-spacing: 0.04em;
      color: rgba(216, 255, 226, 0.78);
    }

    &__countdown {
      margin: 0 0 1.25rem;
      font-family: var(--ts-font-mono, monospace);
      font-size: 0.72rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(216, 255, 226, 0.5);
    }

    &__btn {
      font-family: var(--ts-font-mono, monospace);
      font-size: 0.78rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ts-error, #ff5c5c);
      background: transparent;
      border: 1px solid var(--ts-error, #ff5c5c);
      padding: 0.6rem 1.6rem;
      cursor: pointer;

      &:hover {
        background: rgba(255, 92, 92, 0.14);
      }
    }
  }

  .connecting {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2.2rem;
    background: var(--ts-void, #010a04);
    z-index: 9;

    /* The BB mark, masked so it takes the accent colour. */
    &__mark {
      height: clamp(96px, 18vh, 168px);
      aspect-ratio: 200 / 460;
      background-color: var(--ts-signal);
      -webkit-mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
      mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
      animation: bb-breathe 2.8s var(--ts-ease) infinite;
    }

    &__label {
      margin: 0;
      font-family: var(--ts-font-mono, monospace);
      font-size: 0.78rem;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--ts-warn, #ffc44d);
    }
  }
@keyframes bb-breathe {
  0%,
  100% {
    opacity: 1;
    filter: drop-shadow(0 0 18px rgba(0, 255, 65, 0.55));
  }
  50% {
    opacity: 0.55;
    filter: drop-shadow(0 0 34px rgba(0, 255, 65, 0.25));
  }
}
</style>
