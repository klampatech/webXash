<!--
  THE OPTIONS OVERLAY — THE GAME'S OWN WINDOW.

  THE REDESIGN
  ============
  The ESC menu is now the buy menu's twin: the same 960x620 frame, the
  same palette, the same two fonts, and the same scale-to-fit rule. A
  player who has just closed the buy menu and opened the options sees
  the same window in the same place.

  What changed is the shape of the thing inside it. The old overlay was
  a column of groups under a row of tabs, and it was CONTENT-SIZED: the
  panel grew and shrank with whatever the current tab held, so the Quit
  button — the one control a player reaches for when they want to LEAVE
  a match — moved up and down as the tabs changed. Kyle's redesign
  makes it a fixed window with a SIDEBAR: three pages down the left,
  the Quit button pinned at the bottom of the sidebar where it cannot
  move, and only the content area scrolling.

  THE THREE PAGES
  ===============
    Player       the character roster, the chosen character large, the
                 name field beside it.
    Game         the sliders (sensitivity, field of view, volume), the
                 buy menu's style, and the fullscreen.
    Performance  the readout: the verdict, the numbers, the findings.

  THE PALETTE IS THE BUY MENU'S
  ============================
  Not a new palette and not an approximation: the buy panel's own
  tokens, verbatim, because these are two windows into the same game
  and a player should not have to learn a new colour scheme when they
  open the other one. Barlow Condensed for the headings, Inter for the
  interface.

  THE KEYBOARD
  ============
  The engine registers its key listener on `window` in the BUBBLE
  phase, so every keystroke in this panel is stopped before it gets
  there. `stopPropagation()` and not `preventDefault()`: the engine
  must not see the key, and the input's own behaviour must still
  happen. The panel also SUSPENDS the engine's keyboard while it is
  open, so a focused field is not enough on its own.

  AND THE FOCUS TRAP
  ==================
  The name field is focused when the panel opens, because without it
  the keystrokes go to `<body>` and the ENGINE eats them as game
  commands (a name containing "w" walks the player forward). Three
  things have to hold, and all three matter:

    1. `v-show`, not `v-if`, so the field is always in the DOM;
    2. the page is reset to "player" SYNCHRONOUSLY, before the await,
       because `focus()` on a `display:none` element fails SILENTLY;
    3. `await nextTick()` before the focus.
