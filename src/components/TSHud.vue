<template>
  <!--
    THE BUY PANEL.

    A view over the port's buy-menu state and an input device for it.
    The numbers (the budget, the slot count, the prices) are the game's
    — the port prints them — and a click is a key on the port's current
    page, which is the same `handle_key` the canvas menu runs. The
    browser computes nothing: it shows what the port says and asks the
    port to act.

    It is its own layer rather than part of the HUD block below,
    because the HUD's other fields are simulated (see the DEMO banner)
    and the panel has to be usable whether or not that block is on
    screen.
  -->
  <div
    v-if="showBuyPanel"
    class="ts-hud__buy-menu"
    data-buy-menu
    @keydown.stop
    @keyup.stop
    @keypress.stop
  >
    <div class="buy-menu__panel">
      <header class="buy-menu__head">
        <h2 class="buy-menu__title">BUY MENU</h2>
        <span class="buy-menu__page">{{ pageName }}</span>
      </header>

      <!--
        The budget bar. Every number here is the port's: the budget,
        what the config costs (the ammo included, as the canvas's own
        total counts it) and the slots it takes.
      -->
      <div class="buy-menu__budget">
        <div class="buy-menu__bar">
          <div class="buy-menu__bar-fill" :style="{ width: budgetPercent + '%' }" />
        </div>
        <div class="buy-menu__budget-row">
          <span class="buy-menu__cell">
            <span class="buy-menu__cell-label">SPENT</span>
            <span class="buy-menu__cell-value">${{ spent.toLocaleString() }}</span>
          </span>
          <span class="buy-menu__cell">
            <span class="buy-menu__cell-label">LEFT</span>
            <span class="buy-menu__cell-value">${{ remaining.toLocaleString() }}</span>
          </span>
          <span class="buy-menu__cell">
            <span class="buy-menu__cell-label">SLOTS</span>
            <span class="buy-menu__cell-value">{{ slotsUsed }}<template v-if="slotLimit">/{{ slotLimit }}</template></span>
          </span>
        </div>
      </div>

      <!-- The page. The rows are the port's rows, in the port's order. -->
      <ul v-if="buyState.available" class="buy-menu__rows">
        <li
          v-for="(row, i) in buyState.rows"
          :key="i"
          class="buy-menu__row"
          :class="rowClass(row)"
        >
          <hr v-if="row.separator" class="buy-menu__sep" />
          <button
            v-else
            class="buy-menu__row-btn"
            type="button"
            :disabled="!row.key || row.dim"
            @click="activate(row)"
          >
            <span class="buy-menu__row-key">{{ keyBadge(row) }}</span>
            <span class="buy-menu__row-label">{{ row.text }}</span>
            <span class="buy-menu__row-price">{{ row.price ? '$' + row.price.toLocaleString() : '' }}</span>
          </button>
        </li>
      </ul>

      <!--
        No state yet. The port's commands only exist in a client build
        that carries them; until one does, the panel says so rather
        than showing an empty menu that looks broken.
      -->
      <div v-else class="buy-menu__notice">
        <p v-if="buyState.unsupported">
          This client build has no buy-menu bridge, so the panel has nothing to read. The
          game's own menu is being used instead.
        </p>
        <p v-else>Waiting for the game's buy menu…</p>
      </div>

      <footer class="buy-menu__foot">
        Click a row, or press its number · B closes the panel
      </footer>
    </div>
  </div>

  <!--
    The bridge is not there. The game's own menu still works (the
    hidden flag was never set), so this is a notice rather than an
    error — and it says where the switch is.
  -->
  <div v-if="showBridgeNotice" class="ts-hud__buy-menu ts-hud__buy-menu--notice" data-buy-menu-notice>
    <div class="buy-menu__notice-panel">
      <p class="buy-menu__notice-title">MODERN BUY MENU UNAVAILABLE</p>
      <p class="buy-menu__notice-body">
        This client build has no buy-menu bridge, so the panel has nothing to read. The game's
        own menu is being used instead — set <strong>Buy menu</strong> back to
        <strong>Classic</strong> in the options overlay (Esc, Esc).
      </p>
    </div>
  </div>

  <div v-if="visible && hudEnabled && !buyPanelOnly" class="ts-hud" data-tshud>
    <!-- D.7.57 — DEMO banner. cash / killfeed / weapon / class /
         fire-mode / team-scores are JS-animated placeholders until
         the engine bridge actually feeds them. Hard to mistake the
         simulation for real state when it tells you it's a simulation. -->
    <div class="ts-hud__demo-banner" role="note">DEMO — values shown below are simulated, not engine-fed</div>

    <!-- Top bar: cash (left), round timer + slowmo (center), round count (right) -->
    <div class="ts-hud__top">
      <div class="ts-hud__cash" :class="{ 'ts-hud__cash--flash': cashFlash }">
        <span class="cash-amount">${{ cash.toLocaleString() }}</span>
        <span class="cash-label">CASH</span>
      </div>
      <div class="ts-hud__round">
        <div class="round-timer" :class="{ 'round-timer--low': roundTimeRemaining < 30 }">
          {{ formatTime(roundTimeRemaining) }}
        </div>
        <div v-if="slowmatch" class="slowmo-indicator">
          <span class="slowmo-dot"></span>SLOW-MO
        </div>
        <div class="round-label">ROUND {{ roundCount }}</div>
      </div>
      <div class="ts-hud__teams">
        <div v-for="t in teams" :key="t.id" class="team-pill" :style="{ backgroundColor: t.color }">
          {{ t.shortName }}<span class="team-score">{{ t.score }}</span>
        </div>
      </div>
    </div>

    <!-- Bottom bar: weapon mode + ammo (left), buy menu (center), class info (right) -->
    <div class="ts-hud__bottom">
      <div class="ts-hud__weapon">
        <span class="weapon-name">{{ currentWeapon }}</span>
        <span v-if="fireMode" class="weapon-mode">{{ fireModeLabel(fireMode) }}</span>
      </div>
      <div class="ts-hud__buy-trigger">
        <kbd>B</kbd>
        <span class="buy-hint">BUY · FIREMODE · USEITEMS · ALT2</span>
      </div>
      <div class="ts-hud__class">
        <span class="class-name">{{ className }}</span>
      </div>
    </div>

    <!-- D.7.28 live-state strip — real engine values, bottom-left -->
    <div class="ts-hud__livestate" data-livestate>
      <div class="ls-row">
        <span class="ls-key">MAP</span>
        <span class="ls-val">{{ mapName }}</span>
      </div>
      <div class="ls-row">
        <span class="ls-key">TEAMS</span>
        <span class="ls-val ls-val--dim">{{ teamList || '—' }}</span>
      </div>
      <div class="ls-row">
        <span class="ls-key">NAME</span>
        <span class="ls-val">{{ playerName || '—' }}</span>
      </div>
      <div v-if="missingSpawnEntities.length" class="ls-row ls-row--warn">
        <span class="ls-key">MISSING</span>
        <span class="ls-val ls-val--warn">{{ missingSpawnEntities.join(', ') }}</span>
      </div>
    </div>

    <!-- Killfeed (right side, vertical stack) -->
    <div v-if="showKillfeed" class="ts-hud__killfeed">
      <div
        v-for="k in killfeed.slice(-5)"
        :key="k.id"
        class="kf-entry"
        :class="`kf-entry--${k.team}`"
      >
        <span class="kf-attacker">{{ k.attacker }}</span>
        <span class="kf-icon">⊕</span>
        <span class="kf-victim">{{ k.victim }}</span>
      </div>
    </div>

    <!-- D.7.29 engine-error toast — replaces the engine's modal alert() -->
    <div v-if="engineAlert" class="ts-hud__alert" data-engine-alert>
      <span class="alert-tag">ENGINE</span>
      <span class="alert-msg">{{ engineAlert }}</span>
    </div>

    <!-- D.7.56 pump telemetry — REAL numbers, not literals. If the
         game loop is being driven from JS (see services/ts-pump.ts)
         this counts up at ~60Hz. It is the one honest proof that TS
         gameplay code is executing in the WASM. -->
    <div class="ts-hud__pump" data-pump-strip>
      <span class="pump-tag">GAMELOOP</span>
      <span class="pump-val" :class="{ 'pump-val--live': pumpStats.live }">
        {{ pumpStats.live ? `${pumpStats.hz}Hz` : 'idle' }}
      </span>
      <span class="pump-ticks">{{ pumpStats.ticks }} ticks</span>
      <span v-if="pumpStats.lastError" class="pump-err">err</span>
    </div>

    <!-- Slow-mo flash when round timer hits zero (placeholder for visual interest) -->
    <div v-if="slowmoFlash" class="ts-hud__slowmo-flash" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeMount, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useXashStore } from '/@/stores/store.ts'
