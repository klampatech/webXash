/**
 * The player's video settings: detected from the browser, turned into
 * engine launch arguments, and re-applied whenever the engine would
 * otherwise drift back to the viewport's resolution.
 *
 * THE MEASURED CONTRACT (2026-11-05) — READ THIS FIRST
 * ====================================================
 * The engine's `vid_setmode` takes CSS PIXELS and multiplies by the
 * device pixel ratio ITSELF. Measured, real Chrome 151 headful at
 * `--force-device-scale-factor=2`, the engine's own cvars and the
 * canvas's backing store after each command:
 *
 *     vid_setmode 1280 720   ->  vid_width 2560   buffer 2560x1440
 *     vid_setmode  640 360   ->  vid_width 1280   buffer 1280x720
 *     vid_setmode 6912 4468  ->  vid_width 13824  buffer 13824x8936
 *
 * Every one exactly twice the number asked for, at dpr 2. At dpr 1 the
 * engine's own resize lands on the number asked for, unchanged.
 *
 * So a policy that multiplies by the device pixel ratio and then hands
 * the result to the engine asks for dpr SQUARED pixels. On Kyle's
 * MacBook (dpr 2) that was 3456x2234 asked for and 6912x4468 actually
 * rendered: 30.9 megapixels, four times the pixels the panel has, and
 * past the GL maximum texture dimension of 8192. The allocation failed,
 * the engine fell back to a tiny mode (the resolution looked minuscule)
 * and wedged (the hang, the looping audio, the dead reconnect).
 *
 * THE FOUR NUMBERS, AND WHICH UNIT EACH ONE IS IN
 * -----------------------------------------------
 *   MODE        CSS pixels     what `vid_setmode` takes
 *   BACKING     device pixels  mode * dpr; the canvas's drawing buffer
 *   BOX         CSS pixels     the canvas's clientWidth/clientHeight
 *   DEVICE BOX  device pixels  box * dpr; what the browser paints
 *
 * The browser scales the BACKING onto the DEVICE BOX on every single
 * frame, and the two agree — nothing is scaled — exactly when the MODE
 * is the BOX. That is the whole cap, and it is why the mode's SHAPE
 * follows the box: the engine's own resize lands on the box's shape
 * too (SDL resize -> `VID_SaveWindowSize` -> `R_SaveVideoMode`), so
 * the watchdog and the engine agree and nothing churns.
 *
 * AND THE BOOT ARGUMENTS ARE A FIFTH THING
 * -----------------------------------------
 * `-width`/`-height` are LITERAL dimensions. Measured, at dpr 2, boot
 * arguments 1920x1200 produced a 1920x1200 backing store, not
 * 3840x2400. So the launch arguments want DEVICE pixels and the
 * runtime command wants CSS pixels. They are not the same number, and
 * the old code used one function for both — which is why the first
 * frame was at half the device box.
 *
 * WHY THE ENGINE RENDERS AT THE VIEWPORT'S RESOLUTION AT ALL
 * ----------------------------------------------------------
 * The engine renders AT the browser viewport's resolution. Always.
 * Measured against production on 2026-10-28 — one Chromium, one
 * client, the engine's own `vid_width`/`vid_height` cvars and the
 * canvas backing store tracked the viewport exactly at every size
 * tried:
 *
 *     viewport      engine render res   engine frames/s
 *     640x480       640x480             69.5
 *     1280x720      1280x720            30.2
 *     1920x1080     1920x1080            8.6
 *     2560x1440     2560x1440            4.5
 *
 * The frame cost is the pixel count, so going fullscreen on a 1440p
 * display is a 4x hit. That is the "some FPS hits when I go full
 * screen" Kyle reported. And it is what the "150 ms" in the
 * 2026-10-27 capacity/latency report actually was: the report measured
 * a 154.5 ms event-loop lag in-game, the browser's
 * `requestAnimationFrame` rate and the engine's frame rate were
 * identical at every size, and the page's main thread is blocked for
 * exactly one frame while the engine draws. It was never server
 * latency.
 *
 * AND WHY IT IS NOT JUST "SET IT ONCE"
 * ------------------------------------
 * The engine RESYNCS to the window on every resize:
 *
 *     SDL_WINDOWEVENT_RESIZED -> VID_SaveWindowSize -> R_SaveVideoMode
 *
 * and `R_SaveVideoMode` rewrites `width`, `height`, `vid_width` and
 * `vid_height` from the new window size. Measured: a forced 1280x720
 * did NOT survive the viewport growing to 2560x1440 — the engine went
 * back to 2560x1440 and the frame rate fell to 0.4/s. So the
 * resolution has to be re-applied after every resize, not just once at
 * boot.
 *
 * AND WHY 'AUTO' IS A MEASURED BUDGET, NOT A CONSTANT
 * ---------------------------------------------------
 * A fixed pixel count is a statement about the ART, not about the
 * machine, and the machine is the thing that has to hold the frame
 * rate. Measured on Kyle's M3 Pro, production, 2026-11-19, in a dense
 * fight: IDLE -- the GPU wait -- was 48.6% of the wall, the engine
 * 23.5%, the GL call path 20.1% (bufferData 10.83%) and the client's
 * own JavaScript 0.3%. The engine's frame cost was 32.66 ms against a
 * browser ticking at 29.2 Hz, 21.2% of the frames late, and the frame
 * period swinging between 34 ms and 132 ms.
 *
 * So 'auto' now spends what the machine can MEASURE it can hold:
 *
 *     pixels_target = pixels_now * (target_frame_ms / measured_frame_ms)
 *
 * where `measured_frame_ms` is the engine's own measured frame cost
 * (the client's pacing telemetry), and `target_frame_ms` is the slot at
 * the rate the client is aiming for, with the pacer's own headroom.
 * The fixed `AUTO_MAX_PIXELS` stays as the CEILING -- a machine that
 * is comfortably fast keeps its full resolution -- and the engine's
 * own minimum is the FLOOR. The budget only ever moves DOWN, it moves
 * only when the measurement says the machine is measurably over budget,
 * it moves only by a bounded step, and it moves only after two
 * measurements in a row have said so. See "THE MEASURED BUDGET" below.
 *
 * THIS MODULE HAS NO IMPORTS, ON PURPOSE
 * --------------------------------------
 * The parent's unit suite imports this file directly and exercises the
 * real policy — see tests/unit/video-settings.test.mjs. That only works
 * if the module is plain TypeScript with no imports of its own, the
 * same constraint browser-chords.ts is written under. Keep it that way.
 *
 * IT ALSO MEANS THE PACER'S HEADROOM IS MIRRORED, NOT IMPORTED:
 * `frame-pacing.ts` exports `ENGINE_HEADROOM = 0.85` and this module
 * carries the same number, because it cannot import it. The parent's
 * unit suite reads the pacer's source and asserts that the two agree.
 */

/** A render resolution, in CSS pixels. */
export interface RenderResolution {
  width: number;
  height: number;
}