-->
<template>
  <div v-if="open" ref="root" class="opts" role="dialog" aria-modal="true" aria-label="Game options">
    <div
      ref="frame"
      class="opts__frame"
      @keydown.stop
      @keyup.stop
      @keypress.stop
    >
      <!-- THE HEADER: the window's title, and the way out of it. -->
      <header class="opts__head">
        <h2 class="opts__title">Options</h2>
        <button class="opts__close" type="button" aria-label="Close" @click="closeOverlay">✕</button>
      </header>

      <div class="opts__body">
        <!--
          THE SIDEBAR.

          It replaces the old tab strip, and it is a NAVIGATION, not a
          tablist: the three pages are places in the window, not panels
          of a tab widget, so the markup is a nav and the current page
          is marked with `aria-current="page"`.

          The Quit button is PINNED to the bottom of the sidebar, in the
          one red in the palette. It is the control a player reaches for
          when they want to leave a match, so it is in the same place on
          every page and it is never below the fold.
        -->
        <nav class="opts__side" aria-label="Options pages">
          <div class="opts__side-nav">
            <button
              v-for="p in PAGES"
              :key="p.key"
              class="opts__side-btn"
              :class="{ 'is-on': page === p.key }"
              type="button"
              :aria-current="page === p.key ? 'page' : undefined"
              @click="selectPage(p.key)"
            >
              <span class="opts__side-label">{{ p.label }}</span>
              <span
                v-if="p.key === 'performance' && problemCount > 0"
                class="opts__badge"
                :title="`${problemCount} thing${problemCount === 1 ? '' : 's'} to fix`"
              >{{ problemCount }}</span>
            </button>
          </div>

          <button class="opts__quit" type="button" @click="quitToWebUi">Quit game</button>
        </nav>

        <!-- THE PAGES. Only this column scrolls. -->
        <div class="opts__content">
          <h3 class="opts__page-title">{{ pageTitle }}</h3>

          <!--
            THE PLAYER PAGE: the chosen character, large, with the name
            field under it, and the whole roster beside it.
          -->
          <section
            v-show="page === 'player'"
            ref="playerPage"
            tabindex="-1"
            class="opts__page opts__page--split"
          >
            <div class="opts__card opts__selected">
              <p class="opts__label">Selected</p>
              <div class="opts__selected-portrait">
                <img
                  v-if="selectedModel"
                  :src="`/models/${selectedModel}.png`"
                  :alt="`${selectedModel} portrait`"
                  width="150"
                  height="150"
                />
                <span v-else class="opts__selected-empty">—</span>
              </div>
              <span class="opts__selected-name">{{ selectedLabel }}</span>

              <p class="opts__label opts__label--spaced">Name</p>
              <input
                ref="nameInput"
                v-model="name"
                class="opts__input"
                type="text"
                maxlength="24"
                spellcheck="false"
                autocomplete="off"
                aria-label="Player name"
                @keyup.enter="applyName"
              />
              <button
                class="opts__btn opts__btn--ghost"
                type="button"
                :disabled="!name.trim()"
                @click="applyName"
              >
                Set name
              </button>
            </div>

            <!--
              THE ROSTER. The picker's own component, shared with the
              pre-join identity modal, so the two menus cannot disagree
              about which characters exist. Only the colours, the tile
              size and the type are the caller's.
            -->
            <div class="opts__roster">
              <CharacterPicker
                :model="model"
                label="Character model"
                @select="chooseModel"
              />
            </div>
          </section>

          <!-- THE GAME PAGE: the sliders, the buy menu, the fullscreen. -->
          <section
            v-show="page === 'game'"
            ref="gamePage"
            tabindex="-1"
            class="opts__page opts__page--stack"
          >
            <div class="opts__card opts__card--stack">
              <p class="opts__label">Controls</p>

              <div v-for="s in OPTION_SLIDERS" :key="s.key" class="opts__row opts__row--slider">
                <span class="opts__row-label">
                  {{ s.label }}
                  <!--
                    The row says when the number is the GAME'S and not
                    the player's. The engine's `fov` cvar can hold 0
                    while its default is 90, and 0 is not a field of
                    view — so the slider shows the default and says so.
                  -->
                  <span v-if="sliderState[s.key].isDefault" class="opts__chip">default</span>
                </span>

                <input
                  class="opts__range"
                  type="range"
                  :min="s.min"
                  :max="s.max"
                  :step="s.step"
                  :value="sliderState[s.key].value"
                  :style="{ '--fill': sliderPercent(s, sliderState[s.key].value) + '%' }"
                  :aria-label="s.label"
                  @input="onSliderInput(s, $event)"
                />

                <input
                  class="opts__input opts__input--num"
                  type="number"
                  :min="s.min"
                  :max="s.max"
                  :step="s.step"
                  :value="numberDraft[s.key] ?? formatSlider(s, sliderState[s.key].value)"
                  :aria-label="`${s.label} value`"
                  @input="onNumberInput(s, $event)"
                  @change="onNumberCommit(s)"
                  @blur="onNumberCommit(s)"
                />
              </div>

              <div class="opts__row opts__row--end">
                <button class="opts__btn opts__btn--primary" type="button" @click="applySettings">
                  Apply
                </button>
              </div>
            </div>

            <!-- THE BUY MENU'S STYLE. -->
            <div class="opts__card opts__card--split">
              <div class="opts__card-head">
                <p class="opts__label">Buy menu</p>
                <span class="opts__row-label">Style</span>
              </div>
              <div class="opts__switch" role="radiogroup" aria-label="Buy menu style">
                <button
                  v-for="mode in buyMenuModes"
                  :key="mode"
                  class="opts__switch-btn"
                  :class="{ 'is-on': buyMenu === mode }"
                  type="button"
                  role="radio"
                  :aria-checked="buyMenu === mode"
                  @click="setBuyMenu(mode)"
                >
                  {{ mode === 'classic' ? 'Classic' : 'Modern' }}
                </button>
              </div>
            </div>

            <!--
              THE DRAW COST.

              The levers the player has on the cost of a frame. They
              are NOT a default and nothing claims they help: the
              project's own sweep found the effect smaller than the
              drift, so the honest thing is to offer the switches and
              the instrument — the Performance page measures the frame
              cost, so a player can flip one, press Re-measure, and
              read the new number in milliseconds.
            -->
            <div class="opts__card opts__card--stack">
              <div class="opts__card-head">
                <p class="opts__label">Draw cost</p>
                <span class="opts__row-effect">
                  Turn these down to make a frame cheaper, then check ESC → Performance for the
                  new frame cost.
                </span>
              </div>
              <div
                v-for="sw in drawCostSwitches"
                :key="sw.cvar"
                class="opts__row opts__row--switch"
              >
                <span class="opts__row-label">
                  {{ sw.label }}
                  <span class="opts__row-effect">{{ sw.effect }}</span>
                </span>
                <button
                  class="opts__switch-btn opts__switch-btn--single"
                  :class="{ 'is-on': drawCostState[sw.cvar]?.cheap }"
                  type="button"
                  role="switch"
                  :aria-checked="drawCostState[sw.cvar]?.cheap === true"
                  :disabled="drawCostState[sw.cvar]?.known !== true"
                  @click="toggleDrawCost(sw)"
                >
                  {{ drawCostState[sw.cvar]?.cheap ? 'Reduced' : 'Full' }}
                </button>
              </div>
            </div>

            <!--
              THE FULLSCREEN.

              Escape is not the way out of the fullscreen any more: the
              browser takes that key, and on Chromium it is the key that
              lets go of the MOUSE mid-match — which is what a player
              pressing Escape actually wants. So the fullscreen is a
              deliberate choice from here, and this is the control that
              makes it one.
            -->
            <div class="opts__card opts__card--split">
              <div class="opts__card-head">
                <p class="opts__label">Display</p>
                <span class="opts__row-label">Fullscreen</span>
              </div>
              <button
                class="opts__switch-btn opts__switch-btn--single"
                :class="{ 'is-on': inFullscreen }"
                type="button"
                role="switch"
                :aria-checked="inFullscreen"
                @click="toggleFullscreen"
              >
                {{ inFullscreen ? 'On' : 'Off' }}
              </button>
            </div>
          </section>

          <!-- THE READOUT. -->
          <section
            v-show="page === 'performance'"
            ref="perfPage"
            tabindex="-1"
            class="opts__page opts__page--perf"
          >
            <TSPerformance
              context="game"
              :report="perfReport ?? undefined"
              @remeasure="remeasurePerf"
            />
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue';
import { storeToRefs } from 'pinia';
import { useXashStore } from '/@/stores/store.ts';
import { overlayOpen, closeOverlay } from '/@/services/escape-gate';
import { isFullscreen, exitFullscreen, enterFullscreen } from '/@/services/fullscreen';
import { noteFullscreenExitRequested } from '/@/services/escape-gate';
import { readCvarFull, writeCvar } from '/@/services/engine-cvars';
import {
  DRAW_COST_SWITCHES,
  isCheap,
  valueFor,
  type DrawCostSwitch,
} from '/@/services/draw-cost.ts';
import { logDebug } from '/@/services/debug-log';
import { setBridgeSuspended } from '/@/services/keyboard-bridge';
import TSPerformance from '/@/components/TSPerformance.vue';
import CharacterPicker from '/@/components/CharacterPicker.vue';
import { applyBuyMenuMode, type BuyMenuMode } from '/@/services/buy-menu';
import {
  installPerfSessionWriter,
  savePerfSession,
  liveReport,
  remeasureEngineCost,
} from '/@/services/perf-collect.ts';
import {
  OPTION_SLIDERS,
  clampToSlider,
  formatSlider,
  readSlider,
  sliderPercent,
  type OptionSlider,
} from '/@/services/options-values.ts';
import {
  applyModel,
  applyName as applyEngineName,
  canonicalModel,
  displayName,
  engineModel,
  refreshIdentity,
} from '/@/services/player-identity';
import type { PerfReport } from '/@/services/perf-check.ts';

