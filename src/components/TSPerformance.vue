<template>
  <section class="ts-perf">
    <h2 v-if="context !== 'game'" class="ts-stamp ts-perf__head">Your Client</h2>

    <!--
      THE READOUT IS A STATUS, NOT A DOCUMENT.

      It says what the game measured on THIS machine, in this browser,
      right now — and then, only if there is something to change, what
      to change. A panel that lists browser settings for everybody is a
      panel nobody reads, and one that sends people to change settings
      that were never the problem.
    -->

    <p class="ts-perf__summary" :class="`is-${summaryTone}`">
      {{ report.summary }}
    </p>

    <!--
      WHERE THE NUMBERS BELOW CAME FROM, SAID WHERE THEY ARE READ.

      The provenance finding at the foot of the list says it too, but
      the numbers are ABOVE that list: they are the first thing the
      player reads, so they are labelled first.
    -->
    <p v-if="sourceLabel" class="ts-perf__source">
      {{ sourceLabel }}
    </p>

    <!-- The measured numbers, so the prose above is checkable. -->
    <dl class="ts-perf__numbers">
      <div v-for="row in numberRows" :key="row.label" class="ts-perf__number">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>

    <ul class="ts-perf__findings">
      <li
        v-for="finding in report.findings"
        :key="finding.id"
        class="ts-perf__finding"
        :class="`is-${finding.severity}`"
      >
        <span class="ts-perf__dot" aria-hidden="true"></span>
        <div class="ts-perf__finding-text">
          <strong>{{ finding.title }}</strong>
          <span>{{ finding.detail }}</span>
        </div>
      </li>
    </ul>

    <!--
      THE CHECKLIST ONLY EXISTS WHEN THERE IS SOMETHING TO DO.

      When the client is healthy the list is empty and the panel says
      so, because "you are set up properly" is a useful thing for
      somebody to read once.
    -->
    <div v-if="report.checklist.length" class="ts-perf__fixes">
      <h3 class="ts-perf__fixes-head">If the game feels slower than it should</h3>
      <ol class="ts-perf__fix">
        <li v-for="item in report.checklist" :key="item.id" class="ts-perf__fix-item">
          <span class="ts-perf__fix-action">{{ item.action }}</span>
          <code class="ts-perf__fix-where">{{ item.where }}</code>
          <span class="ts-perf__fix-why">{{ item.why }}</span>
        </li>
      </ol>
    </div>

    <div class="ts-perf__foot">
      <button class="ts-perf__again" type="button" :disabled="measuring" @click="remeasure">
        {{ measuring ? 'Measuring…' : 'Measure again' }}
      </button>
      <span class="ts-perf__note">
        {{ note }}
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * What the game measured about the player's client, and what they can
 * do about it.
 *
 * WHY THIS PANEL EXISTS
 * ---------------------
 * The client already knows the three things that decide whether the
 * game feels smooth:
 *
 *   - which GPU it is drawing on (a software rasteriser is fatal),
 *   - how many refreshes a second the browser is actually delivering,
 *   - how long one engine frame takes against the display's budget.
 *
 * None of it reached the screen. So a player whose browser was
 * halving their refresh rate saw "the game runs at 40-50 fps and
 * sometimes feels smooth at 60" and had no way to find out why — and
 * the answer was almost always in their browser, not in the game.
 *
 * WHAT IT SHOWS
 * -------------
 * The measured numbers, the findings they imply, and — only when
 * there is something to change — the browser-specific settings that
 * change it.
 *
 * The policy is in `services/perf-check.ts` (pure, unit-tested in the
 * parent's suite); the gathering is in `services/perf-collect.ts`.
 */
import { computed, onMounted, ref } from 'vue';
import {
  clientReport,
  ensurePanelRateMeasured,
  liveReport,
} from '/@/services/perf-collect.ts';
import { describeSessionAge, formatMegapixels } from '/@/services/perf-check.ts';
import type { PerfReport } from '/@/services/perf-check.ts';

/**
 * WHERE THIS COPY IS, AND WHAT IT IS ALLOWED TO SAY.
 *
 * The landing page carries this panel as a tab, and the in-game options
 * overlay carries it as a tab of its own. In the overlay the heading
 * belongs to the overlay's own tab strip, so `game` drops it.
 *
 * AND THE DATA SOURCE FOLLOWS THE PROP, NOT THE OTHER WAY ROUND. The
 * in-game copy reads the LIVE game — the player is looking at the game
 * right now, and a stale number would be a lie. The landing copy
 * restores the last match's numbers from the session, because the
 * landing page cannot measure a game that is not running.
 *
 * The old `embed` flag decided the HEADING from the presentation and
 * left the data source to be inferred. One prop, two meanings that
 * always coincide, and the source is explicit.
 */
const props = withDefaults(defineProps<{ context?: 'landing' | 'game' }>(), {
  context: 'landing',
});

/** The report for this copy. */
function readReport(): PerfReport {
  return props.context === 'game' ? liveReport() : clientReport();
}

const report = ref<PerfReport>(readReport());
const measuring = ref(false);

/** The tone of the summary line. */
const summaryTone = computed(() => {
  const s = report.value.summary;
  if (s.includes('not set up')) return 'bad';
  // THE SUMMARY NAMES THE BOTTLENECK.
  //
  // "Your browser is holding the game back" was the old wording, and
  // it was wrong often enough to cost a player an hour of settings
  // fiddling. The summary now says which of the two it is — the
  // browser offering too few refreshes, or the game not keeping up —
  // and both of those are a warning.
  if (s.includes('holding the game back')) return 'warn';
  if (s.includes('only offering')) return 'warn';
  if (s.includes('could not keep up')) return 'warn';
  if (s.includes('not been measured')) return 'info';
  return 'ok';
});

/**
 * THE FOOT NOTE, WHICH HAS TO BE TRUE.
 *
 * On the landing page the numbers may be the last match's, restored
 * from the session — and then "measured on this machine, in this
 * browser" is not the whole truth. The provenance finding in the list
 * above says where they came from; this says what they are about.
 */
const note = computed(() =>
  report.value.source === 'last-session'
    ? 'These numbers are from your last game, on this machine, in this browser.'
    : 'The numbers above are measured on this machine, in this browser.'
);

/**
 * THE PROVENANCE, ABOVE THE NUMBERS.
 *
 * "the game is drawing 60 fps" is a lie when the game is not running,
 * so the headline number is in the past tense when the numbers are the
 * last match's — and the block of numbers is labelled with where they
 * came from and how old they are, so the label is where the numbers
 * are read and not only at the foot of the panel.
 */
const sourceLabel = computed(() => {
  if (report.value.source !== 'last-session') return '';
  const age = describeSessionAge(report.value.measuredAt, Date.now());
  return `Last game — ${age}`;
});

/**
 * The measured numbers, as rows.
 *
 * The panel rate and the delivered rate are BOTH shown, because they
 * are different numbers and the difference between them is the whole
 * story: the first is what the display can do, the second is what the
 * game is actually drawing.
 */
const numberRows = computed(() => {
  const n = report.value.numbers;
  const rows: { label: string; value: string }[] = [];

  if (n.panelHz > 0) {
    const was = report.value.source === 'last-session';
    // THE GAME'S OWN FRAME RATE.
    //
    // The browser's tick rate is not the game's frame rate: with the
    // cap in force the browser keeps ticking at the panel's rate while
    // the engine draws every Nth tick. The number that answers "how
    // many frames is the game drawing" is the engine's own.
    const gameFps = n.engineFps > 0 ? n.engineFps : n.displayHz;
    rows.push({
      label: 'Display',
      value:
        gameFps > 0 && gameFps < n.panelHz * 0.9
          ? `${n.panelHz.toFixed(0)} Hz — the game ${was ? 'was' : 'is'} drawing ${gameFps.toFixed(0)} fps`
          : `${n.panelHz.toFixed(0)} Hz`,
    });
  }
  if (n.engineWorkMs > 0) {
    rows.push({
      label: 'Frame cost',
      value:
        n.budgetMs > 0
          ? `${n.engineWorkMs.toFixed(2)} ms against the ${n.budgetMs.toFixed(2)} ms budget`
          : `${n.engineWorkMs.toFixed(2)} ms`,
    });
  }
  // ONLY WHEN THE GAME IS RUNNING.
  //
  // Before the engine boots, the canvas is a 300×150 placeholder — it
  // is not the game's render size, and printing it as "0.0 megapixels"
  // reads like the game is drawing nothing.
  if (n.engineWorkMs > 0 && n.backingPixels > 0) {
    rows.push({
      label: 'Render size',
      value: formatMegapixels(n.backingPixels),
    });
  }
  const renderer = report.value.findings.find((f) => f.id === 'renderer-ok' || f.id === 'software-renderer');
  if (renderer && renderer.id === 'renderer-ok') {
    rows.push({ label: 'Graphics', value: 'Hardware accelerated' });
  }
  return rows;
});

/**
 * Measure again.
 *
 * The panel rate is re-measured (the page is idle when this panel is
 * open, so the measurement is clean), and the report is re-read.
 *
 * WHAT THIS DOES NOT DO: it cannot re-measure the ENGINE's frame cost.
 * That number only exists while the game is running, so the only thing
 * that refreshes it is playing another match — which is what the
 * provenance finding says when the numbers came from the last game.
 */
async function remeasure() {
  measuring.value = true;
  try {
    await ensurePanelRateMeasured();
    report.value = readReport();
  } finally {
    measuring.value = false;
  }
}

onMounted(async () => {
  // The refresh rate has to be measured while the page is idle, and
  // this panel is idle — so this is the one moment the measurement is
  // guaranteed clean.
  await ensurePanelRateMeasured();
  report.value = readReport();
});
</script>

<style scoped lang="scss">
.ts-perf {
  &__head {
    margin: 0 0 0.7rem;
    font-size: 1.05rem;
    color: var(--ts-lime);
  }

  &__summary {
    margin: 0 0 1rem;
    font-family: var(--ts-font-display);
    font-size: 1rem;
    letter-spacing: 0.04em;
    color: var(--ts-ink);

    &.is-ok {
      color: var(--ts-ok);
    }
    &.is-warn {
      color: var(--ts-warn);
    }
    &.is-bad {
      color: var(--ts-error);
    }
    &.is-info {
      color: var(--ts-ink-muted);
    }
  }

  /*
    The stamp on the numbers: where they came from, and how old they
    are. Quiet, and in the panel's own label idiom — the same shape as
    the fixes heading above it, in the muted ink instead of the lime.
  */
  &__source {
    margin: 0 0 0.5rem;
    font-family: var(--ts-font-display);
    font-size: 0.78rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ts-ink-muted);
  }

  /* The numbers first, so the prose under them is checkable. */
  &__numbers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 0.55rem 1.4rem;
    margin: 0 0 1.2rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--ts-edge);
    background: var(--ts-panel);
  }

  &__number {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;

    dt {
      font-family: var(--ts-font-mono);
      font-size: 0.62rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ts-ink-muted);
    }

    dd {
      margin: 0;
      font-family: var(--ts-font-mono);
      font-size: 0.82rem;
      color: var(--ts-ink-bright);
    }
  }

  &__findings {
    display: grid;
    gap: 0.55rem;
    margin: 0 0 1.2rem;
    padding: 0;
    list-style: none;
  }

  &__finding {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0 0.65rem;
    align-items: start;
  }

  &__dot {
    width: 0.5rem;
    height: 0.5rem;
    margin-top: 0.42rem;
    background: var(--ts-ink-muted);

    .is-ok & {
      background: var(--ts-ok);
      box-shadow: 0 0 6px var(--ts-signal);
    }
    .is-warn & {
      background: var(--ts-warn);
    }
    .is-bad & {
      background: var(--ts-error);
      box-shadow: 0 0 6px var(--ts-error);
    }
  }

  &__finding-text {
    display: flex;
    flex-direction: column;
    gap: 0.12rem;

    strong {
      font-weight: 600;
      font-size: 0.88rem;
      color: var(--ts-ink-bright);
    }

    span {
      font-size: 0.8rem;
      line-height: 1.45;
      color: var(--ts-ink-muted);
    }
  }

  &__fixes-head {
    margin: 0 0 0.6rem;
    font-family: var(--ts-font-display);
    font-size: 0.9rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--ts-lime);
  }

  &__fix {
    display: grid;
    gap: 0.9rem;
    margin: 0;
    padding: 0 0 0 1.4rem;
  }

  &__fix-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  &__fix-action {
    font-weight: 600;
    font-size: 0.88rem;
    color: var(--ts-ink-bright);
  }

  /* The setting to change, verbatim — the player copies it. */
  &__fix-where {
    padding: 0.3rem 0.5rem;
    border-left: 2px solid var(--ts-signal);
    background: rgba(0, 255, 65, 0.05);
    font-family: var(--ts-font-mono);
    font-size: 0.74rem;
    line-height: 1.4;
    color: var(--ts-signal-hot);
    word-break: break-word;
  }

  &__fix-why {
    font-size: 0.79rem;
    line-height: 1.45;
    color: var(--ts-ink-muted);
  }

  &__foot {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin-top: 1.2rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--ts-edge);
  }

  &__again {
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--ts-edge-lit);
    background: transparent;
    font-family: var(--ts-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ts-lime);
    cursor: pointer;
    transition: border-color var(--ts-sweep) var(--ts-ease),
      color var(--ts-sweep) var(--ts-ease);

    &:hover:not(:disabled) {
      border-color: var(--ts-signal);
      color: var(--ts-signal-hot);
    }

    &:disabled {
      opacity: 0.45;
      cursor: default;
    }
  }

  &__note {
    font-size: 0.74rem;
    color: var(--ts-ink-muted);
  }
}
</style>
