<template>
  <div v-if="visible && hudEnabled" class="ts-hud" data-tshud>
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

    <!-- Buy menu overlay -->
    <div v-if="showBuyMenu" class="ts-hud__buy-menu" data-buy-menu>
      <div class="buy-menu__panel">
        <h2>THE SPECIALISTS — BUY MENU</h2>
        <div class="buy-menu__categories">
          <button
            v-for="cat in buyCategories"
            :key="cat.key"
            class="buy-cat"
            :class="{ 'buy-cat--active': activeCategory === cat.key }"
            @click="activeCategory = cat.key"
          >
            {{ cat.label }}
          </button>
        </div>
        <div class="buy-menu__items">
          <button
            v-for="item in currentCategoryItems"
            :key="item.id"
            class="buy-item"
            :class="{ 'buy-item--owned': ownedWeapons.includes(item.name) }"
            :disabled="item.price > cash"
            @click="purchaseItem(item)"
          >
            <span class="buy-item__name">{{ item.name }}</span>
            <span class="buy-item__price">${{ item.price }}</span>
          </button>
        </div>
        <div class="buy-menu__footer">
          Press ESC to close · Press 1-{{ buyCategories.length }} to switch categories
        </div>
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
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useXashStore } from '/@/stores/store.ts'
import { startLiveState, onLiveState } from '/@/services/live-state.ts'
import { startKeyboardBridge, tryAttachMouseBridge, setBridgeSuspended } from '/@/services/keyboard-bridge.ts'
import XashLoader from '/@/services/xash-loader'
import { tsPump } from '/@/services/ts-pump.ts'
import { onBeforeMount } from 'vue'

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

// === Reactive state — fed by the engine via stdout intercept ===
const cash = ref(850)
const roundTimeRemaining = ref(178)
const roundCount = ref(1)
const slowmatch = ref(tsConfig.value.slowmatch)
const currentWeapon = ref('Desert Eagle')
const fireMode = ref(0) // 0=semi 1=burst 2=auto
const className = ref('Soldier')
const slowmoFlash = ref(false)
const showBuyMenu = ref(false)
const activeCategory = ref(0)

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

// === Buy menu data — TS-style weapon categories ===
// Pulled from TS decomp tools/decompile/output/*.ts, simplified. Real
// prices are stored in ts/purchase.txt or computed by server DLL — we
// can't know real prices without the WASM rebuild, so display placeholders.
// D.7.35 — each buy item now carries the engine command that actually
// grants it. The TS `buy` command doesn't exist without ts.dll, so we
// spend the cash in our own JS state and then issue the closest real
// HL1 equivalent via Cmd_ExecuteString. That makes the buy menu a
// working armory instead of decoration: buy a weapon, it appears in
// your hands and in slot<N>.
//
// `give` requires sv_cheats 1; TSGameRules.enabledCheats() is
// equivalent, so we enable it once at match start and leave it on.
const buyCategories = [
  {
    key: 0,
    label: 'PISTOLS',
    items: [
      { id: 'pistol_beretta', name: 'Beretta', price: 200, give: 'weapon_9mmhandgun' },
      { id: 'pistol_deserteagle', name: 'Desert Eagle', price: 650, give: 'weapon_357' },
      { id: 'pistol_anaconda', name: 'Anaconda', price: 850, give: 'weapon_357' },
    ],
  },
  {
    key: 1,
    label: 'SMGS',
    items: [
      { id: 'smg_uzi', name: 'Uzi', price: 700, give: 'weapon_9mmhandgun' },
      { id: 'smg_mp5', name: 'MP5', price: 1500, give: 'weapon_9mmAR' },
      { id: 'smg_p90', name: 'P90', price: 2350, give: 'weapon_9mmAR' },
    ],
  },
  {
    key: 2,
    label: 'RIFLES',
    items: [
      { id: 'rifle_ak47', name: 'AK-47', price: 2500, give: 'weapon_ak47' },
      { id: 'rifle_m4', name: 'M4', price: 3100, give: 'weapon_m4' },
      { id: 'rifle_sniper', name: 'M82 Sniper', price: 4000, give: 'weapon_m4' },
    ],
  },
  {
    key: 3,
    label: 'EQUIPMENT',
    items: [
      { id: 'eq_flashbang', name: 'Flashbang', price: 100, give: 'flashlight' },
      { id: 'eq_grenade', name: 'HE Grenade', price: 250, give: 'weapon_grenade' },
      { id: 'eq_armor', name: 'Body Armor', price: 650, give: 'item_armor' },
    ],
  },
]

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
function syncPointerLock() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null
  if (!canvas) return
  if (showBuyMenu.value) {
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  } else if (document.pointerLockElement !== canvas) {
    // Best-effort; a rejection here just means the user has to click
    // the canvas again, which is the normal flow anyway.
    canvas.requestPointerLock?.().catch(() => {})
  }
}