const open = overlayOpen;

/**
 * A report to show, when the caller has one.
 *
 * The panel reads the LIVE game itself, so this is empty in the game.
 * It exists so the dev harness can put a report with findings in front
 * of the layout — the readout's interesting states are the ones with
 * something wrong, and a harness with no game running cannot make one.
 */
const props = withDefaults(defineProps<{ report?: PerfReport | null }>(), {
  report: null,
});

const name = ref('');
const model = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

/** The three pages, so the focus can follow the player. */
const playerPage = ref<HTMLElement | null>(null);
const gamePage = ref<HTMLElement | null>(null);
const perfPage = ref<HTMLElement | null>(null);

/**
 * THE PAGES, in the order the sidebar lists them.
 */
type OptsPage = 'player' | 'game' | 'performance';

const PAGES: { key: OptsPage; label: string }[] = [
  { key: 'player', label: 'Player' },
  { key: 'game', label: 'Game' },
  { key: 'performance', label: 'Performance' },
];

/**
 * Which page is showing.
 *
 * The panel always OPENS on the player page, because the name field
 * lives there and the focus has to land in it: `focus()` on a hidden
 * input fails SILENTLY, so opening on another page would leave the
 * field dead and the ENGINE would eat the keystrokes as game commands.
 */
const page = ref<OptsPage>('player');

const pageTitle = computed(() => {
  const p = PAGES.find((x) => x.key === page.value);
  return p ? p.label : '';
});

async function selectPage(next: OptsPage): Promise<void> {
  page.value = next;
  if (next === 'performance') {
    // The badge's number comes from the same report the page shows, so
    // it is refreshed whenever the page comes forward.
    refreshPerfReport();
  }

  // THE FOCUS FOLLOWS THE PAGE.
  //
  // The name field holds the focus while the Player page is up. When
  // the player leaves that page the field is hidden — and a focus on a
  // hidden element falls back to <body>, where the ENGINE's listeners
  // are waiting. The page itself takes the focus instead, so a screen
  // reader says where the player is and the arrow keys still work.
  await nextTick();
  if (next === 'player') {
    nameInput.value?.focus();
    nameInput.value?.select();
    return;
  }
  const target = next === 'game' ? gamePage.value : perfPage.value;
  target?.focus();
}

// ---------------------------------------------------------------------------
// THE SLIDERS
// ---------------------------------------------------------------------------

/**
 * What each slider shows.
 *
 * `isDefault` is true when the cvar held nothing usable and the
 * engine's own default is being shown instead.
 */
const sliderState = ref<Record<OptionSlider['key'], { value: number; isDefault: boolean }>>({
  sensitivity: { value: 2, isDefault: false },
  fov: { value: 90, isDefault: false },
  volume: { value: 1, isDefault: false },
});

/**
 * What the number field is showing while it is being typed into.
 *
 * The field is bound to a string, not to the value: binding a number
 * to a number input rewrites the text on every keystroke, and a
 * half-typed "1." becomes "1" under the player's cursor.
 */
const numberDraft = ref<Record<string, string | undefined>>({});

function onSliderInput(spec: OptionSlider, e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value);
  const value = clampToSlider(spec, raw);
  sliderState.value[spec.key] = { value, isDefault: false };
  numberDraft.value = { ...numberDraft.value, [spec.key]: formatSlider(spec, value) };
}

function onNumberInput(spec: OptionSlider, e: Event): void {
  const text = (e.target as HTMLInputElement).value;
  numberDraft.value = { ...numberDraft.value, [spec.key]: text };
}

function onNumberCommit(spec: OptionSlider): void {
  const draft = numberDraft.value[spec.key];
  if (draft === undefined) return;
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) {
    // An empty or broken field falls back to what the slider holds.
    numberDraft.value = {
      ...numberDraft.value,
      [spec.key]: formatSlider(spec, sliderState.value[spec.key].value),
    };
    return;
  }
  const value = clampToSlider(spec, parsed);
  sliderState.value[spec.key] = { value, isDefault: false };
  numberDraft.value = { ...numberDraft.value, [spec.key]: formatSlider(spec, value) };
}