/**
 * The display, as the browser reports it.
 *
 * `width`/`height` are CSS pixels — the DISPLAY's size, not the
 * window's. `devicePixelRatio` is how many device pixels one CSS pixel
 * covers.
 */
export interface DisplayInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

/**
 * What the player picked in the launch options.
 *
 * 'auto'     — the display's own resolution, capped by the pixel budget.
 * 'display'  — the display's own resolution, uncapped.
 * the rest   — fixed presets.
 */
export type ResolutionChoice =
  | 'auto'
  | 'display'
  | '1920x1080'
  | '1600x900'
  | '1280x720'
  | '960x540'
  | '640x360';

/** The choices the options panel offers, in the order it shows them. */
export const RESOLUTION_CHOICES: ResolutionChoice[] = [
  'auto',
  'display',
  '1920x1080',
  '1600x900',
  '1280x720',
  '960x540',
  '640x360',
];

/**
 * The pixel budget 'auto' spends: 1920x1080 CSS PIXELS.
 *
 * A GoldSrc-era renderer gains nothing visible above it — the art is
 * 320x240 — while the cost is linear in pixels, so a 1440p display
 * pays 2.3x the fill rate and a 4K display 5x, for detail the source
 * art does not have. The player who wants the pixels can pick
 * 'display'.
 *
 * IT IS IN CSS PIXELS, AND THAT IS A DELIBERATE CHOICE
 * -----------------------------------------------------
 * The budget is the RESOLUTION the engine is asked for, in the units
 * the engine is told in. On a 1x display that is 1920x1080 device
 * pixels; on a 2x display the same number is 3840x2160 device pixels
 * — the panel's own pixels, sharp, which is what the game looked like
 * before the 2026-11-05 regression.
 *
 * The alternative is a DEVICE-pixel budget (1920x1080 device pixels
 * whatever the ratio), which is 4x cheaper to fill on a Retina panel
 * and soft: the browser upscales the frame to the panel. It is one
 * constant away, and it is a product decision, not a bug fix — the
 * wedge was the emergency and the sharpness is the preference.
 *
 * AND THE CHEAPER ONE BUYS NOTHING -- ON A STILL SCENE.
 *
 * That note used to cite `references/engine-render-performance.md`, a
 * file that does not exist in this repository and never did. The claim
 * it made -- that the engine holds 60 FPS at 4K on integrated graphics,
 * and that dropping the render resolution to 640x360 changes NOTHING --
 * was measured, but on a STILL scene: with sixteen bots frozen in
 * place, 14x the pixels moved the engine's cost by 0.00 ms.
 *
 * On the scene the player is actually in -- sixteen bots fighting in a
 * small arena -- the same 14x cost 1.61x at the heavy viewpoint: the
 * same six viewpoints, the same fixture verified 6/6, went from 15.63
 * ms to 25.15 ms, from 60 FPS to 32, with 60% of the frames late.
 *
 * So the premise is CONTESTED, and the resolution is not "the budget is
 * fixed" but "the budget is MEASURED" -- see the measured budget below.
 * The fixed number stays as the CEILING: it is what a machine that is
 * comfortably fast is allowed to spend, and it is never exceeded.
 */
export const AUTO_MAX_PIXELS = 1920 * 1080;

// ═══════════════════════════════════════════════════════════════════════
// THE MEASURED BUDGET -- WHAT THE MACHINE CAN ACTUALLY HOLD
//
// WHY A FIXED PIXEL COUNT IS NOT A BUDGET
// --------------------------------------
// A budget is what the machine can hold. `AUTO_MAX_PIXELS` was a
// constant that said what a GoldSrc-era renderer gains nothing from,
// which is a statement about the ART, not about the machine. On a
// machine that composites 8 megapixels at 60 fps it costs sharpness for
// nothing; on a machine that cannot composite 2 megapixels without the
// frame period swinging between 34 ms and 132 ms it costs smoothness.
//
// MEASURED (Kyle's M3 Pro, production, 2026-11-19, a dense fight):
//
//     IDLE (the GPU wait)   48.6% of the wall
//     the wasm engine       23.5%
//     the GL call path      20.1%  (bufferData 10.83%)
//     our own app JS         0.3%
//
// So roughly HALF the main thread is waiting for the GPU, and the
// engine's frame cost was 32.66 ms against a browser ticking at 29.2 Hz
// -- 21.2% of the frames late, the frame period swinging from 34 ms to
// 132 ms. The frame cost scales with the pixel count, so the pixels are
// the lever, and the only honest way to pull it is to MEASURE what the
// machine is doing.
//
// THE MEASUREMENT
// ---------------
// The client measures its own frame cost: `window.__xashPacing` reports
// the engine's measured per-frame cost in milliseconds, the browser's
// observed tick rate, the panel's rate, the gate and the late-frame
// fraction (see services/frame-pacing-apply.ts). The engine's cost is
// a CPU-SIDE measurement of the engine's frame: it does not cleanly
// separate the engine's own work from the GPU wait, and it does not
// have to -- when the machine is GPU-bound the wait IS the cost, and
// fewer pixels are exactly what shortens it.
//
// THE FORMULA
// -----------
// The frame cost scales with the pixel count, so the pixels that fit
// the target frame time are:
//
//     pixels_target = pixels_now * (target_frame_ms / measured_frame_ms)
//
// `target_frame_ms` is the frame time the engine is allowed at the
// rate the client is aiming for, with the pacer's own headroom
// (`ENGINE_HEADROOM`): the engine must fit the slot AND leave room for
// the game's clock, the browser's timers and the compositor -- the same
// room the pacer leaves, so the two policies agree about what "fits"
// means.
//
// WHAT IT IS NOT
// --------------
// It is NOT a new frame limiter and it does NOT touch the pacer. The
// pacer narrows the RATE; this lowers the PIXELS so the rate can stay
// where the player wants it. And it only ever moves DOWN: a machine
// that is comfortably inside its budget is left completely alone.
// ═══════════════════════════════════════════════════════════════════════

/**
 * THE SHARE OF A FRAME THE ENGINE IS ALLOWED TO USE.
 *
 * THE SAME NUMBER THE PACER USES.
 *
 * `frame-pacing.ts` exports `ENGINE_HEADROOM = 0.85` and uses it both
 * for the sustainable frame rate and for the slot the engine's frame is
 * given. This module cannot import it -- this module has NO IMPORTS, on
 * purpose -- so the number is MIRRORED here, and the parent's unit suite
 * asserts that the two files agree (tests/unit/video-settings.test.mjs
 * reads the pacer's source and compares).
 *
 * It is the same number, not a second one: the budget asks the same
 * question the pacer asks -- would the engine's frame FIT the slot,
 * with the same room left over for everything else?
 */
export const ENGINE_HEADROOM = 0.85;

