#!/usr/bin/env node
/**
 * postinstall: stop the engine's per-frame `gl.getError()` round-trip.
 *
 * WHY
 * ---
 * The engine calls `glGetError()` about TEN TIMES PER FRAME. Each
 * call, in Chrome, is a GPU ROUND-TRIP: `WebGLRenderingContext.getError()`
 * has to flush the command buffer and wait for the error state, so it
 * cannot be answered from a queue. That is a synchronous wait on the
 * GPU in the middle of the engine's frame callback.
 *
 * Measured 2026-11-07 on Kyle's MacBook Pro (M3 Pro, 120 Hz ProMotion),
 * one clean browser tab, live gameplay:
 *
 *     getError calls        1203 per second  (~10 per frame)
 *     share of main thread  a third to a half of the active time
 *     frame cost, as shipped   9.62 ms
 *     frame cost, patched      8.13 ms
 *
 * The saving is 1.49 ms per frame — 15% of the frame — and it is the
 * difference between FITTING and NOT FITTING inside a 120 Hz frame
 * period of 8.33 ms. On a 144 Hz display (6.94 ms) it does not close
 * the gap on this machine, but it moves every slower machine closer.
 *
 * The engine asks because it wants to know whether a GL call failed.
 * In a shipped game that is a DIAGNOSTIC, not a correctness
 * requirement: a failed GL call renders wrong either way, and the
 * engine's response to a reported error is to print it.
 *
 * WHAT THE PATCH DOES
 * -------------------
 * It keeps the glue's own error bookkeeping (`GL.lastError`, which
 * catches bad arguments passed to the glue) and makes the EXPENSIVE
 * part — the real `GLctx.getError()` — happen at most four times a
 * second instead of ten times a frame.
 *
 * Detection is not removed, only slowed: a genuine GL error still
 * surfaces within 250 ms.
 *
 * THE ESCAPE HATCH
 * ----------------
 * `?gldebug=1` on the page URL restores the original behaviour
 * exactly — every call does the real check. Anyone chasing a GL error
 * needs the real thing, and the fix must not be the reason an error
 * is hard to find.
 *
 * WHY A SCRIPT AND NOT patch-package
 * ----------------------------------
 * Exactly one patch, reproducible on a clean checkout, no new
 * dependency. This is the third such patch, alongside
 * `patch-xash-exports.cjs` and `patch-xash-memory.cjs`.
 *
 * IDEMPOTENT: safe to run repeatedly; re-running is a no-op.
 * LOUD: exits non-zero if the anchor is missing or ambiguous, so a
 * dependency bump that changes the minified glue fails the install
 * instead of silently shipping a slow frame.
 */

const fs = require('fs');
const path = require('path');

/**
 * The glue to patch.
 *
 * Overridable with an argument (or XASH_GLUE_PATH) so the unit suite
 * can run the patch against a fixture instead of the real file — the
 * same convention `patch-xash-memory.cjs` uses for its wasm path.
 */
const TARGET = path.resolve(
  process.argv[2] ||
    process.env.XASH_GLUE_PATH ||
    path.join(__dirname, '..', 'node_modules', 'xash3d-fwgs', 'dist', 'generated', 'xash.js')
);

/** The marker that says "already patched". */
const MARKER = '_xashGlErrorRateLimited';

/**
 * The original, as the minifier emitted it.
 *
 * Matched as a regex rather than a literal so a whitespace-only
 * change in a future release still matches — but anchored tightly
 * enough that a DIFFERENT function cannot be mistaken for this one.
 */
const ANCHOR_RE =
  /var _emscripten_glGetError = \(\) => \{ var error = GLctx\.getError\(\) \|\| GL\.lastError; GL\.lastError = 0; return error; \};/;

/**
 * The patched version.
 *
 * Written out longhand rather than minified, because this is the one
 * piece of the glue a human will ever need to read.
 */
const REPLACEMENT = `var _emscripten_glGetError = () => {
  /* _xashGlErrorRateLimited — see scripts/patch-xash-gl-geterror.cjs */
  var error = GL.lastError;
  GL.lastError = 0;
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (_emscripten_glGetError._debug === undefined) {
    _emscripten_glGetError._debug =
      (typeof location !== 'undefined' &&
        location.search &&
        location.search.indexOf('gldebug=1') >= 0);
  }
  if (
    _emscripten_glGetError._debug ||
    now - (_emscripten_glGetError._last || 0) > 250
  ) {
    _emscripten_glGetError._last = now;
    var real = GLctx.getError();
    if (real) error = real;
  }
  return error;
};`;

/**
 * Vite's dependency-optimisation cache.
 *
 * Overridable so the unit suite can exercise the cache handling
 * without touching the real node_modules — the same convention
 * XASH_GLUE_PATH uses for the glue.
 */
