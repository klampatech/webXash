<!--
  THE READOUT: what the game measured about the player's client, and
  what they can do about it.

  WHY THIS PANEL EXISTS
  ---------------------
  The client already knows the three things that decide whether the
  game feels smooth:

    - which GPU it is drawing on (a software rasteriser is fatal),
    - how many refreshes a second the browser is actually delivering,
    - how long one engine frame takes against the display's budget.

  None of it reached the screen. So a player whose browser was
  halving their refresh rate saw "the game runs at 40-50 fps and
  sometimes feels smooth at 60" and had no way to find out why — and
  the answer was almost always in their browser, not in the game.

  THE SHAPE
  ---------
  A verdict at the top, the numbers down the left, the findings down
  the right. The findings are the long list and the numbers are the
  short one, so the numbers get the narrow column and the findings
  get the wide one — and the findings column is the one that scrolls.

  SEVERITY IS A LABEL, NOT ONLY A COLOUR
  --------------------------------------
  A coloured dot alone is a colourblind player's dead end, and a
  colour alone is not a severity: "Info" and "OK" are both grey-ish
  in a palette this dark. So every finding carries its severity in
  words as well: OK, Info, Warning, Error.

  THE CHECKLIST IS ONLY THERE WHEN IT CAN BE ACTED ON
  ---------------------------------------------------
  The fixes are the browser-specific steps that make the number
  better, and they are gated on the facts: a client that is set up
  properly gets no checklist, because a checklist that is always
  there is a checklist nobody reads. Every item names the setting, the
  exact place to change it, and what it does — a player who cannot
  act on an instruction should not be given one.

  TWO PALETTES, ONE LAYOUT
  ------------------------
  The layout is shared; the colours are the surface's. In the game
  this panel is the buy menu's gold-on-dark, because it opens over
  the game's own amber HUD. On the landing page it keeps the shell's
  phosphor green, because that page is a terminal and a gold panel in
  the middle of it reads as two systems fighting.