/**
 * THE RATE THE CLIENT ASKS THE GAME TO HOLD.
 *
 * SIXTY FRAMES A SECOND -- or the display's own rate, when the display
 * is slower than that.
 *
 * WHY 60 AND NOT THE PANEL'S RATE
 * -------------------------------
 * The pacer picks its cap from the rate the engine can sustain, so on a
 * 120 Hz panel it hands out 120 fps when the frame is cheap and 40 fps
 * when it is not. A budget measured against the PANEL's rate would
 * therefore ask a 120 Hz machine for a 7.08 ms frame -- and a machine
 * holding a smooth 60 fps at 12.9 ms a frame would be cut by 45%, on a
 * machine that is doing nothing wrong.
 *
 * 60 fps is the rate the client's own rate table tops out at for a
 * frame of this size, and it is the rate a player reads as smooth.
 */
export const AUTO_TARGET_FPS = 60;

/**
 * HOW MANY CONSECUTIVE OVER-BUDGET MEASUREMENTS ARE NEEDED BEFORE THE
 * BUDGET MOVES.
 *
 * TWO. One expensive window -- a firefight, a shader compilation, a GC
 * pause -- must not halve the player's resolution. A scene is not a
 * regression. This is the pacer's own rule (`GATE_CONSECUTIVE_WINDOWS`
 * in `frame-pacing.ts`), applied to the other lever.
 */
export const AUTO_BUDGET_WINDOWS = 2;

/**
 * HOW FAR PAST THE TARGET THE FRAME COST HAS TO BE BEFORE THE MACHINE
 * COUNTS AS OVER BUDGET.
 *
 * FIVE PER CENT. The frame cost is measured with about 1.4% of noise
 * (7.00 ms and 7.20 ms are the same view on the same machine), and the
 * budget changes at a THRESHOLD -- so a reading that straddles it
 * would move the budget and then move it back, and the resolution would
 * pump for the whole match.
 */
export const AUTO_BUDGET_HYSTERESIS = 0.05;

/**
 * HOW FAR THE BUDGET MAY FALL IN ONE MOVE.
 *
 * THREE QUARTERS. A budget that could fall to a tenth of its size in
 * one step would take the resolution with it -- one expensive window
 * after the warm-up and the game is a postage stamp. The budget walks
 * down instead, one bounded step at a time, and the walk is only
 * allowed to start once the evidence supports it.
 */
export const AUTO_BUDGET_MAX_STEP = 0.75;

/**
 * HOW LONG THE BUDGET STANDS STILL AFTER IT MOVES.
 *
 * TWENTY SECONDS -- two measurement windows. The engine resyncs to the
 * window on every resize, so a resolution that churns is worse than one
 * that does not, and the pacer measures every ten seconds: two
 * windows is long enough for the effect of the last move to show up in
 * the next measurement, and short enough that the budget is still
 * moving during a fight that has changed character.
 */
export const AUTO_BUDGET_COOLDOWN_MS = 20000;

/**
 * A measurement of the machine, as the client's own telemetry reports
 * it.
 */
export interface AutoBudgetMeasurement {
  /**
   * The engine's measured per-frame cost, in milliseconds.
   *
   * From `window.__xashPacing` (`engineWorkMs`). It is a CPU-side
   * measurement of the engine's frame, so it does not cleanly separate
   * the engine's own work from the GPU wait -- which is fine, because
   * on a GPU-bound machine the wait IS the cost and fewer pixels are
   * exactly what shortens it.
   */
  engineWorkMs: number;
  /**
   * The rate the client is aiming for, in frames per second.
   *
   * See `autoTargetFps`: 60 fps, or the display's rate if it is slower.
   */
  targetFps: number;
  /**
   * The pixels the engine is rendering RIGHT NOW, in DEVICE pixels.
   *
   * The caller should pass it: it is the canvas's backing store, and
   * it is the resolution the measurement was TAKEN AT, which is what
   * the formula scales from. It can be smaller than the budget in
   * force -- the canvas's box caps the mode -- and it is the honest
   * answer when the budget in force is used instead.
   */
  currentDevicePixels?: number;
  /**
   * Is this reading past the engine's warm-up?
   *
   * The first window of a match is the most expensive one the engine
   * will ever produce -- it is compiling shaders and streaming the map
   * -- and so is the first window after a map change. A warm-up reading
   * is not a measurement of the MACHINE, so it may not move the
   * budget. Defaults to settled, so a caller that has no warm-up
   * concept is not blocked by one.
   */
  settled?: boolean;
}

/**
 * The budget in force, and the evidence behind it.
 */
export interface AutoBudgetState {
  /** The budget in force, in DEVICE pixels. */
  devicePixels: number;
  /**
   * The CEILING: the fixed policy's own budget for this display, in
   * device pixels. The budget never goes above it.
   */
  ceilingDevicePixels: number;
  /**
   * The FLOOR: the engine's own minimum, in device pixels. The budget
   * never goes below it.
   */
  floorDevicePixels: number;
  /** How many over-budget measurements have arrived in a row. */
  overWindows: number;
  /** When the budget last moved, in epoch milliseconds. 0 = never. */
  lastMovedAt: number;
}

/**
 * What the budget decided about a measurement.
 */
export interface AutoBudgetDecision {
  /** The state after the decision. */
  state: AutoBudgetState;
  /** The budget in force, in device pixels. */
  devicePixels: number;
  /** Did the budget move? */
  changed: boolean;
  /** Does the measurement say the machine is over budget? */
  overBudget: boolean;
  /** The measured frame cost, in milliseconds. */
  measuredMs: number;
  /** The frame time the engine is allowed at the target rate. */
  targetMs: number;
  /** Why. This string goes in the log and the diagnostics. */
  reason: string;
}

/** The smallest mode the fixed presets ask for. */
export const MIN_RENDER_WIDTH = 640;
export const MIN_RENDER_HEIGHT = 360;

/**
 * The engine's own floor — `VID_MIN_WIDTH`/`VID_MIN_HEIGHT` in the
 * engine's vid_common.h. Below this the engine falls back to 320x240.
 */
export const ENGINE_MIN_WIDTH = 320;
export const ENGINE_MIN_HEIGHT = 200;

/**
 * The largest DEVICE-pixel surface the engine may be asked for.
 *
 * The 2026-11-05 regression was an allocation failure: the policy
 * asked for 6912x4468 device pixels, which is past the GL maximum
 * texture dimension of 8192, and the engine fell back to a tiny mode
 * and wedged. So the guard is not optional.
 *
 * 8192 is the conservative floor: it is what the software renderer
 * reports (and the renderer the rig measures with), and every real GPU
 * reports more — so the guard never costs a real device anything. The
 * live limit can be handed in with `setMaxDeviceDimension` once the
 * engine's WebGL context exists.
 */
export const MAX_DEVICE_DIMENSION = 8192;

/** The fixed presets, by choice id, in CSS pixels. */
const PRESETS: Record<string, RenderResolution> = {
  '1920x1080': { width: 1920, height: 1080 },
  '1600x900': { width: 1600, height: 900 },
  '1280x720': { width: 1280, height: 720 },
  '960x540': { width: 960, height: 540 },
  '640x360': { width: 640, height: 360 },
};