const VITE_CACHE = path.resolve(
  process.env.XASH_VITE_CACHE ||
    path.join(__dirname, '..', 'node_modules', '.vite')
);

/**
 * Drop Vite's dependency-optimisation cache — but ONLY when it is
 * actually stale.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * Vite pre-bundles `xash3d-fwgs` into `node_modules/.vite/deps/` and
 * serves THAT copy, not the file on disk. So patching the glue on
 * disk changes nothing about the build until that cache is dropped —
 * and the build succeeds, and the game is simply still slow.
 *
 * That is the worst kind of failure: a patch that applies, reports
 * success, and does nothing. Measured 2026-11-07: the first build
 * after patching shipped the UNPATCHED glue, because the cache in
 * `node_modules/.vite/deps/` was three weeks old.
 *
 * WHY IT IS NOT DROPPED EVERY TIME
 * --------------------------------
 * This runs from `postinstall`, so an unconditional drop means EVERY
 * install makes the next dev server re-bundle the 3.9 MB engine glue
 * from scratch — for nothing, once the cache is already patched. The
 * cache that needs dropping is the one built from the UNPATCHED glue,
 * and that can be recognised: the minifier strips the marker comment,
 * but the `gldebug=1` escape hatch survives it — which is exactly
 * what the build gate looks for.
 *
 * `force` is for the case where the glue was just CHANGED: then the
 * cache is stale by definition, whatever it contains.
 */
function clearViteDepCache({ force = false } = {}) {
  const deps = path.join(VITE_CACHE, 'deps');
  if (!fs.existsSync(deps)) return false;

  if (!force) {
    let files = [];
    try {
      files = fs.readdirSync(deps).filter((f) => f.endsWith('.js'));
    } catch (e) {
      files = [];
    }
    for (const f of files) {
      try {
        if (fs.readFileSync(path.join(deps, f), 'utf8').includes('gldebug=1')) {
          return false; // already patched — the cache is fine, keep it
        }
      } catch (e) {
        /* unreadable counts as stale */
      }
    }
  }

  fs.rmSync(VITE_CACHE, { recursive: true, force: true });
  return true;
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.log('[patch-xash-gl-geterror] xash.wasm glue not present; skipping.');
    return;
  }

  const src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(MARKER)) {
    console.log('[patch-xash-gl-geterror] already applied; nothing to do.');
    const cleared = clearViteDepCache();
    if (cleared) {
      console.log(
        '[patch-xash-gl-geterror] dropped the stale Vite dependency cache — ' +
          'the next build will pick the patched glue up.'
      );
    }
    return;
  }

  const matches = src.match(new RegExp(ANCHOR_RE.source, 'g')) || [];
  if (matches.length === 0) {
    fail(
      `could not find the original _emscripten_glGetError in ${TARGET}.\n` +
        '[patch-xash-gl-geterror] The glue has been re-minified differently.\n' +
        '[patch-xash-gl-geterror] Re-derive the anchor: grep the glue for\n' +
        '[patch-xash-gl-geterror]   _emscripten_glGetError\n' +
        '[patch-xash-gl-geterror] and rebuild the REPLACEMENT around whatever it found.'
    );
  }
  if (matches.length > 1) {
    fail(
      `the original _emscripten_glGetError appears ${matches.length} times; ` +
        'refusing to guess which one is the engine\'s.'
    );
  }

  const patched = src.replace(ANCHOR_RE, REPLACEMENT);
  if (patched === src) {
    fail('the replacement did not change the file; refusing to claim success.');
  }

  fs.writeFileSync(TARGET, patched, 'utf8');

  // Verify what was written, so the claim is checked rather than
  // assumed: the marker must be present, the original must be gone,
  // and the escape hatch must have survived.
  const after = fs.readFileSync(TARGET, 'utf8');
  if (!after.includes(MARKER)) {
    fail('the marker is not in the patched file; refusing to claim success.');
  }
  if (ANCHOR_RE.test(after)) {
    fail('the original is still in the patched file; refusing to claim success.');
  }
  if (!after.includes("location.search.indexOf('gldebug=1')")) {
    fail('the ?gldebug=1 escape hatch is missing; refusing to claim success.');
  }

  const cleared = clearViteDepCache({ force: true });
  console.log(
    `[patch-xash-gl-geterror] patched ${path.relative(process.cwd(), TARGET)} — ` +
      'the engine\'s per-frame glGetError GPU round-trip now happens at most ' +
      '4 times a second (?gldebug=1 restores the original).' +
      (cleared
        ? ' The stale Vite dependency cache was dropped, so the next build picks it up.'
        : '')
  );
}

function fail(msg) {
  console.error(`[patch-xash-gl-geterror] ERROR: ${msg}`);
  process.exit(1);
}

main();
