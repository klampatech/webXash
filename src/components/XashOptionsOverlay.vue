<template>
  <div v-if="open" class="opts" role="dialog" aria-label="Game options">
    <!--
      @keydown.stop / @keyup.stop — keep the keyboard away from the GAME.

      The engine registers its key listener on `window` in the BUBBLE
      phase (measured with CDP's DOMDebugger.getEventListeners). A key
      typed into the name field bubbles up to `window` and the engine's
      HUD_Key_Event runs its bind table: typing "seal" would walk the
      player forward on the "s", reload on the "e" and duck on the "l".

      `stopPropagation()` (not `preventDefault`) is the right tool: it
      stops the event BEFORE it reaches `window`, so the engine never
      sees it, and the input's own default action — putting the
      character in the field — still happens. `preventDefault()` would
      stop the character from being typed at all.

      The capture-phase `keydown` on the panel is the belt to that
      braces: a key pressed while the panel has focus but not in a
      field must not reach the engine either.
    -->
    <div
      class="opts__panel"
      @keydown.stop
      @keyup.stop
      @keypress.stop
    >
      <header class="opts__head">
        <div class="opts__brand">
          <span class="opts__brand-mark" aria-hidden="true" />
          <h2 class="opts__title">Options</h2>
        </div>

        <!--
          THE TABS.

          Kyle asked for the readout to have its own tab: "We can have
          'Settings' and 'Your Client'". Two tabs, and that is all.

          WHY THE STRIP IS OUTSIDE THE SCROLL AREA. The strip is not in
          the scrolling body — it is fixed in the header, always
          visible. That is the whole point: the readout is long, and
          when it was the last group of the one long panel it pushed the
          Quit button — the one control a player reaches for when they
          want to LEAVE a match — down the scroll and out of sight.

          With the tabs the Quit button stays in the Session group of
          the Settings tab, the readout lives in the Your Client tab,
          and the way back to the way out is one click away whatever
          the readout says.

          WHY IT SHARES THE HEADER ROW. It used to be a row of its own
          under the header, and that row was the reason the Quit button
          ended up LOWER than it had been before the tabs: the strip
          cost the panel about fifty pixels of height, and the panel is
          centred, so half of that came straight off the top of the
          Quit button. Sharing the row costs ZERO extra height — the
          strip takes the space between the brand mark and the close
          button, which was empty anyway.

          IT IS A REAL TABLIST. `role="tablist"` on the strip,
          `role="tab"` + `aria-selected` + `aria-controls` on the buttons,
          `role="tabpanel"` + `aria-labelledby` on the panels, and a
          ROVING TABINDEX — the selected tab is the only one in the tab
          order — so the arrow keys can move between the tabs without
          walking the whole modal. Home and End jump to the ends, and the
          selection follows the focus.

          The ids are stable on purpose: the parent's test suite anchors
          on them.
        -->
        <div
          class="opts__tabs"
          role="tablist"
          aria-label="Options sections"
          @keydown="onTabKeydown"
        >
          <button
            id="opts-tab-settings"
            ref="settingsTabBtn"
            class="opts__tab"
            :class="{ 'opts__tab--on': activeTab === 'settings' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'settings'"
            aria-controls="opts-panel-settings"
            :tabindex="activeTab === 'settings' ? 0 : -1"
            @click="selectTab('settings')"
          >
            Settings
          </button>
          <button
            id="opts-tab-client"
            ref="clientTabBtn"
            class="opts__tab"
            :class="{ 'opts__tab--on': activeTab === 'client' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'client'"
            aria-controls="opts-panel-client"
            :tabindex="activeTab === 'client' ? 0 : -1"
            @click="selectTab('client')"
          >
            Your Client
          </button>
        </div>

        <button class="opts__close" type="button" aria-label="Close" @click="closeOverlay">✕</button>
      </header>

      <!--
        THE BODY IS THE ONLY PART THAT SCROLLS.

        The head and the strip stay where they are, so the Quit button
        is never below the fold and the tab strip is never below the
        fold either.
      -->
      <div class="opts__body">
        <!--
          THE SETTINGS TAB: everything the player can change, and the
          one control that ends the match.
        -->
        <section
          v-show="activeTab === 'settings'"
          id="opts-panel-settings"
          ref="settingsPanel"
          class="opts__panel-content"
          role="tabpanel"
          aria-labelledby="opts-tab-settings"
          tabindex="-1"
        >
        <!--
          THE FOCUS FIX (the bug: "typing in the input is not captured by
          the input").

          Measured against production on 2026-10-27: the DOM input was
          fine, and typing into it worked — but only AFTER a click. Open
          the overlay and type without clicking, and every keystroke went
          to <body> instead: the input never had focus, so the text went
          nowhere and the ENGINE ate the keys as game commands (a name
          containing "w" would walk the player forward).

          So the input is focused when the overlay opens, and the engine's
          view of the keyboard is suspended while it is open. The second
          half matters as much as the first: the engine's key listeners
          are on `window` (measured with CDP's DOMDebugger.getEventListeners
          — the engine registers keydown/keyup/keypress there), so a
          focused input does NOT stop the game from receiving the keys.
          `setBridgeSuspended` already exists for exactly this.
        -->
        <section class="opts__group">
          <h3 class="opts__legend">Identity</h3>
          <label class="opts__row">
            <span class="opts__label">Name</span>
            <input
              ref="nameInput"
              v-model="name"
              class="opts__input"
              type="text"
              maxlength="24"
              spellcheck="false"
              autocomplete="off"
              @keyup.enter="applyName"
            />
          </label>
          <button class="opts__btn" type="button" :disabled="!name.trim()" @click="applyName">
            Set name
          </button>

          <!--
            The character picker. TS's own options menu has one (the
            screenshot Kyle sent), and the models are the server's
            `mp_teammodels` list — see player-identity.ts for how the
            server treats a chosen model.
          -->
          <div class="opts__row opts__row--models">
            <span class="opts__label">Character</span>
            <div class="opts__models" role="group" aria-label="Character model">
              <button
                v-for="m in models"
                :key="m"
                class="opts__model"
                type="button"
                :class="{ 'opts__model--on': model === m }"
                :aria-pressed="model === m"
                @click="chooseModel(m)"
              >
                <!--
                  The picture is the GAME'S OWN PORTRAIT: the .bmp that
                  ships beside the model, with its flat backdrop made
                  transparent so the character sits on the panel.

                  It was a 3D render once. The renderer applied each
                  bone's bind-pose world matrix to vertices that already
                  carried their bind position, so the position was added
                  twice: one gordon vertex moved 67.7 units on a 22-unit
                  character, and the heads floated with the hands detached
                  from the arms. The portrait is correct and it is free.
                -->
                <img
                  class="opts__model-img"
                  :src="`/models/${m}.png`"
                  :alt="`${m} character preview`"
                  width="72"
                  height="72"
                  loading="lazy"
                />
                <span class="opts__model-name">{{ m }}</span>
              </button>
            </div>
          </div>
        </section>

        <section class="opts__group">
          <h3 class="opts__legend">Controls</h3>
          <label class="opts__row">
            <span class="opts__label">Sensitivity</span>
            <input
              v-model.number="sensitivity"
              class="opts__input opts__input--num"
              type="number"
              min="0.1"
              max="20"
              step="0.1"
            />
          </label>
          <label class="opts__row">
            <span class="opts__label">Field of view</span>
            <input
              v-model.number="fov"
              class="opts__input opts__input--num"
              type="number"
              min="30"
              max="160"
              step="1"
            />
          </label>
          <label class="opts__row">
            <span class="opts__label">Volume</span>
            <input
              v-model.number="volume"
              class="opts__input opts__input--num"
              type="number"
              min="0"
              max="1"
              step="0.05"
            />
          </label>
          <button class="opts__btn opts__btn--primary" type="button" @click="applySettings">Apply</button>
        </section>

        <!--
          THE BUY MENU.

          Two menus, one set of loadouts. 'Classic' is the game's own
          canvas menu, drawn by the client library. 'Modern' is the DOM
          panel: it reads the game's own prices, budget and slot count
          from the port and sends the game's own key presses, so a
          purchase behaves exactly as it does in the classic menu.

          The saved loadouts are the game's (`tsbuylist.tsa`), so
          switching never forks what the player has bought.
        -->
        <section class="opts__group">
          <h3 class="opts__legend">Buy menu</h3>
          <div class="opts__row">
            <span class="opts__label">Buy menu</span>
            <div class="opts__switch" role="radiogroup" aria-label="Buy menu style">
              <button
                v-for="mode in buyMenuModes"
                :key="mode"
                class="opts__switch-btn"
                :class="{ 'opts__switch-btn--on': buyMenu === mode }"
                type="button"
                role="radio"
                :aria-checked="buyMenu === mode"
                @click="setBuyMenu(mode)"
              >
                {{ mode === 'classic' ? 'Classic' : 'Modern' }}
              </button>
            </div>
          </div>
        </section>

        <section class="opts__group">
          <h3 class="opts__legend">Session</h3>
          <!--
            THE FULLSCREEN TOGGLE.

            The way in and out of the fullscreen, in one control, and it
            shows the state it would leave you in.

            Escape is not the way out any more: the browser takes that key
            for the fullscreen on the browsers that do not implement the
            Keyboard Lock API, and on Chromium it is the key that lets go
            of the MOUSE mid-match - which is what a player pressing
            Escape actually wants. The fullscreen is a deliberate choice
            from here, or "Quit" (which leaves the match and the fullscreen
            together).
          -->
          <div class="opts__row">
            <span class="opts__label">Fullscreen</span>
            <button
              class="opts__switch-btn"
              :class="{ 'opts__switch-btn--on': inFullscreen }"
              type="button"
              role="switch"
              :aria-checked="inFullscreen"
              @click="toggleFullscreen"
            >
              {{ inFullscreen ? 'On' : 'Off' }}
            </button>
          </div>
          <button class="opts__btn opts__btn--danger" type="button" @click="quitToWebUi">
            Quit
          </button>
        </section>
        </section>

        <!--
          THE READOUT, ON ITS OWN TAB.

          The landing page carries the same panel, as a tab. But the
          landing page is DESTROYED when the engine boots
          (`showXashSettingUI` goes false and never comes back), so the
          frame cost, the budget and the delivered frame rate were only
          ever measurable and never visible — the one number a player
          cannot get is the one that explains why the game feels slow.

          Here the game IS running, so the numbers are the live ones: the
          pacer's state and the engine's own frame cost.

          IT IS A TAB, NOT A GROUP, BECAUSE OF THE QUIT BUTTON. A readout
          that pushes the way out of a match below the fold is a readout
          that has cost the player something. Here the readout cannot
          push anything: it is in its own panel, the Quit button is in
          the Settings panel, and the strip that switches between them
          never scrolls away.

          The tab's label is the heading — the overlay's own legend for
          the readout is gone, because the strip says it already.
        -->
        <section
          v-show="activeTab === 'client'"
          id="opts-panel-client"
          ref="clientPanel"
          class="opts__panel-content"
          role="tabpanel"
          aria-labelledby="opts-tab-client"
          tabindex="-1"
        >
          <TSPerformance context="game" />
        </section>
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
import { readCvar, writeCvar } from '/@/services/engine-cvars';
import { logDebug } from '/@/services/debug-log';
import { setBridgeSuspended } from '/@/services/keyboard-bridge';
import TSPerformance from '/@/components/TSPerformance.vue';
import { applyBuyMenuMode, type BuyMenuMode } from '/@/services/buy-menu';
import { installPerfSessionWriter, savePerfSession } from '/@/services/perf-collect.ts';
import {
  TS_MODELS,
  applyModel,
  applyName as applyEngineName,
  displayName,
  engineModel,
  refreshIdentity,
} from '/@/services/player-identity';

const open = overlayOpen;

const name = ref('');
const model = ref('');
const sensitivity = ref<number | null>(null);
const fov = ref<number | null>(null);
const volume = ref<number | null>(null);

const models = TS_MODELS;
const nameInput = ref<HTMLInputElement | null>(null);

/**
 * THE TABS.
 *
 * Two of them: the settings, and the readout. The readout has its own
 * tab because it is the one LONG thing in this modal, and when it was
 * the last group of the one long panel it pushed the Quit button — the
 * one control a player reaches for when they want to leave a match —
 * down the scroll and out of sight.
 *
 * With the tabs, the Quit button is in the Session group of the
 * Settings tab, the readout is in the Your Client tab, and the strip
 * that switches between them sits OUTSIDE the scroll area, so the way
 * out is always one click away.
 */
type OptsTab = 'settings' | 'client';

/** The tabs, in the order the arrow keys walk them. */
const TAB_ORDER: OptsTab[] = ['settings', 'client'];

/** Which tab is showing. The overlay always OPENS on the settings. */
const activeTab = ref<OptsTab>('settings');

// The tab buttons and the panels, so the focus can be moved between
// them. The roving tabindex lives on the buttons; the panels carry
// `tabindex="-1"` so they can be focused programmatically.
const settingsTabBtn = ref<HTMLButtonElement | null>(null);
const clientTabBtn = ref<HTMLButtonElement | null>(null);
const settingsPanel = ref<HTMLElement | null>(null);
const clientPanel = ref<HTMLElement | null>(null);

function tabButton(tab: OptsTab): HTMLButtonElement | null {
  return tab === 'settings' ? settingsTabBtn.value : clientTabBtn.value;
}

function tabPanel(tab: OptsTab): HTMLElement | null {
  return tab === 'settings' ? settingsPanel.value : clientPanel.value;
}

/**
 * Switch tabs.
 *
 * The focus moves to the panel that was chosen, so a keyboard or a
 * screen-reader user lands in the thing they just picked instead of
 * being left at the top of the modal.
 *
 * The arrow keys are the exception: they keep the focus ON the strip
 * (the selection follows the focus there), so a player can keep
 * arrowing between the tabs instead of having to come back to the
 * strip for every switch.
 */
function selectTab(tab: OptsTab, focus: 'panel' | 'tab' = 'panel'): void {
  activeTab.value = tab;
  void nextTick(() => {
    if (focus === 'panel') {
      tabPanel(tab)?.focus();
    } else {
      tabButton(tab)?.focus();
    }
  });
}

/**
 * THE TAB STRIP'S KEYS.
 *
 * A tablist is not a row of buttons. ArrowLeft and ArrowRight move
 * between the tabs, Home and End jump to the ends, and the selection
 * follows the focus — which is what the roving tabindex is for: only
 * the selected tab is in the tab order, so Tab does not walk the strip
 * twice.
 */
function onTabKeydown(e: KeyboardEvent): void {
  const current = TAB_ORDER.indexOf(activeTab.value);
  let next = current;
  if (e.key === 'ArrowLeft') {
    next = (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
  } else if (e.key === 'ArrowRight') {
    next = (current + 1) % TAB_ORDER.length;
  } else if (e.key === 'Home') {
    next = 0;
  } else if (e.key === 'End') {
    next = TAB_ORDER.length - 1;
  } else {
    return;
  }
  e.preventDefault();
  selectTab(TAB_ORDER[next], 'tab');
}

// The buy menu's style. It lives in the store (and is persisted), but
// it is NOT a cvar: it is the port's `ts_buy_mode` command, a client
// library switch, so it never reaches the launch args.
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

/** Load the current values from the engine when the overlay opens. */
async function refresh() {
  const [s, f, v] = await Promise.all([
    readCvar('sensitivity'),
    readCvar('fov'),
    readCvar('volume'),
  ]);
  if (s !== null) sensitivity.value = Number(s);
  if (f !== null) fov.value = Number(f);
  if (v !== null) volume.value = Number(v);
  logDebug(`[opts] loaded sensitivity=${s} fov=${f} volume=${v}`);

  // The identity, too: the field starts with the name the player is
  // actually playing under, and the picker shows the current model.
  await refreshIdentity();
  name.value = displayName.value;
  model.value = engineModel.value;
}

/**
 * Open the overlay with the keyboard in the right place.
 *
 * The focus is the fix for "typing in the input is not captured by the
 * input" (measured: without a click, every keystroke went to <body>).
 * `nextTick` waits for the field to exist before focusing it.
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
  // THE OVERLAY ALWAYS OPENS ON THE SETTINGS.
  //
  // The name input lives in the Settings panel, and `focus()` on a
  // HIDDEN input fails SILENTLY — so if the overlay opened on the
  // readout tab, the name field would never take the focus, every
  // keystroke would go to <body>, and the engine would eat them as
  // game commands. That is the same class of bug the focus fix above
  // was about, so the tab is reset before the field is focused.
  activeTab.value = 'settings';
  void refresh();
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
});

function applySettings() {
  if (sensitivity.value !== null) writeCvar('sensitivity', sensitivity.value);
  if (fov.value !== null) writeCvar('fov', fov.value);
  if (volume.value !== null) writeCvar('volume', volume.value);
}

function applyName() {
  const n = name.value.trim();
  if (!n) return;
  if (applyEngineName(n)) {
    logDebug(`[opts] name set to "${n}"`);
  }
}

function chooseModel(m: string) {
  if (applyModel(m)) {
    model.value = m;
    logDebug(`[opts] model set to "${m}"`);
  }
}

/**
 * Is the page in fullscreen right now?
 *
 * The "Leave fullscreen" button is only useful when it is, and the
 * fullscreen can change without the overlay knowing (the browser's own
 * chrome can leave it), so it is tracked from the event.
 */
const inFullscreen = ref(isFullscreen());

function onFullscreenChange(): void {
  inFullscreen.value = isFullscreen();
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange));
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFullscreenChange));

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
});