/**
 * The device pixel ratio, as the browser reports it.
 *
 * NOT clamped to a range: the engine multiplies its mode by the REAL
 * ratio, so a model that disagreed with it would put the boot
 * arguments and the runtime command in different places. The size
 * that follows from the ratio is bounded by the GL guard instead.
 */
export function devicePixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  const raw = window.devicePixelRatio;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return raw;
}

/**
 * The display, from the browser.
 *
 * `screen.width`/`screen.height` are the DISPLAY's size in CSS pixels.
 * The device pixel ratio is reported alongside them.
 *
 * `screen` can be missing or zero (some privacy modes, some embedded
 * contexts), so the window size and then a sane default are the
 * fallbacks.
 */
export function detectDisplay(): DisplayInfo {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 720, devicePixelRatio: 1 };
  }
  const scr = window.screen;
  const width = scr?.width || window.innerWidth || 1280;
  const height = scr?.height || window.innerHeight || 720;
  return { width, height, devicePixelRatio: devicePixelRatio() };
}

/**
 * Round to a multiple of 8.
 *
 * The engine is happy with odd sizes, but multiples of 8 keep texture
 * alignment tidy and make the scaled result land on the familiar
 * resolutions (1920x1080 is a multiple of 8 in both axes; 1918x1078 is
 * not).
 */
function snap8(value: number): number {
  return Math.max(8, Math.floor(value / 8) * 8);
}

/** Clamp to the engine's floor. */
function clampToEngine(res: RenderResolution): RenderResolution {
  return {
    width: Math.max(ENGINE_MIN_WIDTH, Math.round(res.width)),
    height: Math.max(ENGINE_MIN_HEIGHT, Math.round(res.height)),
  };
}

/**
 * The render resolution for a choice, on a given display, in CSS pixels.
 *
 * PURE — it takes the display as an argument rather than reading it, so
 * the parent's unit suite can exercise the policy for displays nobody
 * here owns.
 *
 * 'auto' is the interesting one:
 *
 *   - a display that already fits the budget renders at its OWN
 *     resolution. That is the native one, so it looks exactly right and
 *     costs nothing extra.
 *   - a display that does not fit is scaled to the budget with its
 *     aspect preserved. 2560x1440 becomes 1920x1080; 3840x2160 becomes
 *     1920x1080; a 3440x1440 ultrawide becomes 2224x928.
 *
 * This is the POLICY's target, in the units the engine is told in. It
 * is not necessarily what the engine ends up rendering: the canvas's
 * box is the cap (`effectiveRenderResolution`), and the shape follows
 * the box, not the policy.
 */
export function resolveRenderResolution(
  choice: ResolutionChoice,
  display: DisplayInfo,
  budget?: AutoBudget | null,
): RenderResolution {
  const preset = PRESETS[choice];
  if (preset) return clampToEngine(preset);

  const dw = display.width > 0 ? display.width : 1280;
  const dh = display.height > 0 ? display.height : 720;

  if (choice === 'display') {
    return clampToEngine({ width: dw, height: dh });
  }

  // 'auto'
  const base = autoBaseResolution(dw, dh, display);

  // A MEASURED BUDGET, when there is one.
  //
  // The fixed policy is the CEILING: the measured budget may only make
  // the resolution SMALLER, never larger. A machine that is
  // comfortably fast is left exactly where the fixed policy put it --
  // the measurement is not allowed to make anyone blurry.
  if (!budget) return base;
  return applyAutoBudget(base, budget, display);
}

/**
 * The fixed 'auto' policy: the display's own resolution, capped by the
 * pixel budget.
 *
 * THE BUDGET IS IN DEVICE PIXELS, NOT CSS PIXELS.
 *
 * The engine's mode is in CSS pixels and the device pixel ratio is
 * applied on top, so the canvas's backing store is the CSS size times
 * the ratio -- in BOTH dimensions. A 2x display therefore renders FOUR
 * times the pixels this budget allows, and the policy has been letting
 * it through. The player's session showed 6.7 megapixels against a
 * budget of 2.07.
 *
 * AND IT WAS NOT FREE.
 *
 * The note above the constant said a device-pixel budget "buys
 * NOTHING", on the evidence that the engine holds 60 FPS at 4K on
 * integrated graphics and that 640x360 changes NOTHING. Both of those
 * were measured on a STILL scene. With sixteen bots frozen in place,
 * 14x the pixels moved the engine's cost by 0.00 ms -- so the
 * conclusion was true and useless.
 *
 * On the scene the player is actually in -- sixteen bots fighting in a
 * small arena -- the same 14x cost 1.61x at the heavy viewpoint: the
 * same six viewpoints, the same fixture verified 6/6, went from
 * 15.63 ms to 25.15 ms, from 60 FPS to 32, with 60% of the frames
 * late. On the player's own machine that is the difference between a
 * smooth frame and a 41.94 ms one.
 *
 * So the choice is the one it always was: sharpness against frame
 * time. The difference is that the frame time is now measured on the
 * scene that matters -- and `display` is still there for the sharpness.
 */
function autoBaseResolution(
  dw: number,
  dh: number,
  display: DisplayInfo,
): RenderResolution {
  const dpr = display.devicePixelRatio > 0 ? display.devicePixelRatio : 1;
  const budget = AUTO_MAX_PIXELS / (dpr * dpr);
  if (dw * dh <= budget) {
    // It fits. Render at the display's own size.
    return clampToEngine({ width: dw, height: dh });
  }

  // It does not fit. Scale to the budget, keeping the display's aspect.
  //
  // The HEIGHT IS DERIVED FROM THE WIDTH, not computed on its own, so
  // the shape of the picture is the display's shape: snapping both axes
  // independently cost 0.75% of the aspect at the smaller sizes.
  const aspect = dw / dh;
  const width = snap8(Math.sqrt(budget * aspect));
  const height = Math.round(width / aspect);
  return clampToEngine({ width, height });
}

/**
 * A measured budget, in device pixels.
 *
 * The ONLY thing a measurement is allowed to say is "the machine can
 * hold fewer pixels than this".
 */
export interface AutoBudget {
  /** The budget, in DEVICE pixels. */
  devicePixels: number;
}

/**
 * Scale the fixed policy's resolution down to a measured budget.
 *
 * THE FLOORS AND CEILINGS, ALL AT ONCE
 * -------------------------------------
 *   - never more pixels than the DISPLAY has: the fixed policy already
 *     refuses to ask for more than the display's own resolution, and the
 *     measured budget only ever shrinks that;
 *   - never more than the FIXED budget's ceiling: the measured budget
 *     is clamped to the fixed policy's own answer, so a fast machine
 *     keeps its full resolution and no machine is ever given MORE
 *     pixels than the old fixed policy gave it;
 *   - never below the ENGINE's floor: `clampToEngine` keeps the mode
 *     at or above `ENGINE_MIN_WIDTH` x `ENGINE_MIN_HEIGHT`, which is
 *     where the engine stops falling back to 320x240 on its own.
 */
