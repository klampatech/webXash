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
      <div class="ts-landing__rain" :style="rainVars">
        <!--
          v-text, not an interpolation: Vue's template compiler collapses
          the whitespace in an interpolated string, and this string is
          192 newlines. v-text sets the text node directly, so the
          newlines survive to be rendered as line breaks.

          Two elements per column, not one. The trail is the fixed
          glyphs; the head is the one character at the leading edge
          that re-decodes, and it changes several times a second. If it
          were a character inside the trail's text, every change would
          re-lay-out all 192 lines of that column.
        -->
        <span
          v-for="(col, i) in rainColumns"
          :key="i"
          class="ts-landing__rain-col"
          :style="rainStyle(i)"
        >
          <span class="ts-landing__rain-trail" v-text="col.trail" />
        </span>
        <!--
          The heads, and they are OUTSIDE the columns. A column carries
          the phosphor glow — a drop-shadow filter over a strip three
          tiles tall — and a filter is re-run whenever anything inside
          it changes. A head changing inside the column re-filtered
          3072px of strip several times a second in every column at
          once, and the rain ran at half speed.
        -->
        <span
          v-for="(head, hi) in rainHeads"
          :key="hi"
          class="ts-landing__rain-head"
          :style="head.style"
          v-text="head.char"
        />
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
          v-show="activeTab === 'leaderboard'"
          role="tabpanel"
          class="ts-landing__section"
        >
          <TSLeaderboard />
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
import { ref, computed, onMounted, onUnmounted } from 'vue';
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
import TSLeaderboard from '/@/components/TSLeaderboard.vue';
import PlayerIdentityModal from '/@/components/PlayerIdentityModal.vue';
import { enterFullscreen } from '/@/services/fullscreen.ts';
import {
  identityLaunchArgs,
  loadSavedIdentity,
} from '/@/services/player-identity';