import { startLiveState, onLiveState } from '/@/services/live-state.ts'
import { overlayOpen } from '/@/services/escape-gate'
import { startKeyboardBridge, tryAttachMouseBridge, setBridgeSuspended } from '/@/services/keyboard-bridge.ts'
import XashLoader from '/@/services/xash-loader'
import { tsPump } from '/@/services/ts-pump.ts'
import {
  buyMenuState,
  requestBuyState,
  sendBuyKey,
  startBuyMenuBridge,
  stopBuyMenuBridge,
  type BuyRow,
} from '/@/services/buy-menu.ts'

/**
 * `buyPanelOnly` mounts the panel without the rest of the HUD.
 *
 * The HUD's other fields are simulated (the DEMO banner says so), and
 * they stay behind their own flag. The buy panel does not: it reads
 * the game's own state, so it can be on screen without them — and it
 * has to be, because the HUD is off by default (D.7.37) and the panel
 * is a menu, not a readout.
 */
const props = defineProps<{ buyPanelOnly?: boolean }>()

const store = useXashStore()
const { tsConfig, showXashSettingUI } = storeToRefs(store)

// D.7.30 — diagnostic isolation switch. ?nohud=1 in the URL
// prevents the overlay from mounting entirely, so we can prove
// whether the HUD overlay is intercepting keyboard events (vs.
// the engine itself being keyboard-dead for an unrelated reason).
// Read once, before mounting — no runtime toggle.
const hudEnabled = ref(true)
onBeforeMount(() => {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('nohud') === '1') hudEnabled.value = false
  } catch (_) { /* no window.location in non-DOM contexts */ }
})

// === The modern buy panel ===============================================

