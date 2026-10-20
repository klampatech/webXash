import { computed, onMounted, ref } from 'vue';
import { SaveManager } from '/@/services';
import { defineStore } from 'pinia';
import { type SaveEntry } from '/@/services/save-manager.ts';
import { DEFAULT_GAME_DIR } from '/@/services/save-manager.ts';
import { GAME_SETTINGS } from '/@/services/xash-loader.ts';

export const useXashStore = defineStore(
  'xash',
  () => {
    // State
    const xashCanvas = ref<HTMLCanvasElement>();
    const selectedGameKey = ref<keyof typeof GAME_SETTINGS>('TS');
    const selectedZip = ref('');
    const selectedLocalFolder = ref('');
    // multiplayerIP is set by XashMultiplayerIP.vue before launch.
    // XashLoader picks it up at game-init time and routes through
    // Xash3DWebRTC (signaling server) when non-empty.
    const multiplayerIP = ref('');
    const saves = ref<Partial<SaveEntry>[]>();
    const loading = ref(false);
    const loadingProgress = ref(1);
    const maxLoadingAmount = ref(100);
    const showXashSettingUI = ref(true);
    // -- Launch options
    // Default to TS game launchArgs + 4 bots. xash.wasm heap cap was
    // raised from 256MB → 2GB (D.7.13, wasm memory section patched
    // initial=4096 max=4096 → initial=4096 max=32768), so 4 bots
    // fits comfortably. Override in the Advanced panel for solo
    // (0) or fuller counts (8+ at your own risk).
    // D.7.18: reorder fixes an engine argv-parser quirk where cvar
    // values after `+map <name>` consume the map name (Usage: map
    // <mapname> error). Putting cvars first lets the engine process
    // them, then `+map ts_apartments` cleanly captures the map name.
    // Override in the Advanced panel.
    const launchOptions = ref('bot_quota 2 -game ts +map ts_apartments');
    const fullScreen = ref(false);
    const enableConsole = ref(true);
    const enableCheats = ref(false);

    // Methods

    const onStartLoading = () => {
      loading.value = true;
      loadingProgress.value = 0;
    };

    const onEndLoading = () => {
      loading.value = false;
      showXashSettingUI.value = false;
    };

    const refreshSavesList = async () => {
      const saveEntries = await SaveManager.listSaves();

      // Throw away the game data for now just to save on memory.
      for (const file of saveEntries) {
        if (file.data) {
          for (const saveData of file.data) {
            saveData.data = new Uint8Array();
          }
        }
      }

      saves.value = saveEntries;
    };

    // Computed

    const selectedGame = computed(() => {
      return GAME_SETTINGS[selectedGameKey.value];
    });

    const customGameArg = computed((): string => {
      // This regex should return two groups if it detects:
      // Group 0 (full match): -game blueshift
      // Group 1: blueshift (the word after -game)
      const customGameSearch = launchOptions.value?.match(
        /-game\s+(\S+)(?!.*-game\s+\S+)/,
      );
      if (customGameSearch && customGameSearch.length === 2) {
        return customGameSearch[1];
      } else if (selectedLocalFolder.value) {
        return selectedLocalFolder.value;
      } else {
        return DEFAULT_GAME_DIR;
      }
    });

    // Hooks

    onMounted(async () => {
      // Getting Save Data from IDB
      await refreshSavesList();
    });

    return {
      // Data
      xashCanvas,
      selectedGameKey,
      selectedZip,
      selectedLocalFolder,
      multiplayerIP,
      saves,
      loading,
      loadingProgress,
      maxLoadingAmount,
      showXashSettingUI,
      launchOptions,
      fullScreen,
      enableConsole,
      enableCheats,
      // Computed
      selectedGame,
      customGameArg,
      // Methods
      onStartLoading,
      onEndLoading,
      refreshSavesList,
    };
  },
  {
    persist: {
      pick: [
        'selectedGameKey',
        'selectedZip',
        'multiplayerIP',
        'selectedLocalFolder',
        'launchOptions',
        'fullScreen',
        'enableConsole',
        'enableCheats',
      ],
    },
  },
);
