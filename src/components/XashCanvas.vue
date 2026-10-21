<template>
  <div v-if="loading" class="loading"></div>
  <canvas
    ref="xashCanvasElement"
    id="canvas"
    class="emscripten"
    tabindex="0"
    @pointerdown="engageInput"
    oncontextmenu="event.preventDefault()"
  ></canvas>
  <TSHud />
</template>

<script setup lang="ts">
  import { storeToRefs } from 'pinia';
  import { useXashStore } from '/@/stores/store.ts';
  import { onMounted, ref } from 'vue';
  import TSHud from '/@/components/TSHud.vue';

  // Dependencies

  const store = useXashStore();
  const { loading, xashCanvas } = storeToRefs(store);

  // Data

  const xashCanvasElement = ref<HTMLCanvasElement>();

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

  onMounted(() => {
    xashCanvas.value = xashCanvasElement.value
  })
</script>

<style scoped lang="scss">
  .loading {
    position: absolute;
    height: 100%;
    width: 100%;
    background-repeat: no-repeat;
    background-position: center;
    background-image: url('../assets/hl-spin.svg');
    z-index: 9;
  }
</style>