/**
 * The port's state.
 *
 * The panel is a VIEW of this and an INPUT DEVICE for it: the numbers
 * are the port's, and the only thing the panel sends back is a key.
 */
const buyState = buyMenuState

/** The player wants the DOM panel rather than the game's own menu. */
const modernBuyMenu = computed(() => tsConfig.value?.buyMenu === 'modern')

/**
 * The player closed the panel while the game's own menu stayed open.
 *
 * The port's menu is the state machine and it keeps running: the
 * classic menu's own "cancel" row is the only thing that closes it, and
 * the player may not want to walk the menu back to that row to close a
 * browser panel. So the panel has one flag of its own — "not right
 * now" — and the port is told nothing about it.
 */
const buyMenuDismissed = ref(false)

/**
 * The panel is up when the game's own menu is open.
 *
 * The port opens its menu by itself when the player becomes an observer
 * (that is the observer effect the canvas menu has always had), so the
 * panel opens with it. The player can also open the panel with B.
 */
const showBuyPanel = computed(
  () => hudEnabled.value && modernBuyMenu.value && !buyMenuDismissed.value && buyState.open,
)

/**
 * The bridge is not there: this client build does not carry the port's
 * buy-menu commands.
 *
 * The game's own menu keeps working in that case (the hidden flag was
 * never set), so this is a notice, not an error.
 */
const showBridgeNotice = computed(
  () => modernBuyMenu.value && buyState.bridgeMissing && !showBuyPanel.value,
)

// === Reactive state — fed by the engine via stdout intercept ===
const cash = ref(850)
const roundTimeRemaining = ref(178)
const roundCount = ref(1)
const slowmatch = ref(tsConfig.value.slowmatch)
const currentWeapon = ref('Desert Eagle')
const fireMode = ref(0) // 0=semi 1=burst 2=auto
const className = ref('Soldier')
const slowmoFlash = ref(false)

interface Team { id: number; shortName: string; score: number; color: string }
const teams = ref<Team[]>([
  { id: 0, shortName: 'SEALS', score: 0, color: 'rgba(60,120,200,0.7)' },
  { id: 1, shortName: 'MERC', score: 0, color: 'rgba(180,60,60,0.7)' },
  { id: 2, shortName: 'GORD', score: 0, color: 'rgba(180,140,60,0.7)' },
  { id: 3, shortName: 'AGENT', score: 0, color: 'rgba(60,160,90,0.7)' },
])

interface KillfeedEntry { id: number; attacker: string; victim: string; team: 'red'|'blue' }
const killfeed = ref<KillfeedEntry[]>([
  { id: 1, attacker: 'Lombardi', victim: 'Orgasmo', team: 'red' },
  { id: 2, attacker: 'Winters', victim: 'Mason', team: 'blue' },
])

/**
 * D.7.36 — release pointer lock while the buy menu is open, take it
 * back on close.
 *
 * While the canvas holds pointer lock, the cursor is captured: real
 * mouse events go to the canvas no matter what DOM element is under
 * the (frozen, invisible) cursor position. So the buy menu's buttons
 * are literally unclickable — `elementFromPoint` reports the button,
 * but the browser delivers the click to the canvas. Verified:
 * `document.pointerLockElement === canvas` while the menu is open.
 *
 * So opening the menu must exit the lock, and closing it must
 * re-acquire (which browsers only allow from a user gesture, hence
 * the close is done straight off the B/ESC keypress).
 */
const hadPointerLock = ref(false)

function syncPointerLock() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null
  if (!canvas) return
  if (showBuyPanel.value) {
    if (document.pointerLockElement === canvas) {
      hadPointerLock.value = true
      document.exitPointerLock()
    }
  } else if (hadPointerLock.value && document.pointerLockElement !== canvas) {
    // Best-effort; a rejection here just means the user has to click
    // the canvas again, which is the normal flow anyway.
    hadPointerLock.value = false
    canvas.requestPointerLock?.().catch(() => {})
  }
}

/** Enable the cheat channel the `give` command requires. */
function enableCheatChannel() {
  XashLoader.exec('set sv_cheats 1')
}

