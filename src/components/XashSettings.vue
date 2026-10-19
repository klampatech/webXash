<template>
  <div class="xash-settings">
    <!-- Hero launcher — TS only -->
    <div v-if="!loading" class="xash-launcher">
      <div class="xash-launcher__hero">
        <h1 class="xash-launcher__title">The Specialists</h1>
        <p class="xash-launcher__subtitle">
          Half-Life mod running natively in your browser via Xash3D FWGS
        </p>

        <button
          class="xash-launcher__play"
          :disabled="isStarting"
          @click="onStartTS"
        >
          <span v-if="!isStarting">▶ Play</span>
          <span v-else>Loading…</span>
        </button>

        <div v-if="isStarting && downloadProgress > 0" class="xash-launcher__progress">
          Downloading tsmod.zip… {{ downloadProgress }}%
        </div>
      </div>

      <!-- Advanced — collapsible -->
      <details class="xash-launcher__advanced">
        <summary>Advanced</summary>
        <XashLaunchOptions />
        <XashMultiplayerIP />
      </details>

      <Attribution />
    </div>

    <!-- Loading screen -->
    <XashLoading v-if="loading" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useXashStore } from '/@/stores/store';
import { XashLoader } from '/@/services';
import setCanvasLoading from '/@/utils/setCanvasLoading.ts';
import XashLaunchOptions from '/@/components/XashLaunchOptions.vue';
import XashMultiplayerIP from '/@/components/XashMultiplayerIP.vue';
import XashLoading from '/@/components/XashLoading.vue';
import Attribution from '/@/components/Attribution.vue';

const store = useXashStore();
const {
  loading,
  xashCanvas,
  selectedGame,
  launchOptions,
  fullScreen,
  enableConsole,
  enableCheats,
  loadingProgress,
  customGameArg,
} = storeToRefs(store);
const { onStartLoading, onEndLoading, refreshSavesList } = store;

const isStarting = ref(false);

// downloadProgress is 0-100, derived from the global loading bar.
const downloadProgress = computed(() => Math.round(loadingProgress.value));

const onStartTS = async () => {
  if (!xashCanvas.value) {
    console.error('Canvas is not available');
    return;
  }
  isStarting.value = true;
  setCanvasLoading();

  // Fetch tsmod.zip from /hl/
  const zip = await XashLoader.downloadZip(
    'tsmod.zip',
    'hl/',
    (progress: number) => {
      loadingProgress.value = progress;
    },
  );
  if (!zip) {
    alert('Could not load tsmod.zip!');
    isStarting.value = false;
    return;
  }

  try {
    const xash = await XashLoader.startGameZip(zip, {
      canvas: xashCanvas.value,
      selectedGame: selectedGame.value,
      selectedZip: 'tsmod.zip',
      selectedLocalFolder: '',
      launchOptions: launchOptions.value,
      fullScreen: fullScreen.value,
      enableConsole: enableConsole.value,
      enableCheats: enableCheats.value,
      onStartLoading,
      onEndLoading,
      onProgress: (progress: any) => {
        if (typeof progress === 'number') {
          loadingProgress.value = progress;
        } else {
          loadingProgress.value = progress.current;
        }
      },
    });

    await XashLoader.onAfterLoad({
      xash,
      selectedGame: selectedGame.value,
      customGameArg: customGameArg.value,
      enableCheats: enableCheats.value,
    });

    await XashLoader.initConsoleCallbacks(xash, []);

    await refreshSavesList();
  } catch (error) {
    console.error('Failed to start game:', error);
    alert(
      'Failed to start: ' + (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    isStarting.value = false;
  }
};
</script>

<style scoped lang="scss">
.xash-settings {
  width: 100%;
  height: 100%;
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none; /* let canvas get clicks when game running */
}

.xash-launcher {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 480px;
  width: 90%;
  padding: 2rem;
  background: rgba(0, 0, 0, 0.85);
  border-radius: 8px;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

  &__hero {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: center;
    text-align: center;
  }

  &__title {
    font-size: 2.5rem;
    margin: 0;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  &__subtitle {
    margin: 0;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.9rem;
  }

  &__play {
    margin-top: 1.5rem;
    padding: 1rem 3rem;
    font-size: 1.5rem;
    font-weight: 700;
    background: #c4302b;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.1s ease;

    &:hover:not(:disabled) {
      background: #d63b35;
      transform: translateY(-1px);
    }

    &:active:not(:disabled) {
      transform: translateY(0);
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  }

  &__progress {
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.7);
  }

  &__advanced {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    padding: 0.75rem;

    summary {
      cursor: pointer;
      font-size: 0.85rem;
      color: rgba(255, 255, 255, 0.7);
      user-select: none;
    }
  }
}
</style>