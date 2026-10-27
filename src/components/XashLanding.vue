<template>
  <div class="ts-landing" :class="{ 'ts-landing--loading': isStarting }">
    <!-- fixed top bar -->
    <div class="ts-landing__topbar">
      <span class="ts-landing__status">
        <span class="ts-landing__status-dot" aria-hidden="true" />
        {{ liveStatus }}
      </span>
      <span class="ts-landing__topbar-right">
        <span class="ts-landing__topbar-live">Live</span>
      </span>
    </div>

    <!-- the stage: the code rain, the grid, the glow, the emblem -->
    <div class="ts-landing__bg" aria-hidden="true">
      <div class="ts-landing__rain">
        <span v-for="(strip, i) in rainStrips" :key="i" :style="rainStyle(strip, i)" />
      </div>
      <div class="ts-landing__grid" />
      <div class="ts-landing__glow" />
      <div class="ts-landing__emblem" />
    </div>

    <div class="ts-landing__inner">
      <!-- nav -->
      <nav class="ts-landing__nav">
        <div class="ts-landing__brand">
          <span class="ts-landing__brand-mark" aria-hidden="true" />
          <span class="ts-landing__brand-name">
            Bullet<span>Ballet</span>
          </span>
        </div>
        <div class="ts-landing__nav-links">
          <a href="https://www.tsmod.net/" target="_blank" rel="noreferrer noopener">TS Mod</a>
          <a href="https://github.com/x8BitRain/webXash" target="_blank" rel="noreferrer noopener">webXash</a>
          <a href="https://github.com/FWGS/xash3d-fwgs" target="_blank" rel="noreferrer noopener">Xash3D FWGS</a>
        </div>
      </nav>

      <!-- hero -->
      <header class="ts-landing__hero">
        <div class="ts-landing__eyebrow">
          <span class="ts-landing__dot" aria-hidden="true" />
          The Specialists Mod / Half-Life 1 · running in a browser
        </div>

        <div class="ts-landing__mark" aria-hidden="true" />

        <h1 class="ts-landing__title">
          <span class="ts-landing__title-first">Bullet</span
          ><span class="ts-landing__title-second">Ballet</span>
        </h1>

        <!-- the dashed rule: a phosphor scan line with a solid cap -->
        <svg class="ts-landing__rule" viewBox="0 0 560 24" preserveAspectRatio="none" aria-hidden="true">
          <line
            x1="0"
            y1="12"
            x2="520"
            y2="12"
            stroke="currentColor"
            stroke-width="3"
            stroke-dasharray="2 10"
            stroke-linecap="round"
          />
          <path d="M520 6h30v12h-30z" fill="var(--ts-lime)" />
        </svg>

        <p class="ts-landing__lede">
          The Specialists Mod 3.0 with the original ruleset — ported to
          WebAssembly, served from a dedicated server. No install.
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
          is what made the first production bug take a day to find: the
          button did nothing visible and the reason was three layers
          down.
        -->
        <p v-if="launchError" class="ts-landing__error">{{ launchError }}</p>

        <!--
          Fullscreen is on by default, and Escape leaves it. The toggle is
          here because a browser fullscreen can only be entered from a
          click: if a player wants the game in a window, they need a way
          to say so BEFORE the game takes the screen.
        -->
        <label class="ts-landing__fullscreen">
          <input v-model="browserFullscreen" type="checkbox" />
          <span>Start full screen</span>
        </label>

        <div class="ts-landing__progress" :class="{ 'is-active': isStarting }">
          <div class="ts-landing__progress-bar" :style="{ width: downloadProgress + '%' }" />
          <span class="ts-landing__progress-text">
            {{ isStarting ? `Loading game data · ${downloadProgress}%` : '' }}
          </span>
        </div>
      </header>

      <!-- panels -->
      <div class="ts-landing__panel">
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

        <section
          v-show="activeTab === 'servers'"
          role="tabpanel"
          class="ts-landing__section"
        >
          <TSServerList @join="onJoinServer" @servers="onServers" />
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
        <span class="ts-landing__foot-label">BulletBallet</span>
        <span class="ts-landing__foot-links">
          <a href="https://www.tsmod.net/" target="_blank" rel="noreferrer noopener">TS Mod</a>
          <a href="https://github.com/x8BitRain/webXash" target="_blank" rel="noreferrer noopener">webXash</a>
          <a href="https://github.com/FWGS/xash3d-fwgs" target="_blank" rel="noreferrer noopener">Xash3D FWGS</a>
        </span>
      </footer>
    </div>

    <!-- fixed bottom bar -->
    <div class="ts-landing__bottombar">
      Fan project · not affiliated with Valve or Half-Life
    </div>

    <!--
      The pre-join identity step. It sits in front of the launch, so the
      name and character are decided BEFORE the engine connects — which
      is the only way the server ever learns about them (a change after
      the connect is a different code path on the server, and under TS
      3.0's ruleset a different outcome).
    -->
    <PlayerIdentityModal
      :open="identityOpen"
      @confirm="onIdentityConfirm"
      @close="identityOpen = false"
    />
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
import TSServerList from '/@/components/TSServerList.vue';
import TSHowToPlay from '/@/components/TSHowToPlay.vue';
import PlayerIdentityModal from '/@/components/PlayerIdentityModal.vue';
import { enterFullscreen } from '/@/services/fullscreen.ts';
import {
  identityLaunchArgs,
  loadSavedIdentity,
} from '/@/services/player-identity';

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

// The pre-join identity step.
//
// WHY A MODAL AND NOT A LANDING-PAGE SECTION
// ------------------------------------------
// Kyle asked which is better. The modal wins for one reason: the
// identity is a per-join decision, and a section on the landing page
// is a per-visit decision that people walk past. A modal interrupts
// exactly once (the "remember me" checkbox makes it exactly once ever)
// and is impossible to miss.
//
// The landing page still carries the saved identity, so a returning
// player sees their name and character in the modal without typing.
const identityOpen = ref(false);

/** The launch options the modal is holding, and the join will use. */
const pendingLaunch = ref<string | undefined>(undefined);

/**
 * Whether the identity step should be shown at all.
 *
 * A player who ticked "remember me" does not get asked again — that is
 * the whole point of the checkbox. A player who did NOT tick it is
 * asked every time, which is what they asked for.
 */
const identityRequired = ref(true);

function onIdentityConfirm() {
  identityOpen.value = false;
  const options = pendingLaunch.value;
  pendingLaunch.value = undefined;
  void launch(options);
}

/**
 * The code rain.
 *
 * ONE GLYPH STRIP PER COLUMN. The mock's rain is twelve columns of one
 * identical string, and its animation translates only -8% -> +8% of a
 * 120%-tall element, so the glyphs shimmer in place and never travel.
 * Each column here carries its own strip and travels a full tile
 * height, so it actually rains.
 *
 * WHY A BACKGROUND AND NOT TEXT
 * -----------------------------
 * A seamless loop needs the pattern's period to equal the travel
 * distance EXACTLY. With text, the period is the glyph count times the
 * glyph advance — a number that depends on the font, the font size and
 * the viewport. Get it slightly wrong and a gap opens at the end of the
 * cycle and the next cycle POPS the top back in, which is exactly what
 * was reported: "sometimes the lines just appear rather than always
 * raining down from the top".
 *
 * A repeating background has no such problem. `background-size` fixes
 * the tile at an exact pixel height, the travel is that same height in
 * pixels, and the strip repeats forever underneath. It is seamless for
 * ANY viewport, at any size, with no measurement anywhere.
 *
 * The strips are generated from a fixed seed on purpose: the rain must
 * be the same on every load, so the page never reflows under the
 * reader, and a screenshot of it is reproducible.
 */
/**
 * The glyph set.
 *
 * Weighted towards half-width katakana, because that is what the CRT
 * matrix look is made of: a column of dense, angular, half-width
 * characters reads as terminal output, where a column of Latin letters
 * reads as a spreadsheet.
 */
const RAIN_GLYPHS =
  'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿ' +
  '0123456789' +
  'ABCDEFXYZ' +
  '<>/\\|[]{}+=*#$%&@';
/** Glyphs per tile. 64 at 19px is a 1216px tile. */
const RAIN_TILE_GLYPHS = 64;
/** The tile's height in pixels. The travel is EXACTLY this. */
const RAIN_TILE_PX = 1216;
const RAIN_GLYPH_STEP = RAIN_TILE_PX / RAIN_TILE_GLYPHS;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One column's glyph strip, as a repeating background image. */
function rainStrip(seed: number): string {
  let s = (seed + 1) * 48271;
  const rows: string[] = [];
  for (let i = 0; i < RAIN_TILE_GLYPHS; i++) {
    s = (s * 48271) % 2147483647;
    const g = RAIN_GLYPHS[Math.floor((s / 2147483647) * RAIN_GLYPHS.length)];
    rows.push(
      `<text x="10" y="${(14 + i * RAIN_GLYPH_STEP).toFixed(2)}" text-anchor="middle">${escapeXml(g)}</text>`,
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="${RAIN_TILE_PX}" ` +
    `font-family="monospace" font-size="15" fill="#00ff41">${rows.join('')}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const rainStrips = Array.from({ length: 16 }, (_, i) => rainStrip(i));

/** Each column's position, phase and speed, so they do not march in step. */
function rainStyle(strip: string, i: number) {
  return {
    left: (i / rainStrips.length) * 100 + '%',
    backgroundImage: strip,
    animationDelay: -(i * 0.83) + 's',
    // 18-31s for one 1216px tile, so 39-67px/second. It was 10-16s,
    // which is 76-121px/second: a full screen of glyphs moving at a
    // hundred pixels a second is what gives a motion-sickness vibe, and
    // nothing about the effect needed to be that fast.
    animationDuration: 18 + (i % 5) * 3.4 + 's',
  };
}

/**
 * The live status in the top bar.
 *
 * The registry already publishes the current map and the real human
 * count, and the server list polls on a timer, so this is real data
 * rather than a decorative string.
 */
const knownServers = ref<TsServer[]>([]);

const liveStatus = computed(() => {
  const s = knownServers.value[0];
  if (!s) return 'Scanning for servers…';
  const humans = s.humans ?? s.players ?? 0;
  const who = humans === 1 ? '1 player' : `${humans} players`;
  return `${s.map} · ${who}`;
});

function onServers(servers: TsServer[]) {
  knownServers.value = servers;
}

const store = useXashStore();
const {
  xashCanvas,
  selectedGame,
  fullScreen,
  browserFullscreen,
  enableConsole,
  enableCheats,
  loadingProgress,
  customGameArg,
} = storeToRefs(store);
const { onStartLoading, onEndLoading, onBootPhase, onLaunching, refreshSavesList } = store;

const downloadProgress = computed(() => Math.round(loadingProgress.value));

/**
 * One launch path for both the big button and a server row.
 *
 * `options` overrides the URL/default launch options when given — that is
 * how a server row targets its own address instead of the default target.
 */
async function launch(options?: string) {
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


  // The identity step comes BEFORE the fullscreen request and before
  // the download.
  //
  // Fullscreen has to be asked for inside the click's user gesture,
  // and the modal is a DOM interaction in between — so asking for
  // fullscreen from the modal's confirm handler would be too late and
  // the browser would refuse it. Instead the launch is deferred: the
  // modal collects the identity, and the launch runs afterwards.
  //
  // The alternative (fullscreen first, modal on top) works, but then
  // the player is thrown into a fullscreen browser with a dialog in it
  // and the Escape key exits fullscreen instead of closing the dialog.
  if (identityRequired.value) {
    pendingLaunch.value = resolved;
    identityOpen.value = true;
    return;
  }

  await doLaunch(resolved);
}

/**
 * The launch itself: fullscreen, download, boot.
 *
 * Split out of `launch()` so the identity step can sit in front of it
 * without duplicating the body.
 */
async function doLaunch(resolved: string) {
  // Fullscreen is asked for HERE, at the top of the launch, before the
  // first await. The browser only grants a fullscreen request while the
  // click's user gesture is still live, and everything below this line is
  // async: downloading 493 MB, booting the engine.
  //
  // A request made after an await is simply refused.
  //
  // A refusal is not a failure: the game is playable windowed, and the
  // browser's own reason (no gesture, a policy) is not something the
  // player can act on. The service logs it and moves on.
  if (browserFullscreen.value) {
    void enterFullscreen();
  }

  if (!xashCanvas.value) {
    console.error('Canvas is not available');
    return;
  }

  // The identity rides in the launch arguments, so the engine sends it
  // to the server WITH the connect — not as a change after the fact.
  const identityArgs = identityLaunchArgs();
  if (identityArgs.length) {
    resolved = `${resolved} ${identityArgs.join(' ')}`;
  }

  launchError.value = '';
  isStarting.value = true;
  onLaunching(true);

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
  // The saved identity decides whether the player is asked at all: a
  // player who ticked "remember me" is not interrupted again, and one
  // who did not is asked every time (which is what they asked for).
  const saved = loadSavedIdentity();
  identityRequired.value = saved.remember === false || !saved.name;

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
  position: absolute;
  inset: 0;
  z-index: 10;
  overflow-y: auto;
  color: var(--ts-ink);
  /* Opaque on purpose: the game canvas sits at z-index 9 behind this
     page. Any alpha here lets the canvas show through and collide with
     the server list. (The canvas used to paint the Half-Life lambda as
     a centered background, which is how a stray logo used to ghost
     through the running game — that background is gone; see
     src/assets/main.css.) */
  background: var(--ts-void);
  pointer-events: auto;

  /* ---- the fixed bars ------------------------------------------------ */
  &__topbar,
  &__bottombar {
    position: fixed;
    left: 0;
    right: 0;
    z-index: 7;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 2.4rem;
    padding: 0 1.5rem;
    background: #000;
    font-family: var(--ts-font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ts-ink-muted);
  }

  &__topbar {
    top: 0;
  }

  &__bottombar {
    bottom: 0;
    justify-content: center;
  }

  &__topbar-right {
    display: flex;
    align-items: center;
    gap: 0.9rem;
  }

  &__topbar-live {
    color: var(--ts-signal);
  }

  &__status {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
  }

  &__status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ts-signal);
    box-shadow: 0 0 8px var(--ts-signal);
    animation: ts-pulse 2.4s var(--ts-ease) infinite;
  }

  /* ---- the stage ----------------------------------------------------- */
  &__bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
  }

  /* The code rain. One string per column, each travelling a full column
     height — the mock's travels +/-8% of a 120%-tall element, so its
     glyphs shimmer in place and never actually rain. */
  &__rain {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Fade hard from the top down.
       The old mask was fully opaque from 14% to 76% of the screen, so
       the rain hit the hero at full strength with nothing between. The
       rain now falls away as it descends, which leaves the wordmark,
       the lede and the PLAY button sitting on a calm field, and it is
       the lower half of the screen that a moving eye is worst served
       by. */
    -webkit-mask-image: linear-gradient(
      180deg,
      transparent 0%,
      #000 4%,
      rgba(0, 0, 0, 0.55) 20%,
      rgba(0, 0, 0, 0.3) 45%,
      rgba(0, 0, 0, 0.12) 70%,
      transparent 92%
    );
    mask-image: linear-gradient(
      180deg,
      transparent 0%,
      #000 4%,
      rgba(0, 0, 0, 0.55) 20%,
      rgba(0, 0, 0, 0.3) 45%,
      rgba(0, 0, 0, 0.12) 70%,
      transparent 92%
    );

    span {
      position: absolute;
      /* One tile above the window, and three tiles tall, so the column
         is always in flight and always covers the window. */
      top: -1216px;
      height: 3648px;
      width: 20px;
      background-repeat: repeat-y;
      background-size: 20px 1216px;
      opacity: 0.17;
      /* The CRT phosphor glow: a soft halo around each glyph with the
         core left crisp, which is what a real phosphor does and what
         flat text does not. */
      filter: drop-shadow(0 0 3px rgba(0, 255, 65, 0.4));
      animation: ts-rain 18s linear infinite;
      will-change: transform;
    }
  }

  /* faint tactical grid — reads as a targeting overlay */
  &__grid {
    position: absolute;
    inset: -10%;
    background-image:
      linear-gradient(rgba(0, 255, 65, 0.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 65, 0.055) 1px, transparent 1px);
    background-size: 46px 46px;
    -webkit-mask-image: radial-gradient(ellipse 80% 62% at 50% 34%, #000 25%, transparent 78%);
    mask-image: radial-gradient(ellipse 80% 62% at 50% 34%, #000 25%, transparent 78%);
  }

  /* the phosphor horizon glow behind the wordmark */
  &__glow {
    position: absolute;
    top: -22vh;
    left: 50%;
    width: min(1100px, 120vw);
    height: 62vh;
    transform: translateX(-50%);
    background: radial-gradient(
      ellipse at center,
      rgba(0, 255, 65, 0.2) 0%,
      rgba(0, 255, 65, 0.07) 38%,
      transparent 68%
    );
  }

  /* the emblem: concentric rings + radiating ticks, behind the wordmark */
  &__emblem {
    position: absolute;
    top: 34%;
    left: 50%;
    width: min(760px, 96vw);
    aspect-ratio: 1;
    transform: translate(-50%, -50%);
    border: 2px solid rgba(0, 255, 65, 0.17);
    border-radius: 50%;
    pointer-events: none;

    /* inner ring, offset in rather than inset so it reads as depth */
    &::before {
      content: '';
      position: absolute;
      inset: 14px;
      border: 1px solid rgba(216, 255, 226, 0.12);
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
        rgba(0, 255, 65, 0.09) 0deg 1.2deg,
        transparent 1.2deg 15deg
      );
      /* keep the streaks outside the rings */
      -webkit-mask: radial-gradient(
        circle at center,
        transparent 0 49.6%,
        #000 50.4% 100%
      );
      mask: radial-gradient(
        circle at center,
        transparent 0 49.6%,
        #000 50.4% 100%
      );
    }
  }

  /* ---- the column ---------------------------------------------------- */
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
    /* `margin: auto 0` on the hero, NOT `justify-content: center` on the
       parent: centring a scroll container's content with justify-content
       pushes the overflow ABOVE the scroll origin, where it cannot be
       scrolled back to. `margin: auto` centres in the free space and
       leaves the content reachable when there is none. */
    justify-content: flex-start;
    gap: clamp(0.7rem, 1.7vh, 1.3rem);
    width: 100%;
    max-width: 820px;
    min-height: 100%;
    margin: 0 auto;
    /* clear the fixed bars */
    padding: 2.9rem 1.4rem 4rem;
  }

  /* ---- nav ----------------------------------------------------------- */
  &__nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    max-width: 1120px;
  }

  &__brand {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
  }

  /* The mark, masked so it takes the accent colour like everything else. */
  &__brand-mark {
    width: 13px;
    height: 30px;
    flex: none;
    background-color: var(--ts-signal);
    -webkit-mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
    mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
  }

  &__brand-name {
    font-family: var(--ts-font-display);
    font-size: 1.05rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--ts-lime);

    span {
      color: var(--ts-signal);
    }
  }

  &__nav-links {
    display: flex;
    gap: 1.4rem;

    a {
      font-family: var(--ts-font-mono);
      font-size: 0.66rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ts-ink-muted);
      text-decoration: none;
      transition: color var(--ts-sweep) var(--ts-ease);

      &:hover {
        color: var(--ts-signal);
      }
    }
  }

  /* ---- hero ---------------------------------------------------------- */
  &__hero {
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
    font-size: 0.66rem;
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

  /* The BB mark, masked rather than <img>-ed so it takes the accent
     colour like everything else. A relative URL, because Vite resolves
     CSS urls relative to the file, not from the project root.
     Sized by HEIGHT: the mark is 200x460, so a width-based clamp would
     make it three times taller than the mock's. */
  &__mark {
    height: clamp(84px, 15vh, 150px);
    aspect-ratio: 200 / 460;
    margin: 0.55rem auto 0;
    background-color: var(--ts-signal);
    -webkit-mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
    mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
    filter: drop-shadow(0 0 26px rgba(0, 255, 65, 0.5));
  }

  &__title {
    margin: 0.7rem 0 0;
    font-family: var(--ts-font-display);
    font-size: clamp(48px, min(9vw, 10.5vh), 118px);
    font-weight: 400;
    line-height: 0.9;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    text-shadow:
      0 0 40px rgba(0, 255, 65, 0.3),
      3px 3px 0 rgba(42, 74, 49, 0.9);
  }

  /* BULLET in ghost-white, BALLET in phosphor — the mock's two-tone split. */
  &__title-first {
    color: var(--ts-lime);
  }

  &__title-second {
    color: var(--ts-signal);
  }

  /* The dashed rule: a phosphor scan line with a solid cap. */
  &__rule {
    width: min(520px, 72vw);
    height: 16px;
    margin-top: 0.7rem;
    color: var(--ts-signal);
  }

  &__lede {
    max-width: 50ch;
    margin: 0.6rem 0 0;
    font-size: 0.96rem;
    line-height: 1.6;
    color: var(--ts-ink);
  }

  /* ---- the big button ------------------------------------------------ */
  &__play {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.85rem;
    margin-top: 1.05rem;
    padding: 0.8rem 3.4rem;
    font-family: var(--ts-font-display);
    font-size: 1.5rem;
    font-weight: 400;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--ts-void);
    background: linear-gradient(180deg, var(--ts-signal-hot) 0%, var(--ts-signal) 100%);
    border: none;
    /* Square corners: the chamfer was the GoldSrc panel language, and the
       terminal language is a square edge plus the phosphor left-rule. */
    height: auto; /* immune to any future global button height rule */
    cursor: pointer;
    transition: transform 140ms var(--ts-ease), box-shadow var(--ts-sweep) var(--ts-ease);
    box-shadow: 0 0 0 rgba(0, 255, 65, 0);

    &:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 34px rgba(0, 255, 65, 0.42);
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
    font-size: 0.9em;
    line-height: 1;
  }

  &__play-label {
    /* optical: trim the trailing letter-spacing on the last glyph */
    margin-right: -0.2em;
  }

  &__error {
    margin: 0.9rem auto 0;
    max-width: 34rem;
    text-align: center;
    font-family: var(--ts-font-mono, monospace);
    font-size: 0.78rem;
    line-height: 1.6;
    letter-spacing: 0.04em;
    color: var(--ts-error, #ff5c5c);
  }

  &__fullscreen {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.55rem;
    font-size: 0.78rem;
    color: var(--ts-ink-muted, #6fa67c);
    cursor: pointer;
    user-select: none;

    input {
      accent-color: var(--ts-signal, #00ff41);
      cursor: pointer;
    }
  }

  /* ---- progress ---- */
  &__progress {
    width: min(340px, 80%);
    /* COLLAPSED when inactive. It is a div with a 3px bar and a line of
       text, so it reserved ~37px below the PLAY button on every page
       load, for a download that had not started. The fold criterion is
       that the first server row is visible at 1280x720. */
    height: 0;
    margin-top: 0;
    overflow: hidden;
    opacity: 0;
    transition: opacity var(--ts-sweep) var(--ts-ease);

    &.is-active {
      height: auto;
      margin-top: 0.8rem;
      opacity: 1;
    }
  }

  &__progress-bar {
    height: 3px;
    background: var(--ts-signal);
    box-shadow: 0 0 10px rgba(0, 255, 65, 0.6);
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

  /* ---- panels ---- */
  &__panel {
    width: 100%;
    /* absorbs the free space, so the footer sits at the bottom of the
       page without the tab panel being pushed down the screen */
    margin-bottom: auto;
  }

  &__tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--ts-edge);
  }

  &__tab {
    position: relative;
    padding: 0.7rem 1.5rem;
    font-family: var(--ts-font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ts-ink-muted);
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
      color: var(--ts-signal);

      &::after {
        width: 100%;
      }
    }
  }

  &__section {
    padding-top: 0.9rem;
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
    padding-top: 1.1rem;
    border-top: 1px solid var(--ts-edge);
    font-family: var(--ts-font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ts-ink-muted);
  }

  &__foot-label {
    color: var(--ts-header);
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

@keyframes ts-rain {
  from {
    transform: translateY(0);
  }
  to {
    /* EXACTLY one tile height — the same number as background-size. So
       the strip slides down precisely one tile and the repeat underneath
       takes its place. The loop has no seam and no pop. */
    transform: translateY(1216px);
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

@media (prefers-reduced-motion: reduce) {
  .ts-landing__rain span {
    animation: none !important;
  }
}
</style>
