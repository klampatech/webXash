/**
 * The player's video settings: detected from the browser, turned into
 * engine launch arguments, and re-applied whenever the engine would
 * otherwise drift back to the viewport's resolution.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine renders AT the browser viewport's resolution. Always.
 *
 * Measured against production on 2026-10-28 — one Chromium, one client,
 * the engine's own `vid_width`/`vid_height` cvars and the canvas backing
 * store tracked the viewport exactly at every size tried:
 *
 *     viewport      engine render res   engine frames/s
 *     640x480       640x480             69.5
 *     1280x720      1280x720            30.2
 *     1920x1080     1920x1080            8.6
 *     2560x1440     2560x1440            4.5
 *
 * The frame cost is the pixel count — 14.4 ms at 640x480, 222 ms at
 * 2560x1440 — so going fullscreen on a 1440p display is a 4x hit. That
 * is the "some FPS hits when I go full screen" Kyle reported.
 *
 * It is also, in the end, what the "150 ms" in the 2026-10-27
 * capacity/latency report actually was. That report measured a 154.5 ms
 * event-loop lag in-game and could not explain it. It is the engine's own
 * render frame time: the browser's `requestAnimationFrame` rate and the
 * engine's frame rate were identical at every size (69.5/s, 30.2/s,
 * 8.6/s, 4.5/s), so the page's main thread is blocked for exactly one
 * frame while the engine draws. The setTimeout lag is that block, two
 * to four frames deep. It was never server latency — the network path
 * from an idle page is 31.6 ms.
 *
 * THE FIX, AND WHY IT IS NOT JUST "SET IT ONCE"
 * ---------------------------------------------
 * The canvas is `width: 100vw; height: 100vh` (assets/main.css), so the
 * canvas's CSS size is independent of its backing store. Forcing the
 * engine to a smaller mode and letting the browser upscale gives the
 * frames straight back:
 *
 *     viewport 2560x1440, engine mode 1280x720   ->  16.2 frames/s
 *     viewport 2560x1440, engine mode 640x360    ->  36.7 frames/s
 *
 * But the engine RESYNCS to the window on every resize:
 *
 *     SDL_WINDOWEVENT_RESIZED -> VID_SaveWindowSize -> R_SaveVideoMode
 *
 * and `R_SaveVideoMode` rewrites `width`, `height`, `vid_width` and
 * `vid_height` from the new window size. Measured: a forced 1280x720 did
 * NOT survive the viewport growing to 2560x1440 — the engine went back to
 * 2560x1440 and the frame rate fell to 0.4/s. So the resolution has to
 * be re-applied after every resize, not just once at boot.
 *
 * The engine's command line also accepts `-width`/`-height`
 * (`SetWidthAndHeightFromCommandLine` in the engine's ref_common.c), and
 * those DO set the initial window size — the engine creates its window
 * at that size during renderer init, so the very first frame is already
 * at the right resolution. They are passed too, but they are not the
 * load-bearing half: the launch arguments cannot survive the resize that
 * going fullscreen causes.
 *
 * THIS MODULE HAS NO IMPORTS, ON PURPOSE
 * --------------------------------------
 * The parent's unit suite imports this file directly and exercises the
 * real policy — see tests/unit/video-settings.test.mjs. That only works
 * if the module is plain TypeScript with no imports of its own, the
 * same constraint browser-chords.ts is written under. Keep it that way.
 */

/** A render resolution, in pixels. */
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
 * 'auto'     — the display's own aspect, capped at the pixel budget.
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
 * The pixel budget 'auto' spends: 1920x1080.
 *
 * A GoldSrc-era renderer gains nothing visible above it — the art is
 * 320x240 — while the cost is linear in pixels, so a 1440p display pays
 * 2.3x the fill rate and a 4K display 5x, for detail the source art
 * does not have. The player who wants the pixels can pick 'display'.
 */
export const AUTO_MAX_PIXELS = 1920 * 1080;

/** The smallest mode this module will ask the engine for. */
export const MIN_RENDER_WIDTH = 640;
export const MIN_RENDER_HEIGHT = 360;

