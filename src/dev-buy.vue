<!--
  THE DEV HARNESS.

  It mounts the real buy panel — the same component the game mounts —
  with mock data, so the design can be iterated on in a browser
  without a game session.

  The mock data is printed in the PORT'S OWN record format and fed
  through the real parser (services/buy-menu.mock.ts calls
  `feedBuyMenuRecords`, the same handler the engine's stdout uses), so
  what is on screen is what the panel would draw in a game, and a
  change to the parser shows up here first.

  Every screen and every row state is one click away, and the state is
  in the URL (?screen=browse&state=poor), so a particular state can be
  linked to.

  The stage can be the mockup's own frame size (960 x 620, padding
  included) or the whole window, so the layout can be compared with
  the mockup side by side.
-->
<template>
  <div class="harness">
    <header class="harness__bar">
      <div class="harness__group">
        <span class="harness__label">Screen</span>
        <button
          v-for="option in screens"
          :key="option"
          class="harness__btn"
          :class="{ 'harness__btn--on': screen === option }"
          type="button"
          @click="pickScreen(option)"
        >
          {{ screenLabel(option) }}
        </button>
      </div>

      <div class="harness__group">
        <span class="harness__label">State</span>
        <button
          v-for="option in stateOptions"
          :key="option.state"
          class="harness__btn"
          :class="{ 'harness__btn--on': state === option.state }"
          type="button"
          @click="pickState(option.state)"
        >
          {{ option.label }}
        </button>
      </div>

      <div class="harness__group">
        <span class="harness__label">Frame</span>
        <button
          class="harness__btn"
          :class="{ 'harness__btn--on': size === 'frame' }"
          type="button"
          @click="size = 'frame'"
        >
          960 × 620
        </button>
        <button
          class="harness__btn"
          :class="{ 'harness__btn--on': size === 'scaled' }"
          type="button"
          @click="size = 'scaled'"
        >
          scaled
        </button>
        <button
          class="harness__btn"
          :class="{ 'harness__btn--on': size === 'fill' }"
          type="button"
          @click="size = 'fill'"
        >
          fill the window
        </button>
      </div>

      <span class="harness__spacer"></span>
      <span class="harness__url">{{ url }}</span>
    </header>

    <main class="harness__main">
      <!-- The stage. The panel sizes itself with these variables: the
           mockup's frame is 960 x 620 with its padding included, so
           the frame mode drops the layer's padding. -->
      <div class="harness__stage" :class="`harness__stage--${size}`">
        <TSBuyMenuPanel :send-key="onKey" />
      </div>

      <aside class="harness__side">
        <h2 class="harness__h2">The keys the panel sent</h2>
        <ul class="harness__keys">
          <li v-for="(key, i) in keys" :key="i">{{ key }}</li>
          <li v-if="!keys.length" class="harness__muted">Nothing yet — click a row.</li>
        </ul>

        <h2 class="harness__h2">The port's records</h2>
        <p class="harness__muted harness__note">
          The mock data, in the port's own format, fed through the real parser.
        </p>
        <pre class="harness__records">{{ records.join('\n') }}</pre>
      </aside>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import TSBuyMenuPanel from '/@/components/TSBuyMenuPanel.vue'
import {
  applyMockBuyMenuRecords,
  mockScenarios,
  type MockState,
} from '/@/services/buy-menu.mock.ts'
import type { BuyMenuScreen } from '/@/services/buy-menu.ts'

/** The three screens of the modern flow. */
const screens: BuyMenuScreen[] = ['loadout', 'browse', 'attach']

function screenLabel(screen: BuyMenuScreen): string {
  if (screen === 'loadout') return 'Loadout'
  if (screen === 'browse') return 'Browse'
  return 'Attachments'
}

/** The state the tester is looking at. */
const screen = ref<BuyMenuScreen>('loadout')
const state = ref<MockState>('default')

/** The frame: the mockup's own size, scaled to the window, or the whole window. */
const size = ref<'frame' | 'scaled' | 'fill'>('frame')

/** The keys the panel sent, for the tester to see what it would ask the port. */
const keys = ref<string[]>([])

/** The records of the current scenario, shown beside the panel. */
const records = computed(() =>
  mockScenarios(screen.value).find((s) => s.state === state.value)?.records ?? [],
)

/** The scenarios of the current screen. */
const stateOptions = computed(() => mockScenarios(screen.value))

/** The URL of the current state, so it can be linked to. */
const url = computed(() => {
  const params = new URLSearchParams()
  params.set('screen', screen.value)
  params.set('state', state.value)
  return `dev-buy.html?${params.toString()}`
})

