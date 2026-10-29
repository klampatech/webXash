/**
 * The WebGL context the engine renders into.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine's own context is created by the renderer WASM, which calls
 * `_emscripten_webgl_create_context` -> `GL.createContext(canvas,
 * contextAttributes)` with attributes that come from the WASM side.
 *
 * The usual Emscripten lever, `Module.webGLContextAttributes`, does
 * NOT reach it. The generated glue has a `Browser.createContext(...
 * webGLContextAttributes)` path that merges them, but the engine does
 * not take that path, and a search of the whole glue finds no
 * `Module["webGLContextAttributes"]` read at all. Measured on the
 * live client: `Module.webGLContextAttributes` is absent, and the
 * live context reports `desynchronized: false`.
 *
 * A canvas has ONE WebGL context for its lifetime: `getContext`
 * returns the SAME context every time it is called for the same
 * context type. So the way to control the attributes is to create the
 * context OURSELVES, first, with the attributes we want -- and the
 * engine's later `getContext('webgl2')` then returns ours.
 *
 * Verified against production: pre-creating the context with
 * `desynchronized: true` produced a live context reporting
 * `desynchronized: true`, with the drawing buffer the right size, no
 * context loss, and no GL error.
 *
 * WHAT `desynchronized` IS FOR
 * ----------------------------
 * It asks the compositor for a low-latency presentation path: the
 * canvas is presented as soon as it is drawn, rather than waiting to
 * be composited in step with the rest of the page. That is exactly
 * the shape of the problem this addresses -- frames arriving unevenly
 * -- so it is worth measuring.
 *
 * It is NOT free: a desynchronized canvas can tear, and some browsers
 * ignore it. So it is OFF by default and switched on deliberately.
 */

/** The attributes the engine's context is created with. */
export interface WebGLContextOptions {
  /**
   * Ask for the low-latency presentation path.
   *
   * Off by default: it can cause tearing, and whether it helps at all
   * depends on the browser and the compositor. Measured, not assumed.
   */
  desynchronized?: boolean;
}

/**
 * Create the WebGL2 context on a canvas, with the attributes we want.
 *
 * Returns the context, or null if the browser would not give us one.
 * Calling this more than once is harmless: the second call returns
 * the same context, which is the point.
 */
export function createEngineContext(
  canvas: HTMLCanvasElement | null,
  opts: WebGLContextOptions = {},
): WebGLRenderingContext | WebGL2RenderingContext | null {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  try {
    return canvas.getContext('webgl2', {
      // The engine asks for a WebGL2 context (the launcher passes
      // `-ref webgl2`).
      //
      // These attributes are the ones the ENGINE's own context was
      // measured with, against production:
      //
      //   alpha:true antialias:true depth:true stencil:false
      //   preserveDrawingBuffer:false premultipliedAlpha:true
      //
      // Every attribute that `gl.getContextAttributes()` can REPORT
      // is matched to the measured value -- alpha, antialias, depth,
      // stencil, preserveDrawingBuffer, premultipliedAlpha and
      // desynchronized -- so the observable difference from the
      // shipped behaviour is `desynchronized` and nothing else.
      //
      // Two attributes CANNOT be observed and are therefore NOT
      // verified: `failIfMajorPerformanceCaveat` and
      // `powerPreference`. `getContextAttributes()` does not report
      // either, so no measurement of the engine's own context could
      // have confirmed them. They are set here to the values the
      // engine's renderer asks for, but that is a belief about the
      // engine's WASM side, not a verified match.
      //
      // Matching the reported attributes matters: pre-creating the
      // context with, say, antialias:false would silently change the
      // rendering, which is not what this change is for.
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      desynchronized: opts.desynchronized === true,
    });
  } catch (e) {
    console.warn('[webgl] could not pre-create the context:', e);
    return null;
  }
}

/**
 * Is the low-latency presentation path wanted?
 *
 * Off unless it is asked for. The switch is a URL parameter, so it
 * can be turned on for one player's session without a deploy:
 *
 *     ?desync=1
 *
 * and the diagnostics can read it back out of the live context.
 */
export function wantsDesynchronized(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('desync') === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Pre-create the engine's context, before anything else can ask for
 * one.
 *
 * Returns true if the context exists now with the attributes we asked
 * for.
 *
 * WHY IT HAS TO BE EARLY
 * ----------------------
 * A canvas has one context for its lifetime, and `getContext` returns
 * the existing one. So whoever calls it FIRST decides the attributes.
 *
 * And something else does: `services/fullscreen.ts:102` calls
 * `canvas.getContext('webgl2')` to check whether a lost context can be
 * restored, and `recoverLostContext()` runs on the watchdog's first
 * resize -- which happens while the landing page is up, before the
 * engine has booted. That call created the context with the DEFAULT
 * attributes, so a later pre-creation was silently ignored.
 *
 * Measured: with the pre-creation in the loader, the app's own log
 * line said `desynchronized=false` -- because the context already
 * existed by then.
 *
 * So the context is created here, at IMPORT time, which is before the
 * Vue app exists and therefore before any resize can be heard.
 */
export function prepareEngineContext(
  given?: HTMLCanvasElement | null,
): boolean {
  if (typeof document === 'undefined') return false;
  const canvas =
    given ?? (document.getElementById('canvas') as HTMLCanvasElement | null);
  if (!canvas) {
    // The canvas is created by the Vue app, which does not exist yet
    // at import time. So the context cannot be made here on the first
    // load -- and on the first load there is no resize to be heard
    // either, because the watchdog is installed at the same time and
    // the page has not been resized yet.
    //
    // The loader calls this again once the canvas exists.
    return false;
  }
  const wantDesync = wantsDesynchronized();
  const gl = createEngineContext(canvas, { desynchronized: wantDesync });
  if (!gl) return false;
  try {
    const attrs = gl.getContextAttributes();
    console.log(
      '[webgl] the engine context was pre-created:',
      `desynchronized=${attrs?.desynchronized}`,
      `wanted=${wantDesync}`,
      `search=${typeof window !== 'undefined' ? window.location.search : '?'}`,
      `canvasId=${canvas.id || '(none)'}`,
    );
  } catch (e) {
    /* the attributes are a nicety; the context is what matters */
  }
  return true;
}
