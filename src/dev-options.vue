<!--
  THE DEV HARNESS.

  It mounts the real options overlay — the same component the game
  mounts — with a mocked engine and a mocked readout, so the design can
  be iterated on in a browser without a game session.

  The pages are driven by CLICKING THE PANEL'S OWN SIDEBAR, so the
  harness drives the real control and not a copy of it.

  The stage can be the mockup's own frame size (960 x 620, padding
  included) or the whole window, so the layout can be compared with
  the mockup side by side.
-->
<template>
  <div class="harness">
    <header class="harness__bar">
      <div class="harness__group">
        <span class="harness__label">Page</span>
        <button
          v-for="p in pages"
          :key="p"
          class="harness__btn"
          :class="{ 'harness__btn--on': page === p }"
          type="button"
          @click="go(p)"
        >
          {{ p }}
        </button>
      </div>

      <div class="harness__group">
        <span class="harness__label">State</span>
        <button
          v-for="s in states"
          :key="s.key"
          class="harness__btn"
          :class="{ 'harness__btn--on': state === s.key }"
          type="button"
          @click="state = s.key"
        >
          {{ s.label }}
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
          Mockup
        </button>
        <button
          class="harness__btn"
          :class="{ 'harness__btn--on': size === 'window' }"
          type="button"
          @click="size = 'window'"
        >
          Window
        </button>
      </div>
    </header>

    <div class="harness__stage" :class="{ 'is-frame': size === 'frame' }">
      <XashOptionsOverlay :report="report" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import XashOptionsOverlay from '/@/components/XashOptionsOverlay.vue';
import { buildPerfReport } from '/@/services/perf-check.ts';
import type { PerfFacts } from '/@/services/perf-check.ts';

/**
 * THE FIXTURES.
 *
 * The "slow" one is the design's own scenario, measured: a 120 Hz
 * panel, an engine that needs 31.08 ms against an 8.33 ms budget, and
 * 11% of the frames arriving late. The numbers in the mockup are the
 * numbers this fixture produces.
 */
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const GPU = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)';

function slowFacts(): PerfFacts {
  return {
    renderer: GPU,
    userAgent: CHROME,
    displayHz: 32,
    engineFps: 32,
    browserHz: 120,
    panelHz: 120,
    engineWorkMs: 31.08,
    sustainableFps: 32,
    capFps: 0,
    everyNth: 4,
    lateFrames: 26,
    measuredFrames: 240,
    dpr: 2,
    backingWidth: 3456,
    backingHeight: 2234,
    costMeasuredAt: 1760000032000,
    costSettled: true,
    gameStartAt: 1760000000000,
  };
}

function healthyFacts(): PerfFacts {
  return {
    ...slowFacts(),
    displayHz: 120,
    engineFps: 120,
    engineWorkMs: 4,
    sustainableFps: 212,
    everyNth: 1,
    lateFrames: 0,
  };
}

/** A client that is drawing in software: the worst case there is. */
function softwareFacts(): PerfFacts {
  return {
    ...slowFacts(),
    renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
  };
}

const states = [
  { key: 'slow', label: 'Slow', facts: slowFacts },
  { key: 'healthy', label: 'Healthy', facts: healthyFacts },
  { key: 'software', label: 'Software', facts: softwareFacts },
] as const;

type StateKey = (typeof states)[number]['key'];

const state = ref<StateKey>('slow');
const page = ref('Player');
const size = ref<'frame' | 'window'>('frame');

const pages = ['Player', 'Game', 'Performance'];

const report = computed(() => {
  const s = states.find((x) => x.key === state.value) ?? states[0];
  return buildPerfReport(s.facts());
});

/**
 * GO TO A PAGE, BY CLICKING THE PANEL'S OWN SIDEBAR.
 *
 * The harness drives the real control: the panel's page state is its
 * own, and a second copy of it in the harness would be a second thing
 * that can disagree with the first.
 */
function go(label: string): void {
  page.value = label;
  const buttons = Array.from(
    document.querySelectorAll('.opts__side-btn'),
  ) as HTMLElement[];
  const hit = buttons.find((b) => (b.textContent ?? '').trim().startsWith(label));
  hit?.click();
}

watch(state, () => {
  // The panel re-reads the report when the Performance page comes
  // forward, so the count line and the badge follow the fixture.
  if (page.value === 'Performance') go('Performance');
});

onMounted(() => {
  go(page.value);
});
</script>

<!--
  THE HARNESS PAGE'S OWN SCROLLBAR.

  The app's shell styles its window scrollbar (the shell's edge green),
  and the harness does not load the shell — so without this the
  screenshots carry the browser's white bar, which is not what the game
  looks like. The panel's own scrollbars are styled by the panel.
-->
<style>
html {
  scrollbar-width: thin;
  scrollbar-color: #33291d transparent;
}

html::-webkit-scrollbar {
  width: 10px;
}

html::-webkit-scrollbar-track {
  background: transparent;
}

html::-webkit-scrollbar-thumb {
  background: #33291d;
  border-radius: 5px;
}

html::-webkit-scrollbar-thumb:hover {
  background: #4a3d2b;
}
</style>

<style scoped>
.harness {
  min-height: 100vh;
  background: #0b0907;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  color: #f2e9d8;
}

.harness__bar {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid #2a241b;
  background: #14110d;
}

.harness__group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.harness__label {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #b3a68e;
}

.harness__btn {
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid #33291d;
  border-radius: 6px;
  background: transparent;
  color: #b3a68e;
  font-size: 13px;
  cursor: pointer;
}

.harness__btn--on {
  background: #f2b84b;
  border-color: #f2b84b;
  color: #14110d;
}

/*
 * THE STAGE.
 *
 * The overlay's layer is `position:absolute; inset:0`, so it needs a
 * positioned ancestor. In "mockup" mode the stage is the mockup's own
 * frame (960 x 620, padding included) and the panel is drawn at
 * exactly that size; in "window" mode the stage is the whole page.
 */
.harness__stage {
  position: relative;
  width: 100%;
  height: calc(100vh - 49px);
}

.harness__stage.is-frame {
  /* The mockup's frame PLUS the overlay layer's own 24px padding, so
     the panel is drawn at exactly 960 x 620 with a scale of 1 — the
     size the design specifies, measured, not scaled. */
  width: 1008px;
  height: 668px;
  margin: 0 auto;
  border: 1px solid #33291d;
  overflow: hidden;
}
</style>