/**
 * Load the state out of the URL.
 *
 * `?screen=browse&state=poor` is the whole point: every screen and
 * every row state has a link, and a reload keeps it.
 */
function readUrl(): void {
  const params = new URLSearchParams(window.location.search)
  const wanted = params.get('screen')
  if (wanted === 'loadout' || wanted === 'browse' || wanted === 'attach') screen.value = wanted
  const wantedState = params.get('state')
  if (wantedState) {
    const found = mockScenarios(screen.value).find((s) => s.state === wantedState)
    if (found) state.value = found.state
  }
  const wantedSize = params.get('size')
  if (wantedSize === 'frame' || wantedSize === 'scaled' || wantedSize === 'fill') {
    size.value = wantedSize
  }
}

/**
 * Push the scenario's records into the real parser.
 *
 * The parser is the one the engine's stdout uses, so this is the
 * same code path a game session takes — the panel cannot tell the
 * difference.
 */
function apply(): void {
  keys.value = []
  applyMockBuyMenuRecords({ screen: screen.value, state: state.value })
}

function pickScreen(next: BuyMenuScreen): void {
  screen.value = next
  // The first scenario of the screen is its default state.
  const first = mockScenarios(next)[0]
  if (first) state.value = first.state
}

function pickState(next: MockState): void {
  state.value = next
}

/** The panel asked the port to run a key. */
function onKey(key: number, page?: number): void {
  keys.value.unshift(page === undefined ? `ts_buy_key ${key}` : `ts_buy_key ${key} ${page}`)
  if (keys.value.length > 40) keys.value.pop()
}

watch([screen, state], () => {
  apply()
  // Keep the URL in step, so the state can be copied out of the bar.
  const params = new URLSearchParams()
  params.set('screen', screen.value)
  params.set('state', state.value)
  window.history.replaceState(null, '', `?${params.toString()}`)
})

onMounted(() => {
  readUrl()
  apply()
})
</script>

<style scoped>
/*
  The app's own reset (assets/base.css) is not on this page, so the
  harness brings its own box sizing — and so does the panel, which is
  mounted by the app's reset as well as by this page.
*/
.harness,
.harness *,
.harness *::before,
.harness *::after {
  box-sizing: border-box;
}

.harness {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0b0907;
}

/* ---- the toolbar ---- */
.harness__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
  padding: 10px 16px;
  background: #14110d;
  border-bottom: 1px solid #33291d;
}

.harness__group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.harness__label {
  color: #b3a68e;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin-right: 4px;
}

.harness__btn {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid #33291d;
  border-radius: 6px;
  background: transparent;
  color: #b3a68e;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.harness__btn:hover {
  color: #f2e9d8;
  border-color: #4a3d2b;
}

.harness__btn--on {
  background: #f2b84b;
  border-color: #f2b84b;
  color: #14110d;
}

.harness__btn--on:hover {
  color: #14110d;
}

.harness__spacer {
  flex: 1;
}

.harness__url {
  color: #b3a68e;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
}

/* ---- the stage ---- */
.harness__main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  padding: 16px;
}

.harness__stage {
  position: relative;
  flex: 1;
  min-width: 0;
}

.harness__stage--frame {
  flex: none;
  width: 960px;
  height: 620px;
  /* The mockup's frame: 960 x 620 with the padding inside it. */
  --bm-w: 960px;
  --bm-h: 620px;
  --bm-pad: 0px;
}

.harness__stage--fill {
  --bm-w: 100%;
  --bm-h: 100%;
  --bm-pad: 0px;
}

/*
  The mockup's frame, SCALED to the window.

  This is what the game does on a big screen: the frame is the
  mockup's own 960 x 620 and the panel scales it to the viewport, so
  the type and the spacing grow together. The harness can show it.
*/
.harness__stage--scaled {
  --bm-w: 960px;
  --bm-h: 620px;
  --bm-pad: 0px;
}

/* ---- the side ---- */
.harness__side {
  width: 420px;
  flex: none;
  overflow-y: auto;
  padding: 12px 14px;
  background: #14110d;
  border: 1px solid #33291d;
  border-radius: 10px;
}

.harness__h2 {
  margin: 0 0 6px;
  font-family: 'Barlow Condensed', sans-serif;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #f2b84b;
}

.harness__muted {
  color: #b3a68e;
  font-size: 12px;
}

.harness__note {
  margin: 0 0 6px;
}

.harness__keys {
  list-style: none;
  margin: 0 0 18px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  color: #f2e9d8;
}

.harness__records {
  margin: 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #b3a68e;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