/**
 * The engine's own floor — `VID_MIN_WIDTH`/`VID_MIN_HEIGHT` in the
 * engine's vid_common.h. Below this the engine falls back to 320x240.
 */
export const ENGINE_MIN_WIDTH = 320;
export const ENGINE_MIN_HEIGHT = 200;

/** The fixed presets, by choice id. */
const PRESETS: Record<string, RenderResolution> = {
  '1920x1080': { width: 1920, height: 1080 },
  '1600x900': { width: 1600, height: 900 },
  '1280x720': { width: 1280, height: 720 },
  '960x540': { width: 960, height: 540 },
  '640x360': { width: 640, height: 360 },
};

/**
 * The display, from the browser.
 *
 * `screen.width`/`screen.height` are the DISPLAY's size in CSS pixels —
 * which is what we want, not the window's, and not the device pixels.
 *
 * On a HiDPI display (a Retina MacBook, say) the device has 3024 device
 * pixels across while `screen.width` reports 1512. Rendering at the
 * device resolution would cost FOUR times the fill rate for a game whose
 * art is 320x240, and the browser upscales the canvas anyway. So the
 * device pixel ratio is reported but deliberately not multiplied into the
 * render target.
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
  const devicePixelRatio = window.devicePixelRatio || 1;
  return { width, height, devicePixelRatio };
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
 * The render resolution for a choice, on a given display.
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
 */
export function resolveRenderResolution(
  choice: ResolutionChoice,
  display: DisplayInfo,
): RenderResolution {
  const preset = PRESETS[choice];
  if (preset) return clampToEngine(preset);

  const dw = display.width > 0 ? display.width : 1280;
  const dh = display.height > 0 ? display.height : 720;

  if (choice === 'display') {
    return clampToEngine({ width: dw, height: dh });
  }

  // 'auto'
  if (dw * dh <= AUTO_MAX_PIXELS) {
    // It fits. Render at the display's own size.
    return clampToEngine({ width: dw, height: dh });
  }

  // It does not fit. Scale to the budget, keeping the display's aspect.
  const aspect = dw / dh;
  const width = snap8(Math.sqrt(AUTO_MAX_PIXELS * aspect));
  const height = snap8(Math.sqrt(AUTO_MAX_PIXELS / aspect));
  return clampToEngine({ width, height });
}

/**
 * The engine's launch arguments for a render resolution.
 *
 * `-width`/`-height` are the engine's own command-line switches
 * (`SetWidthAndHeightFromCommandLine`). They set the engine's `width`
 * and `height` cvars during renderer init, and the engine creates its
 * window at that size — so the first frame is already right.
 */
export function renderResolutionArgs(res: RenderResolution): string[] {
  return ['-width', String(res.width), '-height', String(res.height)];
}

/**
 * The engine command that (re)applies a render resolution.
 *
 * `vid_setmode` is a restricted engine command (`VID_Mode_f` in the
 * engine's vid_common.c). It goes through `R_ChangeDisplaySettings`,
 * which is the same path a window resize takes — so it is the one call
 * that makes the engine's window AND its cvars agree on the size.
 */
export function renderResolutionCommand(res: RenderResolution): string {
  return `vid_setmode ${res.width} ${res.height}`;
}

/**
 * The engine's CURRENT render resolution.
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
  return { width: canvas.width, height: canvas.height };
}

/** Does the engine's current resolution differ from the target? */
export function renderResolutionNeedsApplying(
  target: RenderResolution | null,
  current: RenderResolution | null,
): boolean {
  if (!target) return false;
  if (!current) return true;
  return current.width !== target.width || current.height !== target.height;
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

  const current = currentRenderResolution();
  if (!force && !renderResolutionNeedsApplying(target, current)) return true;

  try {
    if (exec(renderResolutionCommand(target)) === false) {
      log?.('[video] the engine did not take the video command');
      return false;
    }
  } catch (e) {
    log?.(`[video] the engine was not ready for a video command: ${e}`);
    return false;
  }

  log?.(
    `[video] render resolution -> ${target.width}x${target.height}` +
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
