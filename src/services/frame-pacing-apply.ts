/**
 * Capping the tick rate the engine is offered.
 *
 * WHY THIS IS NOT A CVar
 * ----------------------
 * The obvious fix would be to set `fps_max`. It does not work: with
 * vsync on, the engine never reads it. Upstream `engine/common/host.c`:
 *
 *     if( gl_vsync.value )
 *         fps = max_fps;              // MAX_FPS_SOFT = 200
 *     else
 *         fps = host_maxfps.value;    // "fps_max" -- ONLY when vsync is off
 *
 * Measured against production: at `fps_max 5` the engine still
 * rendered 60 fps. The cvar is inert.
 *
 * Setting `gl_vsync 0` DOES make `fps_max` live -- measured -- but it
 * costs the vsync alignment that makes frames land on the display's
 * refresh boundary:
 *
 *     shipped (vsync on)        engine 59.2 fps  median 16.7 ms  p99 20.1 ms
 *     gl_vsync 0, fps_max 60    engine 52.2 fps  median 19.5 ms  p99 21.3 ms
 *     gl_vsync 0, fps_max 30    engine 27.4 fps  median 36.6 ms  p99 38.0 ms
 *
 * The median drifts off the display's grid (19.5 ms on a 60 Hz
 * display), which is the judder we are trying to remove. So the cap
 * has to be applied ABOVE the engine, at the tick source.
 *
 * WHERE THE TICKS COME FROM
 * -------------------------
 * Emscripten drives the engine's main loop from `requestAnimationFrame`:
 *
 *     MainLoop.scheduler = function MainLoop_scheduler_rAF() {
 *         MainLoop.requestAnimationFrame(MainLoop.runner);
 *     };
 *     requestAnimationFrame(func) {
 *         if (globalThis.requestAnimationFrame) {
 *             requestAnimationFrame(func);
 *         } else { ... }
 *     }
 *
 * `MainLoop` is not reachable from the page -- it is not on `window`,
 * not on the Module object, and the timing functions are not exported.
 * But the global `requestAnimationFrame` IS the engine's tick source,
 * so replacing it puts a gate in front of the engine's loop.
 *
 * Verified against production: with every SECOND callback forwarded,
 * the engine's rendered frame rate fell from 60.3/s to 0.3/s.
 *
 * WHY COALESCE AND NOT DROP
 * --------------------------
 * That 0.3/s is the whole lesson. The engine's loop is
 * SELF-RESCHEDULING: `MainLoop.runner` calls `MainLoop.scheduler()` at
 * the end of every frame, which is what asks for the next frame. So
 * DROPPING a callback does not skip a frame -- it kills the loop. The
 * engine never asks again.
 *
 * The gate therefore COALESCES: a callback that arrives on a tick we
 * want to skip is held and re-offered on the next tick, and the
 * engine's callback runs only on the ticks we choose. The engine
 * still gets asked for a frame every tick; it just is not given the
 * ones we are skipping. The frames it does draw land on vsync
 * boundaries, evenly spaced, which is the entire point.
 *
 * ONLY THE ENGINE IS GATED
 * ------------------------
 * The app itself uses rAF for three one-shot key-binding calls and a
 * loading spinner that unmounts. Those must not be delayed, so the
 * gate learns WHICH callback is the engine's -- it is the one called
 * most often, once per frame -- and gates only that one. Every other
 * callback is forwarded immediately.
 *
 * WHAT IT COSTS
 * -------------
 * On a display the engine can already sustain, the gate GATES
 * NOTHING: `shouldCap` returns false, the divisor stays at 1, and
 * every callback is forwarded on the tick it arrived. The cap only
 * engages when the engine would otherwise miss deadlines.
 *
 * THE SHIM STAYS INSTALLED, THOUGH. It is NOT removed on a display
 * the engine can already sustain -- an earlier version of this
 * comment claimed it was, and it was never true. The shim IS the
 * global `requestAnimationFrame` patch, and it stays for the life of
 * the page.
 *
 * What that costs, at a divisor of 1:
 *
 *   - every rAF callback goes through one Map insert and one delete,
 *     and is timed with two `performance.now()` calls -- a few
 *     microseconds against a 16.7 ms frame budget;
 *   - no callback is delayed: they still run on the tick they were
 *     asked for, and the app's own one-shots still run immediately;
 *   - and the diagnostics keep working, because the state is read
 *     live rather than snapshotted once.
 *
 * The alternative -- uninstalling the shim when the cap is not
 * needed -- was not taken because uninstalling has to hand the
 * engine's held callback back to the browser (see
 * `uninstallFramePacing`), and a global rAF patch that is removed
 * and re-installed around the engine's loop is a much larger thing
 * to get wrong than a few microseconds per frame.
 */
import {
  computeFrameTarget,
  decideFrameGate,
  frameIntervalMs,
  isLate,
  sustainableFps,
} from './frame-pacing.ts';

/**
 * HOW LONG THE ENGINE IS GIVEN TO WARM UP.
 *
 * FIFTEEN SECONDS, measured from the engine's FIRST FRAME.
 *
 * WHY THE NUMBER IS A PARAMETER AND NOT A LAW
 * -------------------------------------------
 * The research (`docs/CLIENT-PERF-RESEARCH.md`) measured the engine's
 * frame cost settling over 25-30 seconds: the first window is the
 * most expensive one the engine will ever produce, because it is
 * compiling shaders and streaming the map.
 *
 * Thirty seconds would leave the first half-minute of a match on a
 * provisional cap, which is a long time to be wrong in public. Fifteen
 * is where the curve has flattened enough for the median to be
 * representative, and the policy's own 0.85 safety factor covers the
 * rest: a cost measured 15% too low still leaves the engine inside
 * its budget.
 *
 * It is a constant so it can be named, tested and changed in one
 * place — and it is a PARAMETER of `applyFrameCap`, so a measurement
 * can be taken with the warm-up turned off.
 */
export const WARMUP_MS = 15000;

/**
 * HOW LONG A MEASUREMENT WINDOW IS.
 *
 * TWO SECONDS. Long enough to hold a couple of hundred frames on a
 * fast display, short enough that the cost it reports is about NOW
 * and not about ten seconds ago.
 */
const OBSERVE_MS = 2000;