export function applyAutoBudget(
  base: RenderResolution,
  budget: AutoBudget,
  display: DisplayInfo,
): RenderResolution {
  const dpr = display.devicePixelRatio > 0 ? display.devicePixelRatio : 1;
  const baseDevice = base.width * base.height * dpr * dpr;
  if (!(baseDevice > 0)) return base;

  // The ceiling: the measured budget can only ever be SMALLER than the
  // fixed policy's own answer.
  const target = Math.min(budget.devicePixels, baseDevice);
  if (!isFinite(target) || target <= 0 || target >= baseDevice) return base;

  // The area scales with the square of the linear scale, so the scale
  // is the square root of the area ratio. Both axes are FLOORED, so
  // the result is inside the budget by construction.
  const scale = Math.sqrt(target / baseDevice);
  return clampToEngine({
    width: snap8(base.width * scale),
    height: Math.floor(base.height * scale),
  });
}

/**
 * The rate the client aims to hold, from the display's rate.
 *
 * The pacer's target, not the panel's: 60 fps, or the display's own
 * rate when the display is slower than 60 (a 30 Hz panel cannot show
 * 60, and asking for a rate the display cannot deliver would make the
 * budget chase a number that can never be met).
 *
 * See `AUTO_TARGET_FPS` for why the target is 60 and not the panel's
 * rate.
 */
export function autoTargetFps(panelHz: number): number {
  if (!isFinite(panelHz) || panelHz <= 0) return AUTO_TARGET_FPS;
  return Math.min(panelHz, AUTO_TARGET_FPS);
}

/**
 * The engine's own floor, in device pixels, in the DISPLAY's shape.
 *
 * The floor is a MODE, not an area: the engine falls back to 320x240
 * below `VID_MIN_WIDTH` x `VID_MIN_HEIGHT`, and the mode it is given
 * has to be at least that in BOTH axes. So the floor is the smallest
 * mode with the display's aspect that is still at or above the
 * engine's minimum in both axes.
 */
function autoFloorDevicePixels(
  dw: number,
  dh: number,
  dpr: number,
): number {
  const aspect = dw / dh;
  const cssW = Math.max(ENGINE_MIN_WIDTH, Math.ceil(ENGINE_MIN_HEIGHT * aspect));
  const cssH = Math.max(ENGINE_MIN_HEIGHT, Math.ceil(cssW / aspect));
  return cssW * cssH * dpr * dpr;
}

/**
 * The budget for a display, before anything has been measured.
 *
 * The CEILING is the fixed policy's own answer -- the display's own
 * resolution, capped by `AUTO_MAX_PIXELS` in device pixels -- and the
 * budget starts there, because that is what the client has always
 * asked for. The measured budget can only ever move it DOWN.
 */
export function createAutoBudgetState(display: DisplayInfo): AutoBudgetState {
  const dw = display.width > 0 ? display.width : 1280;
  const dh = display.height > 0 ? display.height : 720;
  const dpr = display.devicePixelRatio > 0 ? display.devicePixelRatio : 1;
  const base = autoBaseResolution(dw, dh, display);
  const ceiling = base.width * base.height * dpr * dpr;
  return {
    devicePixels: ceiling,
    ceilingDevicePixels: ceiling,
    floorDevicePixels: autoFloorDevicePixels(dw, dh, dpr),
    overWindows: 0,
    lastMovedAt: 0,
  };
}

/**
 * Decide what a measurement does to the budget.
 *
 * THE RULES, exactly:
 *
 *   1. A MEASUREMENT THAT CANNOT BE USED changes nothing. The budget
 *      in force stays, and the reason says the measurement was not
 *      usable -- a readout that guesses is worse than no readout.
 *   2. A MACHINE THAT IS INSIDE ITS BUDGET IS LEFT ALONE. The budget
 *      only ever moves DOWN: a fight that ends does not give the
 *      pixels back, because the engine's cost is scene-dependent and
 *      the pixels are cheap to keep.
 *   3. A MACHINE THAT IS MEASURABLY OVER BUDGET has to say so TWICE
 *      in a row before the budget moves, and then only by a BOUNDED
 *      STEP, and only when the budget is not in its COOLDOWN.
 *
 * The formula, in one line:
 *
 *     pixels_target = pixels_now * (target_frame_ms / measured_frame_ms)
 *
 * where `target_frame_ms` is the slot at the target rate with the
 * pacer's own headroom, and `measured_frame_ms` is what the engine's
 * frame actually cost.
 */