function fireModeLabel(mode: number): string {
  return ['SEMI', 'BURST', 'AUTO'][mode] || 'SEMI'
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// === Visibility flag — only show during gameplay, not in launcher ===
// showXashSettingUI flips to false once the engine has loaded and we
// hide the launcher UI. That's our "engine is running" signal.
const visible = computed(() =>
  !(showXashSettingUI?.value ?? true) && (tsConfig.value?.hudOverlay ?? true)
)
const showKillfeed = computed(() =>
  !(showXashSettingUI?.value ?? true) && (tsConfig.value?.killfeedOverlay ?? true)
)

// === The buy panel's keys ===============================================

/**
 * Open or close the panel.
 *
 * The engine binds "b" to "buy", and the port's `buy` command opens the
 * game's own menu — which is what the panel shows. So B is NOT ours to
 * take while the panel is closed: the engine has to see it, or the
 * port's menu never opens and the panel has nothing to draw.
 *
 * While the panel is open, B is ours: it closes the panel. The port's
 * menu stays open underneath — the classic menu's own "cancel" row is
 * the only thing that closes it, and that row is on the panel, one
 * click away.
 */
function toggleBuyMenu(): void {
  if (showBuyPanel.value) {
    buyMenuDismissed.value = true
  } else if (buyState.open) {
    // The game's menu is already open (the player closed the panel
    // with B a moment ago), and the engine's "buy" would do nothing:
    // the port refuses to open a menu that is already open. So the
    // panel opens on its own.
    buyMenuDismissed.value = false
  } else {
    // The game's menu is closed: leave the key to the engine. The port
    // opens its menu and prints its state, and the panel opens from
    // that.
    return
  }
  syncPointerLock()
}

/**
 * The panel's keys, taken before the engine sees them.
 *
 * The engine registers its key listener on `window`, so a key pressed
 * while the panel is open still reaches the game: "2" would switch the
 * weapon slot (and drive the hidden canvas menu), and "a" would walk
 * the player left. This listener is registered in the CAPTURE phase on
 * `window`, which runs before any bubble-phase listener on the same
 * node — and the engine registers its listener when the WASM boots,
 * which is after this component mounted. `stopImmediatePropagation()`
 * here therefore keeps the key out of the game.
 *
 * The escape gate is registered even earlier (at module load) and it
 * stops the event itself, so Escape is still the escape gate's: the
 * options overlay opens on the second Escape, as it always has.
 */
function onWindowKeyDown(e: KeyboardEvent): void {
  if (!modernBuyMenu.value) return
  // The options overlay is a modal with a text field in it, and it can
  // be open while the panel is (the game's own menu opens when the
  // player becomes an observer, and the panel is where the Classic /
  // Modern switch lives). While it is up, the keyboard is the
  // overlay's: taking "a" and the digits here would eat the letters
  // being typed into its name field.
  if (overlayOpen.value) return
  // A key typed into a field is the field's, whoever is open.
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return
  }
  const key = e.key.toLowerCase()

  if (key === 'b') {
    if (!showBuyPanel.value && !buyState.open) return // the engine opens the menu
    if (e.repeat) return // holding B is not a toggle
    e.stopImmediatePropagation()
    toggleBuyMenu()
    return
  }

  if (!showBuyPanel.value) return

  // The menu's keys: 1..9, "0" (which is key 10, the canvas's "go
  // back") and "a" (which is key 11 — the canvas draws the tenth
  // weapon row as "A").
  let menuKey = 0
  if (key >= '1' && key <= '9') menuKey = Number(key)
  else if (key === '0') menuKey = 10
  else if (key === 'a') menuKey = 11
  if (!menuKey) return

  e.stopImmediatePropagation()
  sendBuyKey(menuKey)
}

/**
 * A click is a key on the row's own page.
 *
 * The port is the state machine: it knows which page it is on and what
 * each row means. The row carries its own key AND the page that key
 * acts on, so the click sends both and the port does the rest — the
 * same `handle_key` the canvas menu runs.
 *
 * The page matters because the menu draws the columns of the page it
 * is on, and a row of a parent column answers on that column's own
 * page: the canvas's mouse picks the column the click was in. Clicking
 * the main column's "Buy" row while the weapons page is up means "buy",
 * not "pick weapon 2".
 *
 * A dim row is not actionable and sends nothing.
 */
function activate(row: BuyRow): void {
  if (!row.key || row.dim) return
  sendBuyKey(row.key, row.page)
}

/** The row's state, as the canvas draws it. */
function rowClass(row: BuyRow): string[] {
  const classes: string[] = []
  if (row.selected) classes.push('buy-menu__row--on')
  if (row.dim) classes.push('buy-menu__row--dim')
  if (row.unaffordable) classes.push('buy-menu__row--x')
  if (row.separator) classes.push('buy-menu__row--sep')
  return classes
}

/**
 * The number the canvas draws before the row's label.
 *
 * The port reports it: the key's own prefix ("1".."9", "0" for key 10,
 * "A" for key 11), or the entry's number in the remove column ("10"),
 * which is not a key at all.
 *
 * A row with no number of its own is one whose number is part of the
 * title (the saved slots, whose title carries the slot number), so the
 * key's own prefix is the number there.
 */
function keyBadge(row: BuyRow): string {
  if (row.number) return row.number
  if (row.key >= 1 && row.key <= 9) return String(row.key)
  if (row.key === 10) return '0'
  if (row.key === 11) return 'A'
  return ''
}

/** What the config costs, the ammo included — the canvas's own total. */
const spent = computed(() => buyState.total + buyState.ammoSpend)

/** What is left of the budget. */
const remaining = computed(() => buyState.budget - spent.value)

/** The budget bar, as a percentage of the budget. */
const budgetPercent = computed(() => {
  if (!buyState.budget) return 0
  return Math.max(0, Math.min(100, (spent.value / buyState.budget) * 100))
})

/** The inventory slots the config takes. */
const slotsUsed = computed(() => buyState.slots)

/**
 * The slot limit, if the port reported one.
 *
 * The port's state record carries the slots USED, not the limit, and
 * the limit belongs to the port (a ruleset can change it), so the panel
 * does not invent one: it shows the limit only when the port says what
 * it is.
 */
