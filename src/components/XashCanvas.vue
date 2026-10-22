<template>
  <div v-if="showLambda" class="lambda">
    <p class="lambda__label">{{ lambdaLabel }}</p>
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
</template>

<script setup lang="ts">
  import { storeToRefs } from 'pinia';
  import { useXashStore } from '/@/stores/store.ts';
  import {onMounted,onBeforeUnmount,ref, computed } from 'vue';
  import TSHud from '/@/components/TSHud.vue';
  import {
    startKeyboardBridge,
    tryAttachMouseBridge,
  } from '/@/services/keyboard-bridge.ts';
  import { logDebug } from '/@/services/debug-log.ts';
  import XashLoader from '/@/services/xash-loader.ts';

  // Dependencies

  const store = useXashStore();
  const { loading, xashCanvas, launching } = storeToRefs(store);

// The lambda spinner shows only after the themed boot screen has handed
// off, i.e. while the engine paints its first frames. It is ours, not the
// engine's — hl-spin.svg is a frontend asset behind the WASM canvas.
const showLambda = computed(() => !loading.value && launching.value);
const lambdaLabel = computed(() => 'Connecting to server');

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
  .lambda {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--ts-void, #000301);
    background-image: url('../assets/hl-spin.svg');
    background-repeat: no-repeat;
    background-position: center;
    z-index: 9;

    &__label {
      position: absolute;
      bottom: 14%;
      margin: 0;
      font-family: var(--ts-font-mono, monospace);
      font-size: 0.78rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--ts-signal, #ffaa00);
    }
  }
</style>
