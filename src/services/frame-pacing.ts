/**
 * How fast the engine is allowed to render.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine has NO frame limiter in the browser.
 *
 * Upstream, `engine/common/host.c` defines the cvar as:
 *
 *     CVAR_DEFINE( host_maxfps, "fps_max", "72", ..., "host fps upper limit" );
 *
 * and reads it in `Host_CalcFPS`:
 *
 *     if( gl_vsync.value )
 *         fps = max_fps;              // MAX_FPS_SOFT = 200
 *     else
 *     {
 *         fps = host_maxfps.value;    // "fps_max" -- ONLY when vsync is off
 *         ...
 *     }
 *
 *     targetframetime = ( 1.0 / fps );
 *
 * So with vsync ON (production's default, and the only sane setting
 * for a game), `fps_max` is NEVER CONSULTED. The engine's target is
 * 200 fps, and the engine's `Host_Autosleep` skips a frame only when
 * less than `1/200` second has passed -- which is never true at any
 * real refresh rate. The consequence:
 *
 *     the engine renders on EVERY tick the browser offers it.
 *
 * Measured against production, 2026-10-28, counting the engine's own
 * rendered frames (its `gl.clear` calls) against the browser's rAF
 * rate in the same window:
 *
 *     fps_max 100 (shipped)   browser 60.0/s   engine 60.0/s   100%
 *     fps_max 30              browser 60.0/s   engine 60.0/s   100%
 *     fps_max 15              browser 60.0/s   engine 60.1/s   100%
 *     fps_max 5               browser 60.1/s   engine 60.1/s   100%
 *
 * At `fps_max 5` the engine still rendered 60 fps. The cvar is inert.
 *
 * WHY THAT MATTERS ON A FAST DISPLAY
 * ----------------------------------
 * The engine's per-frame work was measured at ~7-8 ms (running the
 * browser uncapped, so the engine ran at its natural maximum):
 *
 *     60 Hz   budget 16.67 ms   YES -- ~50% used
 *     90 Hz   budget 11.11 ms   YES
 *    120 Hz   budget  8.33 ms   marginal -- 99% used
 *    144 Hz   budget  6.94 ms   NO -- needs ~8 ms
 *    165 Hz   budget  6.06 ms   NO
 *    240 Hz   budget  4.17 ms   NO
 *
 * On a 60 Hz display the engine has twice the budget it needs, so it
 * never misses a deadline and the pacing is perfect. On a 144 Hz
 * display it CANNOT finish a frame inside the frame interval, so the
 * browser drops ticks to catch up -- and the frames that survive
 * arrive UNEVENLY. That unevenness is judder, and it is what "plays
 * like the 40s-50s and sometimes feels very smooth like 60s" means.
 *
 * THE ENGINE'S OWN COUNTER CANNOT SEE IT
 * --------------------------------------
 * The counter reports how many frames the engine DREW. The gaps are
 * BETWEEN those frames. So the counter reads healthy while the
 * display shows the gaps, which is why the in-game number and the
 * feel disagree.
 *
 * THE FIX
 * -------
 * Cap the tick rate the engine is offered, so it is only ever asked
 * for frames it can actually finish. Then every frame lands on a
 * vsync boundary, evenly spaced, and the pacing is perfect even
 * though the rate is lower.
 *
 * This module computes that cap. The machinery that enforces it is
 * in `frame-pacing.ts`; this file is the POLICY, kept free of imports
 * so the parent's unit suite can test it directly -- the same
 * constraint `video-settings.ts` is written under.
 */

/** A frame rate cap, in frames per second. */
export interface FrameCap {
  /** The cap, in frames per second. 0 means "no cap". */
  fps: number;
  /** Why the cap is what it is. For the log and the diagnostics. */
  reason: string;
}

/**
 * The frame rate the engine can sustain, from its per-frame work.
 *
 * `workMs` is how long one engine frame takes. The engine can hold a
 * refresh rate R only if `workMs < 1000/R`, so the sustainable rate is
 * `1000 / workMs`.
 *
 * A safety factor is applied: the engine must not merely FIT the
 * budget, it must fit it with room to spare, because a frame that
 * overruns occasionally is exactly what produces the uneven pacing we
 * are trying to remove. One frame of slack per second is not enough;
 * a sixth of the budget is.
 */
