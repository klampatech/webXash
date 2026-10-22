<template>
  <!-- Full-bleed boot screen. Replaces the old `half window` panel, whose
       Steam-style title bar and static <progress> strip read as broken
       during engine boot — that phase has no byte count to report, so the
       bar simply sat there looking hung.

       Everything here is fed by real await boundaries in XashLoader (see
       the BootPhase type), so each line is a fact about where the boot
       actually is, not a timer. -->
  <div class="ts-boot">
    <div class="ts-boot__grid" aria-hidden="true" />

    <div class="ts-boot__stage">
      <div
        class="ts-boot__ring"
        :class="{ 'is-indeterminate': percent == null, 'is-done': done }"
        role="progressbar"
        :aria-valuenow="percent ?? undefined"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="currentLabel"
      >
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ts-boot__ring-track" cx="60" cy="60" r="52" />
          <circle
            v-show="percent != null"
            class="ts-boot__ring-arc"
            cx="60"
            cy="60"
            r="52"
            :style="arcStyle"
          />
          <!-- Determinate phases still spin a faint tick. A bar that is
               holding at 97% while one 36MB archive member inflates and
               writes to the WASM filesystem looks broken; a rotating tick
               over a stalled arc reads as "working on a big piece". -->
          <g v-if="!done" class="ts-boot__ring-sweep" :class="{ 'is-dim': percent != null }">
            <line x1="60" y1="60" x2="60" y2="14" />
          </g>
        </svg>

        <div class="ts-boot__ring-center">
          <span v-if="done" class="ts-boot__pct ts-boot__pct--word">OK</span>
          <span v-else-if="percent != null" class="ts-boot__pct">
            {{ Math.round(percent) }}<i>%</i>
          </span>
          <span v-else class="ts-boot__pct ts-boot__pct--word">···</span>
        </div>
      </div>

      <h1 class="ts-boot__title">The Specialists</h1>
      <p class="ts-boot__phase">{{ currentLabel }}</p>
    </div>

    <ol class="ts-boot__log" aria-live="polite">
      <li
        v-for="step in steps"
        :key="step.id"
        class="ts-boot__log-row"
        :class="{
          'is-active': step.id === phase,
          'is-done': isDone(step.id),
        }"
      >
        <span class="ts-boot__log-mark" aria-hidden="true">
          {{ isDone(step.id) ? '■' : step.id === phase ? '▸' : '·' }}
        </span>
        <span class="ts-boot__log-text">{{ step.label }}</span>
      </li>
    </ol>

    <p class="ts-boot__foot">
      {{
        done
          ? 'Entering game'
          : 'First run downloads the game data — later runs are cached'
      }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useXashStore } from '/@/stores/store';
import type { BootPhase } from '/@/services/xash-loader.ts';

const store = useXashStore();
const { bootPhase, bootPercent } = storeToRefs(store);

/**
 * Order is NOT cosmetic: it is the order of the awaits in
 * XashLoader.startWithZip. `engine` and `filesystem` are the two long
 * unquantifiable ones — xash.wasm is ~3.9MB and the client side module
 * ~1.6MB, fetched and instantiated with no progress callback at all.
 */
const steps: { id: BootPhase; label: string }[] = [
  { id: 'download', label: 'Fetching game data' },
  { id: 'engine', label: 'Loading Xash3D engine' },
  { id: 'filesystem', label: 'Mounting game files' },
  { id: 'starting', label: 'Starting the engine' },
];

const phase = computed(() => bootPhase.value ?? 'download');

/**
 * Smoothed percentage.
 *
 * Two things this must not do, both of which it did:
 *
 *  1. Show fractions. The eased value is a float, so `{{ percent }}`
 *     rendered "37.56561154577637%". Always round at the point of
 *     display, never at the point of computation - the easing needs the
 *     precision.
 *  2. Lag a phase behind and then "skip". An ease proportional to the
 *     remaining gap has no time bound: a 90%-to-100% move at a small
 *     per-frame rate can take longer than the phase lasts, so the bar
 *     showed 90% as the phase ended and the screen then jumped. Easing is
 *     therefore rate-limited to close any gap within ~0.5s, and snaps
 *     outright on completion.
 */
const target = computed(() => bootPercent.value);
const shown = ref<number | null>(null);
let raf = 0;
let lastFrame = 0;
const CONVERGE_MS = 500;

function tick(now: number) {
  raf = 0;
  const t = target.value;

  if (t == null) {
    shown.value = null;
    return;
  }
  if (shown.value == null) {
    shown.value = t;
    return;
  }
  // Completion is a fact, not something to animate toward.
  if (t >= 100) {
    shown.value = 100;
    return;
  }

  const dt = lastFrame ? Math.min(100, now - lastFrame) : CONVERGE_MS;
  lastFrame = now;

  const gap = t - shown.value;
  if (Math.abs(gap) < 0.5) {
    shown.value = t;
    return;
  }
  shown.value += gap * Math.min(1, dt / CONVERGE_MS);
  schedule();
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(tick);
}