/** What the pacer decided, for the log and the diagnostics. */
export interface PacingState {
  /** The cap in force, in frames per second. 0 = no cap. */
  capFps: number;
  /**
   * The rate the BROWSER is delivering ticks at, right now.
   *
   * This is the browser's own tick rate, measured from the intervals
   * between the ticks. It is NOT the rate the game is drawing at: the
   * browser keeps ticking at full speed while the engine draws every
   * Nth tick, so with a cap in force these two numbers say different
   * things. The game's own rate is `engineFps`.
   */
  browserHz: number;
  /**
   * The DISPLAY's refresh rate, measured while the page was idle.
   *
   * This is the one the cap decision uses. It is measured separately
   * because the live tick rate is contaminated by the engine's own
   * work -- see the note on `measureIdleDisplayHz`.
   */
  panelHz: number;
  /**
   * The rate the GAME is drawing frames at.
   *
   * MEASURED DIRECTLY, from the engine's own frame starts. This is the
   * number the readout's "the game was drawing N fps" uses, and it is
   * the reason the readout stopped confusing the browser's tick rate
   * with the game's frame rate.
   */
  engineFps: number;
  /** The engine's measured per-frame cost, in milliseconds. */
  engineWorkMs: number;
  /** The frame rate the engine can sustain. */
  sustainableFps: number;
  /**
   * Whether the gate is DROPPING TICKS.
   *
   * Derived from the gate itself -- it is true exactly when
   * `everyNth` is greater than 1 -- so it cannot say the engine is
   * running uncapped while the gate is still halving its rate.
   */
  active: boolean;
  /** How many display ticks per engine frame. 1 = every tick. */
  everyNth: number;
  /**
   * Is the gate in force a PROVISIONAL decision?
   *
   * True when the gate was taken from a warm-up reading -- the first
   * seconds of the match, before the engine had settled. The readout
   * says so, because a provisional number is not a measurement of the
   * machine; it is a measurement of the engine warming up.
   */
  provisional: boolean;
  /**
   * How many of the ENGINE's frames arrived LATE in the measurement
   * window -- the game did not land in its slot.
   *
   * THIS COUNTS THE ENGINE'S FRAMES, NOT THE BROWSER'S TICKS. The old
   * metric counted tick gaps over 1.5x the tick budget, which with a
   * cap engaged read a quarter of the ticks as "late" even when the
   * game was perfectly paced -- because the engine's frame overruns
   * the tick it started on. The metric that answers "is the judder
   * gone" is the ENGINE's frame spacing against the GATE's period.
   */
  lateFrames: number;
  /**
   * How many of the ENGINE's frames the measurement window saw.
   *
   * `lateFrames` on its own is a count with nothing to be a fraction
   * OF, so a window that saw 10 frames and a window that saw 1000
   * would report the same number for the same problem. This is the
   * denominator, and it is what makes "8% of frames arrived late" a
   * statement about the client rather than about the window length.
   */
  measuredFrames: number;
  /**
   * The fraction of the engine's frames that arrived late, 0..1.
   *
   * This is the number the policy's widening rule reads: above 5%, the
   * engine is already missing its slots and the gate must not be
   * widened.
   */
  lateFraction: number;
  /**
   * When the measurement window closed, in epoch milliseconds.
   *
   * The readout says when the numbers were measured, so a player can
   * tell a reading taken in the first seconds of a match from one
   * taken a minute in.
   */
  measuredAt: number;
  /**
   * Was that window past the engine's warm-up?
   *
   * False means the reading describes the engine WARMING UP, not the
   * machine. The readout says which it is.
   */
  settled: boolean;
  /**
   * When the engine's FIRST FRAME was, in epoch milliseconds.
   *
   * The warm-up is measured from here, and it is what lets the
   * readout say "measured 32 seconds into your game".
   */
  gameStartAt: number;
  /**
   * The DISPLAY's rate as it was measured while the page was IDLE.
   *
   * THIS IS THE ONE NUMBER THAT CATCHES A THROTTLE.
   *
   * The live tick rate cannot tell a slow browser from a slow engine,
   * because both stretch the interval between ticks. But the rate
   * measured at load — before the engine existed — is the display's
   * own rate. If the live rate has fallen BELOW that, something has
   * taken refreshes away from the page since it loaded, and the
   * readout can say so with a measurement on both sides.
   *
   * Chrome's Energy Saver is the usual culprit: it drops a 120 Hz
   * panel to 60 Hz (or to 78 Hz on some machines) when the machine is
   * unplugged, and the player's only symptom is a game that feels
   * worse than the display can show.
   */
  idlePanelHz: number;
  /**
   * The distribution of the ENGINE's frame spacing.
   *
   * THE GAP BETWEEN THE FRAMES THE PLAYER SEES. The engine's own
   * counter reports how many frames it drew; this says how far apart
   * they were, which is the thing the eye reads as smoothness.
   *
   * A perfectly paced game on a 144 Hz display has a p50 of 13.9 ms
   * and a p99 of 13.9 ms. The same game juddering has a p50 of 13.9 ms
   * and a p99 of 41.7 ms, and the buckets show exactly which frames
   * were late.
   */
  pacing: FrameSpacing;
  /** Why. */
  reason: string;
}

/**
 * THE SHAPE OF THE ENGINE'S FRAME SPACING.
 *
 * The percentiles are the honest summary — a median with a long tail
 * is a different thing from a median with a short one, and the mean
 * cannot tell them apart — and the buckets are the picture: one
 * dominant bucket means even pacing, several means uneven, and that
 * is the single clearest line in a frame-timing report.
 */
export interface FrameSpacing {
  /** The median frame spacing, in milliseconds. */
  p50: number;
  /** The 90th percentile. */
  p90: number;
  /** The 99th percentile. */
  p99: number;
  /** The worst spacing in the window. */
  max: number;
  /**
   * The most common spacings, rounded to a tenth of a millisecond,
   * with their counts. Sorted by count, biggest first.
   */
  buckets: Array<{ ms: number; count: number }>;
  /** How many spacings the window saw. */
  samples: number;
}

/**
 * The parts of the state that are NOT the gate.
 *
 * `everyNth` and `active` are deliberately absent: they are DERIVED
 * from the gate itself, in `getPacingState()`. See the note there.
 */
interface PacingCore {
  capFps: number;
  browserHz: number;
  panelHz: number;
  engineFps: number;
  engineWorkMs: number;
  sustainableFps: number;
  provisional: boolean;
  lateFrames: number;
  measuredFrames: number;
  lateFraction: number;
  measuredAt: number;
  settled: boolean;
  gameStartAt: number;
  idlePanelHz: number;
  pacing: FrameSpacing;
  reason: string;
}

/**
 * ONE MEASUREMENT WINDOW, AS IT WAS RECORDED.
 *
 * The pacer takes a reading every ten seconds, and each one is a
 * point on the timeline of the match: the engine's frame cost, what
 * the game was drawing, what the browser was handing it, and how many
 * of the engine's frames arrived late.
 *
 * WHICH IS THE TIMELINE THAT ANSWERS "WHY DID IT DROP THERE".
 *
 * A single reading says what the machine was doing at one moment. A
 * timeline says where the drops were and what else was happening when
 * they happened — the scene, the gate, the browser's rate — and it is
 * the only thing that can separate "the game got expensive here" from
 * "the browser stopped feeding it here".
 */