export function sustainableFps(workMs: number, safetyFactor = 0.85): number {
  if (!isFinite(workMs) || workMs <= 0) return 0;
  return Math.floor(1000 / (workMs / safetyFactor));
}

/**
 * The refresh rates a display is likely to be running at.
 *
 * Used to pick a cap that is a DIVISOR of the display's rate, because
 * a cap that divides the refresh rate evenly is what keeps the frames
 * landing on a regular pattern. Capping a 144 Hz display to 60 fps
 * means every frame is held for 2.4 refreshes -- an uneven pattern of
 * 2s and 3s, which is judder in a different place. Capping it to 48
 * (144/3) holds every frame for exactly 3 refreshes: even.
 */
export const COMMON_REFRESH_RATES = [24, 30, 48, 60, 72, 75, 90, 100, 120, 144, 165, 240, 360];

/**
 * Pick the cap for a display.
 *
 * `displayHz` is the refresh rate the browser is actually delivering
 * frames at -- measured, not assumed, because the display might be
 * 144 Hz and the browser might be running the page at 60.
 *
 * `sustainableFps` is what the engine can do.
 *
 * The result is the highest refresh rate from `COMMON_REFRESH_RATES`
 * that is BOTH:
 *   - no greater than the display's rate (never ask for more frames
 *     than the display can show), and
 *   - no greater than what the engine can sustain (never ask for
 *     frames it cannot finish).
 *
 * With `strictDivision` on, the chosen rate must additionally divide
 * the display rate evenly. That is the evenness guarantee.
 */
export function chooseFrameCap(
  displayHz: number,
  sustainable: number,
  opts: { strictDivision?: boolean } = {},
): FrameCap {
  const strict = opts.strictDivision !== false;

  if (!isFinite(displayHz) || displayHz <= 0) {
    return { fps: 0, reason: 'the display rate is unknown; not capping' };
  }
  if (!isFinite(sustainable) || sustainable <= 0) {
    return { fps: 0, reason: 'the engine cost is unknown; not capping' };
  }

  // Never ask for more than the display can show, or more than the
  // engine can do.
  const ceiling = Math.min(displayHz, sustainable);

  const candidates = COMMON_REFRESH_RATES.filter((hz) => hz <= ceiling);

  if (!candidates.length) {
    // The display is faster than every rate we know, and the engine
    // can sustain more than we know how to name. Fall back to the
    // engine's own sustainable rate, rounded down to a whole number.
    const fallback = Math.floor(ceiling);
    return {
      fps: fallback,
      reason:
        `no standard rate fits under ${ceiling.toFixed(0)} fps; ` +
        `capping at the engine's sustainable rate`,
    };
  }

  // Prefer the highest standard rate. With strict division, the
  // candidates that divide the display rate evenly win.
  const divides = (hz: number) => {
    const ratio = displayHz / hz;
    return Math.abs(ratio - Math.round(ratio)) < 0.02;
  };

  const even = candidates.filter(divides);
  const pool = strict && even.length ? even : candidates;
  const chosen = pool[pool.length - 1];

  const reason =
    `display ${displayHz.toFixed(0)} Hz, engine sustains ` +
    `${sustainable.toFixed(0)} fps -> cap ${chosen} fps` +
    (strict && even.length ? ' (divides the display rate evenly)' : '');

  return { fps: chosen, reason };
}

/**
 * Is a cap worth applying at all?
 *
 * Capping a display that is already comfortable costs headroom for
 * nothing. If the engine can sustain the display's own rate, leave it
 * alone.
 */
export function shouldCap(displayHz: number, sustainable: number): boolean {
  if (!isFinite(displayHz) || displayHz <= 0) return false;
  if (!isFinite(sustainable) || sustainable <= 0) return false;
  return sustainable < displayHz * 0.95;
}

/**
 * The frame interval, in milliseconds, for a frame rate.
 *
 * Used to decide which of two frames is late: with a 16.67 ms budget,
 * a frame that took more than 1.5 budgets missed one.
 */
export function frameIntervalMs(fps: number): number {
  if (!isFinite(fps) || fps <= 0) return 0;
  return 1000 / fps;
}

/**
 * Is a frame interval late, for a given budget?
 *
 * The threshold is RELATIVE to the budget, never a constant. A fixed
 * 20 ms is right for a 60 Hz display (one missed vsync is 33 ms) but
 * would MISS the dropped frames on a 165 Hz display, where one frame
 * is 6.1 ms and a dropped frame is only 12.1 ms -- under a 20 ms
 * threshold, evenly spaced frames with gaps would report zero slow
 * frames while the pacing was visibly broken.
 */
