/**
 * Browser fullscreen for the game.
 *
 * WHY THIS EXISTS
 * ---------------
 * The game is a 3D shooter in a browser tab. In a tab it is a postage
 * stamp: the HUD is unreadable, the mouse look fights the scrollbar, and
 * the player has to alt-tab out of the page to do anything else. The
 * browser has a fullscreen mode for exactly this, and the only reason it
 * was not used is that nobody asked for it.
 *
 * THE CANVAS IS NOT THE FULLSCREEN ELEMENT
 * -----------------------------------------
 * The options overlay, the "connection lost" panel and the Vue HUD are
 * DOM SIBLINGS of the canvas. A browser shows only the fullscreen element
 * and its descendants, so fullscreening the canvas would hide the very UI
 * the player needs when something goes wrong. The document element is
 * fullscreened instead: the canvas is already `100vw × 100vh`, so it
 * fills the screen either way, and the overlays stay visible.
 *
 * THE GESTURE
 * -----------
 * `requestFullscreen()` only works from a user gesture, and only while the
 * gesture is still live. It is therefore called from the click handler,
 * BEFORE the first `await` — everything after that point (resolving the
 * server, downloading 493 MB, booting the engine) is async, and a
 * fullscreen request made after an await is refused.
 *
 * THE RESIZE
 * ----------
 * Going fullscreen is a resize, and Kyle reported that "if the window size
 * changes, the window goes black". Measured in headless Chromium against
 * production (a viewport resize from 1280x720 to 900x600): the engine's
 * canvas backing store, the WebGL drawing buffer and the GL viewport all
 * followed the new size by themselves, and the frame kept rendering. The
 * engine handles the resize; this file does not fight it.
 *
 * What can still go black is a LOST WebGL context, which some drivers do
 * when a canvas is resized. That one is recoverable, and the watchdog
 * below is the only thing here that touches the engine's GL state.
 */

/** Is fullscreen available at all? */
export function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.documentElement?.requestFullscreen === 'function'
  );
}

/** Is the page in fullscreen right now? */
export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

/**
 * Put the page in fullscreen.
 *
 * Call this from a click handler, before any await: the request has to
 * happen while the user gesture is still live.
 *
 * A browser that refuses — no gesture, a policy, an embedded frame — must
 * not break the launch. The game is perfectly playable windowed, so a
 * refusal is a warning and nothing more.
 */
export async function enterFullscreen(): Promise<boolean> {
  if (!fullscreenSupported() || isFullscreen()) return isFullscreen();
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch (e) {
    console.warn('[fullscreen] the browser refused:', e);
    return false;
  }
}

/** Leave fullscreen, if we are in it. */
export function exitFullscreen(): void {
  if (!isFullscreen()) return;
  try {
    const p = document.exitFullscreen?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Nothing to do: the browser will refuse and the player stays
    // fullscreen, which is not a failure worth surfacing.
  }
}

/**
 * The canvas's live WebGL context, if the engine made one.
 *
 * `getContext` with the type the engine already used returns the SAME
 * context object, so this reads the engine's context rather than making a
 * second one. Asking for a different type than the one in use returns null
 * (and logs a console warning in some browsers), so the WebGL2 attempt is
 * the one that matters: the production build runs `-ref webgl2`.
 */
function engineContext(): WebGL2RenderingContext | WebGLRenderingContext | null {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;
  try {
    return (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGL2RenderingContext | null;
  } catch {
    return null;
  }
}

/**
 * Recover a WebGL context that was lost in a resize.
 *
 * A lost context renders BLACK — the canvas keeps its size, the engine
 * keeps running, and nothing is drawn. It is the one failure mode that
 * matches "the window goes black when the size changes", and it is
 * recoverable: the browser can restore the context.
 *
 * This only acts when the context is actually lost. If it is not, this
 * does nothing at all — so it cannot make a working resize worse.
 */
export function recoverLostContext(): boolean {
  const gl = engineContext();
  if (!gl || !gl.isContextLost()) return false;
  try {
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext && 'restoreContext' in ext) {
      ext.restoreContext();
      console.warn('[fullscreen] the WebGL context was lost; asked the browser to restore it');
      return true;
    }
  } catch (e) {
    console.warn('[fullscreen] could not restore the WebGL context:', e);
  }
  return false;
}

/**
 * Watch for the resize that a fullscreen transition causes, and recover a
 * lost context if that is what went black.
 *
 * Idempotent: installing it twice installs one watcher.
 */
export function installFullscreenWatchdog(): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = '__xashFullscreenWatchdogInstalled';
  const w = window as unknown as Record<string, unknown>;
  if (w[key]) return () => {};
  w[key] = true;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    recoverLostContext();
  };
  // Debounced: a fullscreen transition fires a burst of resize events,
  // and a context that is being restored must not be poked again while it
  // is coming back.
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 400);
  };

  window.addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', schedule);
  return () => {
    window.removeEventListener('resize', schedule);
    document.removeEventListener('fullscreenchange', schedule);
    if (timer) clearTimeout(timer);
  };
}
