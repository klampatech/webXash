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