export interface PacingWindow {
  /** When the window closed, in epoch milliseconds. */
  at: number;
  /** The engine's per-frame cost, in milliseconds. */
  engineWorkMs: number;
  /** The rate the GAME was drawing, in fps. */
  engineFps: number;
  /** The rate the BROWSER was delivering ticks at. */
  browserHz: number;
  /** The DISPLAY's rate. */
  panelHz: number;
  /** The gate in force: display ticks per engine frame. */
  everyNth: number;
  /** The fraction of the engine's frames that arrived late, 0..1. */
  lateFraction: number;
  /** Was the reading past the engine's warm-up? */
  settled: boolean;
  /** The median gap between the engine's frames, in milliseconds. */
  frameP50Ms: number;
  /** The 99th percentile of that gap, in milliseconds. */
  frameP99Ms: number;
  /**
   * WAS THE GAME FULLSCREEN WHEN THIS WINDOW CLOSED?
   *
   * This is the one bit of the timeline that answers the question
   * everybody asks: "why is fullscreen worse than windowed?"
   *
   * It is measured from the CANVAS'S OWN SIZE against the SCREEN'S,
   * and not from `document.fullscreenElement`, because the browser's
   * own fullscreen (F11) does not set that — and F11 is how most
   * people actually play. The canvas covering the screen is the fact
   * that matters either way.
   */
  fullscreen: boolean;
}

/**
 * HOW MANY WINDOWS ARE KEPT.
 *
 * Nine hundred windows is half an hour at the pacer's ten-second
 * cadence, and each one is a few dozen bytes — so the whole history
 * is a few tens of kilobytes, which is nothing to keep and everything
 * to have.
 */
const MAX_HISTORY = 900;

/**
 * THE TIMELINE.
 *
 * Appended to at the end of every measurement window, and read by the
 * log exporter. It is a plain array on purpose: the timeline is
 * small, the export is a file, and a ring buffer would make the
 * export's order harder to read.
 */
const windowHistory: PacingWindow[] = [];

/** The timeline of the match, oldest first. */
export function getPacingHistory(): PacingWindow[] {
  return windowHistory.map((w) => ({ ...w }));
}

/** Forget the timeline. */
export function clearPacingHistory(): void {
  windowHistory.length = 0;
}

/**
 * IS THE GAME FILLING THE SCREEN?
 *
 * The canvas's own size against the screen's, with a little slack for
 * the border a windowed browser draws.
 *
 * NOT `document.fullscreenElement`: that is only set by the Fullscreen
 * API, and the browser's own fullscreen — F11, and the way most
 * people actually play — leaves it null. The canvas covering the
 * screen is the fact that matters either way, and it is also the
 * fact that the frame cost differs by.
 */
function viewportFillsScreen(): boolean {
  if (typeof document === 'undefined' || typeof screen === 'undefined') return false;
  const canvas = document.querySelector('canvas');
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.width >= screen.width * 0.95 && rect.height >= screen.height * 0.95;
}

/**
 * RECORD ONE WINDOW.
 *
 * Called at the end of every measurement, whatever the window said.
 * A window that measured nothing is worth keeping too: "the engine
 * stopped" is a finding, and a timeline with a gap in it is the
 * evidence.
 */
function recordWindow(): void {
  windowHistory.push({
    at: core.measuredAt || Date.now(),
    engineWorkMs: core.engineWorkMs,
    engineFps: core.engineFps,
    browserHz: core.browserHz,
    panelHz: core.panelHz,
    everyNth,
    lateFraction: core.lateFraction,
    settled: core.settled,
    frameP50Ms: core.pacing.p50,
    frameP99Ms: core.pacing.p99,
    fullscreen: viewportFillsScreen(),
  });
  while (windowHistory.length > MAX_HISTORY) windowHistory.shift();
}

/** The shape of a window that has measured nothing. */
const EMPTY_SPACING: FrameSpacing = {
  p50: 0,
  p90: 0,
  p99: 0,
  max: 0,
  buckets: [],
  samples: 0,
};

/** The pacer singleton's state. Read by the diagnostics. */
let core: PacingCore = {
  capFps: 0,
  browserHz: 0,
  panelHz: 0,
  engineFps: 0,
  engineWorkMs: 0,
  sustainableFps: 0,
  provisional: false,
  lateFrames: 0,
  measuredFrames: 0,
  lateFraction: 0,
  measuredAt: 0,
  settled: false,
  gameStartAt: 0,
  idlePanelHz: 0,
  pacing: EMPTY_SPACING,
  reason: 'not measured yet',
};

/**
 * Every Nth tick is allowed through to the engine.
 *
 * THE GATE IS THE ONLY COPY OF THIS NUMBER.
 *
 * It used to have a second copy, in `state.everyNth`, and the two
 * could drift: the "not capping" branch set `state.everyNth = 1` and
 * left this one at its old value, so the engine kept running at half
 * speed while the diagnostics reported "not capping, everyNth 1". A
 * state that lies about the machine is the exact bug this whole
 * feature exists to fix, so the gate is now the single source of
 * truth and the reported state is derived from it.
 */
let everyNth = 1;

/**
 * The current state, for the log and the diagnostics.
 *
 * `everyNth` and `active` come from the GATE, not from a stored
 * copy of it, so they cannot disagree with what the shim is
 * actually doing: `active` is true exactly when the gate is
 * dropping ticks.
 */
export function getPacingState(): PacingState {
  return {
    ...core,
    everyNth,
    active: everyNth > 1,
  };
}

/** The native rAF, captured before any patching. */
const nativeRaf =
  typeof window !== 'undefined' && window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : null;
/** The native cancel, captured alongside the native rAF. */
const nativeCancel =
  typeof window !== 'undefined' && window.cancelAnimationFrame
    ? window.cancelAnimationFrame.bind(window)
    : null;