const slotLimit = computed(() => {
  const raw = buyState.raw
  for (const name of ['slot_limit', 'slots_limit', 'max_slots', 'slot_total']) {
    const value = Number(raw[name])
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
})

/** The page the port is on, as the panel's header names it. */
const pageName = computed(() => buyState.pageName)

// The port's menu closed: the next time it opens, the panel shows again.
watch(() => buyState.open, (open) => {
  if (!open) buyMenuDismissed.value = false
})

// The player switched menus: the panel goes with the modern mode, and
// comes back with it.
watch(modernBuyMenu, (modern) => {
  buyMenuDismissed.value = !modern
})

// The panel owns the keyboard and the mouse while it is open.
watch(showBuyPanel, (open) => {
  setBridgeSuspended(open)
  syncPointerLock()
})

onMounted(() => {
  // The panel's channel to the port: the engine's stdout, where the
  // port prints its state.
  startBuyMenuBridge()
  // Ask for the state once the engine is up (straight away if it
  // already is). The port answers on stdout and the panel draws it.
  XashLoader.onEngineUp(() => requestBuyState())

  // The panel's keys, taken before the engine's own listener sees them.
  window.addEventListener('keydown', onWindowKeyDown, { capture: true })

  if (props.buyPanelOnly) {
    // The panel is all this component is here for. The HUD's simulated
    // fields stay behind their own flag, and the input bridges are
    // installed by the component that owns the canvas (XashCanvas).
    return
  }

  // D.7.31 — keyboard→command bridge. The engine's SDL2 keydown
  // listener is registered on `window` but never fires, so we inject
  // the equivalent engine commands instead (+forward on W down,
  // -forward on W up, etc). Skip when ?nohud=1 is set, so the
  // isolation test still tells us whether the HUD is implicated.
  if (!(new URLSearchParams(window.location.search).get('nohud') === '1')) {
    // `give` is gated behind sv_cheats, and TS's own rules enable it
    // anyway (TSGameRules.enabledCheats). Turn it on at match start.
    enableCheatChannel();
    stopKeyboardBridge = startKeyboardBridge();
    // Mouse buttons ride a different SDL path than the keyboard, but
    // mouse LOOK already works — so bridge clicks through the same
    // command channel we use for keys.
    tryAttachMouseBridge();
  }

  // D.7.29 — engine alerts are shimmed out of alert() by xash-loader.ts
  // and re-emitted as 'xash:alert'. Show them as a non-modal toast so
  // the engine's rAF loop is never suspended (which killed the
  // keyboard).
  window.addEventListener('xash:alert', handleEngineAlert)

  // Subscribe to live state updates, then start the engine probe.
  // exec() no-ops if the engine bridge isn't up yet, so the boot
  // burst is retried on the first poll tick.
  liveUnsub = onLiveState((s) => {
    mapName.value = s.mapName || '(loading...)'
    teamList.value = s.teamList
    playerName.value = s.playerName
    hostFramerate.value = s.hostFramerate
    missingSpawnEntities.value = s.missingSpawnEntities.slice(-6)
    hasEngineGap.value = s.missingTsCvars.length > 0
  })

  // Start the engine-cvar probe.
  stopLiveState = startLiveState()
  // D.7.56 — sample pump telemetry twice a second so the strip shows
  // a rate rather than a raw accumulating counter.
  pumpStatsTimer = window.setInterval(() => {
    pumpStats.value = tsPump.stats()
  }, 500)
  // Round timer ticks down every second while visible.
  // Real games feed this from the server via the engine's hud tick;
  // for the overlay demo we self-decrement (lands at 0, no UI bug
  // because buy-menu / cash panels are static).
  interval = window.setInterval(() => {
    if (roundTimeRemaining.value > 0) roundTimeRemaining.value--
    else slowmoFlash.value = !slowmoFlash.value
  }, 1000)

  // === D.7.55 — HUD demo ticker ===
  //
  // Makes the HUD visibly animate even when the engine hasn't fed
  // it multiplayer state yet (ca_connected not reached; see HANDOFF
  // R1 step 1). This is what proves the HUD is wired to the
  // store — without it, every visible number stays static and a
  // reader (K. or us) can't tell whether the HUD itself is broken
  // or whether the engine just isn't dispatching.
  //
  // Order of operations after the engine *does* feed real state:
  //   1. Pinia store gains e.g. hud.cash, hud.teamScore[4]
  //   2. ts-bridge.ts pipes cvar probes to those fields
  //   3. This ticker short-circuits when any pinia value arrives
  //      (replaced by a single `watch` on the pinia state)
  // Until then, simulate the visible feedback: cash increments,
  // team scores tick up, killfeed appends every ~6 s.
  const CLASSES = ['Soldier', 'Special Operative', 'Demolitions', 'Gunslinger', 'Marksman']
  const NAMES_A = ['Lombardi', 'Winters', 'Mason', 'Orgasmov', 'Vargas', 'Dietrich', 'Park']
  const NAMES_B = ['Maverick', 'Goose', 'Iceman', 'Jester', 'Merlin', 'Viper', 'Cougar']
  let demoTick = 0
  function rand<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)] }
  function flashCash(amount: number) {
    cash.value = Math.max(0, Math.min(9999, cash.value + amount))
  }
  // Cash fluctuates by $100 (kill bounty) every ~5 s; the engine
  // would normally deliver this via pfnServerPrint("+1 SEAL\n") or
  // a hud-text message.
  _cashBoostTimer = window.setInterval(() => {
    flashCash(Math.random() < 0.6 ? 150 : -50)
    demoTick++
    if (demoTick % 8 === 0) {
      // Cycle class & weapon every ~40 s so the player card moves
      const next = rand(CLASSES)
      if (next !== className.value) className.value = next
      const WEAPONS = ['Beretta', 'Desert Eagle', 'MP5', 'Anaconda', 'Combat Knife', 'SPAS-12']
      currentWeapon.value = rand(WEAPONS)
      fireMode.value = (fireMode.value + 1) % 3
    }
    if (demoTick % 12 === 0 && roundTimeRemaining.value < 30) {
      // Round ends, ROLLS over — roundCount increments, timer resets.
      roundCount.value = Math.min(99, roundCount.value + 1)
      roundTimeRemaining.value = 178
    }
  }, 5000)
  // Killfeed appends every ~9 s: red vs blue kill.
  _killfeedTimer = window.setInterval(() => {
    const team: 'red' | 'blue' = Math.random() < 0.5 ? 'red' : 'blue'
    const nextId = (killfeed.value[killfeed.value.length - 1]?.id ?? 0) + 1
    killfeed.value = [
      ...killfeed.value.slice(-9),
      { id: nextId, attacker: rand(NAMES_A), victim: rand(NAMES_B), team },
    ]
    // Bump that team's score (they got the kill).
    const idx = team === 'red' ? 0 : 1
    teams.value[idx].score++
  }, 9000)
})