export function decideAutoBudget(
  state: AutoBudgetState,
  measurement: AutoBudgetMeasurement,
  opts: { now?: number } = {},
): AutoBudgetDecision {
  const now = opts.now ?? Date.now();
  const measuredMs = measurement?.engineWorkMs ?? 0;
  const targetFps = measurement?.targetFps ?? 0;

  // --- RULE 1: a measurement that cannot be used ------------------------
  const noCost = !isFinite(measuredMs) || measuredMs <= 0;
  const noTarget = !isFinite(targetFps) || targetFps <= 0;
  if (noCost || noTarget) {
    const why =
      noCost && noTarget
        ? 'the frame cost and the target rate are both unknown'
        : noCost
          ? 'the frame cost is unknown'
          : 'the target rate is unknown';
    return {
      state,
      devicePixels: state.devicePixels,
      changed: false,
      overBudget: false,
      measuredMs,
      targetMs: 0,
      reason:
        `the measurement was not usable (${why}); ` +
        `the budget in force is left in place`,
    };
  }

  // A WARM-UP READING IS NOT A MEASUREMENT OF THE MACHINE.
  //
  // The first window of a match is the most expensive one the engine
  // will ever produce -- it is compiling shaders and streaming the map
  // -- and the first window after a map change is the same story. The
  // pacer knows this and calls such a reading PROVISIONAL; the budget
  // treats it the same way, because a resolution that was cut for the
  // engine's warm-up would be cut for the whole match.
  if (measurement.settled === false) {
    return {
      state,
      devicePixels: state.devicePixels,
      changed: false,
      overBudget: false,
      measuredMs,
      targetMs: 0,
      reason:
        `the reading is inside the engine's warm-up, so it is not a ` +
        `measurement of the machine; the budget in force is left in place`,
    };
  }

  // THE TARGET FRAME TIME: the slot at the target rate, with the
  // pacer's own headroom. The engine has to fit the slot AND leave
  // room for the game's clock, the browser's timers and the
  // compositor -- the same room the pacer leaves.
  const targetMs = (1000 / targetFps) * ENGINE_HEADROOM;
  const measured = `the engine costs ${measuredMs.toFixed(2)} ms a frame ` +
    `against a ${targetMs.toFixed(2)} ms target ` +
    `(${targetFps.toFixed(0)} fps at ${ENGINE_HEADROOM} headroom)`;

  // --- RULE 2: inside the budget is left alone --------------------------
  //
  // The HYSTERESIS band is what makes "inside" and "over" different
  // words: the frame cost is measured with about 1.4% of noise, so a
  // reading that straddles the threshold must not move the budget.
  if (measuredMs <= targetMs * (1 + AUTO_BUDGET_HYSTERESIS)) {
    const next: AutoBudgetState = { ...state, overWindows: 0 };
    return {
      state: next,
      devicePixels: next.devicePixels,
      changed: false,
      overBudget: false,
      measuredMs,
      targetMs,
      reason:
        `${measured}; the machine is inside its budget, ` +
        `so the resolution is left alone`,
    };
  }

  // --- OVER BUDGET ------------------------------------------------------
  //
  // THE FORMULA. The frame cost scales with the pixel count, so the
  // pixels that fit the target frame time are the pixels now, scaled
  // by the ratio of the target frame time to the measured one.
  const currentPixels = measurement.currentDevicePixels ?? 0;
  const pixelsNow = currentPixels > 0 ? currentPixels : state.devicePixels;
  const rawTarget = pixelsNow * (targetMs / measuredMs);

  // THE CEILING AND THE FLOOR, and the rule that the budget never
  // goes UP: a machine that is over budget gets a SMALLER budget, and
  // nothing else.
  let target = Math.min(rawTarget, state.devicePixels, state.ceilingDevicePixels);
  target = Math.max(target, state.floorDevicePixels);

  // THE BOUNDED STEP. The budget walks down; it does not fall off a
  // cliff. One expensive window must not take the resolution with it.
  const stepped = Math.max(target, state.devicePixels * AUTO_BUDGET_MAX_STEP);
  const nextTarget = Math.max(stepped, state.floorDevicePixels);

  const overWindows = state.overWindows + 1;

  if (nextTarget >= state.devicePixels) {
    const next: AutoBudgetState = { ...state, overWindows };
    return {
      state: next,
      devicePixels: next.devicePixels,
      changed: false,
      overBudget: true,
      measuredMs,
      targetMs,
      reason:
        `${measured}; the budget is already at the engine's floor, ` +
        `so there is nothing left to give up`,
    };
  }

  // --- RULE 3: two windows in a row --------------------------------------
  if (overWindows < AUTO_BUDGET_WINDOWS) {
    const next: AutoBudgetState = { ...state, overWindows };
    return {
      state: next,
      devicePixels: next.devicePixels,
      changed: false,
      overBudget: true,
      measuredMs,
      targetMs,
      reason:
        `${measured}; only ${overWindows} measurement` +
        `${overWindows === 1 ? '' : 's'} in a row have said so, ` +
        `so the budget in force is left in place`,
    };
  }

  // --- THE COOLDOWN -----------------------------------------------------
  //
  // The engine resyncs to the window on every resize, so a resolution
  // that churns is worse than one that does not. After a move the
  // budget stands still for a couple of measurement windows, long
  // enough for the effect of the move to show up in the next reading.
  const sinceMove = state.lastMovedAt > 0 ? now - state.lastMovedAt : Infinity;
  if (sinceMove < AUTO_BUDGET_COOLDOWN_MS) {
    const next: AutoBudgetState = { ...state, overWindows };
    return {
      state: next,
      devicePixels: next.devicePixels,
      changed: false,
      overBudget: true,
      measuredMs,
      targetMs,
      reason:
        `${measured}; the budget moved ${(sinceMove / 1000).toFixed(0)} s ` +
        `ago and is in its ${AUTO_BUDGET_COOLDOWN_MS / 1000} s cooldown, ` +
        `so it stands still`,
    };
  }

  const next: AutoBudgetState = {
    devicePixels: nextTarget,
    ceilingDevicePixels: state.ceilingDevicePixels,
    floorDevicePixels: state.floorDevicePixels,
    overWindows: 0,
    lastMovedAt: now,
  };
  const drop = (1 - nextTarget / state.devicePixels) * 100;
  return {
    state: next,
    devicePixels: nextTarget,
    changed: true,
    overBudget: true,
    measuredMs,
    targetMs,
    reason:
      `${measured}; the machine is measurably over budget, so the render ` +
      `budget falls by ${drop.toFixed(0)}% to ${nextTarget} device pixels`,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// THE BUDGET IN FORCE, FOR THIS SESSION
//
// Module state rather than a store field, for the same reason the
// render resolution target is: three different places need it (the
// loader's boot path, the loader's measurement loop, and the options
// panel), and the measurement loop is installed at import time.
// ═══════════════════════════════════════════════════════════════════════

/** The budget in force, or null when nothing has been decided yet. */
let autoBudgetState: AutoBudgetState | null = null;

/**
 * The budget in force, in device pixels, or null.
 *
 * A COPY, so a caller cannot edit the policy's own state by accident.
 */
export function getAutoBudget(): AutoBudgetState | null {
  return autoBudgetState ? { ...autoBudgetState } : null;
}

/**
 * Forget the budget.
 *
 * Called when the player picks a resolution that is not 'auto': the
 * measurement must never touch an explicit choice, and a session that
 * starts again starts with the fixed policy's own budget.
 */
export function resetAutoBudget(): void {
  autoBudgetState = null;
}

/**
 * Feed a measurement into the budget, and get the decision.
 *
 * The first measurement of a session sets the budget to the fixed
 * policy's own answer for this display -- the ceiling -- and every
 * measurement after that may move it down.
 */
export function updateAutoBudget(
  measurement: AutoBudgetMeasurement,
  display: DisplayInfo,
  now: number = Date.now(),
): AutoBudgetDecision {
  const state = autoBudgetState ?? createAutoBudgetState(display);
  const decision = decideAutoBudget(state, measurement, { now });
  autoBudgetState = decision.state;
  return decision;
}

/**
 * The resolution the measured budget asks for, in CSS pixels.
 *
 * A convenience for the loader: the budget in force, turned into the
 * mode the engine should be given.
 */
export function autoBudgetResolution(
  budget: AutoBudget | null,
  display: DisplayInfo,
): RenderResolution {
  return resolveRenderResolution('auto', display, budget);
}

/**
 * The engine's launch arguments for a render resolution.
 *
 * `-width`/`-height` are the engine's own command-line switches
 * (`SetWidthAndHeightFromCommandLine`). They set the engine's `width`
 * and `height` cvars during renderer init, and the engine creates its
 * window at that size — so the first frame is already right.
 *
 * THEY ARE DEVICE PIXELS (measured 2026-11-05)
 * --------------------------------------------
 * The launch arguments are LITERAL dimensions. At dpr 2, boot
 * arguments 1920x1200 produced a 1920x1200 backing store — not
 * 3840x2400. The runtime command (`vid_setmode`) wants CSS pixels.
 * They are not the same number, and using one function for both is
 * what put the first frame at half the device box.
 *
 * So the mode is multiplied by the device pixel ratio here, and the
 * result is bounded by the GL limit — a boot argument past the
 * maximum texture size is the allocation failure that wedged the
 * engine on 2026-11-05.
 */
export function renderResolutionArgs(
  res: RenderResolution,
  dpr: number = devicePixelRatio(),
): string[] {
  const ratio = dpr > 0 ? dpr : 1;
  const device = clampDeviceSize({
    width: Math.round(res.width * ratio),
    height: Math.round(res.height * ratio),
  });
  return ['-width', String(device.width), '-height', String(device.height)];
}

/**
 * The engine command that (re)applies a render resolution.
 *
 * `vid_setmode` is a restricted engine command (`VID_Mode_f` in the
 * engine's vid_common.c). It goes through `R_ChangeDisplaySettings`,
 * which is the same path a window resize takes — so it is the one call
 * that makes the engine's window AND its cvars agree on the size.
 *
 * The mode is in CSS pixels: the engine multiplies by the device pixel
 * ratio itself.
 */
export function renderResolutionCommand(res: RenderResolution): string {
  return `vid_setmode ${res.width} ${res.height}`;
}

/**
 * The engine's CURRENT render resolution, in CSS PIXELS.
 *
 * The canvas's backing store is the engine's mode times the device pixel
 * ratio (measured: `vid_setmode 1280 720` at dpr 2 gives a 2560x1440
 * backing store), so the mode is the backing store divided by the ratio.
 * The comparison in `renderResolutionNeedsApplying` is between two
 * MODES, so both sides have to be in the same units — and the mode is
 * what the engine is told.
 *
 * Read from the canvas backing store. That is not a proxy for the
 * engine's state — it IS the engine's state: the engine sizes the
 * canvas, and the measurement above showed the backing store and the
 * engine's `vid_width`/`vid_height` cvars agreeing at every size tried.
 *
 * It is a synchronous, free read, which matters because this runs in a
 * resize handler, where an async cvar read would be awkward.
 */
export function currentRenderResolution(): RenderResolution | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas || !canvas.width || !canvas.height) return null;
  // The backing store is the mode times the device pixel ratio.
  const dpr = devicePixelRatio();
  return {
    width: Math.round(canvas.width / dpr),
    height: Math.round(canvas.height / dpr),
  };
}