const tabs = [
  { id: 'servers', label: 'Servers' },
  { id: 'leaderboard', label: 'Leaderboard' },
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

/**
 * The player confirmed their identity, so the launch goes ahead.
 *
 * The guard has to be cleared HERE, and this is the whole reason this
 * function exists.
 *
 * `launch()` re-checks `identityRequired` before it connects, and
 * that check is what opens the modal in the first place. So the
 * sequence used to be:
 *
 *   Play -> launch() -> identityRequired is true -> open the modal
 *   confirm -> onIdentityConfirm() -> launch() again
 *          -> identityRequired is STILL true -> open the modal AGAIN
 *
 * and the player could never get into the game. The modal re-opened
 * on top of itself, forever, and the only way out was to tick
 * "remember me" on a page reload — which is not what "remember me"
 * is supposed to mean, and which a first-time player has no reason
 * to know about.
 *
 * The flag is only recomputed in `onMounted`, from what is in
 * localStorage, so within a session it never changed.
 *
 * Clearing it here means "the player has been asked, and answered" —
 * which is the actual condition the guard is meant to express.
 */
function onIdentityConfirm() {
  identityOpen.value = false;
  identityRequired.value = false;
  const options = pendingLaunch.value;
  pendingLaunch.value = undefined;
  void launch(options);
}

/**
 * The code rain.
 *
 * THE REAL MATRIX GLYPHS, AND A HEAD.
 * -----------------------------------
 * Two things were wrong with this effect. The glyphs were a monospace
 * fallback — ordinary Japanese katakana, which reads as "a Japanese
 * terminal" and not as the Matrix — and every glyph in a column had the
 * same brightness, so the columns read as a flat wash of characters
 * with no direction. The thing that makes the effect read as RAIN is the
 * bright head leading each column with a trail fading out behind it.
 *
 * The glyphs are now `Matrix Code`, the film's own shapes (see the
 * @font-face in ts-theme.css), and the brightness comes from a
 * gradient whose period is EXACTLY one tile.
 *
 * WHY THE PATTERN IS TEXT AND NOT A BACKGROUND IMAGE
 * --------------------------------------------------
 * An SVG background image is an isolated document: it cannot use the
 * page's webfonts, so the real Matrix glyphs cannot reach it without
 * embedding the whole font in every column's data URI. Text can use
 * the page's font directly, and one text node per column is 192
 * characters — cheaper than the 16 SVG data URIs this replaces.
 *
 * WHY THE LOOP IS STILL SEAMLESS
 * ------------------------------
 * A seamless loop needs the pattern's period to equal the travel
 * distance EXACTLY, and the earlier version got that by making the
 * travel a fixed pixel height with a repeating background behind it.
 * Text can do the same thing, but only because the period here is
 * VERTICAL: the travel is a number of LINES times an explicit
 * line-height, and neither depends on the font's glyph advance, the
 * font size or the viewport. The travel is 64 lines x 19px = 1216px,
 * and the content is three copies of the same 64-line tile, so at the
 * end of the cycle the column shows the same glyphs in the same places
 * it showed at the start. There is no seam and no pop.
 *
 * The strips are generated from a fixed seed on purpose: the rain must
 * be the same on every load, so the page never reflows under the
 * reader, and a screenshot of it is reproducible.
 */

/**
 * The glyph set — the characters `Matrix Code` maps to the film's
 * shapes, taken from the upstream project's own glyph order. Fifty-six
 * of them: the katakana the films use, a handful of digits, and the
 * punctuation that appears in the title sequences.
 *
 * The upstream project renders these from an MSDF texture; the font is
 * the same shapes without the texture.
 */
const RAIN_GLYPHS =
  'モエヤキオカ7ケサスz152ヨタワ4ネヌナ98ヒ0ホア3ウ セ¦:"꞊ミラリ╌ツテニハソ▪—<>|+*コシマムメ';

/** Glyphs per tile. 64 rows of the row pitch. */
const RAIN_TILE_GLYPHS = 64;
/**
 * THE REFERENCE.
 *
 * Wikipedia's "digital rain" article carries a 500x400 screensaver
 * capture of the effect, and that is the thing this is tuned to look
 * like. Measured off the GIF itself:
 *
 *   the row pitch     27.5px on a 400px screen  = 6.9% of the height
 *   the glyph         22px, which is 80% of the row
 *   the column pitch  ~35px on a 500px screen   = 7% of the width
 *   the trail         uniformly bright green, (0,195-246,0), blooming
 *   the head          ONE glyph, pure white, and it changes EVERY
 *                     frame — ten times a second
 *   the fall          33px per 100ms frame = 0.85 screens a second,
 *                     so the glyphs stream past at about twelve a
 *                     second
 *
 * The sizes are in vh so the rain keeps its proportions on any window
 * instead of being a 400px screensaver on a 1440p screen.
 */
const RAIN_ROW_VH = 6.9;
const RAIN_FONT_VH = 6.35;
/**
 * How fast it falls.
 *
 * The reference crosses its screen in 1.2 seconds. The tile is 64 rows
 * of 6.9% of the screen, so it is 4.42 screens, and at 0.85 screens a
 * second one tile takes 5.2 seconds. That number is the same at every
 * window size, because both the tile and the screen scale with it.
 */
const RAIN_SCREENS_PER_SECOND = 0.85;
const RAIN_TILE_SECONDS =
  (RAIN_TILE_GLYPHS * RAIN_ROW_VH) / 100 / RAIN_SCREENS_PER_SECOND;
/**
 * Tiles of content per column. Three: one above the window, one in it,
 * one below, so the column is always in flight and always covers the
 * window however tall it is.
 */
const RAIN_TILES = 3;
/** Columns. Fourteen: one every 7% of the width, which is the reference's
 *  column pitch. */
const RAIN_COLUMNS = 14;

/**
 * One column's TRAIL: the fixed glyphs of one tile.
 *
 * 64 rows, of which two are EMPTY — the slots the heads occupy.
 *
 * The LAST slot is the leading edge of the column's rain. In the
 * reference the white character is the last character of a run, with
 * nothing below it in that column, and the row after it is empty.
 *
 * The other slot is at a random row, because the reference has more
 * than one white character in a column at a time and they are not in
 * step from one column to the next. And the reason there are two at
 * all is visibility: with one head per 64 rows, and 64 rows being
 * four screens of rain, a head would be on screen a fifth of the time.
 * The reference has one on screen essentially always.
 *
 * Every glyph is followed by a newline. The trailing one matters:
 * without it the last glyph of one tile and the first of the next
 * would land on the same line, and the tile would be 63 lines tall —
 * which is not the height the travel is.
 */
function rainTile(seed: number): { trail: string; slots: number[] } {
  let s = (seed + 1) * 48271;
  const next = () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  const slots = [8 + Math.floor(next() * 48), RAIN_TILE_GLYPHS - 2];
  const rows: string[] = [];
  for (let i = 0; i < RAIN_TILE_GLYPHS; i++) {
    if (slots.includes(i)) {
      rows.push('');
    } else if (i === RAIN_TILE_GLYPHS - 1) {
      // The gap below the leading head: the run stops at the head.
      rows.push('');
    } else {
      rows.push(RAIN_GLYPHS[Math.floor(next() * RAIN_GLYPHS.length)]);
    }
  }
  return { trail: rows.join('\n') + '\n', slots };
}

function randomRainGlyph(): string {
  return RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)];
}

