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
    const launchOptions = ref('-noip -noip6 bot_quota 2 -game ts +map ts_apartments');

    // -- TS-specific launcher config (D.7.26 — JS-side parity layer)
    // TS-specific cvars that the engine reads from the launcher's argv
    // before server.cfg, allowing the user to override defaults set in
    // ts/server.cfg (slowmatch=1, roundtime=180, mp_teamlist="...").
    //
    // The launcher splices these into launchOptions when -game ts is
    // active, BEFORE +map, so the engine sees them at engine startup.
    const tsConfig = ref({
      // Round duration in seconds. Default in ts/server.cfg is 180.
      roundtime: 180,
      // 1 = slow-motion death sequences (TS signature feature).
      // 0 = full-death normal speed.
      slowmatch: 1,
      // Per-team model list (pipe-separated).
      teammodels: 'seal;merc|gordon;laurence|agent|hitman;castor',
      // Round timer / cash HUD overlay visibility (DOM layer).
      hudOverlay: true,
      // 1 = Last-Man-Standing game mode (only player alive wins).
      lastmanstanding: 0,
      // Spectator chat / killfeed rendered in launcher overlay.
      killfeedOverlay: true,
    });

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

    // D.7.26: TS-spliced launch args. When -game ts is active, splice
    // the user's tsConfig cvars BEFORE +map so they reach the engine's
    // argv parser and don't displace the map name (D.7.18 quirk).
    const effectiveLaunchOptions = computed((): string => {
      const base = launchOptions.value ?? '';
      if (!tsConfig.value) return base;
      // Only splice for TS game
      const isTS = /-game\s+ts\b/.test(base);
      if (!isTS) return base;
      const cvars: string[] = [];
      if (tsConfig.value.roundtime) {
        cvars.push(`+roundtime ${tsConfig.value.roundtime}`);
      }
      if (tsConfig.value.slowmatch !== undefined) {
        cvars.push(`+slowmatch ${tsConfig.value.slowmatch}`);
      }
      if (tsConfig.value.lastmanstanding) {
        cvars.push(`+lastmanstanding ${tsConfig.value.lastmanstanding}`);
      }
      if (tsConfig.value.teammodels) {
        cvars.push(`+mp_teammodels "${tsConfig.value.teammodels}"`);
      }
      if (cvars.length === 0) return base;
      // Splice before +map if present
      const idx = base.indexOf('+map');
      if (idx >= 0) {
        return `${base.slice(0, idx)} ${cvars.join(' ')} ${base.slice(idx)}`.trim();
      }
      return `${base} ${cvars.join(' ')}`.trim();
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
      effectiveLaunchOptions,
      tsConfig,
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