/**
 * The canvas's CSS box — the size the browser has to put on the screen.
 *
 * The canvas's DRAWING BUFFER (`canvas.width` x `canvas.height`) is
 * scaled onto this box on every single frame, and the scaling is the
 * browser's compositor work. The engine's buffer is its mode times the
 * device pixel ratio, and the box is this many CSS pixels, so the two
 * agree — and the browser scales nothing — exactly when the MODE is
 * this many CSS pixels.
 *
 * So this is the cap, in the same units as the mode: never ask the
 * engine for more CSS pixels than the canvas is showing, or the browser
 * downscales the surplus every frame.
 *
 * MEASURED (2026-11-04, real Chrome headful, the local rig): the buffer
 * was 1600x1000 while the canvas showed 1050x837 — so the browser was
 * scaling 1.6 million pixels down to 0.88 million, EVERY FRAME. That is
 * the lag Kyle sees when the screen size changes.
 */
export function displayedRenderResolution(): RenderResolution | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return null;
  // CSS pixels - the same units as the mode. See the module header.
  return {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  };
}

/**
 * Fit a target inside a cap: the CAP's SHAPE, the TARGET's AREA.
 *
 * The cap is what the screen can actually show. Rendering more pixels
 * than that is pure waste: the browser scales the extra away on every
 * frame, and the scaling is not free.
 *
 * WHY THE SHAPE COMES FROM THE CAP AND NOT THE TARGET
 * ---------------------------------------------------
 * The target is the DISPLAY's resolution; the cap is the canvas's box,
 * and a window is not the display. Keeping the target's aspect meant
 * the mode could exceed the box on ONE axis (a 2560x1440 target inside
 * a 1728x1117 box is 2224x928 after an area fit — no, worse: the
 * browser then downscales that axis every frame, which is the lag).
 *
 * The box's shape is also where the engine's OWN resize lands (SDL
 * resize -> `VID_SaveWindowSize` -> `R_SaveVideoMode`), so a mode with
 * the box's shape is a mode the engine agrees with: the watchdog and
 * the engine stop fighting, and the browser scales nothing.
 */
export function fitRenderResolution(
  target: RenderResolution,
  cap: RenderResolution,
): RenderResolution {
  const capArea = cap.width * cap.height;
  if (capArea <= 0) return target;
  const targetArea = target.width * target.height;
  const area = Math.min(capArea, targetArea);
  const scale = Math.sqrt(area / capArea);
  // FLOORED, not rounded: rounding both axes up can put the area a
  // fraction over the budget, and a budget that is a budget. Flooring
  // keeps the result inside `area` by construction (floor <= value), and
  // when the whole box fits (scale 1) it is the box exactly.
  return {
    width: Math.max(2, Math.floor(cap.width * scale)),
    height: Math.max(2, Math.floor(cap.height * scale)),
  };
}

/**
 * The resolution the engine should ACTUALLY render at, in CSS pixels.
 *
 * The policy's target is a budget (the display's size, capped). But the
 * browser can only show what the canvas's box holds, and it scales the
 * drawing buffer to that box on EVERY FRAME. So the target is capped by
 * what is displayed:
 *
 *   - The engine renders at the policy's target (the display's size).
 *   - The window is smaller than the display, so the browser scales the
 *     whole frame down, every frame, for as long as the game is running.
 *   - Leaving the fullscreen makes the window smaller still, so the
 *     scaling gets WORSE — that is the "screen resize lag" Kyle
 *     described, and why going back into the fullscreen is seamless
 *     (the ratio returns to 1) while the transition out of it is not.
 *
 * So: never render more pixels than the screen shows. The fullscreen
 * then renders at the display's resolution (sharp), and the windowed
 * game renders at the window's resolution (no scaling, no lag).
 *
 * And the result is bounded by the GL limit, because a mode past it is
 * an allocation failure, not a slow frame.
 */
export function effectiveRenderResolution(
  policyTarget: RenderResolution | null,
  displayed: RenderResolution | null,
  dpr: number = devicePixelRatio(),
): RenderResolution | null {
  if (!policyTarget) return null;
  const base = displayed
    ? fitRenderResolution(policyTarget, displayed)
    : policyTarget;
  return clampToGlLimit(base, dpr);
}

/**
 * Does the engine need to be moved to the target?
 *
 * The target the caller passes in is already the EFFECTIVE one: the
 * policy's resolution, capped by the canvas's displayed size (see
 * `effectiveRenderResolution`). With that cap in place the engine's size
 * and the target are simply two numbers that either agree or they do
 * not.
 *
 * WHY THE COMPARISON HAS A TOLERANCE
 * ----------------------------------
 * The engine TRUNCATES: `cssWidth * dpiScale | 0`. So the mode read
 * back from the backing store can be a fraction under the mode that was
 * asked for, and a strict `!==` compares forever — the watchdog
 * re-issues the command on every resize event and the engine
 * reallocates its render target every time. A pixel of slack is
 * invisible (the browser scales 3454x2234 onto 3456x2234) and stops
 * the churn.
 */
