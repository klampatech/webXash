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
  chooseFrameCap,
  frameIntervalMs,
  isLate,
  shouldCap,
  sustainableFps,
  type FrameCap,
} from './frame-pacing.ts';

/** What the pacer decided, for the log and the diagnostics. */
export interface PacingState {
  /** The cap in force, in frames per second. 0 = no cap. */
  capFps: number;
  /** The measured refresh rate the browser is delivering. */
  displayHz: number;
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
   * How many display ticks arrived LATE in the measurement window --
   * the browser dropped a frame to catch up.
   *
   * This is the unevenness the cap exists to remove, counted rather
   * than described.
   */
  lateTicks: number;
  /** Why. */
  reason: string;
}

/**
 * The parts of the state that are NOT the gate.
 *
 * `everyNth` and `active` are deliberately absent: they are DERIVED
 * from the gate itself, in `getPacingState()`. See the note there.
 */
interface PacingCore {
  capFps: number;
  displayHz: number;
  engineWorkMs: number;
  sustainableFps: number;
  lateTicks: number;
  reason: string;
}

/** The pacer singleton's state. Read by the diagnostics. */
let core: PacingCore = {
  capFps: 0,
  displayHz: 0,
  engineWorkMs: 0,
  sustainableFps: 0,
  lateTicks: 0,
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
}
const stats = new Map<unknown, CallbackStats>();

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

/** How long to observe before deciding. */
const OBSERVE_MS = 2000;

/**
 * Record one callback's duration.
 *
 * The DURATION is the engine's per-frame cost: the engine's callback
 * IS its frame -- input, simulation and rendering all happen inside
 * it. So timing it measures the thing the cap is supposed to fit
 * inside the display's frame budget.
 */
function noteCallback(cb: unknown, durationMs: number): void {
  let s = stats.get(cb);
  if (!s) {
    s = { calls: 0, samples: [] };
    stats.set(cb, s);
  }
  s.calls++;
  s.samples.push(durationMs);
  if (s.samples.length > MAX_SAMPLES) s.samples.shift();
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
    noteCallback(cb, performance.now() - started);
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
    reason: 'the frame-pacing shim was uninstalled; not capping',
  };
}

/**
 * The measurement, from the shim's own observations.
 *
 * `displayHz` is the refresh rate the browser is delivering, from the
 * median interval between display ticks.
 *
 * `engineWorkMs` is how long the engine's own callback takes -- the
 * engine's per-frame cost, measured directly, not inferred.
 *
 * `lateTicks` is how many display ticks arrived late -- the browser
 * dropped a frame to catch up. That is the unevenness this feature
 * exists to remove, counted.
 */
export function readMeasurement(): {
  displayHz: number;
  engineWorkMs: number;
  lateTicks: number;
} {
  // The refresh rate: the median interval between ticks.
  let displayHz = 0;
  if (intervals.length >= 10) {
    const median = medianOf(intervals);
    if (median > 0) displayHz = 1000 / median;
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

  // How many display ticks arrived LATE. The threshold is RELATIVE to
  // the frame budget (see `isLate`), never a constant, so it is
  // correct on a 165 Hz display as well as on a 60 Hz one.
  const budget = frameIntervalMs(displayHz);
  let lateTicks = 0;
  for (const gap of intervals) {
    if (isLate(gap, budget)) lateTicks++;
  }

  return { displayHz, engineWorkMs, lateTicks };
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
 * `force` applies the cap even when the engine keeps up with the
 * display. That is for MEASUREMENT -- on a 60 Hz test box the engine
 * has twice the budget it needs, so the cap would never engage on its
 * own, and the point of measuring it is to see what it DOES.
 */
export async function applyFrameCap(
  opts: { observeMs?: number; force?: boolean; everyNth?: number } = {},
): Promise<PacingState> {
  const observeMs = opts.observeMs ?? OBSERVE_MS;

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
      displayHz: 0,
      engineWorkMs: 0,
      sustainableFps: 0,
      lateTicks: 0,
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

  const { displayHz, engineWorkMs, lateTicks } = readMeasurement();
  const sustainable = sustainableFps(engineWorkMs);

  // If the window was empty, say so plainly. "0 fps against a 0 Hz
  // display" reads like a fact about the display; it is actually a
  // fact about the measurement having failed.
  if (intervals.length < 10 || engineWorkMs <= 0) {
    core = {
      ...core,
      displayHz,
      engineWorkMs,
      lateTicks,
      reason:
        `the measurement window was empty ` +
        `(${intervals.length} ticks, ${stats.size} callbacks seen) -- ` +
        `the engine may not be running yet; ` +
        (everyNth > 1
          ? `the existing cap (1 frame in ${everyNth}) is left in place`
          : `not capping`),
    };
    return getPacingState();
  }

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

  const need = opts.force || shouldCap(displayHz, sustainable);
  if (!need) {
    // THE GATE COMES OFF HERE. `everyNth` IS the gate, so setting it
    // to 1 is what stops the engine being offered every second
    // frame -- and the reported state is derived from it, so "not
    // capping" cannot leave the engine at half speed while the log
    // says it is running uncapped.
    everyNth = 1;
    core = {
      capFps: 0,
      displayHz,
      engineWorkMs,
      sustainableFps: sustainable,
      lateTicks,
      reason:
        `the engine sustains ${sustainable.toFixed(0)} fps against a ` +
        `${displayHz.toFixed(0)} Hz display; not capping`,
    };
    return getPacingState();
  }

  const cap: FrameCap = chooseFrameCap(displayHz, sustainable);
  // `everyNth` may be given directly, to measure a specific cap.
  everyNth = Math.max(
    1,
    opts.everyNth ?? Math.round(displayHz / Math.max(1, cap.fps)),
  );
  const effective = displayHz / everyNth;

  core = {
    capFps: effective,
    displayHz,
    engineWorkMs,
    sustainableFps: sustainable,
    lateTicks,
    reason:
      `${cap.reason}; the engine runs 1 frame in ${everyNth} ` +
      `(effective ${effective.toFixed(1)} fps, budget ` +
      `${frameIntervalMs(effective).toFixed(2)} ms)`,
  };
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