let interval: number | null = null
let stopLiveState: (() => void) | null = null
let liveUnsub: (() => void) | null = null
let stopKeyboardBridge: (() => void) | null = null
// D.7.55 — demo-mode timer handles
let _cashBoostTimer: number | null = null
let _killfeedTimer: number | null = null

// D.7.28 — reactively driven live state mirror
const mapName = ref('(loading...)')
const teamList = ref('')
const playerName = ref('')
const hostFramerate = ref('')
const missingSpawnEntities = ref<string[]>([])
// D.7.35 — the counter flashes when a purchase is refused. The buy
// panel does not spend this cash any more (the port does), so nothing
// sets the flag today; the HUD's cash display keeps the hook.
const cashFlash = ref(false)
const hasEngineGap = ref(false)
// D.7.56 — pump telemetry. This is the honest signal for whether TS
// gameplay logic is actually running: `ts_pump_think` drives
// g_pGameRules->Think() in the WASM, so a nonzero tick count with a
// healthy Hz means TS game code is executing every frame, independent
// of the engine's broken loopback connect. Unlike the HUD literals
// above, this number is REAL — don't mistake it for decoration.
const pumpStats = ref({ ticks: 0, hz: 0, live: false, lastError: null as string | null })
let pumpStatsTimer: number | null = null

// D.7.29 — last engine alert, shown as a non-blocking toast.
const engineAlert = ref('')

function handleEngineAlert(e: Event) {
  const d = (e as CustomEvent).detail as { message?: string }
  if (d?.message) engineAlert.value = d.message.split('\n')[0].slice(0, 120)
  // Auto-clear after 12s so it doesn't linger.
  window.setTimeout(() => { engineAlert.value = '' }, 12000)
}

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeyDown, { capture: true })
  window.removeEventListener('xash:alert', handleEngineAlert)
  if (interval) window.clearInterval(interval)
  if (stopLiveState) stopLiveState()
  if (liveUnsub) liveUnsub()
  if (stopKeyboardBridge) stopKeyboardBridge()
  // D.7.55 — demo-mode timers
  if (_cashBoostTimer) window.clearInterval(_cashBoostTimer)
  if (_killfeedTimer) window.clearInterval(_killfeedTimer)
  if (pumpStatsTimer) window.clearInterval(pumpStatsTimer)
  setBridgeSuspended(false)
  stopBuyMenuBridge()
})

</script>

<style scoped lang="scss">
.ts-hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1000;
  font-family: 'Trebuchet MS', 'Helvetica Neue', sans-serif;
  color: #f4e3b0;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.85);
}

.ts-hud__top {
  position: absolute;
  top: 14px;
  left: 14px;
  right: 14px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 18px;
}