/**
 * Write the sliders back to the engine.
 *
 * The value written is the one the slider SHOWS, which is always
 * inside the slider's range. The old panel wrote the raw cvar value,
 * and the engine's `fov` cvar can hold 0 while its default is 90 — so
 * the old Apply could write a field of view of ZERO.
 */
function applySettings(): void {
  for (const s of OPTION_SLIDERS) {
    writeCvar(s.cvar, sliderState.value[s.key].value);
  }
  // The values are the player's now, whatever they were before.
  for (const s of OPTION_SLIDERS) {
    sliderState.value[s.key] = { ...sliderState.value[s.key], isDefault: false };
  }
  logDebug('[opts] applied', JSON.stringify(sliderState.value));
}

// ---------------------------------------------------------------------------
// THE IDENTITY
// ---------------------------------------------------------------------------

/** The character the player is wearing, in the mod's own spelling. */
const selectedModel = computed(() => canonicalModel(model.value) ?? '');

/** The name of the selected character, for the large portrait's label. */
const selectedLabel = computed(() => {
  const m = selectedModel.value;
  return m ? m : 'Not chosen';
});

function applyName(): void {
  const n = name.value.trim();
  if (!n) return;
  if (applyEngineName(n)) {
    logDebug(`[opts] name set to "${n}"`);
  }
}

function chooseModel(m: string): void {
  if (applyModel(m)) {
    // The CANONICAL spelling, not the one that was clicked: the engine
    // puts this string into `models/player/<name>/<name>.mdl`, and the
    // case is part of the path.
    model.value = canonicalModel(m) ?? m;
    logDebug(`[opts] model set to "${model.value}"`);
  }
}

// ---------------------------------------------------------------------------
// THE READOUT
// ---------------------------------------------------------------------------

/** The report the Performance page shows, and the badge's number. */
const perfReport = ref<PerfReport | null>(props.report ?? null);

/**
 * How many things want the player's attention.
 *
 * A WARNING and an ERROR both count: the badge is "things to fix", and
 * a software renderer is more worth a badge than a late frame.
 */
const problemCount = computed(() => {
  const r = perfReport.value;
  if (!r) return 0;
  return r.findings.filter((f) => f.severity === 'warn' || f.severity === 'bad').length;
});

/**
 * Re-read the readout.
 *
 * In the game this is the LIVE report: the player is looking at the
 * game right now, and a stale number would be a lie.
 */
function refreshPerfReport(): void {
  perfReport.value = props.report ?? liveReport();
}

/**
 * RE-MEASURE, AND THE REPORT AFTERWARDS.
 *
 * The Performance page's "Re-measure" button asks for this. It does
 * TWO things: it re-reads the pacer's own state, and it asks the
 * pacer for a NEW measurement window.
 *
 * The second one is the point. The pacer measures every ten seconds
 * on its own, but a player who has just turned a draw-cost switch
 * off wants the new frame cost NOW — and a readout that cannot be
 * asked for a fresh reading is a report, not an instrument.
 */
async function remeasurePerf(): Promise<void> {
  await remeasureEngineCost();
  refreshPerfReport();
}

// ---------------------------------------------------------------------------
// THE DRAW COST
// ---------------------------------------------------------------------------

/** The switches, as the page shows them. */
const drawCostSwitches = DRAW_COST_SWITCHES;

/** What one draw-cost switch is doing right now. */
interface DrawCostState {
  /** Is the cvar in its cheap state? */
  cheap: boolean;
  /** Do we know the cvar at all? A cvar the engine did not answer is unknown. */
  known: boolean;
  /** The engine's own default, for putting the switch back. */
  engineDefault: string | null;
}

/**
 * The state of every draw-cost switch.
 *
 * A switch whose cvar the engine did not answer is shown as unknown
 * and its button is disabled — a control that says "Reduced" for a
 * cvar that was never read would be a lie, and a button that writes
 * to a cvar that does not exist does nothing at all.
 */
const drawCostState = ref<Record<string, DrawCostState>>({});

/**
 * Turn a draw-cost switch on or off.
 *
 * The expensive state is the engine's OWN default, so turning a
 * switch back restores what the engine had rather than a guess.
 */
function toggleDrawCost(sw: DrawCostSwitch): void {
  const state = drawCostState.value[sw.cvar];
  if (!state || !state.known) return;
  const cheap = !state.cheap;
  const value = valueFor(sw, cheap, state.engineDefault);
  writeCvar(sw.cvar, value);
  drawCostState.value = {
    ...drawCostState.value,
    [sw.cvar]: { ...state, cheap },
  };
  logDebug(`[opts] ${sw.cvar} -> ${value}`);
}

watch(
  () => props.report,
  (r) => {
    if (r) perfReport.value = r;
  },
);

// ---------------------------------------------------------------------------
// THE BUY MENU
// ---------------------------------------------------------------------------

/**
 * The buy menu's style. It lives in the store (and is persisted), but
 * it is NOT a cvar: it is the port's `ts_buy_mode` command, a client
 * library switch, so it never reaches the launch args.
 */
const store = useXashStore();
const { tsConfig } = storeToRefs(store);
const buyMenuModes: BuyMenuMode[] = ['classic', 'modern'];
const buyMenu = computed<BuyMenuMode>(() =>
  tsConfig.value?.buyMenu === 'classic' ? 'classic' : 'modern',
);

/**
 * Switch the buy menu.
 *
 * The store keeps the choice; the port is told immediately, because a
 * player who switches to Modern expects the canvas menu to go away
 * now, not at the next session. The command is idempotent, so
 * repeating it is harmless.
 *
 * The port owns the choice afterwards: it answers with its state, and
 * the state line's `mode=` is what the panel follows. The classic
 * flow is the port's default, so "modern" is asked for — never
 * assumed.
 */