onBeforeUnmount(() => {
  removeSessionWriter?.();
  removeSessionWriter = null;
});

/**
 * Leave the fullscreen.
 *
 * The keyboard lock claims Escape in Chromium, so a tap of Escape
 * releases the mouse instead of leaving the fullscreen (which is what
 * the player wants mid-match). This is the way out.
 */
/**
 * The fullscreen toggle.
 *
 * A click is a user gesture, and `requestFullscreen()` only works from
 * one - so this is the only way IN once the browser has taken the
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

/**
 * Leave the match and go back to the site.
 *
 * A full page load, not a state toggle: the engine's state lives in WASM
 * memory and on the server, and the honest way out of a match is to leave
 * it. The landing page is the site root.
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
.opts {
  /*
   * THE AMBER SCHEME — the GAME's palette, not the shell's.
   *
   * Everything else in this app is a phosphor-green operator terminal:
   * the landing page, the boot screen, the disconnect panel. This panel
   * is the exception, and it is not arbitrary: it opens INSIDE the
   * match, over the game's own amber HUD, so a green menu in the middle
   * of an amber game read as two systems fighting. The game's amber is
   * TS's own — `iTeamColors[0]`, rgb(255,170,0) — and these values are
   * sampled from the design mock Kyle sent, not eyeballed.
   *
   * The tokens are scoped here on purpose: the shell's `--ts-*` palette
   * is unchanged for every other surface, and this one panel gets the
   * game's.
   *
   *   --opts-ground   #13110d  the panel ground, and the text on amber
   *   --opts-surface  #1e1a14  inputs, buttons, card bodies
   *   --opts-raise    #292217  the character's portrait tile
   *   --opts-amber    #e9bb5f  THE accent: headings, selected states
   *   --opts-amber-dim #c5b381 the section legends
   *   --opts-ink      #f1e9da  body text
   *   --opts-ink-muted #b1a791 labels, unselected states
   *   --opts-edge     #493c22  field and card borders
   *   --opts-divider  #32291f  the hairlines between sections
   */
  --opts-ground: #13110d;
  --opts-surface: #1e1a14;
  --opts-raise: #292217;
  --opts-amber: #e9bb5f;
  --opts-amber-hot: #f2c87b;
  --opts-amber-dim: #c5b381;
  --opts-ink: #f1e9da;
  --opts-ink-muted: #b1a791;
  --opts-edge: #493c22;
  --opts-divider: #32291f;

  position: absolute;
  inset: 0;
  display: flex;
  /*
   * THE PANEL'S TOP EDGE IS ANCHORED, NOT CENTRED.
   *
   * The modal used to be one long panel — long enough to hit its
   * 88vh cap — and centred, so its top edge sat a fixed 4vh from the
   * top of the screen (6vh of panel, less the panel's own padding and
   * border). Centring a CONTENT-SIZED panel puts the top edge wherever
   * the content happens to end: switch from the Settings tab to the
   * readout and the whole modal jumped down half the height it lost.
   *
   * Anchoring the top puts it back where it was, and it costs the
   * panel nothing: the body scrolls, the head does not move, and the
   * Quit button stays exactly where it was.
   */
  align-items: flex-start;
  justify-content: center;
  padding-top: 4vh;
  background: rgba(19, 17, 13, 0.92);
  /* Above the HUD (1000) and the buy panel (1001): the overlay is a
     MODAL, and the panel can be open when the player reaches for the
     options (the game opens its own buy menu when the player becomes
     an observer). The panel's own toggle lives in here, so it has to
     be reachable. */
  z-index: 2000;

  &__panel {
    display: flex;
    flex-direction: column;
    width: min(28rem, 92vw);
    max-height: 88vh;
    padding: 1.1rem 1.2rem 1.3rem;
    background: var(--opts-ground);
    border: 1px solid var(--opts-edge);
    /* The buy menu's frame radius. The settings panel and the buy menu
       are both in-game surfaces, and one square and one rounded read as
       two different products. These are the same numbers the modern
       buy menu uses: 14 for the frame, 10 for a card, 8 for a row, a
       button or a tab, 6 for a key. */
    border-radius: 14px;
    box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.6);
    /* The PANEL does not scroll — the BODY does. The head and the tab
       strip stay where they are, so the strip (and with it the way back
       to the Settings tab) is never scrolled away. */
    overflow: hidden;
  }

  &__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* The head never shrinks: the body is the part that scrolls. */
    flex: none;
    /* The strip shares this row, so this gap is the whole separation
       between the header and the body. */
    margin-bottom: 0.55rem;
  }

  &__brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    /* The brand keeps its size: the strip takes what is left over. */
    flex: none;
  }

  /* The BB mark, masked so it takes the accent colour. */
  &__brand-mark {
    width: 9px;
    height: 21px;
    flex: none;
    background-color: var(--opts-amber);
    -webkit-mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
    mask: url('../assets/brand/bb-mark.svg') no-repeat center / contain;
  }

  &__title {
    margin: 0;
    font-family: var(--ts-font-display);
    font-size: 1.1rem;
    letter-spacing: 0.08em;
    color: var(--opts-amber);
    white-space: nowrap;
  }

  /* The close button.

     It used to carry a 1px border around a small glyph, which made it
     read as an empty text input rather than a button. So: no resting
     border, a real 2rem hit area, and the glyph optically centred
     instead of sitting on a text baseline.

     The resting state follows the panel's own idiom (`opts__model`,
     `opts__switch-btn`): a muted glyph over a faint lime wash, so the
     2rem footprint is visible without shouting. Hover lifts it to the
     lime and doubles the wash.

     The focus ring is the app's own phosphor ring (the same one
     `opts__input` and `opts__model` use), not the browser default.
     It stays square: the panel is a GoldSrc game panel, and sharp
     rectangles are its visual language.
  */
  &__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    min-height: 2rem;
    padding: 0;
    background: rgba(233, 187, 95, 0.08);
    border: none;
    border-radius: 8px;
    color: var(--opts-ink-muted);
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;

    &:hover {
      background: rgba(233, 187, 95, 0.16);
      color: var(--opts-amber);
    }

    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 1px var(--opts-amber);

      /* Forced colours force `box-shadow` to none, so the phosphor
         ring is gone. Keep an outline, or a keyboard user in Windows
         High Contrast gets nothing at all. */
      @media (forced-colors: active) {
        outline: 2px solid ButtonText;
        outline-offset: 2px;
      }
    }

    /* Same story at rest: forced colours paint no background and no
       box-shadow, and the border is gone, so the button would have no
       visible container. The outline is that container. */
    @media (forced-colors: active) {
      outline: 2px solid ButtonText;
      outline-offset: 2px;
    }
  }

  &__group {
    padding: 0.7rem 0 0.5rem;
    border-top: 1px solid var(--opts-divider);
  }

  /* THE TAB STRIP.

     It sits in the HEAD ROW, outside the scroll area, so it is always
     visible: the player can always get back to the Settings — and to
     the Quit button — in one click, whatever the readout says.

     It used to be a row of its own under the head, and that row was
     the reason the Quit button ended up LOWER than it had been before
     the tabs: the strip cost the panel about fifty pixels of height,
     and the panel is centred, so half of that came straight off the
     top of the Quit button. Sharing the row costs ZERO extra height —
     the strip takes the space between the brand mark and the close
     button, which was empty anyway. */
  &__tabs {
    display: flex;
    gap: 0.3rem;
    /* The strip takes the space between the brand and the close
       button, and it never shrinks out of the row: it is the way back
       to the Settings tab, and it has to be on screen at all times. */
    flex: 1 1 auto;
    min-width: 0;
  }

  /* A tab. The same shape as the character picker and the Classic /
     Modern switch, with the chosen one lit. */
  &__tab {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.26rem 0.5rem;
    background: var(--opts-surface);
    border: 1px solid var(--opts-edge);
    border-radius: 8px;
    color: var(--opts-ink-muted);
    font-family: var(--ts-font-mono);
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;

    &:hover {
      border-color: var(--opts-amber);
      color: var(--opts-ink);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-amber);
      box-shadow: 0 0 0 1px var(--opts-amber);
    }

    /* The chosen tab is the amber plate, with the ground colour as its
       label — the same idiom as `opts__switch-btn--on`. */
    &--on {
      background: var(--opts-amber);
      border-color: var(--opts-amber);
      color: var(--opts-ground);
    }
  }

  /* THE SCROLLING BODY.

     The only part of the modal that scrolls. The hairline that used to
     be under the tab strip lives here now: it is the separation
     between the fixed head and the scrolling body. */
  &__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    border-top: 1px solid var(--opts-divider);
  }

  /* A tab panel. */
  &__panel-content {
    padding-top: 0.7rem;

    /* The first group of a panel does not need its own rule: the tab
       strip's hairline already separates the strip from the body. */
    > .opts__group:first-child {
      padding-top: 0;
      border-top: none;
    }

    /* The panel is focused programmatically when a tab is chosen, so
       it needs a focus shape of its own — the browser's default blue
       ring does not belong in this palette. */
    &:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 1px rgba(233, 187, 95, 0.45);
    }
  }

  &__legend {
    margin: 0 0 0.5rem;
    font-family: var(--ts-font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--opts-amber-dim);
  }

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
    margin-bottom: 0.45rem;

    &--models {
      align-items: flex-start;
      flex-direction: column;
      gap: 0.4rem;
      margin-top: 0.7rem;
    }
  }

  &__label {
    font-size: 0.82rem;
    color: var(--opts-ink);
  }

  &__input {
    width: 9rem;
    padding: 0.28rem 0.45rem;
    background: var(--opts-surface);
    border: 1px solid var(--opts-edge);
    border-radius: 8px;
    color: var(--opts-ink);
    font-family: var(--ts-font-mono);
    font-size: 0.82rem;

    /* A phosphor focus ring: the field's own colour plus a halo, so the
       focus is unmistakable without a browser-default blue outline. */
    &:focus {
      outline: none;
      border-color: var(--opts-amber);
      box-shadow: 0 0 0 1px var(--opts-amber), 0 0 12px rgba(233, 187, 95, 0.25);
    }

    &--num {
      width: 6rem;
    }
  }

  /* The character picker. A wrapped row of small buttons, so all seven
     models are visible without a dropdown that hides them. */
  &__models {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  &__model {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.5rem;
    background: var(--opts-surface);
    border: 1px solid var(--opts-edge);
    border-radius: 10px;
    color: var(--opts-ink-muted);
    font-family: var(--ts-font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;

    &:hover {
      border-color: var(--opts-amber);
      color: var(--opts-ink);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-amber);
      box-shadow: 0 0 0 1px var(--opts-amber);
    }

    /* The chosen character: the game's amber for the border, the letter
       and the name. The card's own fill stays put — in the mock the
       selected card is the same dark tile with a lit edge. */
    &--on {
      border-color: var(--opts-amber);
      color: var(--opts-amber);
    }
  }

  // The character's own portrait, on transparent pixels.
  //
  // The game's portrait art has a flat grey backdrop, which is removed
  // so the character sits on the panel rather than on a grey card.
  // It is sized to the button, and `contain` keeps its aspect.
  //
  // `image-rendering` is `auto`, not `pixelated`: the portrait is
  // 164x200 and the box is 72px, so the nearest-neighbour downscale
  // threw away two thirds of it. The 3D render it replaced was square
  // and scaled cleanly, which is why it was `pixelated` then.
  &__model-img {
    display: block;
    width: 72px;
    height: 72px;
    object-fit: contain;
    image-rendering: auto;
    background: var(--opts-raise);
    border-radius: 10px;

    /* The old blacksteam theme puts a 2px grey-teal frame on EVERY img
       in the app (`img { border: solid 2px #7b8484 }`). It is not part
       of this palette, so the portrait takes the tile's edge instead —
       or nothing at all, which is what the mock shows: a warm square
       with the character in it. */
    border: none;
  }

  &__model-name {
    line-height: 1;
  }

  &__btn {
    margin-top: 0.35rem;
    padding: 0.35rem 0.7rem;
    background: var(--opts-surface);
    border: 1px solid var(--opts-edge);
    border-radius: 8px;
    color: var(--opts-ink);
    font-family: var(--ts-font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--opts-raise);
      border-color: var(--opts-amber);
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }

    /* The mock's Apply: a solid amber plate with the ground colour as
       the label. It is the only filled button in the panel, so it is
       the only one that reads as the primary action. */
    &--primary {
      background: var(--opts-amber);
      border-color: var(--opts-amber);
      color: var(--opts-ground);
      font-weight: 600;

      &:hover:not(:disabled) {
        background: var(--opts-amber-hot);
        border-color: var(--opts-amber-hot);
        color: var(--opts-ground);
      }
    }

    /* The Quit button stays red: it is the one control here that ends
       the session, and red is the system's danger colour in every
       palette it has. */
    &--danger {
      border-color: rgba(255, 92, 92, 0.5);
      color: #ffb4b4;

      &:hover:not(:disabled) {
        background: rgba(255, 92, 92, 0.16);
        border-color: #ff8b8b;
      }
    }
  }

  /* The Classic / Modern switch. Two states, so two buttons — the same
     shape as the character picker above, with the chosen one lit. */
  &__switch {
    display: inline-flex;
    border: 1px solid var(--opts-edge);
    border-radius: 8px;
    /* Clip the lit half to the container's own radius, so the selected
       side is a rounded plate and not a square block inside a rounded
       frame — which is what the mock shows. */
    overflow: hidden;
  }

  &__switch-btn {
    background: var(--opts-surface);
    border: none;
    border-right: 1px solid var(--opts-divider);
    color: var(--opts-ink-muted);
    font-family: var(--ts-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.28rem 0.75rem;
    cursor: pointer;

    &:last-child {
      border-right: none;
    }

    &:hover {
      color: var(--opts-ink);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--opts-amber);
      box-shadow: 0 0 0 1px var(--opts-amber);
    }

    /* The chosen side is the amber plate, with the ground colour as its
       label — the mock's Modern. */
    &--on {
      background: var(--opts-amber);
      color: var(--opts-ground);
    }
  }
}
</style>