export function isLate(intervalMs: number, budgetMs: number): boolean {
  if (!isFinite(intervalMs) || !isFinite(budgetMs) || budgetMs <= 0) return false;
  return intervalMs > budgetMs * 1.5;
}

// ═══════════════════════════════════════════════════════════════════════
// THE GATE DECISION — the hysteresis.
//
// WHY THIS IS HERE AND NOT IN THE MACHINERY
// -----------------------------------------
// The machinery measures; this decides. The decision is the part that
// has to be right about the PLAYER, not about the machine, and it is
// the part that is pure — which is why it lives in a file with no
// imports, where the parent's unit suite can exercise it directly.
//
// THE BUG THIS FIXES
// ------------------
// The pacer used to decide ONCE, three seconds after the engine booted,
// from a two-second window, and never measure again for the rest of the
// match. On Kyle's M3 Pro that produced a 30 fps cap on a machine that
// could have run the game at 60:
//
//     the boot reading      15.94 ms a frame
//     sustainableFps(15.94) = 53
//     chooseFrameCap(120, 53) = 30 fps
//     120 / 30 = 4          -> one frame in four
//
// The whole difference between "30 fps on a machine that was drawing
// 60" and "60 fps" is the QUALITY of one measurement: the engine needs
// 25-30 seconds to reach steady state, and the first window is the
// most expensive one it will ever produce.
//
// So the pacer measures warm, measures again, and moves the gate only
// when the evidence supports it.
//
// THE ASYMMETRY IS THE POINT
// --------------------------
// Widening the gate (more frames) risks judder; narrowing it (fewer
// frames) risks a player who feels the game got slower. The engine
// getting FASTER after the warm-up is the normal case and is the case
// worth acting on immediately. The engine getting slower for one window
// is usually a scene, not a regression.

/**
 * How late the engine's frames have to be before the gate is not
 * allowed to widen.
 *
 * FIVE PER CENT. Above this, the engine is already missing its slots,
 * and asking it for more frames would make the judder worse. This is
 * the single most important number in the policy: it is the guard
 * against making the player's experience WORSE.
 */
export const LATE_FRACTION_LIMIT = 0.05;

/**
 * How many consecutive windows have to ask for the same NARROWER gate
 * before it is adopted.
 *
 * TWO. One expensive window — a firefight, a shader compilation, a GC
 * pause — must not halve the player's frame rate. A scene is not a
 * regression.
 */
export const NARROW_CONSECUTIVE_WINDOWS = 2;

/** What the pacer is told about the window it is deciding on. */
export interface FrameGateInput {
  /** The DISPLAY's refresh rate, measured while the page was idle. */
  panelHz: number;
  /** The engine's per-frame cost from this window, in milliseconds. */
  engineWorkMs: number;
  /** The gate in force right now: display ticks per engine frame. 1 = uncapped. */
  currentEveryNth: number;
  /** Is this window past the engine's warm-up? */
  settled: boolean;
  /**
   * How many consecutive windows have asked for the SAME target gate.
   * The caller counts them; this function only reads the count.
   */
  consecutiveSame: number;
  /**
   * The fraction of this window's engine frames that arrived late
   * (lateFrames / measuredFrames), 0..1.
   */
  lateFraction: number;
  /**
   * Is the gate in force right now a PROVISIONAL (warm-up) decision?
   *
   * Optional, and defaulted to false: the caller only needs it when a
   * measurement cannot be used and the existing gate has to be left
   * exactly as it was, provisional flag and all.
   */
  currentProvisional?: boolean;
}

/** What the pacer decided, and why. */
export interface FrameGateDecision {
  /** The gate to use: display ticks per engine frame. 1 = uncapped. */
  everyNth: number;
  /** The frame rate that gate means, in fps. */
  capFps: number;
  /** Did the gate change? */
  changed: boolean;
  /** Is the gate in force still a PROVISIONAL (warm-up) decision? */
  provisional: boolean;
  /** Why — this string goes in the log and the diagnostics. */
  reason: string;
  /**
   * The gate this window ASKED for, before the hysteresis rules.
   *
   * The caller counts the consecutive windows that asked for the same
   * target, and it cannot count them without this.
   */
  targetEveryNth: number;
  /** The frame rate that target means, in fps. */
  targetFps: number;
}