.ts-hud__cash {
  background: linear-gradient(180deg, rgba(60,40,0,0.85), rgba(20,10,0,0.7));
  border: 1px solid rgba(190,140,40,0.7);
  padding: 8px 14px;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.cash-amount {
  font-size: 28px;
  color: #ffd76e;
}
.cash-label {
  font-size: 11px;
  color: rgba(255,215,110,0.6);
  letter-spacing: 2px;
}

.ts-hud__round {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.round-timer {
  font-size: 36px;
  font-weight: 800;
  letter-spacing: 2px;
  color: #ffd76e;
  background: rgba(0,0,0,0.55);
  padding: 4px 12px;
  border-radius: 4px;
}
.round-timer--low {
  color: #ff6b3a;
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.slowmo-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 2px;
  color: #ff8c5a;
}
.slowmo-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #ff8c5a;
  animation: pulse 1.5s ease-in-out infinite;
}

.round-label {
  font-size: 10px;
  letter-spacing: 3px;
  color: rgba(255,215,110,0.5);
}

.ts-hud__teams {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.team-pill {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 4px 10px;
  border-radius: 12px;
  background: rgba(0,0,0,0.6);
  border: 1px solid rgba(255,255,255,0.15);
}
.team-score {
  font-size: 11px;
  margin-left: 4px;
  background: rgba(0,0,0,0.4);
  padding: 0 4px;
  border-radius: 4px;
}

.ts-hud__bottom {
  position: absolute;
  bottom: 16px;
  left: 14px;
  right: 14px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 18px;
}

.ts-hud__weapon,
.ts-hud__class {
  background: linear-gradient(180deg, rgba(20,10,0,0.85), rgba(60,40,0,0.7));
  border: 1px solid rgba(190,140,40,0.7);
  padding: 8px 14px;
}
.ts-hud__weapon { justify-self: start; }
.ts-hud__class { justify-self: end; }

.weapon-name, .class-name {
  font-size: 18px;
  color: #ffd76e;
  font-weight: 600;
}
.weapon-mode {
  display: block;
  font-size: 11px;
  letter-spacing: 2px;
  color: #ff8c5a;
  margin-top: 2px;
}

.ts-hud__buy-trigger {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: rgba(20,10,0,0.4);
  padding: 6px 14px;
  border-radius: 4px;
}
.ts-hud__buy-trigger kbd {
  background: rgba(190,140,40,0.7);
  color: #1a0c00;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 700;
}
.buy-hint {
  font-size: 9px;
  letter-spacing: 1.5px;
  color: rgba(255,215,110,0.6);
}

/* The modern buy panel.

   Its own layer, above the HUD: the HUD's other fields are simulated
   (see the DEMO banner) and the panel has to be usable with or
   without them. It sits at the LEFT, where the canvas menu's category
   column sits, so the two read as one menu in two skins. */
.ts-hud__buy-menu {
  position: absolute;
  inset: 0;
  z-index: 1001;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: 24px;
  /* The layer takes no clicks; the panel inside it does. */
  pointer-events: none;
  font-family: 'Trebuchet MS', 'Helvetica Neue', sans-serif;
  color: #f4e3b0;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.85);
}

.buy-menu__panel {
  pointer-events: auto;
  width: 340px;
  max-width: calc(100vw - 48px);
  max-height: 88vh;
  overflow-y: auto;
  background: linear-gradient(180deg, rgba(38,24,0,0.96) 0%, rgba(16,9,0,0.96) 100%);
  border: 1px solid rgba(190,140,40,0.8);
  box-shadow: 0 10px 40px rgba(0,0,0,0.85);
}

.buy-menu__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid rgba(190,140,40,0.45);
}
.buy-menu__title {
  margin: 0;
  font-size: 14px;
  letter-spacing: 3px;
  color: #ffd76e;
}
.buy-menu__page {
  font-size: 11px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: rgba(255,215,110,0.65);
}

/* The budget bar. The numbers in it are the port's. */
.buy-menu__budget {
  padding: 10px 14px 6px;
}
.buy-menu__bar {
  height: 6px;
  background: rgba(0,0,0,0.6);
  border: 1px solid rgba(190,140,40,0.35);
}
.buy-menu__bar-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(190,140,40,0.9), rgba(255,215,110,0.95));
  transition: width 0.15s linear;
}
.buy-menu__budget-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
.buy-menu__cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.buy-menu__cell-label {
  font-size: 9px;
  letter-spacing: 1.5px;
  color: rgba(255,215,110,0.5);
}
.buy-menu__cell-value {
  font-size: 15px;
  font-weight: 700;
  color: #ffd76e;
  font-variant-numeric: tabular-nums;
}

/* The rows: the port's rows, in the port's order. */
.buy-menu__rows {
  list-style: none;
  margin: 4px 0 0;
  padding: 0 8px 8px;
}
.buy-menu__row {
  margin: 0;
}
.buy-menu__row-btn {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid transparent;
  color: #f4e3b0;
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.buy-menu__row-btn:hover:not(:disabled) {
  background: rgba(190,140,40,0.16);
  border-color: rgba(190,140,40,0.4);
}
.buy-menu__row-btn:focus-visible {
  outline: none;
  border-color: #ffd76e;
}
.buy-menu__row-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: rgba(190,140,40,0.25);
  border: 1px solid rgba(190,140,40,0.5);
  color: #ffd76e;
  font-size: 11px;
  font-weight: 700;
}
.buy-menu__row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.buy-menu__row-price {
  color: #ffd76e;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* The canvas's own row states, drawn the same way. */
.buy-menu__row--on .buy-menu__row-btn {
  background: rgba(190,140,40,0.28);
  border-color: rgba(255,215,110,0.6);
}
.buy-menu__row--on .buy-menu__row-label {
  color: #fff3d0;
}
.buy-menu__row--x .buy-menu__row-label,
.buy-menu__row--x .buy-menu__row-price {
  text-decoration: line-through;
  color: #ff6b3a;
}
.buy-menu__row--dim .buy-menu__row-btn {
  opacity: 0.45;
  cursor: default;
}
.buy-menu__sep {
  border: none;
  border-top: 1px solid rgba(190,140,40,0.3);
  margin: 6px 8px;
}

.buy-menu__notice {
  padding: 14px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255,215,110,0.8);
}
.buy-menu__foot {
  padding: 8px 14px 10px;
  border-top: 1px solid rgba(190,140,40,0.3);
  font-size: 10px;
  letter-spacing: 0.5px;
  color: rgba(255,215,110,0.5);
}

