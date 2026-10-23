<template>
  <div class="ts-landing" :class="{ 'ts-landing--loading': isStarting }">
    <!-- ambient backdrop -->
    <div class="ts-landing__bg" aria-hidden="true">
      <div class="ts-landing__grid" />
      <div class="ts-landing__glow" />
      <!-- The circular emblem. wiki_logo.jpg carries a large circular
           mass beneath the wordmark (verified by OCR); this rebuilds it
           in CSS rather than shipping their art. Two concentric rings
           plus radiating tick streaks — a targeting-dial reading. -->
      <div class="ts-landing__emblem" />
    </div>

    <div class="ts-landing__inner">
      <!-- masthead -->
      <header class="ts-landing__masthead">
        <div class="ts-landing__eyebrow">
          <span class="ts-landing__dot" aria-hidden="true" />
          Half-Life 1 · running in a browser
        </div>

        <h1 class="ts-landing__title">The Specialists</h1>

        <p class="ts-landing__tagline">
          Tactical deathmatch with the original ruleset — ported to
          WebAssembly, served from a dedicated server.
        </p>

        <!-- the one big thing to do -->
        <button
          class="ts-landing__play"
          :disabled="isStarting"
          @click="onPlay"
        >
          <span class="ts-landing__play-glyph" aria-hidden="true">▶</span>
          <span class="ts-landing__play-label">
            {{ isStarting ? 'Deploying…' : 'Play' }}
          </span>
        </button>
        <!--
          A launch that could not start says so, here. Failing silently
          is what made the first production bug take so long to find:
          the button did nothing visible and the reason was three layers
          down.
        -->
        <p v-if="launchError" class="ts-landing__error">{{ launchError }}</p>

        <div class="ts-landing__progress" :class="{ 'is-active': isStarting }">
          <div class="ts-landing__progress-bar" :style="{ width: downloadProgress + '%' }" />
          <span class="ts-landing__progress-text">
            {{ isStarting ? `Loading game data · ${downloadProgress}%` : '' }}
          </span>
        </div>

        <nav class="ts-landing__tabs" role="tablist">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="ts-landing__tab"
            :class="{ 'is-active': activeTab === tab.id }"
            role="tab"
            :aria-selected="activeTab === tab.id"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>
      </header>

      <!-- panels -->
      <div class="ts-landing__panel">
        <section
          v-show="activeTab === 'servers'"
          role="tabpanel"
          class="ts-landing__section"
        >
          <TSServerList @join="onJoinServer" />
        </section>

        <section
          v-show="activeTab === 'how'"
          role="tabpanel"
          class="ts-landing__section"
        >
          <TSHowToPlay />
        </section>
      </div>

      <footer class="ts-landing__foot">
        <span>Fan project · not affiliated with Valve or Half-Life</span>
        <span class="ts-landing__foot-links">
          <a href="https://www.tsmod.net/" target="_blank" rel="noreferrer noopener">TS Mod</a>
          <a href="https://github.com/x8BitRain/webXash" target="_blank" rel="noreferrer noopener">webXash</a>
          <a href="https://github.com/FWGS/xash3d-fwgs" target="_blank" rel="noreferrer noopener">Xash3D FWGS</a>
        </span>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useXashStore } from '/@/stores/store';
import { XashLoader } from '/@/services';
import {
  launchOptionsFor,
  resolveLaunchTarget,
  type TsServer,
} from '/@/services/ts-server-list.ts';
import setCanvasLoading, { clearCanvasLoading } from '/@/utils/setCanvasLoading.ts';
import TSServerList from '/@/components/TSServerList.vue';
import TSHowToPlay from '/@/components/TSHowToPlay.vue';

const tabs = [
  { id: 'servers', label: 'Servers' },
  { id: 'how', label: 'How It Works' },
] as const;

const activeTab = ref<(typeof tabs)[number]['id']>('servers');
const isStarting = ref(false);
// Why a launch could not start. Shown on the landing page rather than
// thrown away, because "nothing happened when I pressed Play" is the
// least debuggable failure there is.
const launchError = ref('');