/**
 * The gate a window ASKS for, before the hysteresis rules.
 *
 * The caller needs this on its own: it counts the consecutive windows
 * that asked for the SAME target, and it cannot count them without
 * knowing the target. So the arithmetic lives here, once, and both
 * the caller and `decideFrameGate` use it.
 */
export interface FrameTarget {
  /** Display ticks per engine frame. 1 = uncapped. */
  everyNth: number;
  /** The frame rate that means, in fps. */
  fps: number;
  /** The frame rate the engine can sustain, in fps. */
  sustainableFps: number;
}

/**
 * The target gate for a window: the EXISTING policy, and nothing else.
 *
 * `chooseFrameCap(panelHz, sustainableFps(engineWorkMs))` picks the
 * highest standard rate that is no greater than the display's and no
 * greater than the engine's sustainable rate, preferring one that
 * divides the display rate evenly. The gate is that rate expressed
 * as "one engine frame every N display ticks".
 *
 * The pacer can never ask for more than the engine sustains: that is
 * `chooseFrameCap`'s contract and it does not change.
 */
export function computeFrameTarget(panelHz: number, engineWorkMs: number): FrameTarget {
  const sustainable = sustainableFps(engineWorkMs);
  const cap = chooseFrameCap(panelHz, sustainable);
  const everyNth = Math.max(1, Math.round(panelHz / Math.max(1, cap.fps)));
  return {
    everyNth,
    fps: panelHz > 0 ? panelHz / everyNth : 0,
    sustainableFps: sustainable,
  };
}

/**
 * How a gate is described in the log.
 *
 * "not capping" for an open gate, because that is the phrase the
 * diagnostics, the log and the tests all look for.
 */
function describeGate(everyNth: number, panelHz: number): string {
  if (!isFinite(everyNth) || everyNth <= 1) return 'not capping';
  const fps = panelHz > 0 ? panelHz / everyNth : 0;
  return `1 frame in ${everyNth} (${fps.toFixed(0)} fps)`;
}

/**
 * Decide the gate.
 *
 * THE RULES, exactly:
 *
 *   1. A MEASUREMENT THAT CANNOT BE USED changes nothing. The gate
 *      in force stays, and the reason says the measurement was not
 *      usable — a readout that guesses is worse than no readout.
 *   2. Otherwise the target is the EXISTING policy: the highest rate
 *      that is both no greater than the display's and no greater than
 *      the engine's sustainable rate, landing evenly on the display's
 *      grid. The pacer can never ask for more than the engine
 *      sustains; that is `chooseFrameCap`'s contract and it does not
 *      change.
 *   3. A WARM-UP WINDOW NEVER MOVES AN EXISTING GATE. If there is no
 *      gate yet, the target is adopted as a PROVISIONAL one — the
 *      player gets protection from judder in the first seconds, and
 *      the readout says the decision was provisional.
 *   4. A SETTLED WINDOW may move the gate:
 *        - the same gate: kept, and the provisional flag cleared;
 *        - a WIDER gate: adopted immediately, UNLESS more than 5% of
 *          the engine's frames arrived late — then it is REFUSED,
 *          because the engine is already missing its slots;
 *        - a NARROWER gate: adopted only when two consecutive
 *          windows have asked for it.
 */