/** The columns' trails. These never change. */
const rainColumns = Array.from({ length: RAIN_COLUMNS }, (_, i) => {
  const tile = rainTile(i);
  return {
    // Three copies of the same tile, so the column's pattern repeats
    // exactly every 64 rows. The empty lines come with it.
    trail: tile.trail.repeat(RAIN_TILES),
    slots: tile.slots,
  };
});

/**
 * THE HEAD.
 *
 * In the films the leading character of a column is not a fixed glyph.
 * It re-decodes: it flickers from one character to the next several
 * times a second, and that is a large part of what makes the effect
 * read as code being DECODED rather than as text scrolling past.
 *
 * So the head is a character of its own, separate from the trail, and
 * it changes.
 *
 * It is a separate ELEMENT rather than a character inside the trail's
 * text for one reason: the trail is 192 lines of text, and changing a
 * character in it would re-lay-out all 192 of them, several times a
 * second, in every column at once. The head is one character in one
 * absolutely-positioned box, so changing it costs one glyph.
 *
 * There is one head per TILE, not one per column, because the trail
 * leaves an empty line for the head once per tile and an uncovered
 * empty line is a hole in the rain. On a window shorter than a tile
 * only the first of them is ever on screen; on a tall one the others
 * come into view as the column falls, and they are the heads of the
 * rain lines below.
 *
 * And they are OUTSIDE the columns, not inside them. The column
 * carries the phosphor glow — a drop-shadow filter over a strip three
 * tiles tall — and a filter is re-run whenever anything inside it
 * changes. A head changing inside the column therefore re-filtered
 * 3072px of strip several times a second, in every column at once,
 * and the whole rain ran at half speed. Outside the column the heads
 * animate with the same clock and the same distance, and the filter
 * is left alone.
 */
const rainHeads = ref(
  rainColumns.flatMap((col, ci) =>
    col.slots.flatMap((slot) =>
      Array.from({ length: RAIN_TILES }, (_, t) => {
        // The row of the strip this head sits on.
        const row = t * RAIN_TILE_GLYPHS + slot;
        return {
          char: randomRainGlyph(),
          style: { ...rainStyle(ci), '--head-row': row },
        };
      }),
    ),
  ),
);

/**
 * How often the head changes, and how likely a given column changes on
 * any one tick.
 *
 * The reference's head changes EVERY FRAME — the GIF is ten frames a
 * second and the head's glyph was identical to the previous frame in
 * none of the eleven frames measured. So the head changes about ten
 * times a second here too.
 *
 * A column that changed on EVERY tick would make all of them change
 * in step, which reads as a flash across the screen rather than as
 * independent columns decoding; so each tick changes only some of the
 * columns and no column is on a fixed beat.
 */
const RAIN_HEAD_TICK_MS = 60;
const RAIN_HEAD_CHANCE = 0.6;

let rainHeadTimer: ReturnType<typeof setInterval> | null = null;

/** A reduced-motion reader wants the rain still; a still head is still. */
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function scrambleRainHeads(): void {
  if (prefersReducedMotion.matches) return;
  for (const head of rainHeads.value) {
    if (Math.random() < RAIN_HEAD_CHANCE) head.char = randomRainGlyph();
  }
}

/**
 * The geometry, handed to the CSS as custom properties.
 *
 * The tile height and the glyph count are the two numbers that have to
 * agree: the tile is 64 lines tall, and the line height is the tile
 * divided by 64. If those drift apart the pattern's period stops
 * matching the travel distance and the loop opens a seam — the exact
 * failure this effect was built to avoid. So they are set in ONE place
 * here and the CSS reads them, rather than being written out twice.
 *
 * The line height is handed over as well, because the head has to sit
 * on the tile's last line exactly, and that is the tile minus one
 * line.
 */
const rainVars = [
  `--ts-rain-tile: ${RAIN_TILE_GLYPHS * RAIN_ROW_VH}vh`,
  `--ts-rain-glyphs: ${RAIN_TILE_GLYPHS}`,
  `--ts-rain-line: ${RAIN_ROW_VH}vh`,
  `--ts-rain-font: ${RAIN_FONT_VH}vh`,
].join('; ');