-->
<template>
  <section class="ts-perf" :class="`is-${context}`">
    <h2 v-if="context !== 'game'" class="ts-stamp ts-perf__head">Your Client</h2>

    <!--
      THE VERDICT.

      The summary is the engine's own sentence, and it names the
      bottleneck by CAUSE: a browser that is offering too few
      refreshes and an engine that cannot keep up are different
      problems with different fixes, and the headline is the first
      thing a player reads.

      The counts under it are the same findings, counted by severity,
      so a player can see whether there is one thing wrong or five.
    -->
    <div class="ts-perf__banner" :class="`is-${summaryTone}`">
      <span class="ts-perf__banner-bar" aria-hidden="true" />
      <div class="ts-perf__banner-body">
        <h3 class="ts-perf__banner-head">{{ report.summary }}</h3>
        <p class="ts-perf__banner-counts">{{ countLine }}</p>
      </div>
    </div>

    <div class="ts-perf__cols">
      <!--
        THE NUMBERS.

        They are the first thing a player reads, so the provenance
        sits HERE, where the numbers are read — not only at the foot
        of the findings. A player who quits back to the web UI must be
        able to tell that these are the last match's numbers and not a
        live reading.
      -->
      <div class="ts-perf__stats">
        <p v-if="sourceLabel" class="ts-perf__source">{{ sourceLabel }}</p>

        <div v-for="row in numberRows" :key="row.label" class="ts-perf__stat">
          <span class="ts-perf__stat-label">{{ row.label }}</span>
          <span class="ts-perf__stat-value">{{ row.value }}</span>

          <!--
            THE FRAME BUDGET, AS TWO BARS.

            The budget in gold and the actual in red, scaled against
            each other: when the engine is over budget the actual bar
            is the whole width and the budget is the fraction of it
            that the engine was allowed. The caption says which bar is
            which, because a bar with no label is a decoration.
          -->
          <div v-if="row.bars" class="ts-perf__bars">
            <div class="ts-perf__bar">
              <i class="ts-perf__bar-fill is-budget" :style="{ width: row.bars.budgetPct + '%' }" />
            </div>
            <div class="ts-perf__bar">
              <i
                class="ts-perf__bar-fill"
                :class="row.bars.over ? 'is-over' : 'is-under'"
                :style="{ width: row.bars.actualPct + '%' }"
              />
            </div>
            <span class="ts-perf__bars-note">{{ row.bars.caption }}</span>
          </div>
        </div>

        <div class="ts-perf__foot">
          <span class="ts-perf__note">{{ note }}</span>
          <div class="ts-perf__actions">
            <button class="ts-perf__again" type="button" :disabled="measuring" @click="remeasure">
              {{ measuring ? 'Measuring…' : 'Re-measure' }}
            </button>
            <!--
              THE LOG.

              "It stutters in fullscreen" is a claim about a moment
              the player cannot go back to. This downloads the whole
              timeline of the match — every measurement the pacer
              took, with the frame cost, the rate the game was
              drawing and the rate the browser was handing it — so the
              claim can be checked instead of argued about.
            -->
            <button
              class="ts-perf__again"
              type="button"
              :disabled="exporting"
              @click="exportLog"
            >
              {{ exporting ? 'Saving…' : 'Export log' }}
            </button>
          </div>
          <span v-if="exportedName" class="ts-perf__exported">{{ exportedName }}</span>
        </div>
      </div>

      <!--
        THE FINDINGS.

        Each row opens onto its own detail, so the list stays short
        and the player reads one thing at a time.
      -->
      <div class="ts-perf__findings">
        <!--
          THE FINDINGS SCROLL; THE FIXES DO NOT.

          The list of findings can be long, and the fixes are the
          actionable end of it — so the list scrolls and the fixes
          stay pinned under it, where they cannot be scrolled past by
          a player who never noticed them.
        -->
        <div class="ts-perf__findings-scroll">
        <div
          v-for="f in report.findings"
          :key="f.id"
          class="ts-perf__finding"
          :class="`is-${f.severity}`"
        >
          <button
            class="ts-perf__finding-head"
            type="button"
            :aria-expanded="expanded === f.id"
            @click="toggle(f.id)"
          >
            <span class="ts-perf__dot" aria-hidden="true" />
            <span class="ts-perf__finding-title">{{ f.title }}</span>
            <span class="ts-perf__sev">{{ severityLabel(f.severity) }}</span>
            <span class="ts-perf__chev" aria-hidden="true">{{ expanded === f.id ? '▾' : '▸' }}</span>
          </button>
          <p v-if="expanded === f.id" class="ts-perf__detail">{{ f.detail }}</p>
        </div>
        </div>

        <!--
          THE CHECKLIST, ONLY WHEN THERE IS SOMETHING TO DO.

          Every item is a setting, the exact place to change it, and
          what it does — so a player can act on it in a minute.
        -->
        <div v-if="report.checklist.length" class="ts-perf__fixes">
          <h4 class="ts-perf__fixes-head">If the game feels slower than it should</h4>
          <ol class="ts-perf__fix">
            <li v-for="item in report.checklist" :key="item.id" class="ts-perf__fix-item">
              <span class="ts-perf__fix-action">{{ item.action }}</span>
              <code class="ts-perf__fix-where">{{ item.where }}</code>
              <span class="ts-perf__fix-why">{{ item.why }}</span>
            </li>
          </ol>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * The report for the player's client.
 *
 * The policy is in `services/perf-check.ts` (pure, unit-tested in the
 * parent's suite); the gathering is in `services/perf-collect.ts`.
 */
import { computed, onMounted, ref } from 'vue';
import {
  clientReport,
  ensurePanelRateMeasured,
  liveReport,
  remeasureEngineCost,
  downloadPerfLog,
} from '/@/services/perf-collect.ts';
import { describeSessionAge, formatMegapixels } from '/@/services/perf-check.ts';
import type { PerfReport, PerfSeverity } from '/@/services/perf-check.ts';

/**
 * WHERE THIS COPY IS, AND WHAT IT IS ALLOWED TO SAY.
 *
 * The landing page carries this panel as a tab, and the in-game options
 * overlay carries it as its own page. In the overlay the heading
 * belongs to the overlay's own page title, so `game` drops it.
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
const props = withDefaults(
  defineProps<{
    context?: 'landing' | 'game';
    /**
     * A report to show, when the caller has one.
     *
     * The options overlay owns the report, because the sidebar's
     * badge counts the same findings the page shows. When the report
     * is passed in, this component does not measure anything itself:
     * it asks the owner to, with `remeasure`.
     */
    report?: PerfReport;
  }>(),
  { context: 'landing', report: undefined },
);