/* The notice that the bridge is not there. */
.ts-hud__buy-menu--notice {
  align-items: flex-start;
  padding-top: 64px;
}
.buy-menu__notice-panel {
  pointer-events: auto;
  width: 340px;
  max-width: calc(100vw - 48px);
  padding: 12px 14px;
  background: linear-gradient(180deg, rgba(60,26,0,0.95), rgba(24,10,0,0.95));
  border: 1px solid rgba(255,140,60,0.6);
  box-shadow: 0 10px 40px rgba(0,0,0,0.85);
}
.buy-menu__notice-title {
  margin: 0 0 6px;
  font-size: 12px;
  letter-spacing: 2px;
  color: #ff9b5a;
}
.buy-menu__notice-body {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255,215,180,0.85);
}

.ts-hud__cash--flash {
  animation: cashDenied 0.4s ease-out;
}
@keyframes cashDenied {
  0%, 100% { background: rgba(10,10,14,0.72); }
  50% { background: rgba(190, 40, 40, 0.85); }
}

/* D.7.29 engine-error toast */
/* D.7.56 — pump telemetry strip. Lives top-left under the cash
   bar, deliberately dim. The bright green live state is the only
   thing that should catch your eye — it means TS gameplay code in
   the WASM is actually being ticked. */

.ts-hud__pump {
  position: absolute;
  /* The bottom-left is occupied by the weapon card (MP5 / BURST),
     so the pump strip moved to top-left beneath the cash bar.
     `top` matches the height of the cash block (`ts-hud__top`); 8px
     below gives a small gap that reads as alignment. */
  top: 64px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 9px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(244, 227, 176, 0.18);
  border-radius: 3px;
  font-size: 10px;
  letter-spacing: 0.06em;
  opacity: 0.65;
  z-index: 5;
}

.pump-tag {
  color: rgba(244, 227, 176, 0.55);
  font-weight: 700;
}

.pump-val {
  color: rgba(244, 227, 176, 0.8);
  font-variant-numeric: tabular-nums;
}

.pump-val--live {
  color: #6ee06e;
  font-weight: 700;
}

.pump-ticks {
  color: rgba(244, 227, 176, 0.4);
  font-variant-numeric: tabular-nums;
}

.pump-err {
  color: #ff6b6b;
  font-weight: 700;
}

/* D.7.57 — DEMO banner. Loud on purpose: everything it covers is a
   JS placeholder, and on 2026-10-21 both Kyle and I read the
   simulated killfeed/team-scores as evidence that bots were running.
   They weren't — the names come from a hardcoded array in the demo
   ticker. The fix for that confusion is to say so on screen rather
   than to rely on remembering which field is real. */
.ts-hud__demo-banner {
  position: absolute;
  top: 4px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 2px 10px;
  background: rgba(180, 60, 0, 0.85);
  border: 1px solid rgba(255, 190, 120, 0.5);
  border-radius: 2px;
  color: #ffe0c0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
}

.ts-hud__alert {
  position: absolute;
  top: 74px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  background: rgba(120,20,0,0.88);
  border: 1px solid rgba(255,110,60,0.75);
  border-left: 4px solid #ff6b3a;
  padding: 7px 14px;
  font-size: 11px;
  font-family: monospace;
  animation: alertIn 0.25s ease-out;
  pointer-events: none;
}
.alert-tag {
  color: #ff8c5a;
  font-weight: 700;
  letter-spacing: 1.5px;
  font-size: 10px;
  flex-shrink: 0;
}
.alert-msg {
  color: #ffd9c9;
  word-break: break-word;
}
@keyframes alertIn {
  from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

/* D.7.28 live-state strip */
.ts-hud__livestate {
  position: absolute;
  top: 50%;
  right: 14px;
  transform: translateY(-50%);
  background: rgba(0,0,0,0.55);
  border: 1px solid rgba(190,140,40,0.35);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 260px;
  font-size: 10px;
}
.ls-row { display: flex; gap: 8px; align-items: baseline; }
.ls-key {
  color: rgba(255,215,110,0.5);
  letter-spacing: 1.5px;
  min-width: 46px;
  flex-shrink: 0;
}
.ls-val {
  color: #ffd76e;
  font-family: monospace;
  word-break: break-all;
}
.ls-val--dim { color: rgba(255,215,110,0.45); }
.ls-row--warn .ls-val--warn {
  color: #ff8c5a;
  font-size: 9px;
}

/* Killfeed */
.ts-hud__killfeed {
  position: absolute;
  top: 90px;
  right: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
}
.kf-entry {
  font-size: 12px;
  padding: 3px 8px;
  background: rgba(0,0,0,0.5);
  border-left: 3px solid rgba(255,255,255,0.2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.kf-entry--red { border-left-color: #ff6b3a; }
.kf-entry--blue { border-left-color: #5a9bff; }
.kf-icon { opacity: 0.6; font-weight: bold; }

.ts-hud__slowmo-flash {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle, rgba(255,140,90,0.15) 0%, transparent 60%);
  pointer-events: none;
  animation: flash 0.4s ease-in;
}
@keyframes flash {
  from { opacity: 1; }
  to { opacity: 0; }
}
</style>