export function decideFrameGate(input: FrameGateInput): FrameGateDecision {
  const current = Math.max(1, Math.round(input.currentEveryNth || 1));
  const currentProvisional = input.currentProvisional === true;
  const currentFps = input.panelHz > 0 ? input.panelHz / current : 0;

  // --- RULE 1: a measurement that cannot be used ------------------------
  const noPanel = !isFinite(input.panelHz) || input.panelHz <= 0;
  const noCost = !isFinite(input.engineWorkMs) || input.engineWorkMs <= 0;
  if (noPanel || noCost) {
    const why =
      noPanel && noCost
        ? "the display's rate and the engine's frame cost are both unknown"
        : noPanel
          ? "the display's rate is unknown"
          : "the engine's frame cost is unknown";
    return {
      everyNth: current,
      capFps: currentFps,
      changed: false,
      provisional: currentProvisional,
      targetEveryNth: current,
      targetFps: currentFps,
      reason:
        `the measurement was not usable (${why}); ` +
        `the existing gate is left in place (${describeGate(current, input.panelHz)})`,
    };
  }

  // --- RULE 2: the target, from the existing policy ---------------------
  const target = computeFrameTarget(input.panelHz, input.engineWorkMs);
  const sustainable = target.sustainableFps;
  const targetEveryNth = target.everyNth;
  const targetFps = target.fps;
  const measured =
    `the engine costs ${input.engineWorkMs.toFixed(2)} ms a frame ` +
    `(${sustainable.toFixed(0)} fps) against a ${input.panelHz.toFixed(0)} Hz display`;
  const targetText = describeGate(targetEveryNth, input.panelHz);

  // --- RULE 3: a warm-up window -----------------------------------------
  if (!input.settled) {
    if (current <= 1) {
      // No gate yet: adopt the target as a PROVISIONAL one, so the
      // player is protected from judder in the first seconds.
      return {
        everyNth: targetEveryNth,
        capFps: targetFps,
        changed: targetEveryNth !== current,
        provisional: true,
        targetEveryNth,
        targetFps,
        reason:
          `${measured} -> ${targetText}; the reading is PROVISIONAL ` +
          `(the engine is still warming up, so the cost will come down)`,
      };
    }
    // A gate is already in force: it stays, whatever the warm-up
    // reading says.
    return {
      everyNth: current,
      capFps: currentFps,
      changed: false,
      provisional: currentProvisional,
      targetEveryNth,
      targetFps,
      reason:
        `${measured} -> ${targetText}; the window is still inside the ` +
        `engine's warm-up, so the gate in force ` +
        `(${describeGate(current, input.panelHz)}) is left in place`,
    };
  }

  // --- RULE 4: a settled window -----------------------------------------
  if (targetEveryNth === current) {
    // The settled reading CONFIRMS the gate, so it is no longer
    // provisional.
    return {
      everyNth: current,
      capFps: currentFps,
      changed: false,
      provisional: false,
      targetEveryNth,
      targetFps,
      reason:
        `${measured} -> ${targetText}; the settled reading confirms the gate`,
    };
  }

  if (targetEveryNth < current) {
    // WIDER: more frames.
    const lateFraction = isFinite(input.lateFraction) ? Math.max(0, input.lateFraction) : 0;
    if (lateFraction > LATE_FRACTION_LIMIT) {
      // THE MOST IMPORTANT RULE IN THE FEATURE.
      //
      // The engine is already missing its slots. Asking it for more
      // frames would make the judder WORSE, so the gate stays exactly
      // where it is.
      const pct = (lateFraction * 100).toFixed(0);
      return {
        everyNth: current,
        capFps: currentFps,
        changed: false,
        provisional: currentProvisional,
        targetEveryNth,
        targetFps,
        reason:
          `${measured} -> ${targetText}; the engine is already missing its ` +
          `slots (${pct}% of its frames arrived late), so the gate is NOT ` +
          `widened — asking for more frames would make the judder worse`,
      };
    }
    if (targetEveryNth <= 1) {
      return {
        everyNth: targetEveryNth,
        capFps: targetFps,
        changed: true,
        provisional: false,
        targetEveryNth,
        targetFps,
        reason:
          `${measured} -> ${targetText}; the engine keeps up with the ` +
          `display, so the gate comes off`,
      };
    }
    return {
      everyNth: targetEveryNth,
      capFps: targetFps,
      changed: true,
      provisional: false,
      targetEveryNth,
      targetFps,
      reason:
        `${measured} -> ${targetText}; the engine is landing its frames on ` +
        `time, so the gate widens`,
    };
  }

  // NARROWER: fewer frames.
  const consecutive = Math.max(0, Math.round(input.consecutiveSame || 0));
  if (consecutive < NARROW_CONSECUTIVE_WINDOWS) {
    return {
      everyNth: current,
      capFps: currentFps,
      changed: false,
      provisional: currentProvisional,
      targetEveryNth,
      targetFps,
      reason:
        `${measured} -> ${targetText}; waiting for a second window before ` +
        `narrowing the gate — one expensive window must not halve the ` +
        `player's frame rate`,
    };
  }
  return {
    everyNth: targetEveryNth,
    capFps: targetFps,
    changed: true,
    provisional: false,
    targetEveryNth,
    targetFps,
    reason:
      `${measured} -> ${targetText}; the cost has been high for ` +
      `${consecutive} windows in a row, so the gate narrows`,
  };
}