/**
 * The browser's REAL refresh rate, measured while the page was idle.
 *
 * WHY THIS EXISTS — THE MEASUREMENT WAS WRONG
 * -------------------------------------------
 * The pacer read the display's refresh rate from the intervals between
 * the SHIM'S OWN TICKS. The shim's tick is the browser's rAF callback,
 * and that callback runs the ENGINE's frame. So the interval between
 * two ticks is:
 *
 *     the display's frame period  +  the engine's work
 *
 * When the engine keeps up, the second term is small and the number
 * is right. When the engine OVERRUNS the frame period, the browser
 * misses a vsync and the tick stretches to two display periods — and
 * the pacer reads that stretched interval as "the display is half as
 * fast as it is".
 *
 * MEASURED (2026-11-07, Kyle's MacBook Pro, M3 Pro, Liquid Retina XDR
 * 120 Hz panel):
 *
 *     the panel's own rate (CoreGraphics):   120.0 Hz
 *     a bare rAF loop, no game:              120.5 Hz
 *     the pacer's reading, with the game:     60.1 Hz
 *
 * So the pacer believed the display was a 60 Hz panel when it was a
 * 120 Hz one — and it believed that BECAUSE the engine could not keep
 * up, which is the exact condition the pacer exists to handle.
 *
 * WHY THAT BREAKS THE CAP
 * -----------------------
 * The cap's whole job is to hold the engine to a DIVISOR of the
 * display's period, so the frames it does draw land evenly. With the
 * display rate wrong, the divisor is wrong, and the pacer can decide
 * NOT TO CAP AT ALL on a fast display — which is the one case where
 * capping matters. Checked against the real policy:
 *
 *     true display   engine cost   measured as   the decision
 *     144 Hz         8.0 ms        72 Hz         "not capping"  ← WRONG
 *     144 Hz         7.0 ms        72 Hz         "not capping"  ← WRONG
 *     240 Hz         5.0 ms        120 Hz        "not capping"  ← WRONG
 *
 * With the TRUE display rate the same three cases cap to 72, 72 and
 * 120 fps respectively — each a divisor of the panel, each evenly
 * spaced.
 *
 * THE FIX
 * -------
 * Measure the display's rate while the page is IDLE, and use THAT for
 * the cap decision. The live tick rate stays in the state, because it
 * is still the honest answer to "how many frames is the game actually
 * delivering" — the two numbers mean different things and the readout
 * shows both.
 *
 * The measurement uses the rAF TIMESTAMP rather than `performance.now()`:
 * the timestamp is the time the browser scheduled the frame, so it is
 * the display's clock and not ours.
 */
let idleDisplayHz = 0;

/**
 * Measure the browser's refresh rate, while the page is idle.
 *
 * MUST be called while the engine is NOT running its frame loop. With
 * the engine running, the intervals are stretched by the engine's own
 * work and the number is wrong — that is the whole point of this
 * function.
 *
 * The sample window is short by design: it is called on the landing
 * page, and it must not hold the boot up.
 */
export async function measureIdleDisplayHz(observeMs = 700): Promise<number> {
  // ONE MEASUREMENT AT A TIME.
  //
  // The landing page starts a measurement at startup and the loader
  // asks for one before the engine boots. A player who clicks PLAY
  // quickly would otherwise have two samplers running at once, each
  // with its own rAF chain, and the second one's samples would land
  // in the first one's window.
  if (idleMeasureInFlight) return idleMeasureInFlight;
  idleMeasureInFlight = measureIdleDisplayHzOnce(observeMs);
  try {
    return await idleMeasureInFlight;
  } finally {
    idleMeasureInFlight = null;
  }
}

/** The in-flight measurement, so two callers share one sampler. */
let idleMeasureInFlight: Promise<number> | null = null;

/** The measurement itself. */
async function measureIdleDisplayHzOnce(observeMs: number): Promise<number> {
  if (typeof window === 'undefined') return 0;
  const raf = window.requestAnimationFrame;
  if (!raf) return 0;

  const stamps: number[] = [];
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const tick = (t: number) => {
      stamps.push(t);
      if (stamps.length >= 40) {
        finish();
        return;
      }
      raf(tick);
    };
    raf(tick);
    // The safety net: a backgrounded tab gets no rAF at all, and this
    // must never hang the boot on it.
    setTimeout(finish, observeMs + 150);
  });

  if (stamps.length < 10) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!isFinite(median) || median <= 0) return 0;

  const hz = 1000 / median;
  // Only trust a reading that is plausibly a display rate. A window
  // that was throttled to 1 Hz (a backgrounded tab) would otherwise
  // be recorded as the display's rate, and that is a worse lie than
  // no number at all.
  if (hz < 20 || hz > 500) return 0;

  idleDisplayHz = hz;
  return hz;
}

/** The idle-measured refresh rate, in Hz. 0 = not measured. */
export function getIdleDisplayHz(): number {
  return idleDisplayHz;
}


/** Is the shim installed? */
let shimInstalled = false;

/** The engine's callback, once it has been identified. */
let engineCallback: unknown = null;

/**
 * The callbacks waiting to run.
 *
 * Keyed by the id we handed back to the caller, so
 * `cancelAnimationFrame` removes exactly the right one. A SINGLE
 * pending slot would silently drop the app's own rAF callbacks -- the
 * loading spinner and the three one-shot key-binding calls -- which
 * shows up as "the spinner stopped", not as an error.
 */
const pending = new Map<number, FrameRequestCallback>();

/**
 * The ids we hand out.
 *
 * They start HIGH, above anything a browser's own rAF ids reach, so
 * that an id handed out by the shim can never collide with one
 * handed out by the browser. That matters after the shim is removed:
 * the browser's `cancelAnimationFrame` would otherwise be able to
 * cancel an unrelated frame that happened to get the same number.
 */
const ID_BASE = 1_000_000;
let nextId = ID_BASE;

/** Is a native rAF already scheduled? */
let scheduled = false;

/** The tick counter, for the every-Nth decision. */
let tick = 0;

/** Per-callback statistics, for identifying the engine's. */
interface CallbackStats {
  calls: number;
  /**
   * The recent durations of this callback, in milliseconds.
   *
   * The MEDIAN of these is the per-frame cost -- see `readMeasurement`
   * for why the median and not the mean.
   */
  samples: number[];
  /**
   * The recent frame STARTS of this callback, in performance-clock
   * milliseconds.
   *
   * The gaps between them are the ENGINE's frame spacing, which is
   * what the late-frame metric measures and what the engine's own
   * frame rate is counted from. The browser's tick rate cannot answer
   * either question: with the gate in force the browser keeps ticking
   * at the panel's rate while the engine draws every Nth tick, so the
   * two numbers say different things.
   *
   * The starts are recorded from the clock reading the shim already
   * takes around every callback, so this costs NO extra clock read --
   * which matters, because the parent's fake-clock harness counts
   * those reads to keep its samples deterministic.
   */
  starts: number[];
}
const stats = new Map<unknown, CallbackStats>();

/**
 * WHEN EACH CALLBACK WAS FIRST SEEN.
 *
 * The engine's TRUE first frame is what the warm-up is measured from,
 * and the first frame happens long before the first measurement
 * window closes -- so this map is NOT cleared between windows. Only
 * the one-shot callbacks (the app's spinner, the key-binding calls)
 * are pruned, and they are pruned because they will never be seen
 * again.
 */
interface FirstSeen {
  /** The performance-clock timestamp of the first frame. */
  perf: number;
  /** The same moment, in epoch milliseconds. */
  epoch: number;
}
const firstSeen = new Map<unknown, FirstSeen>();

