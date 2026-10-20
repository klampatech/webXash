<template>
  <div v-if="visible && hudEnabled" class="ts-hud" data-tshud>
    <!-- Top bar: cash (left), round timer + slowmo (center), round count (right) -->
    <div class="ts-hud__top">
      <div class="ts-hud__cash">
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
            :disabled="item.price > cash"
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

    <!-- Slow-mo flash when round timer hits zero (placeholder for visual interest) -->
    <div v-if="slowmoFlash" class="ts-hud__slowmo-flash" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useXashStore } from '/@/stores/store.ts'
import { startLiveState, onLiveState } from '/@/services/live-state.ts'
import { startKeyboardBridge, tryAttachMouseBridge } from '/@/services/keyboard-bridge.ts'
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
const buyCategories = [
  {
    key: 0,
    label: 'PISTOLS',
    items: [
      { id: 'pistol_beretta', name: 'Beretta', price: 200 },
      { id: 'pistol_deserteagle', name: 'Desert Eagle', price: 650 },
      { id: 'pistol_anaconda', name: 'Anaconda', price: 850 },
    ],
  },
  {
    key: 1,
    label: 'SMGS',
    items: [
      { id: 'smg_uzi', name: 'Uzi', price: 700 },
      { id: 'smg_mp5', name: 'MP5', price: 1500 },
      { id: 'smg_p90', name: 'P90', price: 2350 },
    ],
  },
  {
    key: 2,
    label: 'RIFLES',
    items: [
      { id: 'rifle_ak47', name: 'AK-47', price: 2500 },
      { id: 'rifle_m4', name: 'M4', price: 3100 },
      { id: 'rifle_sniper', name: 'M82 Sniper', price: 4000 },
    ],
  },
  {
    key: 3,
    label: 'EQUIPMENT',
    items: [
      { id: 'eq_flashbang', name: 'Flashbang', price: 100 },
      { id: 'eq_grenade', name: 'HE Grenade', price: 250 },
      { id: 'eq_armor', name: 'Body Armor', price: 650 },
    ],
  },
]

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
  } else if (e.key === 'Escape' && showBuyMenu.value) {
    showBuyMenu.value = false
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
  // Round timer ticks down every second while visible.
  // Real games feed this from the server via the engine's hud tick;
  // for the overlay demo we self-decrement (lands at 0, no UI bug
  // because buy-menu / cash panels are static).
  interval = window.setInterval(() => {
    if (roundTimeRemaining.value > 0) roundTimeRemaining.value--
    else slowmoFlash.value = !slowmoFlash.value
  }, 1000)
})

let interval: number | null = null
let stopLiveState: (() => void) | null = null
let liveUnsub: (() => void) | null = null
let stopKeyboardBridge: (() => void) | null = null

// D.7.28 — reactively driven live state mirror
const mapName = ref('(loading...)')
const teamList = ref('')
const playerName = ref('')
const hostFramerate = ref('')
const missingSpawnEntities = ref<string[]>([])
const hasEngineGap = ref(false)
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
.buy-menu__panel {
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

/* D.7.29 engine-error toast */
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