const emit = defineEmits<{ (e: 'remeasure'): void }>();

/**
 * The report for this copy.
 *
 * The in-game copy reads the LIVE game. The landing copy restores the
 * last match's numbers from the session.
 */
function readReport(): PerfReport {
  return props.context === 'game' ? liveReport() : clientReport();
}

/** The report this component owns, when the caller has not given one. */
const ownReport = ref<PerfReport>(readReport());

/** The report on screen: the caller's, or this component's own. */
const report = computed<PerfReport>(() => props.report ?? ownReport.value);

const measuring = ref(false);

/**
 * The tone of the verdict.
 *
 * THE FINDINGS DECIDE IT, NOT THE SUMMARY TEXT.
 *
 * The tone used to be read out of the summary string — "not set up",
 * "only offering", "could not keep up" — which meant every new
 * finding had to remember to add its wording to this list, and a
 * finding nobody remembered got the wrong colour. The severities
 * are already on the findings, so they are what the tone is made of.
 *
 * The one exception is the summary that says nothing has been
 * measured yet: that is not a fault, and it is not an "ok" either.
 */
const summaryTone = computed(() => {
  const s = report.value.summary;
  if (s.includes('not been measured')) return 'info';
  const findings = report.value.findings;
  if (findings.some((f) => f.severity === 'bad')) return 'bad';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'ok';
});

/**
 * THE COUNTS: how many findings, by severity.
 *
 * They add up to the number of findings on screen, so a player can
 * see at a glance whether there is one thing wrong or five.
 */