/**
 * The engine's first frame, in epoch milliseconds.
 *
 * 0 until the engine's callback has been identified.
 */
let gameStartAtMs = 0;

/**
 * The last target gate a window asked for, and how many windows in a
 * row have asked for it.
 *
 * THE COUNTER INCLUDES THE CURRENT WINDOW: the first window that
 * asks for a narrower gate counts as 1, and the second window that
 * asks for the same one counts as 2 -- which is what lets the policy
 * narrow the gate on the second window and not on the first.
 */
let lastTargetEveryNth: number | null = null;
let consecutiveSame = 0;
/**
 * WAS THE GATE IN FORCE FORCED BY THE HARNESS?
 *
 * A forced gate is the measurement harness's: it wants to see what a
 * particular cap does, so the policy does not get to move it. The flag
 * survives until the next policy decision, which is when the policy
 * sees it.
 */
let forcedGate = false;


/**
 * How many recent samples to keep per callback.
 *
 * A rolling window is plenty: the engine's per-frame cost does not
 * change, and an unbounded list of every frame since boot is a leak
 * in a long session.
 */
const MAX_SAMPLES = 240;

/** The intervals between display ticks, for the refresh rate. */
const intervals: number[] = [];
let lastTickAt = 0;

/**
 * Record one callback's duration.
 *
 * The DURATION is the engine's per-frame cost: the engine's callback
 * IS its frame -- input, simulation and rendering all happen inside
 * it. So timing it measures the thing the cap is supposed to fit
 * inside the display's frame budget.
 *
 * The START is the frame's position on the clock, and the gaps
 * between the starts are the engine's frame spacing.
 */
function noteCallback(cb: unknown, startedAt: number, durationMs: number): void {
  let s = stats.get(cb);
  if (!s) {
    s = { calls: 0, samples: [], starts: [] };
    stats.set(cb, s);
  }
  s.calls++;
  s.samples.push(durationMs);
  s.starts.push(startedAt);
  if (s.samples.length > MAX_SAMPLES) s.samples.shift();
  if (s.starts.length > MAX_SAMPLES) s.starts.shift();
  if (!firstSeen.has(cb)) {
    firstSeen.set(cb, { perf: startedAt, epoch: epochFromPerf(startedAt) });
  }
}

/**
 * A performance-clock timestamp, in epoch milliseconds.
 *
 * `performance.timeOrigin` is the browser's own epoch for the
 * performance clock, so adding the timestamp to it gives the same
 * instant on both clocks without reading the clock again -- and NOT
 * reading the clock again matters, because every extra read moves
 * the parent's fake clock and changes the samples it collects.
 *
 * Where there is no time origin (the fake clock in the test harness),
 * the wall clock is used instead.
 */
function epochFromPerf(perfMs: number): number {
  const origin =
    typeof performance !== 'undefined'
      ? (performance as unknown as { timeOrigin?: number }).timeOrigin
      : undefined;
  if (typeof origin === 'number' && isFinite(origin)) return origin + perfMs;
  return Date.now();
}

/**
 * The median of a set of numbers.
 *
 * For an even count, the average of the two middle values.
 */
function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A percentile of a set of numbers.
 *
 * The NEAREST-RANK definition: the smallest value at or above which
 * the given fraction of the samples lie. The interpolation variants
 * invent a number that no frame actually had, and this report is
 * about frames — the p99 has to be a frame somebody sat through.
 */
function percentileOf(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * THE SHAPE OF THE ENGINE'S FRAME SPACING.
 *
 * The gaps between the engine's frame starts — the interval between
 * the frames the player actually sees, which is NOT the interval
 * between the browser's ticks (with the gate in force the browser
 * keeps ticking at the panel's rate while the engine draws every Nth
 * tick, so those are different numbers by a factor of N).
 *
 * AND THE BUCKETS ARE THE PICTURE. The repo's own research says the
 * bucket histogram is the clearest single line in a frame-timing
 * report: one dominant bucket means the frames are evenly spaced,
 * and several buckets mean the gaps are uneven, which is judder.
 * The percentiles say how bad it is; the buckets say what it looks
 * like.
 */