function setBuyMenu(mode: BuyMenuMode): void {
  if (!tsConfig.value) return;
  tsConfig.value.buyMenu = mode;
  applyBuyMenuMode(mode);
  logDebug(`[opts] buy menu -> ${mode}`);
}

// ---------------------------------------------------------------------------
// THE FULLSCREEN
// ---------------------------------------------------------------------------

/**
 * Is the page in fullscreen right now?
 *
 * The state can change without the panel knowing (the browser's own
 * chrome can leave it), so it is tracked from the event.
 */
const inFullscreen = ref(isFullscreen());

function onFullscreenChange(): void {
  inFullscreen.value = isFullscreen();
}

/**
 * The fullscreen toggle.
 *
 * A click is a user gesture, and `requestFullscreen()` only works
 * from one — so this is the only way IN once the browser has taken the
 * fullscreen away with an Escape.
 *
 * Going OUT is told to the escape gate first, so that it does not put
 * the fullscreen straight back: the player asked for this.
 */
async function toggleFullscreen(): Promise<void> {
  if (inFullscreen.value) {
    noteFullscreenExitRequested();
    exitFullscreen();
    logDebug('[opts] left fullscreen');
    return;
  }
  await enterFullscreen();
  inFullscreen.value = isFullscreen();
  logDebug('[opts] entered fullscreen:', inFullscreen.value);
}

// ---------------------------------------------------------------------------
// THE FRAME
// ---------------------------------------------------------------------------

/**
 * THE PANEL SCALES TO THE VIEWPORT.
 *
 * The frame is the design's own 960 x 620 and is always DRAWN at that
 * size; the scale factor is what changes. CSS cannot divide one
 * length by another, so the factor is computed here — from the layer's
 * box (minus its padding) against the frame's own size — and handed to
 * the CSS as --opts-scale.
 *
 * This is the buy panel's rule, unchanged, so the two windows in the
 * game behave the same way in a small window and in a big one.
 */
const MAX_SCALE = 1.8;
const MIN_SCALE = 0.45;

const root = ref<HTMLElement | null>(null);
const frame = ref<HTMLElement | null>(null);

function updateScale(): void {
  const layer = root.value;
  const panel = frame.value;
  if (!layer || !panel) return;
  const style = window.getComputedStyle(layer);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availW = layer.clientWidth - (Number.isFinite(padX) ? padX : 0);
  const availH = layer.clientHeight - (Number.isFinite(padY) ? padY : 0);
  const baseW = panel.offsetWidth;
  const baseH = panel.offsetHeight;
  if (availW <= 0 || availH <= 0 || baseW <= 0 || baseH <= 0) return;
  const factor = Math.min(availW / baseW, availH / baseH);
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, factor));
  panel.style.setProperty('--opts-scale', scale.toFixed(4));
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  resizeObserver = new ResizeObserver(() => updateScale());
  if (root.value) resizeObserver.observe(root.value);
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  resizeObserver?.disconnect();
  resizeObserver = null;
});

// ---------------------------------------------------------------------------
// THE LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * Load the current values from the engine when the overlay opens.
 *
 * The cvars are read with their DEFAULTS as well as their values: the
 * engine's `fov` cvar can hold 0 while its default is 90, and a
 * slider that shows 0 is showing the player a field of view of zero.
 */
async function refresh() {
  // THE DRAW COST IS READ AT THE SAME TIME AS THE SLIDERS.
  //
  // They are both engine round-trips and there is no reason to wait
  // for one before starting the other — doing them in series made the
  // overlay take twice as long to fill in, for no reason at all.
  const drawReadingsPromise = Promise.all(DRAW_COST_SWITCHES.map((s) => readCvarFull(s.cvar)));

  const readings = await Promise.all(OPTION_SLIDERS.map((s) => readCvarFull(s.cvar)));

  OPTION_SLIDERS.forEach((s, i) => {
    const reading = readings[i];
    const resolved = readSlider(s, reading.value, reading.defaultValue);
    sliderState.value[s.key] = { value: resolved.value, isDefault: resolved.isDefault };
    numberDraft.value = { ...numberDraft.value, [s.key]: formatSlider(s, resolved.value) };
    logDebug(
      `[opts] loaded ${s.cvar}=${reading.value} (default ${reading.defaultValue}) -> ${resolved.value}`,
    );
  });

  // The identity, too: the field starts with the name the player is
  // actually playing under, and the picker shows the current model.
  await refreshIdentity();
  name.value = displayName.value;
  model.value = engineModel.value;

  // THE DRAW COST, read from the engine.
  //
  // A cvar the engine does not answer is not a cvar that is off; it
  // is a cvar that is unknown, and the switch says so by being
  // disabled. `r_lockpvs` in particular is worth knowing about: the
  // player's own `r_lockpvs 1` from a console would otherwise be
  // reported as "Full" and overwritten.
  const drawReadings = await drawReadingsPromise;
  const drawState: Record<string, DrawCostState> = {};
  DRAW_COST_SWITCHES.forEach((s, i) => {
    const reading = drawReadings[i];
    drawState[s.cvar] = {
      cheap: isCheap(s, reading.value),
      known: reading.value !== null,
      engineDefault: reading.defaultValue,
    };
    logDebug(`[opts] ${s.cvar}=${reading.value} (default ${reading.defaultValue})`);
  });
  drawCostState.value = drawState;

  refreshPerfReport();
}