export function renderResolutionNeedsApplying(
  target: RenderResolution | null,
  current: RenderResolution | null,
): boolean {
  if (!target) return false;
  if (!current) return true;
  return (
    Math.abs(current.width - target.width) > 1 ||
    Math.abs(current.height - target.height) > 1
  );
}

/**
 * The GL limit the guard uses, in device pixels.
 *
 * The live limit can be handed in once the engine's WebGL context
 * exists (`setMaxDeviceDimension`); until then the conservative
 * measured floor stands.
 */
let maxDeviceDimension = MAX_DEVICE_DIMENSION;

/**
 * Hand the guard the engine's real maximum texture size.
 *
 * The engine's context reports `MAX_TEXTURE_SIZE`, and a mode past it
 * cannot be allocated — which is the failure that wedged the engine on
 * 2026-11-05. The value is ignored when it is not a usable limit.
 */
export function setMaxDeviceDimension(limit: number): void {
  if (!Number.isFinite(limit) || limit < 2048) return;
  maxDeviceDimension = Math.floor(limit);
}

/** The GL limit the guard is using, in device pixels. */
export function getMaxDeviceDimension(): number {
  return maxDeviceDimension;
}

/** Clamp a DEVICE-pixel size to the GL limit, uniformly. */
function clampDeviceSize(size: RenderResolution): RenderResolution {
  const limit = maxDeviceDimension;
  const longest = Math.max(size.width, size.height);
  if (longest <= limit) return size;
  const scale = limit / longest;
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
}

/**
 * Clamp a CSS-pixel mode so the engine's device-pixel surface fits the
 * GL limit.
 *
 * The engine's surface is the mode times the device pixel ratio, and
 * that is the number that has to fit.
 */
export function clampToGlLimit(
  res: RenderResolution,
  dpr: number = devicePixelRatio(),
): RenderResolution {
  const ratio = dpr > 0 ? dpr : 1;
  const device = clampDeviceSize({
    width: Math.round(res.width * ratio),
    height: Math.round(res.height * ratio),
  });
  const maxCss = Math.floor(maxDeviceDimension / ratio);
  return {
    width: Math.max(
      Math.min(ENGINE_MIN_WIDTH, maxCss),
      Math.round(device.width / ratio),
    ),
    height: Math.max(
      Math.min(ENGINE_MIN_HEIGHT, maxCss),
      Math.round(device.height / ratio),
    ),
  };
}

/**
 * The resolution the page has decided on.
 *
 * Module state rather than a store field, because three different
 * places need it — the loader (to build the launch arguments), the
 * post-boot hook (to apply it) and the resize watchdog (to re-apply it)
 * — and the watchdog is installed at import time, before the Vue app
 * exists.
 */
let target: RenderResolution | null = null;

/**
 * Is the engine's COMMAND system up?
 *
 * The engine's console and its command pool do not exist until the
 * engine has run its first frame. A console command sent before that
 * lands in an uninitialised pool, and the engine answers it with its
 * own fatal error — measured, in the engine's console:
 *
 *     _Mem_Alloc: pool == NULL (alloc at ../engine/common/cmd.c:638)
 *
 * and the JavaScript side sees the failure as the bare value
 * `Infinity` thrown out of `Cmd_ExecuteString`.
 *
 * The resize watchdog is the thing that trips this: it is installed at
 * import time, before the Vue app exists, so it hears the resize
 * events that happen while the engine is still booting. The loader arms
 * this module once the engine is up.
 */
let armed = false;

/** Say that the engine's command system is up. */
export function armRenderResolution(): void {
  armed = true;
}

/**
 * Say that the engine's command system is NOT up.
 *
 * The engine is torn down and rebuilt when the player reloads the page
 * (the "connection lost" reconnect), so anything that talks to it has
 * to stop until the new engine says it is ready.
 */
export function disarmRenderResolution(): void {
  armed = false;
}

/** Is the engine's command system up? */
export function isRenderResolutionArmed(): boolean {
  return armed;
}

/** Set the resolution the page has decided on. */
export function setRenderResolutionTarget(res: RenderResolution | null): void {
  target = res;
}

/** The resolution the page has decided on, if any. */
export function getRenderResolutionTarget(): RenderResolution | null {
  return target;
}

/**
 * Re-apply the render resolution if the engine has drifted away from it.
 *
 * Returns true when the engine is at the target afterwards — either it
 * already was, or this call put it there. The caller supplies `exec`
 * so this module stays import-free: the loader passes its own console
 * bridge, and the test passes a recorder.
 *
 * `exec` returns false when the engine refused the command, and throws
 * when the engine was not up at all. Both are "not applied".
 *
 * `force` issues the command even when the canvas backing store already
 * matches the target. That is what reconciles the engine's OWN state
 * with the canvas: the `-width`/`-height` launch arguments set the
 * canvas's backing store, but the engine's `vid_width`/`vid_height`
 * cvars can still be sitting at the viewport's size — measured, in one
 * boot: the canvas backing store was 1920x1080 while `vid_width` and
 * `vid_height` still said 2560x1440. Only the engine's own
 * `vid_setmode` path leaves the two agreeing.
 */
export function applyRenderResolution(
  exec: (cmd: string) => boolean | void,
  log?: (message: string) => void,
  force = false,
): boolean {
  if (!target) return false;
  // Nothing may be sent to an engine that cannot take commands yet.
  if (!armed && !force) return false;

  // The EFFECTIVE target: the policy's resolution, capped by what the
  // canvas actually shows. Rendering more than the screen shows is
  // waste, and the browser's per-frame scaling of the extra is the lag.
  const dpr = devicePixelRatio();
  const effective = effectiveRenderResolution(
    target,
    displayedRenderResolution(),
    dpr,
  );
  if (!effective) return false;

  const current = currentRenderResolution();
  if (!force && !renderResolutionNeedsApplying(effective, current)) return true;

  try {
    if (exec(renderResolutionCommand(effective)) === false) {
      log?.('[video] the engine did not take the video command');
      return false;
    }
  } catch (e) {
    log?.(`[video] the engine was not ready for a video command: ${e}`);
    return false;
  }

  const device = `${Math.round(effective.width * dpr)}x${Math.round(
    effective.height * dpr,
  )}`;
  log?.(
    `[video] render resolution -> ${effective.width}x${effective.height} CSS` +
      ` (${device} device)` +
      (current ? ` (was ${current.width}x${current.height})` : ''),
  );
  return true;
}

/** A human-readable label for a choice, for the options panel. */
export function describeResolutionChoice(
  choice: ResolutionChoice,
  display: DisplayInfo,
): string {
  switch (choice) {
    case 'auto': {
      const res = resolveRenderResolution('auto', display);
      return `Auto (${res.width}×${res.height})`;
    }
    case 'display':
      return `Display (${display.width}×${display.height})`;
    default: {
      const res = PRESETS[choice];
      return res ? `${res.width}×${res.height}` : choice;
    }
  }
}