const countLine = computed(() => {
  const counts: Record<PerfSeverity, number> = { bad: 0, warn: 0, info: 0, ok: 0 };
  for (const f of report.value.findings) counts[f.severity] += 1;

  const parts: string[] = [];
  if (counts.bad) parts.push(`${counts.bad} error${counts.bad === 1 ? '' : 's'}`);
  if (counts.warn) parts.push(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`);
  if (counts.info) parts.push(`${counts.info} note${counts.info === 1 ? '' : 's'}`);
  if (counts.ok) parts.push(`${counts.ok} OK`);
  return parts.length ? parts.join(' · ') : 'Nothing to report';
});

/**
 * THE SEVERITY, IN WORDS.
 *
 * A colour alone is not a severity, and a coloured dot alone is a
 * dead end for a colourblind player.
 */
function severityLabel(severity: PerfSeverity): string {
  switch (severity) {
    case 'bad':
      return 'Error';
    case 'warn':
      return 'Warning';
    case 'info':
      return 'Info';
    default:
      return 'OK';
  }
}

/**
 * WHICH FINDING IS OPEN.
 *
 * The first one that wants something done opens by default: a player
 * who opens this page is usually here because something is wrong.
 */
const expanded = ref<string | null>(null);

function toggle(id: string): void {
  expanded.value = expanded.value === id ? null : id;
}

/**
 * THE FOOT NOTE, WHICH HAS TO BE TRUE.
 *
 * On the landing page the numbers may be the last match's, restored
 * from the session — and then "measured on this device" is not the
 * whole truth. The provenance label in the numbers column says where
 * they came from; this says what they are about.
 */
const note = computed(() =>
  report.value.source === 'last-session'
    ? 'From your last game, on this machine.'
    : 'Measured on this device.',
);

/**
 * THE PROVENANCE, ABOVE THE NUMBERS.
 *
 * "the game is drawing 60 fps" is a lie when the game is not running,
 * so the headline number is in the past tense when the numbers are the
 * last match's — and the label is where the numbers are read and not
 * only at the foot of the panel.
 */
const sourceLabel = computed(() => {
  if (report.value.source === 'last-session') {
    const age = describeSessionAge(report.value.measuredAt, Date.now());
    return `Last game — ${age}`;
  }
  // THE LIVE CASE SAYS HOW OLD THE READING IS TOO.
  //
  // The pacer re-measures every ten seconds, so a live reading is
  // usually fresh — but a reading that stopped being refreshed is
  // still printed as if it were now, and "the game is drawing 60 fps"
  // is a lie when it was measured two minutes ago. The age is said
  // in the same words as everything else.
  if (report.value.costMeasuredAt > 0) {
    return `Measured ${describeSessionAge(report.value.costMeasuredAt, Date.now())}`;
  }
  return '';
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
  const rows: {
    label: string;
    value: string;
    bars?: { budgetPct: number; actualPct: number; over: boolean; caption: string };
  }[] = [];

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
    const row: (typeof rows)[number] = {
      label: 'Frame cost',
      value:
        n.budgetMs > 0
          ? `${n.engineWorkMs.toFixed(2)} ms vs ${n.budgetMs.toFixed(2)} ms budget`
          : `${n.engineWorkMs.toFixed(2)} ms`,
    };

    // THE TWO BARS.
    //
    // The budget is what the engine was allowed; the actual is what
    // it used. They are scaled against each other, so the pair reads
    // as "this much over" or "this much of it used" at a glance —
    // and the caption says which bar is which, because a bar with no
    // label is a decoration.
    if (n.budgetMs > 0) {
      const ratio = n.engineWorkMs / n.budgetMs;
      const over = ratio > 1;
      row.bars = {
        budgetPct: over ? 100 / ratio : 100,
        actualPct: over ? 100 : Math.max(2, ratio * 100),
        over,
        caption: over
          ? `Budget in gold, actual in red · ${ratio.toFixed(1)}× over budget`
          : `Budget in gold, actual in green · using ${Math.round(ratio * 100)}% of the budget`,
      };
    }

    rows.push(row);
  }

  // THE SPREAD OF THE FRAME TIMES.
  //
  // The engine's counter says how many frames it drew; this says how
  // far apart they were. That is the thing the eye reads as
  // smoothness, and it is the one number that says whether a capped
  // game is landing its frames evenly.
  if (n.pacing && n.pacing.samples >= 10 && n.pacing.p50 > 0) {
    rows.push({
      label: 'Frame spacing',
      value: `${n.pacing.p50.toFixed(1)} ms apart · worst ${n.pacing.max.toFixed(1)} ms`,
    });
  }

  // THE NEXT RATE UP, AND HOW FAR IT IS.
  //
  // The one number that turns "the game is capped" into something
  // the player can go and fix.
  if (n.nextRate && n.nextRate.gapMs > 0) {
    rows.push({
      label: 'Next rate',
      value: `${n.nextRate.gapMs.toFixed(2)} ms away from ${n.nextRate.targetFps.toFixed(0)} fps`,
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

  const renderer = report.value.findings.find(
    (f) => f.id === 'renderer-ok' || f.id === 'software-renderer',
  );
  if (renderer && renderer.id === 'renderer-ok') {
    rows.push({ label: 'Graphics', value: 'Hardware accelerated' });
  }

  return rows;
});

/**
 * Measure again.
 *
 * TWO MEASUREMENTS, AND ONLY ONE OF THEM CAN HAPPEN AT A TIME.
 *
 * The panel's refresh rate is measured while the page is idle; the
 * engine's frame cost is measured while the game is running. So both
 * are asked for, and each one is a no-op when the game is not there.
 *
 * AND THE ENGINE'S COST IS THE ONE THAT MATTERS. It is the number
 * the player changes when they turn a draw-cost switch off, and it is
 * the only way they can find out whether the switch helped. Without
 * this, the readout could only report what it saw once.
 */
async function remeasure() {
  if (props.report) {
    // The owner has the report, so the owner measures.
    emit('remeasure');
    return;
  }
  measuring.value = true;
  try {
    await ensurePanelRateMeasured();
    await remeasureEngineCost();
    ownReport.value = readReport();
  } finally {
    measuring.value = false;
  }
}

/**
 * EXPORT THE LOG.
 *
 * The timeline of the match, as a file: every measurement the pacer
 * took, with the frame cost, the rate the game was drawing, the rate
 * the browser was handing it and how many of the engine's frames
 * arrived late.
 *
 * WHY THE PLAYER NEEDS THIS AND NOT JUST THE NUMBERS ON SCREEN
 * ------------------------------------------------------------
 * "It stutters in fullscreen" is a claim about a MOMENT, and the
 * player cannot go back to it. The numbers on screen are the state
 * right now; the log is the whole match, and it is the thing that
 * turns a complaint into something that can be checked.
 */
const exporting = ref(false);

/** The name of the log that was just saved, so the player can find it. */
const exportedName = ref('');

function exportLog(): void {
  exporting.value = true;
  try {
    exportedName.value = downloadPerfLog();
  } finally {
    exporting.value = false;
  }
}

onMounted(async () => {
  if (props.report) {
    // The owner has the report; the owner opens the finding too.
    const first = props.report.findings.find(
      (f) => f.severity === 'bad' || f.severity === 'warn',
    );
    if (first) expanded.value = first.id;
    return;
  }
  // The refresh rate has to be measured while the page is idle, and
  // this panel is idle — so this is the one moment the measurement is
  // guaranteed clean.
  await ensurePanelRateMeasured();
  ownReport.value = readReport();

  // OPEN THE FINDING THAT WANTS SOMETHING DONE.
  const first = ownReport.value.findings.find(
    (f) => f.severity === 'bad' || f.severity === 'warn',
  );
  if (first) expanded.value = first.id;
});
</script>

<style scoped lang="scss">
/*
 * TWO PALETTES, ONE LAYOUT.
 *
 * The colours are the SURFACE's, and the surface decides: the game
 * gets the buy menu's gold-on-dark (this panel opens over the game's
 * own amber HUD), and the landing page keeps the shell's phosphor
 * green (that page is a terminal, and a gold panel in the middle of
 * it reads as two systems fighting).
 */
.ts-perf {
  --perf-card: var(--ts-panel);
  --perf-border: var(--ts-edge);
  --perf-text: var(--ts-ink-bright);
  --perf-muted: var(--ts-ink-muted);
  --perf-accent: var(--ts-lime);
  --perf-warn: var(--ts-warn);
  --perf-bad: var(--ts-error);
  --perf-ok: var(--ts-ok);
  --perf-bar-bg: var(--ts-panel);
  /* THE SCROLLBAR IS THE PANEL'S OWN. A white bar in the middle of a
     dark panel is the browser's furniture, not the design's. */
  --perf-scroll: #123a1c;
  --perf-scroll-hover: #6fa67c;
  --perf-font-display: var(--ts-font-display);
  --perf-font: var(--ts-font-body);
  --perf-label-font: var(--ts-font-mono);

  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  font-family: var(--perf-font);
  color: var(--perf-text);

  /* THE GAME'S PALETTE: the buy menu's tokens, verbatim. */
  &.is-game {
    --perf-card: #1f1a13;
    --perf-border: #33291d;
    --perf-text: #f2e9d8;
    --perf-muted: #b3a68e;
    --perf-accent: #f2b84b;
    --perf-warn: #ffb35a;
    --perf-bad: #ff8a73;
    --perf-ok: #8fd18a;
    --perf-bar-bg: #2a241b;
    --perf-scroll: #33291d;
    --perf-scroll-hover: #4a3d2b;
    --perf-font-display: 'Barlow Condensed', 'Oswald', 'Arial Narrow', sans-serif;
    --perf-font: Inter, 'Helvetica Neue', system-ui, -apple-system, sans-serif;
    --perf-label-font: Inter, 'Helvetica Neue', system-ui, -apple-system, sans-serif;
  }

  &__head {
    margin: 0;
    font-family: var(--perf-font-display);
    font-size: 1.05rem;
    color: var(--perf-accent);
  }

  /*
   * THE VERDICT.
   *
   * A bar down the side in the verdict's own colour, the sentence
   * that names the bottleneck, and the counts under it.
   */
  &__banner {
    display: flex;
    gap: 14px;
    align-items: stretch;
    flex: none;
    padding: 14px 18px;
    background: var(--perf-card);
    border: 1px solid var(--perf-border);
    border-radius: 10px;

    &.is-warn {
      border-color: #5a4220;
      background: #2a2012;
    }

    &.is-bad {
      border-color: var(--perf-bad);
    }
  }

  &__banner-bar {
    width: 6px;
    flex: none;
    align-self: stretch;
    border-radius: 3px;
    background: var(--perf-accent);

    .is-warn & {
      background: var(--perf-warn);
    }

    .is-bad & {
      background: var(--perf-bad);
    }

    .is-info & {
      background: var(--perf-muted);
    }

    .is-ok & {
      background: var(--perf-ok);
    }
  }

  &__banner-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__banner-head {
    margin: 0;
    font-family: var(--perf-font-display);
    font-weight: 700;
    font-size: 24px;
    letter-spacing: 0.04em;
    /* THE VERDICT WEARS ITS OWN COLOUR, like the bar beside it. */
    color: var(--perf-accent);

    .is-warn & {
      color: var(--perf-warn);
    }

    .is-bad & {
      color: var(--perf-bad);
    }

    .is-ok & {
      color: var(--perf-ok);
    }

    .is-info & {
      color: var(--perf-muted);
    }
  }

  &__banner-counts {
    margin: 0;
    font-size: 0.8rem;
    color: var(--perf-muted);
  }

  /* THE TWO COLUMNS. */
  &__cols {
    display: flex;
    gap: 16px;
    flex: 1;
    min-height: 0;
  }

  /* THE NUMBERS, DOWN THE LEFT. */
  &__stats {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 270px;
    flex: none;
    min-height: 0;
  }

  &__source {
    margin: 0;
    font-family: var(--perf-font-display);
    font-size: 0.7rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--perf-muted);
  }

  &__stat {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 14px;
    background: var(--perf-card);
    border: 1px solid var(--perf-border);
    border-radius: 10px;
  }

  &__stat-label {
    font-family: var(--perf-label-font);
    font-size: 0.62rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--perf-muted);
  }

  &__stat-value {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--perf-text);
  }

  /* THE TWO BARS: the budget in gold, the actual in red or green. */
  &__bars {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }

  &__bar {
    height: 6px;
    border-radius: 3px;
    background: var(--perf-bar-bg);
    overflow: hidden;
  }

  &__bar-fill {
    display: block;
    height: 6px;
    border-radius: 3px;

    &.is-budget {
      background: var(--perf-accent);
    }

    &.is-over {
      background: var(--perf-bad);
    }

    &.is-under {
      background: var(--perf-ok);
    }
  }

  &__bars-note {
    font-size: 0.72rem;
    color: var(--perf-muted);
  }

  /* THE FOOT OF THE NUMBERS: the note, and the re-measure button.
   *
   * In the GAME the foot is pinned to the bottom of the column, the
   * way the design shows it — the column is a fixed height there and
   * the numbers fill it. On the landing page the column is as tall as
   * its content, so a pinned foot would leave a hole under one card.
   */
  &__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
    padding-top: 4px;

    .is-game & {
      margin-top: auto;
    }
  }

  &__note {
    font-size: 0.72rem;
    color: var(--perf-muted);
  }

  /* THE TWO BUTTONS, SIDE BY SIDE.
   *
   * "Re-measure" and "Export log" are the same kind of thing — the
   * player acting on the readout — so they sit together and look
   * alike.
   */
  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }

  /* THE NAME OF THE LOG THAT WAS SAVED.
   *
   * The button goes quiet once it has worked, so the player is told
   * what to look for in their downloads instead of wondering whether
   * the click landed.
   */
  &__exported {
    font-size: 0.68rem;
    color: var(--perf-muted);
    font-family: var(--perf-label-font);
  }

  &__again {
    min-height: 36px;
    padding: 0 14px;
    background: transparent;
    border: 1px solid var(--perf-border);
    border-radius: 8px;
    color: var(--perf-text);
    font-family: var(--perf-font);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    flex: none;

    &:hover:not(:disabled) {
      border-color: var(--perf-accent);
      color: var(--perf-accent);
    }

    &:disabled {
      opacity: 0.45;
      cursor: default;
    }

    &:focus-visible {
      outline: none;
      border-color: var(--perf-accent);
      box-shadow: 0 0 0 1px var(--perf-accent);
    }
  }

  /* THE FINDINGS, DOWN THE RIGHT. This is the column that scrolls. */
  &__findings {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  /* The scrolling list inside it. */
  &__findings-scroll {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
    scrollbar-color: var(--perf-scroll) transparent;

    &::-webkit-scrollbar {
      width: 8px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: var(--perf-scroll);
      border-radius: 4px;
    }

    &::-webkit-scrollbar-thumb:hover {
      background: var(--perf-scroll-hover);
    }
  }

  &__finding {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 11px 14px;
    background: var(--perf-card);
    border: 1px solid var(--perf-border);
    border-radius: 10px;

    &.is-warn {
      border-color: #5a4220;
    }
  }

  &__finding-head {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 0;
    background: transparent;
    border: none;
    color: inherit;
    font-family: var(--perf-font);
    text-align: left;
    cursor: pointer;

    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 1px var(--perf-accent);
      border-radius: 4px;
    }
  }

  &__dot {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 2px;
    background: var(--perf-muted);

    .is-ok & {
      background: var(--perf-ok);
    }

    .is-warn & {
      background: var(--perf-warn);
    }

    .is-bad & {
      background: var(--perf-bad);
    }
  }

  &__finding-title {
    flex: 1;
    min-width: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--perf-text);
  }

  /* THE SEVERITY, IN WORDS. */
  &__sev {
    flex: none;
    font-family: var(--perf-label-font);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--perf-muted);

    .is-ok & {
      color: var(--perf-ok);
    }

    .is-warn & {
      color: var(--perf-warn);
    }

    .is-bad & {
      color: var(--perf-bad);
    }
  }

  &__chev {
    flex: none;
    color: var(--perf-muted);
    font-size: 0.8rem;
  }

  &__detail {
    margin: 0;
    padding-left: 20px;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--perf-muted);
  }

  /* THE CHECKLIST. Pinned: it does not scroll away. */
  &__fixes {
    flex: none;
    padding: 12px 14px;
    background: var(--perf-card);
    border: 1px solid var(--perf-border);
    border-radius: 10px;
  }

  &__fixes-head {
    margin: 0 0 8px;
    font-family: var(--perf-font-display);
    font-size: 0.85rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--perf-accent);
  }

  &__fix {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0 0 0 1.2rem;
  }

  &__fix-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  &__fix-action {
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--perf-text);
  }

  /* The setting to change, verbatim — the player copies it. */
  &__fix-where {
    padding: 0.3rem 0.5rem;
    border-left: 2px solid var(--perf-accent);
    background: rgba(255, 255, 255, 0.04);
    font-family: var(--perf-label-font);
    font-size: 0.74rem;
    line-height: 1.4;
    color: var(--perf-text);
    word-break: break-word;
  }

  &__fix-why {
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--perf-muted);
  }
}
</style>