/**
 * Open the overlay with the keyboard in the right place.
 *
 * The focus is the fix for "typing in the input is not captured by
 * the input" (measured: without a click, every keystroke went to
 * <body>). `nextTick` waits for the field to exist before focusing it.
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
  // THE PAGE IS RESET BEFORE THE FIELD IS FOCUSED.
  //
  // The name input lives on the player page, and `focus()` on a HIDDEN
  // input fails SILENTLY — so if the panel opened on another page, the
  // name field would never take the focus, every keystroke would go
  // to <body>, and the engine would eat them as game commands. The
  // reset is synchronous, and the focus comes after the tick.
  page.value = 'player';
  void refresh();
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
});

/**
 * KEEP THE SESSION WHEN THE PAGE GOES AWAY.
 *
 * Quitting to the web UI is a full page load, and everything the
 * readout knows lives in module state that dies with the page — so the
 * last match's numbers are written to `sessionStorage` on the way out
 * and restored on the landing page.
 *
 * The write is guarded on a MEASURED FRAME, so the landing page's own
 * `pagehide` cannot erase the session it is about to show.
 */
let removeSessionWriter: (() => void) | null = null;

onMounted(() => {
  removeSessionWriter = installPerfSessionWriter();
  updateScale();
});

onBeforeUnmount(() => {
  removeSessionWriter?.();
  removeSessionWriter = null;
});

/**
 * Leave the match and go back to the site.
 *
 * A full page load, not a state toggle: the engine's state lives in
 * WASM memory and on the server, and the honest way out of a match is
 * to leave it. The landing page is the site root.
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
  // KEEP THE LAST MATCH FIRST.
  //
  // The next line is a full page load: every module-level fact the
  // readout knows dies with this document. The session snapshot is
  // what carries them to the landing page, so it is written BEFORE the
  // navigation — and the write is guarded on a measured frame, so it
  // only happens when there is a game to remember.
  savePerfSession();
  window.location.href = '/';
}
</script>

<style scoped lang="scss">
/*
 * THE PALETTE — THE BUY MENU'S, VERBATIM.
 *
 * These are not this panel's colours and not the shell's phosphor
 * green: they are the buy panel's own tokens, the same gold-on-dark
 * family, because these are two windows into the same game. The
 * overlay opens INSIDE the match, over the game's own amber HUD, and
 * a green menu in the middle of an amber game read as two systems
 * fighting.
 *
 *   --opts-bg      #14110d  the window's ground
 *   --opts-card    #1f1a13  the cards
 *   --opts-focus   #2a2216  the selected row's fill
 *   --opts-border  #33291d  the hairlines
 *   --opts-edge    #4a3d2b  the buttons' own edges
 *   --opts-text    #f2e9d8  the text
 *   --opts-muted   #b3a68e  the labels
 *   --opts-accent  #f2b84b  the accent: headings, the selected row
 *   --opts-warn    #ffb35a  a warning
 *   --opts-ok      #8fd18a  all well
 *   --opts-danger  #ff8a73  the one red: the Quit button
 */