/** Enable the cheat channel the `give` command requires. */
function enableCheatChannel() {
  XashLoader.exec('set sv_cheats 1')
}

/** Purchase an item: deduct cash in JS state, then grant via engine. */
function purchaseItem(item: { id: string; name: string; price: number; give?: string }) {
  if (!item.give) return
  if (cash.value < item.price) {
    // Not enough cash — flash the counter.
    cashFlash.value = true
    window.setTimeout(() => { cashFlash.value = false }, 400)
    return
  }
  cash.value -= item.price
  enableCheatChannel()
  XashLoader.exec(`give ${item.give}`)
  if (item.id === 'eq_flashbang') XashLoader.exec('impulse 104')
  // Add to the owned-weapon strip so the player can see what they bought.
  ownedWeapons.value = [...new Set([...ownedWeapons.value, item.name])]
}

const currentCategoryItems = computed(() => buyCategories[activeCategory.value]?.items || [])

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

// === Keyboard handler — toggle buy menu ===
function handleKey(e: KeyboardEvent) {
  if (e.key === 'b' || e.key === 'B') {
    showBuyMenu.value = !showBuyMenu.value
    // D.7.36 — while the menu is open it owns the keyboard; otherwise
    // "2" would both switch category and send +slot2 to the engine.
    setBridgeSuspended(showBuyMenu.value)
    syncPointerLock()
  } else if (e.key === 'Escape' && showBuyMenu.value) {
    showBuyMenu.value = false
    setBridgeSuspended(false)
    syncPointerLock()
  } else if (showBuyMenu.value && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1
    if (idx < buyCategories.length) activeCategory.value = idx
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKey)

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
// D.7.35 — real purchases: track what the player has bought so the
// menu can mark it, and flash the counter when they can't afford it.
const ownedWeapons = ref<string[]>([])
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
  window.removeEventListener('keydown', handleKey)
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

/* Buy menu */
.ts-hud__buy-menu {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}
/* D.7.36 — `.ts-hud` sets `pointer-events: none` so engine clicks
   reach the canvas. That value INHERITS into children, so every
   interactive part of the buy menu has to opt back in explicitly or
   clicks fall straight through to the game. */
.buy-menu__panel {
  pointer-events: auto;
  background: linear-gradient(180deg, #2a1a00 0%, #160b00 100%);
  border: 2px solid rgba(190,140,40,0.8);
  padding: 24px 32px;
  min-width: 480px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.85);
}
.buy-menu__panel h2 {
  margin: 0 0 16px 0;
  font-size: 18px;
  letter-spacing: 3px;
  color: #ffd76e;
  text-align: center;
  border-bottom: 1px solid rgba(190,140,40,0.5);
  padding-bottom: 8px;
}
.buy-menu__categories {
  pointer-events: auto;
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.buy-cat {
  flex: 1;
  background: rgba(60,40,0,0.6);
  border: 1px solid rgba(190,140,40,0.5);
  color: #f4e3b0;
  padding: 6px 8px;
  font-size: 11px;
  letter-spacing: 1.5px;
  cursor: pointer;
}
.buy-cat--active {
  background: rgba(190,140,40,0.85);
  color: #1a0c00;
}
.buy-menu__items {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 14px;
}
.buy-item {
  pointer-events: auto;
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(40,25,0,0.7);
  border: 1px solid rgba(190,140,40,0.3);
  color: #f4e3b0;
  cursor: pointer;
  font-size: 13px;
}
.buy-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.buy-item__price {
  color: #ffd76e;
  font-weight: 600;
}
.buy-menu__footer {
  font-size: 10px;
  letter-spacing: 1px;
  color: rgba(255,215,110,0.5);
  text-align: center;
}

/* D.7.35 — purchased item marker + insufficient-funds flash */
.buy-item--owned {
  border-color: rgba(120, 220, 140, 0.7) !important;
  background: rgba(30, 70, 45, 0.55) !important;
}
.buy-item--owned .buy-item__name::after {
  content: ' ✓';
  color: #7fdc9a;
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