const store = useXashStore();
const { xashCanvas, selectedGame, fullScreen, enableConsole, enableCheats, loadingProgress, customGameArg } =
  storeToRefs(store);
const { onStartLoading, onEndLoading, onBootPhase, onLaunching, refreshSavesList } = store;

const downloadProgress = computed(() => Math.round(loadingProgress.value));

/**
 * One launch path for both the big button and a server row.
 *
 * `options` overrides the URL/default launch options when given — that is
 * how a server row targets its own address instead of the default target.
 */
async function launch(options?: string) {
  if (!xashCanvas.value) {
    console.error('Canvas is not available');
    return;
  }

  // Resolve WHERE to connect BEFORE anything expensive happens.
  //
  // The address has to come from the server list, never from a
  // hard-coded default: the default in the store is a DEVELOPMENT
  // address, and from a browser that resolves to the player's own
  // machine. Finding that out after a 493 MB download and a full engine
  // boot is a terrible way to learn it.
  //
  // It also means PLAY and Join cannot disagree about where a player
  // goes, because they now resolve it the same way.
  let resolved = options;
  if (!resolved) {
    try {
      const target = await resolveLaunchTarget();
      if (!target) {
        launchError.value =
          'No servers answered. Check back in a moment — the fleet may be restarting.';
        return;
      }
      resolved = launchOptionsFor(target);
    } catch (e) {
      launchError.value =
        e instanceof Error ? e.message : 'Could not reach the server list.';
      return;
    }
  }

  launchError.value = '';
  isStarting.value = true;
  onLaunching(true);
  setCanvasLoading();

  // Take over the screen BEFORE the zip download, not just for the
  // engine boot. onStartLoading is otherwise only called inside
  // startGameWithZip, which meant the largest single wait — the mod zip —
  // played out on the landing page behind its own thin progress bar, and
  // the boot screen only appeared for the part after it.
  onStartLoading();
  onBootPhase({ phase: 'download', percent: 0 });

  // Fetch tsmod.zip from /hl/
  const zip = await XashLoader.downloadZip(
    'tsmod.zip',
    'hl/',
    (progress: number) => {
      loadingProgress.value = progress;
      onBootPhase({ phase: 'download', percent: progress });
    },
  );
  if (!zip) {
    alert('Could not load tsmod.zip!');
    onEndLoading();
    isStarting.value = false;
    return;
  }

  try {
    const xash = await XashLoader.startGameZip(zip, {
      // ?nocache=1 forces a genuinely cold zip download: skips the cache
      // read, skips the write, and evicts any stored entry.
      bypassZipCache: new URLSearchParams(location.search).get('nocache') === '1',
      canvas: xashCanvas.value,
      selectedGame: selectedGame.value,
      selectedZip: 'tsmod.zip',
      selectedLocalFolder: '',
      launchOptions: resolved,
      fullScreen: fullScreen.value,
      enableConsole: enableConsole.value,
      enableCheats: enableCheats.value,
      onStartLoading,
      onEndLoading,
      // Real phase boundaries from the loader, so the boot screen can
      // show indeterminate sweeps where there is no byte count.
      onPhase: onBootPhase,
      onProgress: (progress: any) => {
        loadingProgress.value =
          typeof progress === 'number' ? progress : progress.current;
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
    // Give the screen back, or the user is stranded staring at a loader
    // that will never advance.
    onEndLoading();
    alert(
      'Failed to start: ' + (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    isStarting.value = false;
    onLaunching(false);
    // The lambda spinner background was only ever added, never removed,
    // so it stayed on the canvas for the whole session. Invisible in-game
    // because the engine paints opaque pixels over it, but dead state.
    clearCanvasLoading();
  }
}

/**
 * PLAY — the pre-configured path.
 *
 * The target is resolved inside `launch()`, from the live server list.
 */
function onPlay() {
  launch();
}

/** Server row — target that server's address. */
function onJoinServer(server: TsServer) {
  launch(launchOptionsFor(server));
}

/**
 * Auto-launch after a reconnect.
 *
 * The CONNECTION LOST overlay reloads the page, and a reload drops the
 * player back on the landing page — which, read literally, is not a
 * reconnect. It is a "click Play again", and if the thing that broke was
 * the connect address, clicking Play again would break it again.
 *
 * `?autoplay=1` says: on load, go straight back in.
 */
onMounted(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('autoplay') === '1') {
    // Let the landing paint first, so the boot screen is what the player
    // sees rather than a blank frame.
    setTimeout(() => onPlay(), 60);
  }
});
</script>

<style scoped lang="scss">
.ts-landing {
  &__error {
    margin: 1rem auto 0;
    max-width: 34rem;
    text-align: center;
    font-family: var(--ts-font-mono, monospace);
    font-size: 0.78rem;
    line-height: 1.6;
    letter-spacing: 0.04em;
    color: var(--ts-signal, #ffaa00);
  }

  position: absolute;
  inset: 0;
  z-index: 10;
  overflow-y: auto;
  color: var(--ts-ink);
  /* Opaque on purpose: the game canvas sits at z-index 9 and paints
     hl.svg (the Half-Life lambda) as a centered background. Any alpha
     here lets it show through and collide with the server list. */
  background: var(--ts-void);
  pointer-events: auto;

  /* ---- backdrop ---- */
  &__bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  /* faint tactical grid — reads as a targeting overlay */
  &__grid {
    position: absolute;
    inset: -10%;
    background-image:
      linear-gradient(rgba(240, 110, 0, 0.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(240, 110, 0, 0.055) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(ellipse 80% 62% at 50% 34%, #000 25%, transparent 78%);
  }

  /* orange horizon glow behind the wordmark */
  &__glow {
    position: absolute;
    top: -22vh;
    left: 50%;
    width: min(1100px, 120vw);
    height: 62vh;
    transform: translateX(-50%);
    background: radial-gradient(
      ellipse at center,
      rgba(240, 110, 0, 0.2) 0%,
      rgba(240, 110, 0, 0.07) 38%,
      transparent 68%
    );
  }

  &__inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Never let a child shrink. .ts-landing is a fixed-height scroll
       container, so the default flex-shrink:1 crushes the PLAY button
       to its own padding height (measured: 16.8px 70.4px padding
       collapsing to a 34px box) the moment content exceeds the
       viewport. Overflow-y on the parent is what should scroll. */
    & > * {
      flex-shrink: 0;
    }
    justify-content: center;
    gap: clamp(1rem, 2.6vh, 1.9rem);
    width: 100%;
    max-width: 820px;
    min-height: 100%;
    margin: 0 auto;
    padding: clamp(1.5rem, 4vh, 3rem) 1.4rem 1.5rem;
  }

  /* the emblem: concentric rings + radiating ticks, behind the wordmark */
  &__emblem {
    position: absolute;
    top: 50%;
    left: 50%;
    width: min(620px, 92vw);
    aspect-ratio: 1;
    transform: translate(-50%, -46%);
    border: 2px solid rgba(166, 156, 122, 0.3);
    border-radius: 50%;
    pointer-events: none;

    /* inner ring, offset in rather than inset so it reads as depth */
    &::before {
      content: '';
      position: absolute;
      inset: 14px;
      border: 1px solid rgba(232, 236, 187, 0.2);
      border-radius: 50%;
    }

    /* radiating streaks — the tick marks on a dial */
    &::after {
      content: '';
      position: absolute;
      inset: -14px;
      border-radius: 50%;
      background: repeating-conic-gradient(
        from 0deg,
        rgba(166, 156, 122, 0.16) 0deg 1.2deg,
        transparent 1.2deg 15deg
      );
      /* keep the streaks outside the rings */
      mask: radial-gradient(
        circle at center,
        transparent 0 49.6%,
        #000 50.4% 100%
      );
    }
  }

  /* ---- masthead ---- */
  &__masthead {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  &__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--ts-font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ts-header);
  }

  /* live-ish pulse dot */
  &__dot {
    width: 6px;
    height: 6px;
    background: var(--ts-signal);
    box-shadow: 0 0 8px var(--ts-signal);
    animation: ts-pulse 2.4s var(--ts-ease) infinite;
  }

  &__title {
    margin: 0.5rem 0 0;
    font-family: var(--ts-font-display);
    font-size: clamp(3.1rem, 11vw, 5.6rem);
    font-weight: 700;
    line-height: 0.92;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ts-lime);
    text-shadow:
      0 0 34px rgba(240, 110, 0, 0.32),
      3px 3px 0 rgba(61, 58, 45, 0.9);
  }

  &__tagline {
    max-width: 46ch;
    margin: 0.85rem 0 0;
    font-size: 0.94rem;
    line-height: 1.6;
    color: var(--ts-ink);
  }

  /* ---- the big button ---- */
  &__play {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.85rem;
    margin-top: clamp(1.4rem, 3.5vh, 2.2rem);
    padding: 1.05rem 4.4rem;
    font-family: var(--ts-font-display);
    font-size: 1.65rem;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ts-void);
    background: linear-gradient(180deg, var(--ts-signal-hot) 0%, var(--ts-signal) 100%);
    border: none;
    /* chamfer matches the panels */
    height: auto; /* immune to any future global button height rule */
    clip-path: polygon(
      12px 0,
      100% 0,
      100% calc(100% - 12px),
      calc(100% - 12px) 100%,
      0 100%,
      0 12px
    );
    height: auto; /* immune to any future global button height rule */
    cursor: pointer;
    transition: transform 140ms var(--ts-ease), box-shadow var(--ts-sweep) var(--ts-ease);
    box-shadow: 0 0 0 rgba(240, 110, 0, 0);

    &:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 34px rgba(240, 110, 0, 0.42);
    }

    &:active:not(:disabled) {
      transform: translateY(0);
    }

    &:disabled {
      cursor: progress;
      opacity: 0.75;
    }
  }

  &__play-glyph {
    font-size: 1.15rem;
    line-height: 1;
  }

  &__play-label {
    /* optical: trim the trailing letter-spacing on the last glyph */
    margin-right: -0.2em;
  }

  /* ---- progress ---- */
  &__progress {
    width: min(340px, 80%);
    margin-top: 1rem;
    opacity: 0;
    transition: opacity var(--ts-sweep) var(--ts-ease);

    &.is-active {
      opacity: 1;
    }
  }

  &__progress-bar {
    height: 3px;
    background: var(--ts-signal);
    box-shadow: 0 0 10px rgba(240, 110, 0, 0.6);
    transition: width 220ms var(--ts-ease);
  }

  &__progress-text {
    display: block;
    margin-top: 0.45rem;
    font-family: var(--ts-font-mono);
    font-size: 0.74rem;
    letter-spacing: 0.1em;
    color: var(--ts-ink-muted);
  }

  /* ---- tabs ---- */
  &__tabs {
    display: flex;
    gap: 0;
    margin-top: clamp(1.2rem, 3vh, 2rem);
    border-bottom: 1px solid var(--ts-edge);
  }

  &__tab {
    position: relative;
    padding: 0.6rem 1.5rem;
    font-family: var(--ts-font-display);
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ts-header);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color var(--ts-sweep) var(--ts-ease);

    /* underline grows from the centre on active */
    &::after {
      content: '';
      position: absolute;
      left: 50%;
      bottom: -1px;
      width: 0;
      height: 2px;
      background: var(--ts-signal);
      transform: translateX(-50%);
      transition: width var(--ts-sweep) var(--ts-ease);
    }

    &:hover {
      color: var(--ts-khaki);
    }

    &.is-active {
      color: var(--ts-lime);

      &::after {
        width: 100%;
      }
    }
  }

  /* ---- panels ---- */
  &__panel {
    width: 100%;
  }

  /* ---- footer ---- */
  &__foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem 1.2rem;
    width: 100%;
    margin-top: 0.4rem;
    padding-top: 1.2rem;
    border-top: 1px solid var(--ts-edge);
    font-size: 0.72rem;
    color: var(--ts-ink-faint);
  }

  &__foot-links {
    display: flex;
    gap: 1rem;

    a {
      color: var(--ts-header);
      text-decoration: none;
      transition: color var(--ts-sweep) var(--ts-ease);

      &:hover {
        color: var(--ts-signal);
      }
    }
  }
}

@keyframes ts-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>