.opts {
  --opts-bg: #14110d;
  --opts-card: #1f1a13;
  --opts-card-2: #262016;
  --opts-focus: #2a2216;
  --opts-border: #33291d;
  --opts-edge: #4a3d2b;
  --opts-text: #f2e9d8;
  --opts-muted: #b3a68e;
  --opts-accent: #f2b84b;
  --opts-warn: #ffb35a;
  --opts-ok: #8fd18a;
  --opts-danger: #ff8a73;
  --opts-danger-border: #7a362b;
  --opts-bar-bg: #2a241b;

  --opts-font-display: 'Barlow Condensed', 'Oswald', 'Arial Narrow', sans-serif;
  --opts-font: Inter, 'Helvetica Neue', system-ui, -apple-system, sans-serif;

  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(20, 17, 13, 0.92);
  /* Above the HUD (1000) and the buy panel (1001): the overlay is a
     MODAL, and the panel can be open when the player reaches for the
     options (the game opens its own buy menu when the player becomes
     an observer). The panel's own toggle lives in here, so it has to
     be reachable. */
  z-index: 2000;
  font-family: var(--opts-font);
  color: var(--opts-text);
  -webkit-font-smoothing: antialiased;

  /*
   * THE PANEL BRINGS ITS OWN BOX SIZING.
   *
   * The app's reset sets `box-sizing: border-box` globally, but the
   * panel is also mounted by the dev harness, on a page that has no
   * reset — and a frame that is 56px wider than the window it is
   * supposed to be is a frame that overflows it. The buy panel sets
   * the same rule for the same reason.
   */
  &,
  & *,
  & *::before,
  & *::after {
    box-sizing: border-box;
  }

  /*
   * THE FRAME: THE DESIGN'S OWN 960 x 620, DRAWN AT THAT SIZE.
   *
   * The scale factor is what changes with the window, and it is
   * computed in the script (CSS cannot divide one length by
   * another). The buy panel works the same way, so the two windows in
   * the game are the same window.
   */
  &__frame {
    width: 960px;
    height: 620px;
    /*
     * The frame NEVER flexes. It is a fixed 960 x 620 window and the
     * only thing that changes with the viewport is the SCALE, so a
     * flex parent that squeezed it would be changing the design.
     */
    flex: none;
    transform: scale(var(--opts-scale, 1));
    transform-origin: center center;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    background: var(--opts-bg);
    border: 1px solid var(--opts-border);
    border-radius: 14px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.75);
  }

  /* THE HEADER: the title, and the way out. */
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex: none;
  }

  &__title {
    margin: 0;
    font-family: var(--opts-font-display);
    font-weight: 700;
    font-size: 30px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--opts-accent);
  }

  /* The close button: a square ghost, in the design's own shape. */
  &__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--opts-edge);
    border-radius: 8px;
    color: var(--opts-text);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;

    &:hover {
      border-color: var(--opts-accent);
      color: var(--opts-accent);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-accent);
      box-shadow: 0 0 0 1px var(--opts-accent);
    }

    /* Forced colours paint no background and no box-shadow, and the
       border is gone, so the button would have no visible container.
       The outline is that container. */
    @media (forced-colors: active) {
      outline: 2px solid ButtonText;
      outline-offset: 2px;
    }
  }

  /* THE BODY: the sidebar, and the pages. */
  &__body {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 20px;
    border-top: 1px solid var(--opts-border);
    padding-top: 12px;
  }

  /*
   * THE SIDEBAR.
   *
   * 190px, the design's own width, with the Quit button PINNED to the
   * bottom: it is the control a player reaches for when they want to
   * leave a match, so it is in the same place on every page and it is
   * never below the fold.
   */
  &__side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 190px;
    flex: none;
  }

  &__side-nav {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }

  &__side-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 46px;
    padding: 0 14px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--opts-muted);
    font-family: var(--opts-font);
    font-size: 15px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;

    &:hover {
      color: var(--opts-text);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-accent);
      box-shadow: 0 0 0 1px var(--opts-accent);
    }

    /* The current page: the game's focus fill, a gold edge, and the
       text in the full ink. */
    &.is-on {
      background: var(--opts-focus);
      border-color: var(--opts-accent);
      color: var(--opts-text);
    }
  }

  &__side-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /*
   * THE BADGE: how many things want the player's attention.
   *
   * It is the only amber pill in the panel, and it is on the
   * Performance page because that is the page where the things are.
   */
  &__badge {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 10px;
    background: #3a2a12;
    color: var(--opts-warn);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
  }

  /* THE QUIT BUTTON: the one red element in the window. */
  &__quit {
    min-height: 44px;
    padding: 0 20px;
    background: transparent;
    border: 1px solid var(--opts-danger-border);
    border-radius: 8px;
    color: var(--opts-danger);
    font-family: var(--opts-font);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    flex: none;

    &:hover {
      background: rgba(255, 138, 115, 0.12);
      border-color: var(--opts-danger);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-danger);
      box-shadow: 0 0 0 1px var(--opts-danger);
    }
  }

  /* THE PAGES' COLUMN. */
  &__content {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  &__page-title {
    margin: 0;
    flex: none;
    font-family: var(--opts-font-display);
    font-weight: 700;
    font-size: 22px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--opts-accent);
  }

  /*
   * A PAGE.
   *
   * Only this scrolls. The title, the sidebar and the Quit button are
   * outside it, so nothing that matters can be pushed off the window.
   */
  &__page {
    display: flex;
    gap: 16px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;

    /*
     * THE SCROLLBAR IS THE PANEL'S OWN.
     *
     * The browser's default is a light grey bar on a light track, and
     * on this dark panel it reads as a scratch across the design. So
     * it is thin, and it is the panel's own border colour — the same
     * treatment the buy menu's lists get, because they are the same
     * design.
     */
    scrollbar-width: thin;
    scrollbar-color: var(--opts-border) transparent;

    &::-webkit-scrollbar {
      width: 8px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: var(--opts-border);
      border-radius: 4px;
    }

    &::-webkit-scrollbar-thumb:hover {
      background: var(--opts-edge);
    }

    /*
     * The page takes the focus when the player changes page, so the
     * focus ring would draw a box around the whole window. The page
     * is a container, not a control — there is nothing to point at.
     */
    &:focus {
      outline: none;
    }

    &--stack {
      flex-direction: column;
      gap: 10px;
    }

    /* The readout lays itself out, and its own column scrolls. */
    &--perf {
      display: block;
      overflow: hidden;
    }
  }

  /* A CARD: the design's own card. */
  &__card {
    background: var(--opts-card);
    border: 1px solid var(--opts-border);
    border-radius: 10px;
    padding: 16px;

    &--stack {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      /*
       * The Controls card holds three sliders and the Apply button,
       * and it has to FIT the window with the Buy menu and Display
       * cards below it — so the rows are 12px apart rather than the
       * mockup's roomier 20. The mockup's frame had two cards; this
       * one has three.
       */
      gap: 12px;
    }

    /* A card with a label on one side and a control on the other. */
    &--split {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
  }

  &__card-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* THE SMALL LABEL: the design's own `.t`. */
  &__label {
    margin: 0;
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--opts-muted);

    &--spaced {
      margin-top: 6px;
    }
  }

  &__row-label {
    font-size: 15px;
    color: var(--opts-text);
  }

  /* A ROW: a label, a control, or a label and a control. */
  &__row {
    display: flex;
    align-items: center;
    gap: 16px;

    &--slider {
      .opts__row-label {
        width: 168px;
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
      }
    }

    &--end {
      justify-content: flex-end;
    }

    /* A row with a label on the left and a switch on the right. */
    &--switch {
      justify-content: space-between;
      gap: 16px;

      /* The label and its explanation are two lines. */
      .opts__row-label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
    }
  }

  /* THE SMALL SECONDARY LINE under a label. */
  &__row-effect {
    font-size: 12px;
    line-height: 1.4;
    color: var(--opts-muted);
  }

  /* THE "DEFAULT" CHIP: the number is the game's, not the player's. */
  &__chip {
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--opts-card-2);
    color: var(--opts-muted);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* THE SLIDER.
   *
   * A native range input, so the keyboard works on it (the arrow keys
   * move it, and it announces itself), drawn in the design's own
   * shape: a 6px track, a gold fill up to the thumb, and a round
   * thumb in the ink colour with a gold edge.
   */
  &__range {
    flex: 1;
    min-width: 0;
    height: 18px;
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;

    /* The track, with the fill painted up to the thumb's position. */
    &::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(
        to right,
        var(--opts-accent) 0%,
        var(--opts-accent) var(--fill, 0%),
        var(--opts-bar-bg) var(--fill, 0%),
        var(--opts-bar-bg) 100%
      );
    }

    &::-moz-range-track {
      height: 6px;
      border-radius: 3px;
      background: var(--opts-bar-bg);
    }

    &::-moz-range-progress {
      height: 6px;
      border-radius: 3px;
      background: var(--opts-accent);
    }

    /* The thumb: the ink colour, with the gold edge. */
    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 18px;
      height: 18px;
      margin-top: -6px;
      border-radius: 9px;
      background: var(--opts-text);
      border: 2px solid var(--opts-accent);
    }

    &::-moz-range-thumb {
      width: 18px;
      height: 18px;
      border-radius: 9px;
      background: var(--opts-text);
      border: 2px solid var(--opts-accent);
    }

    &:focus-visible {
      outline: none;

      &::-webkit-slider-thumb {
        box-shadow: 0 0 0 3px rgba(242, 184, 75, 0.35);
      }

      &::-moz-range-thumb {
        box-shadow: 0 0 0 3px rgba(242, 184, 75, 0.35);
      }
    }
  }

  /* THE TEXT FIELDS. */
  &__input {
    width: 100%;
    height: 44px;
    padding: 0 12px;
    background: var(--opts-card);
    border: 1px solid var(--opts-border);
    border-radius: 8px;
    color: var(--opts-text);
    font-family: var(--opts-font);
    font-size: 15px;

    &:focus {
      outline: none;
      border-color: var(--opts-accent);
      box-shadow: 0 0 0 3px rgba(242, 184, 75, 0.25);
    }

    &--num {
      width: 96px;
      flex: none;
    }
  }

  /* THE SELECTED CHARACTER, LARGE. */
  &__selected {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    width: 236px;
    flex: none;
    align-self: flex-start;
  }

  &__selected-portrait {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 150px;
    background: var(--opts-focus);
    border: 1px solid var(--opts-edge);
    border-radius: 10px;
    overflow: hidden;

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: auto;
    }
  }

  &__selected-empty {
    font-family: var(--opts-font-display);
    font-size: 64px;
    font-weight: 700;
    color: var(--opts-accent);
  }

  &__selected-name {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    text-align: center;
    color: var(--opts-text);
  }

  /* THE ROSTER: the picker's own component, in the game's colours. */
  &__roster {
    flex: 1;
    min-width: 0;

    /*
     * The picker's colours are the CALLER's, and the picker's own
     * styles live in its own scoped sheet — so these are set on the
     * wrapper and read by the child.
     */
    --picker-surface: var(--opts-card);
    --picker-edge: var(--opts-border);
    --picker-ink: var(--opts-muted);
    --picker-accent: var(--opts-accent);
    --picker-on-surface: var(--opts-focus);
    --picker-on-edge: var(--opts-accent);
    --picker-on-ink: var(--opts-accent);
    --picker-tile: var(--opts-focus);
    --picker-tile-size: 68px;
    --picker-font: var(--opts-font);
    --picker-name-size: 10px;
    --picker-gap: 8px;
    --picker-tile-pad: 8px 2px;
  }

  /* THE BUTTONS. */
  &__btn {
    min-height: 44px;
    padding: 0 20px;
    background: transparent;
    border: 1px solid var(--opts-edge);
    border-radius: 8px;
    color: var(--opts-text);
    font-family: var(--opts-font);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;

    &:hover:not(:disabled) {
      border-color: var(--opts-accent);
      color: var(--opts-accent);
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-accent);
      box-shadow: 0 0 0 1px var(--opts-accent);
    }

    /* The Apply button: the one filled button in the window, so it is
       the only one that reads as the primary action. */
    &--primary {
      min-height: 44px;
      padding: 0 32px;
      background: var(--opts-accent);
      border-color: var(--opts-accent);
      color: var(--opts-bg);
      font-size: 16px;
      font-weight: 600;

      &:hover:not(:disabled) {
        background: #f7c96a;
        border-color: #f7c96a;
        color: var(--opts-bg);
      }
    }
  }

  /* THE CLASSIC / MODERN SWITCH, and the fullscreen switch. */
  &__switch {
    display: inline-flex;
    border: 1px solid var(--opts-border);
    border-radius: 8px;
    overflow: hidden;
    flex: none;
  }

  &__switch-btn {
    min-height: 44px;
    padding: 0 18px;
    background: transparent;
    border: none;
    color: var(--opts-muted);
    font-family: var(--opts-font);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;

    &:hover {
      color: var(--opts-text);
    }

    &:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 1px var(--opts-accent);
    }

    /* The chosen side is the amber plate, with the ground colour as
       its label. */
    &.is-on {
      background: var(--opts-accent);
      color: var(--opts-bg);
      font-weight: 600;
    }

    /* The single-button switch: the fullscreen's own control. */
    &--single {
      min-width: 72px;
      border: 1px solid var(--opts-border);
      border-radius: 8px;
    }
  }
}
</style>