watch(target, () => {
  lastFrame = 0;
  schedule();
}, { immediate: true });

// A phase change must not leave the previous phase's value on screen.
watch(bootPhase, () => {
  shown.value = target.value ?? null;
  lastFrame = 0;
  schedule();
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
});

const percent = computed(() => shown.value);
const done = computed(() => phase.value === 'starting');

const currentLabel = computed(
  () => steps.find((s) => s.id === phase.value)?.label ?? 'Preparing',
);

function isDone(id: BootPhase): boolean {
  const order = steps.map((s) => s.id);
  return order.indexOf(id) < order.indexOf(phase.value);
}

/** Circumference for r=52 is 2πr ≈ 326.73; dashoffset → 0 as percent → 100. */
const RADIUS = 2 * Math.PI * 52;
const arcStyle = computed(() => ({
  strokeDasharray: `${RADIUS}`,
  strokeDashoffset: `${RADIUS * (1 - (percent.value ?? 0) / 100)}`,
}));
</script>

<style scoped lang="scss">
.ts-boot {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: clamp(1.1rem, 3vh, 2rem);
  padding: 2rem 1.4rem;
  color: var(--ts-ink);
  background: var(--ts-void);
  pointer-events: auto;

  &__grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(240, 110, 0, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(240, 110, 0, 0.05) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(ellipse 70% 55% at 50% 42%, #000 20%, transparent 76%);
    pointer-events: none;
  }

  &__stage {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  /* ---- the ring ---- */
  &__ring {
    position: relative;
    width: clamp(132px, 22vh, 168px);
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    margin-bottom: 1.4rem;

    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      transform: rotate(-90deg); /* start the arc at 12 o'clock */
    }
  }

  &__ring-track,
  &__ring-arc {
    fill: none;
    stroke-width: 3;
  }

  &__ring-track {
    stroke: var(--ts-edge);
  }

  &__ring-arc {
    stroke: var(--ts-signal);
    stroke-linecap: round;
    transition: stroke-dashoffset 260ms var(--ts-ease);
  }

  /* sweep hand — full strength when indeterminate, faint over a bar */
  &__ring-sweep {
    transform-origin: 60px 60px;
    animation: ts-boot-sweep 1.25s linear infinite;

    line {
      stroke: var(--ts-signal);
      stroke-width: 2.5;
      stroke-linecap: round;
      opacity: 0.9;
    }
  }

  &__ring.is-indeterminate &__ring-track {
    stroke: rgba(166, 156, 122, 0.28);
  }

  &__ring-sweep.is-dim {
    animation-duration: 2.4s;
    opacity: 0.4;
  }

  &__ring.is-done &__ring-arc {
    stroke: var(--ts-lime);
  }

  &__ring-center {
    position: relative;
    z-index: 1;
    font-family: var(--ts-font-mono);
    line-height: 1;
  }

  &__pct {
    font-size: 1.6rem;
    color: var(--ts-lime);

    i {
      font-style: normal;
      font-size: 0.75rem;
      color: var(--ts-header);
    }

    &--word {
      font-size: 1.3rem;
      color: var(--ts-header);
      letter-spacing: 0.1em;
    }
  }

  &__title {
    margin: 0;
    font-family: var(--ts-font-display);
    font-size: clamp(1.5rem, 4.2vw, 2.1rem);
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ts-lime);
    text-shadow: 2px 2px 0 var(--ts-ink-faint);
  }

  &__phase {
    margin: 0.45rem 0 0;
    font-family: var(--ts-font-mono);
    font-size: 0.8rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ts-signal);
  }

  /* ---- boot log ---- */
  &__log {
    position: relative;
    z-index: 1;
    width: min(360px, 86vw);
    margin: 0;
    padding: 0.85rem 1rem;
    list-style: none;
    background: rgba(0, 3, 1, 0.6);
    border: 1px solid var(--ts-edge);
  }

  &__log-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.16rem 0;
    font-family: var(--ts-font-mono);
    font-size: 0.76rem;
    color: var(--ts-ink-muted);
    transition: color 200ms var(--ts-ease);

    &.is-done {
      color: var(--ts-ink-muted);
    }

    &.is-active {
      color: var(--ts-lime);
    }
  }

  &__log-mark {
    flex: none;
    width: 0.8rem;
    color: var(--ts-signal);
  }

  &__log-text {
    letter-spacing: 0.03em;
  }

  &__foot {
    position: relative;
    z-index: 1;
    margin: 0;
    font-family: var(--ts-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    color: var(--ts-ink-muted);
    text-align: center;
  }
}

@keyframes ts-boot-sweep {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ts-boot__ring-sweep {
    animation: none;
    opacity: 0.6;
  }
}
</style>