/** Each column's position, phase and speed, so they do not march in step. */
function rainStyle(i: number) {
  return {
    left: (i / RAIN_COLUMNS) * 100 + '%',
    // The reference's columns all fall at the SAME speed and are spread
    // evenly over one cycle, so the delay is a fraction of the cycle
    // rather than a fixed number of seconds.
    animationDelay: -((i / RAIN_COLUMNS) * RAIN_TILE_SECONDS) + 's',
    animationDuration: RAIN_TILE_SECONDS + 's',
  };
}

/**
 * The head's timer stops with the component. A landing page that is
 * unmounted must not keep re-decoding in the background.
 */
onUnmounted(() => {
  if (rainHeadTimer !== null) {
    clearInterval(rainHeadTimer);
    rainHeadTimer = null;
  }
});

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
  // The head re-decodes. The trail never changes, so this is the only
  // thing the rain costs.
  rainHeadTimer = setInterval(scrambleRainHeads, RAIN_HEAD_TICK_MS);

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

      /* THE MATRIX GLYPHS, in the font that has the film's shapes.

         The font lives on the container so the columns and the heads
         share it — the heads are outside the columns, so they cannot
         inherit it from them. */
      font-family: 'Matrix Code', monospace;
      font-size: var(--ts-rain-font);
      /* The row pitch, which is the reference's: 6.9% of the screen, and
         the glyph is 80% of it, so there is the reference's 20% of air
         between one glyph and the next. */
      line-height: var(--ts-rain-line);
      text-align: center;

      .ts-landing__rain-col {
        position: absolute;
        /* One tile above the window, and three tiles tall, so the column
           is always in flight and always covers the window. */
        top: calc(-1 * var(--ts-rain-tile));
        height: calc(var(--ts-rain-tile) * 3);
        /* The font's widest advance is one em, so this is the width the
           glyphs need. */
        width: var(--ts-rain-font);

        /* THE TRAIL.
           The reference's columns are UNIFORMLY bright — there is no
           ramp down the column, no dimming tail. What makes the leading
           edge read as the leading edge is the white head, and the head
           is white in every frame of the reference.

           So the trail is one colour, the brand's phosphor green, and
           the only thing that changes about a glyph is the one at the
           head. */
        color: var(--ts-signal);

        animation: ts-rain 18s linear infinite;
        will-change: transform;
      }

      .ts-landing__rain-trail {
        display: block;
        /* The strip is 192 newlines. Without this they are spaces. */
        white-space: pre;

        /* The CRT phosphor glow: a soft halo around each glyph with the
           core left crisp, which is what a real phosphor does and what
           flat text does not. The reference's bloom is wide — about a
           third of the glyph's own height.

           It is a TEXT-SHADOW and not a filter on the column, and that
           is not a detail. A filter is a composited layer, and a layer
           has to be re-composited whenever anything overlaps it — which,
           with the re-decoding heads flying over the columns several
           times a second, is constantly. Filtered, the rain ran at 54
           frames a second; as a text-shadow it runs at 60, and the glow
           is the same glow. */
        text-shadow: 0 0 1.4vh rgba(0, 255, 65, 0.55);
      }

      /* THE HEAD.
         The one character at the leading edge of the column, and the
         only thing in the rain that changes.

         It sits on the LAST line of its tile, which is the line the
         trail leaves empty for it, so it is exactly at the end of the
         line of glyphs above it and exactly at the gradient's brightest
         point.

         It is not painted with the gradient — the gradient is clipped to
         the text of the column, and the head has to be brighter than
         the trail rather than merely as bright as it.

         It travels with the column: the same keyframes, the same
         duration, the same delay, and the tile's last line as its
         starting offset. */
      .ts-landing__rain-head {
        position: absolute;
        /* The row of the strip it sits on. The tile is 64 rows, so the
           heads of the second and third tiles are 64 and 128 rows down. */
        top: calc((var(--head-row) - var(--ts-rain-glyphs)) * var(--ts-rain-line));
        width: var(--ts-rain-font);
        /* PURE WHITE, which is what the reference's head is: rgb(255,255,255)
           in every frame, against a trail of rgb(0,195-246,0). */
        color: #fff;
        text-shadow:
          0 0 1.4vh rgba(255, 255, 255, 0.95),
          0 0 3vh rgba(0, 255, 65, 0.55);
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
    /* EXACTLY one tile height — the same number as the line height
       times the glyph count, which is the pattern's period. So the
       strip slides down precisely one tile and the next copy of the
       tile takes its place. The loop has no seam and no pop. */
    transform: translateY(var(--ts-rain-tile));
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
  .ts-landing__rain-col,
  .ts-landing__rain-head {
    animation: none !important;
  }
}
</style>