export function summarizeSpacing(starts: number[]): FrameSpacing {
  if (!starts || starts.length < 2) {
    return { ...EMPTY_SPACING };
  }
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return { ...EMPTY_SPACING };

  // THE BUCKETS. Rounded to a tenth of a millisecond, because the
  // frames land on the display's grid and the grid IS the point: two
  // frames 13.9 ms apart are the same bucket however the fraction
  // falls, and a bucket at 41.7 ms is a dropped frame.
  const counts = new Map<number, number>();
  for (const gap of gaps) {
    const key = Math.round(gap * 10) / 10;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const buckets = [...counts.entries()]
    .map(([ms, count]) => ({ ms, count }))
    .sort((a, b) => (b.count - a.count) || (a.ms - b.ms))
    .slice(0, 10);

  return {
    p50: percentileOf(gaps, 50),
    p90: percentileOf(gaps, 90),
    p99: percentileOf(gaps, 99),
    max: gaps[gaps.length - 1],
    buckets,
    samples: gaps.length,
  };
}

/** The tick the shim runs on, deciding whether the engine runs. */
function onTick(time: number): void {
  scheduled = false;

  const now = performance.now();
  if (lastTickAt > 0) {
    intervals.push(now - lastTickAt);
    // A rolling window is plenty; the refresh rate does not change.
    if (intervals.length > 240) intervals.shift();
  }
  lastTickAt = now;

  tick++;

  // The ENGINE's frame runs on every Nth tick. On a skipped tick it
  // is HELD, not dropped: dropping would kill the engine's loop,
  // because the engine asks for its next frame from inside the
  // callback we just declined to run.
  //
  // Every OTHER callback -- the app's -- always runs. They are not the
  // engine's, and delaying them would be a bug.
  const allowEngine = everyNth <= 1 || tick % everyNth === 0;

  const toRun: Array<[number, FrameRequestCallback]> = [];
  for (const [id, cb] of pending) {
    if (!allowEngine && cb === engineCallback) continue;
    toRun.push([id, cb]);
  }

  for (const [id, cb] of toRun) {
    pending.delete(id);
    const started = performance.now();
    try {
      cb(time);
    } catch (e) {
      console.error('[frame-pacing] a frame callback threw:', e);
    }
    noteCallback(cb, started, performance.now() - started);
  }

  // Keep the chain alive: if anything is still pending -- including the
  // engine's held callback -- there will be another tick.
  if (pending.size) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  nativeRaf?.(onTick);
}

/**
 * Install the measuring shim.
 *
 * While observing, every callback is forwarded and timed. The one
 * called most often is the engine's -- it runs once per frame, while
 * the app's are one-shot.
 */
export function installFramePacingShim(): void {
  if (shimInstalled) return;
  if (!nativeRaf) return;
  shimInstalled = true;

  window.requestAnimationFrame = ((
    callback: FrameRequestCallback,
  ): number => {
    const id = nextId++;
    pending.set(id, callback);
    schedule();
    return id;
  }) as typeof window.requestAnimationFrame;

  // Cancel has to work, or a component that unmounts leaves its
  // callback running forever.
  if (nativeCancel) {
    window.cancelAnimationFrame = ((
      id: number,
    ): void => {
      pending.delete(id);
    }) as typeof window.cancelAnimationFrame;
  }
}

/**
 * Remove the shim and restore the native rAF.
 *
 * WHAT THIS DOES TO THE ENGINE'S LOOP
 * ------------------------------------
 * It does NOT stop it. The engine asks for its next frame from
 * INSIDE the frame it just ran, so a callback that is DROPPED here
 * would take the engine from 60.3 fps to 0.3 fps -- the loop would
 * never be asked for again.
 *
 * So the held callbacks are HANDED BACK: each one is re-offered to
 * the browser's own `requestAnimationFrame`, which runs it on the
 * next native frame. The engine's callback runs there, asks for its
 * next frame from the now-restored native rAF, and the loop
 * continues on the browser's own schedule -- just without the gate
 * and without the measurement.
 *
 * The frame rate does not change; what goes away is the pacing.
 */
export function uninstallFramePacing(): void {
  if (!shimInstalled) return;
  shimInstalled = false;

  // Restore the native rAF FIRST, so that a callback which
  // re-registers itself -- which is exactly what the engine's does --
  // registers with the browser and not with the shim being removed.
  if (nativeRaf) {
    window.requestAnimationFrame =
      nativeRaf as unknown as typeof window.requestAnimationFrame;
  }
  if (nativeCancel) {
    window.cancelAnimationFrame =
      nativeCancel as unknown as typeof window.cancelAnimationFrame;
  }

  // Hand the held callbacks back to the browser rather than dropping
  // them. Dropping the engine's callback kills the engine's loop.
  const held = [...pending.values()];
  pending.clear();
  for (const cb of held) nativeRaf?.(cb);

  scheduled = false;
  engineCallback = null;

  // The gate comes off, and the reported state follows it -- the state
  // is derived from the gate, so the two cannot disagree.
  everyNth = 1;
  core = {
    ...core,
    capFps: 0,
    provisional: false,
    reason: 'the frame-pacing shim was uninstalled; not capping',
  };
}

/**
 * The measurement, from the shim's own observations.
 *
 * `browserHz` is the rate the BROWSER is delivering ticks at, from the
 * median interval between the ticks.
 *
 * `engineWorkMs` is how long the engine's own callback takes -- the
 * engine's per-frame cost, measured directly, not inferred.
 *
 * `engineFps` is how many frames the GAME is drawing, counted from
 * the engine's own frame starts. It is NOT the browser's rate: with
 * the gate in force the browser keeps ticking at the panel's rate
 * while the engine draws every Nth tick.
 *
 * `lateFrames` is how many of the ENGINE's frames arrived late --
 * measured against the GATE's period, so a game that is landing its
 * frames on time reads zero even though the browser's ticks are
 * uneven. That is the unevenness this feature exists to remove,
 * counted where it happens.
 */
export function readMeasurement(): {
  browserHz: number;
  engineWorkMs: number;
  engineFps: number;
  lateFrames: number;
  measuredFrames: number;
  pacing: FrameSpacing;
} {
  // The browser's tick rate: the median interval between ticks.
  let browserHz = 0;
  if (intervals.length >= 10) {
    const median = medianOf(intervals);
    if (median > 0) browserHz = 1000 / median;
  }

  // The engine's cost: the callback with the most calls is the one
  // that runs every frame. Its MEDIAN duration is the per-frame cost.
  //
  // THE MEDIAN, NOT THE MEAN. A frame cost is a distribution with a
  // long tail: one frame in a few hundred pays for a shader
  // compilation, a GC pause, or the tab regaining focus. The MEAN is
  // dragged up by that tail, so the estimate it produces is
  // pessimistic -- and `sustainableFps()` already applies a 0.85
  // safety factor to tolerate exactly those outliers. Using the mean
  // as well would count the same outlier TWICE: once in the
  // estimate, once in the safety margin, and the cap would engage
  // harder than the policy intends. The median is unmoved by a
  // handful of outlier frames, which is what a per-frame cost
  // estimate needs to be.
  let engineWorkMs = 0;
  let best: CallbackStats | null = null;
  for (const s of stats.values()) {
    if (!best || s.calls > best.calls) best = s;
  }
  if (best && best.samples.length > 0) {
    engineWorkMs = medianOf(best.samples);
  }

  // The ENGINE's frame rate, counted from its own frame starts.
  //
  // NOT the browser's rate. The browser keeps ticking at the panel's
  // rate while the engine draws every Nth tick, so with the gate in
  // force the two numbers are a factor of N apart -- and only one of
  // them is the frame rate the player is looking at.
  const starts = best ? best.starts : [];
  let engineFps = 0;
  if (starts.length >= 2) {
    const span = starts[starts.length - 1] - starts[0];
    if (span > 0) engineFps = ((starts.length - 1) / span) * 1000;
  }

  // How many of the ENGINE's frames arrived LATE.
  //
  // The threshold is RELATIVE to the GATE's period (see `isLate`),
  // never a constant, so it is correct on a 165 Hz display as well as
  // on a 60 Hz one. And it is measured against the GATE's period and
  // not the browser's tick budget: with a 30 fps gate (a slot every
  // 33.3 ms) and the engine's frames landing every 33.3 ms, the
  // frames are NOT late. The old metric counted the BROWSER's tick
  // gaps, which with a cap engaged read a quarter of the ticks as
  // "late" even when the game was perfectly paced.
  const panelHz = Math.max(browserHz, idleDisplayHz);
  const gateFps = panelHz > 0 ? panelHz / Math.max(1, everyNth) : 0;
  const budget = frameIntervalMs(gateFps);
  let lateFrames = 0;
  for (let i = 1; i < starts.length; i++) {
    if (isLate(starts[i] - starts[i - 1], budget)) lateFrames++;
  }

  return {
    browserHz,
    engineWorkMs,
    engineFps,
    lateFrames,
    measuredFrames: starts.length,
    // THE SHAPE OF THE GAPS. The percentiles and the buckets, from the
    // engine's own frame starts — the frames the player sees.
    pacing: summarizeSpacing(starts),
  };
}

/**
 * Is the frame cap switched OFF for this session?
 *
 * The pattern is the one `wantsDesynchronized()` uses in
 * `webgl-context.ts`: a URL parameter, off by default, read at
 * runtime, and documented.
 *
 *     ?nocap=1
 *
 * THE DEFAULT STAYS ON. The cap is ON unless the parameter says
 * otherwise, because the cap exists because the UNCAPPED engine
 * arrives unevenly on a fast display: a player who wants it off is
 * fixing a problem they can see, and the default must not regress
 * everyone else.
 */
export function wantsNoFrameCap(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('nocap') === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Measure, then cap the engine's tick rate if it needs it.
 *
 * The measurement window is `observeMs`. Call it again later to
 * re-measure; the cap is recomputed and the gate adjusted.
 *
 * THE WINDOW IS NEVER THE WHOLE STORY. The first window closes while
 * the engine is still warming up, so the gate it produces is
 * PROVISIONAL, and the caller keeps calling this function for the
 * rest of the match. The policy in `frame-pacing.ts` decides what a
 * window is allowed to do to the gate: a warm-up window never moves
 * a gate that is already in force, a settled window may widen it
 * when the engine's frames are landing on time, and may narrow it
 * only after two windows in a row have asked for it.
 *
 * `force` applies the cap even when the engine keeps up with the
 * display. That is for MEASUREMENT -- on a 60 Hz test box the engine
 * has twice the budget it needs, so the cap would never engage on its
 * own, and the point of measuring it is to see what it DOES.
 * `everyNth` with it sets a SPECIFIC gate, for the same reason.
 *
 * `warmupMs` is the engine's warm-up, measured from its first frame.
 * It is a parameter so a measurement can be taken with the warm-up
 * turned off -- which is what the parent's test harness does when it
 * wants a settled decision from a two-second window.
 */
export async function applyFrameCap(
  opts: {
    observeMs?: number;
    force?: boolean;
    everyNth?: number;
    warmupMs?: number;
  } = {},
): Promise<PacingState> {
  // ONE MEASUREMENT AT A TIME.
  //
  // A measurement window RESETS the observation buffers, so two of
  // them running at once would wipe each other's samples and both
  // would report half a window as if it were a whole one.
  //
  // The loader's periodic loop is sequential by construction — it
  // schedules the next measurement after the previous one comes back
  // — but the readout's "Re-measure" button calls in from outside
  // that loop, and a player pressing it while the periodic reading
  // is open would open a second window over the first.
  //
  // So a second caller WAITS for the first rather than starting its
  // own: the reading it gets is the one the first caller took, which
  // is a fresh reading a moment later. A caller that wants its own
  // window — the measurement harness — gets it, because the harness
  // is the only caller that sets `force`.
  if (capMeasureInFlight && !opts.force) {
    try {
      await capMeasureInFlight;
    } catch (e) {
      /* the measurement that was already running reports its own failure */
    }
    return getPacingState();
  }

  const run = applyFrameCapOnce(opts);
  capMeasureInFlight = run;
  try {
    return await run;
  } finally {
    if (capMeasureInFlight === run) capMeasureInFlight = null;
  }
}

/** The measurement in flight, so two callers share one window. */
let capMeasureInFlight: Promise<PacingState> | null = null;

/**
 * The measurement itself.
 */
async function applyFrameCapOnce(
  opts: {
    observeMs?: number;
    force?: boolean;
    everyNth?: number;
    warmupMs?: number;
  } = {},
): Promise<PacingState> {
  const observeMs = opts.observeMs ?? OBSERVE_MS;
  const warmupMs = opts.warmupMs ?? WARMUP_MS;

  // The player can switch the cap OFF for their session. It is ON by
  // default, and this is the one thing that turns it off.
  //
  // The opt-out applies to the AUTOMATIC path. `force` is an explicit,
  // deliberate measurement request (the A/B harness), so it still
  // works with the parameter set.
  const optedOut = !opts.force && wantsNoFrameCap();
  if (optedOut) {
    // Nothing is measured and nothing is gated: the page runs exactly
    // as it did before this feature existed. The shim is NOT
    // installed -- there is no point patching the global rAF for a
    // measurement whose result cannot be acted on.
    everyNth = 1;
    core = {
      capFps: 0,
      browserHz: 0,
      panelHz: idleDisplayHz,
      engineFps: 0,
      engineWorkMs: 0,
      sustainableFps: 0,
      provisional: false,
      lateFrames: 0,
      measuredFrames: 0,
      lateFraction: 0,
      measuredAt: 0,
      settled: false,
      gameStartAt: gameStartAtMs,
      idlePanelHz: idleDisplayHz,
      pacing: EMPTY_SPACING,
      reason: 'the frame cap is switched OFF for this session (?nocap=1)',
    };
    return getPacingState();
  }

  // The shim has to be installed before anything can be measured.
  // If it is not, the engine is running on the native rAF and there is
  // nothing to read -- which is what produced a "0 Hz display" in an
  // earlier run of this.
  if (!shimInstalled) installFramePacingShim();

  // Reset the observation window, so the numbers are from the engine
  // as it is NOW and not from boot (when the engine is compiling
  // shaders and streaming the map).
  intervals.length = 0;
  stats.clear();
  lastTickAt = 0;

  await new Promise((r) => setTimeout(r, observeMs));

  const {
    browserHz,
    engineWorkMs,
    engineFps,
    lateFrames,
    measuredFrames,
    pacing,
  } = readMeasurement();
  const lateFraction = measuredFrames > 0 ? lateFrames / measuredFrames : 0;
  const sustainable = sustainableFps(engineWorkMs);

  // THE DISPLAY'S RATE, NOT THE RATE THE GAME IS ACHIEVING.
  //
  // The live tick rate is the display's period PLUS the engine's
  // work, so when the engine overruns the frame period the browser
  // misses vsyncs and the live rate reads LOW. The idle measurement
  // is the display's real rate. The cap has to be a divisor of THAT,
  // or the frames it lets through do not land on the display's grid.
  const panelHz = Math.max(browserHz, idleDisplayHz);

  // WHEN THE WINDOW CLOSED, in epoch milliseconds.
  const measuredAt = Date.now();

  // Identify the engine's callback: the one called most often.
  let bestCb: unknown = null;
  let bestCalls = 0;
  for (const [cb, s] of stats.entries()) {
    if (s.calls > bestCalls) {
      bestCalls = s.calls;
      bestCb = cb;
    }
  }
  // Only gate a callback that is genuinely running every frame.
  // A one-shot app callback must never be gated.
  if (bestCalls >= 10) {
    engineCallback = bestCb;
  }

  // THE ENGINE'S FIRST FRAME. The warm-up is measured from here, and
  // it has to be the TRUE first frame -- the one from before the
  // first measurement window -- not the first frame of this window.
  const seen = firstSeen.get(engineCallback);
  if (seen && (!gameStartAtMs || seen.epoch < gameStartAtMs)) {
    gameStartAtMs = seen.epoch;
  }

  // The one-shot callbacks are pruned: they will never be seen
  // again, and the map is about the engine's frame, not about every
  // callback the app has ever registered.
  for (const cb of [...firstSeen.keys()]) {
    if (cb !== engineCallback && !stats.has(cb)) firstSeen.delete(cb);
  }

  // IS THIS WINDOW PAST THE WARM-UP?
  //
  // The engine's cost falls over the first seconds of a match -- it
  // is compiling shaders and streaming the map -- and a reading taken
  // during that is a picture of the warm-up, not of the machine.
  const ageMs = gameStartAtMs > 0 ? Math.max(0, measuredAt - gameStartAtMs) : 0;
  const settled = gameStartAtMs > 0 && ageMs >= warmupMs;

  // If the window was empty, say so plainly. "0 fps against a 0 Hz
  // display" reads like a fact about the display; it is actually a
  // fact about the measurement having failed.
  if (intervals.length < 10 || engineWorkMs <= 0) {
    core = {
      ...core,
      browserHz,
      panelHz,
      engineFps,
      engineWorkMs,
      // THE GATE IN FORCE IS THE GATE IN FORCE.
      //
      // `core` is spread forward here, so `capFps` would be inherited
      // from the previous window while `panelHz` moves on -- and the
      // readout could then name a rate the gate no longer implies. It
      // is derived from the gate, like every other path.
      capFps: everyNth > 1 && panelHz > 0 ? panelHz / everyNth : 0,
      sustainableFps: sustainable,
      lateFrames,
      measuredFrames,
      lateFraction,
      measuredAt,
      settled,
      gameStartAt: gameStartAtMs,
      idlePanelHz: idleDisplayHz,
      pacing: EMPTY_SPACING,
      reason:
        `the measurement window was empty ` +
        `(${intervals.length} ticks, ${stats.size} callbacks seen) -- ` +
        `the engine may not be running yet; ` +
        (everyNth > 1
          ? `the existing cap (1 frame in ${everyNth}) is left in place`
          : `not capping`),
    };
    recordWindow();
    return getPacingState();
  }

  // THE MEASUREMENT OVERRIDE: a SPECIFIC gate, applied directly.
  //
  // This is the A/B harness's business -- it wants to see what a
  // particular cap does -- so it does not go through the policy and
  // it does not touch the consecutive-window counter.
  if (opts.force && opts.everyNth) {
    everyNth = Math.max(1, Math.round(opts.everyNth));
    // A FORCED GATE RESETS THE COUNTER.
    //
    // The counter is the policy's own history: how many consecutive
    // settled windows have asked for the same target. A forced gate was
    // not that policy's decision, so the history it would continue is
    // not the policy's history.
    lastTargetEveryNth = null;
    consecutiveSame = 0;
    forcedGate = true;
    const forcedFps = panelHz > 0 ? panelHz / everyNth : 0;
    core = {
      capFps: everyNth > 1 ? forcedFps : 0,
      browserHz,
      panelHz,
      engineFps,
      engineWorkMs,
      sustainableFps: sustainable,
      // A forced gate is not a decision the policy made from a
      // settled reading, so it is provisional by definition.
      provisional: true,
      lateFrames,
      measuredFrames,
      lateFraction,
      measuredAt,
      settled,
      gameStartAt: gameStartAtMs,
      idlePanelHz: idleDisplayHz,
      pacing: EMPTY_SPACING,
      reason:
        `forced to one frame in ${everyNth} for measurement ` +
        `(${forcedFps.toFixed(1)} fps, budget ` +
        `${frameIntervalMs(forcedFps).toFixed(2)} ms)`,
    };
    recordWindow();
    return getPacingState();
  }

  // THE POLICY.
  //
  // The target gate comes from the existing policy -- the highest
  // rate that is no greater than the display's and no greater than
  // what the engine sustains -- and the hysteresis rules decide what
  // the window is allowed to do with it.
  const target = computeFrameTarget(panelHz, engineWorkMs);

  // THE CONSECUTIVE-WINDOW COUNTER.
  //
  // The count INCLUDES this window: the first window that asks for a
  // narrower gate is 1, and the second window that asks for the same
  // one is 2 -- which is what lets the policy narrow on the second
  // window and not on the first.
  // THE COUNTER COUNTS SETTLED WINDOWS ONLY.
  //
  // A warm-up reading is the least trustworthy one the engine will ever
  // produce, and the policy treats it as untrustworthy everywhere else --
  // it cannot move a gate in force. Counting it here would let the first
  // settled window narrow the gate on the strength of two WARM-UP
  // readings, which is exactly what the rule is against.
  if (settled) {
    if (lastTargetEveryNth === target.everyNth) {
      consecutiveSame += 1;
    } else {
      lastTargetEveryNth = target.everyNth;
      consecutiveSame = 1;
    }
  }

  const decision = decideFrameGate({
    panelHz,
    engineWorkMs,
    currentEveryNth: everyNth,
    settled,
    consecutiveSame,
    lateFraction,
    currentProvisional: core.provisional,
    currentForced: forcedGate,
  });
  forcedGate = false;

  // THE GATE IS THE GATE. `everyNth` IS what the shim enforces, and
  // the reported state is derived from it, so the state cannot say
  // "not capping" while the engine is still being offered every
  // second frame.
  everyNth = decision.everyNth;
  const effective = everyNth > 1 && panelHz > 0 ? panelHz / everyNth : 0;

  core = {
    capFps: effective,
    browserHz,
    panelHz,
    engineFps,
    engineWorkMs,
    sustainableFps: sustainable,
    provisional: decision.provisional,
    lateFrames,
    measuredFrames,
    lateFraction,
    measuredAt,
    settled,
    gameStartAt: gameStartAtMs,
    idlePanelHz: idleDisplayHz,
    pacing,
    reason:
      decision.reason +
      (everyNth > 1
        ? `; the gate is one frame in ${everyNth} ` +
          `(effective ${effective.toFixed(1)} fps, budget ` +
          `${frameIntervalMs(effective).toFixed(2)} ms)`
        : '; not capping'),
  };
  recordWindow();
  return getPacingState();
}

/**
 * Force a cap, for measurement.
 *
 * `everyNth` is how many display ticks pass per engine frame. 2 on a
 * 60 Hz display means 30 fps.
 *
 * This is deliberately not reachable from the UI: it exists so the A/B
 * harness can measure what the cap DOES, on a display where the cap
 * would otherwise never engage.
 */
export async function forceFrameCap(everyNth = 2): Promise<PacingState> {
  return applyFrameCap({ force: true, everyNth });
}
