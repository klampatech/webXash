#!/usr/bin/env node
/**
 * The build must ship the PATCHED glue.
 *
 * WHY
 * ---
 * A wasm patch once shipped broken: the page booted, the game
 * downloaded, and then the client died with a CompileError — while
 * the deploy's browser check stayed green, because it only looked at
 * HTTP responses. That reached production, and it is why
 * `check-xash-wasm.cjs` exists.
 *
 * The glue patch has the same shape of risk and a quieter failure:
 * if the patched glue does not make it into the bundle, the game is
 * not broken — it is just SLOW, by 52% of a frame, forever, with
 * nothing in the logs to say so.
 *
 * There are two ways that happens, and both are real:
 *
 *   1. VITE'S DEPENDENCY CACHE. Vite pre-bundles `xash3d-fwgs` into
 *      `node_modules/.vite/deps/` and serves that copy, not the file
 *      on disk. A patch applied to the file on disk does not reach
 *      the build until the cache is dropped. Measured 2026-11-07: the
 *      first build after patching shipped the unpatched glue, because
 *      the cache was three weeks old.
 *
 *   2. THE PATCH DID NOT APPLY. The patch script fails loudly, but a
 *      build run against a `node_modules` that was never patched (a
 *      cache restored from elsewhere, a `--ignore-scripts` install)
 *      has no idea the glue is supposed to be patched.
 *
 * So the check runs at the END of the build, against the bundle that
 * was actually produced, and fails the build if the patch is missing.
 *
 * WHAT IT CHECKS
 * --------------
 * The `gldebug=1` string, which only the patch introduces. A comment
 * would not do — the minifier strips comments — but a string literal
 * survives.
 *
 *   usage: node scripts/check-xash-glue.cjs [distDir]
 */
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.resolve(process.argv[2] || 'dist');

/** The string the patch introduces, and only the patch introduces. */
const MARKER = 'gldebug=1';

async function main() {
  const assets = path.join(DIST, 'assets');
  if (!fs.existsSync(assets)) {
    console.error(`[check-xash-glue] ${assets} does not exist`);
    process.exitCode = 1;
    return;
  }

  const files = fs
    .readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(assets, f));

  if (files.length === 0) {
    console.error('[check-xash-glue] no javascript in the build output');
    process.exitCode = 1;
    return;
  }

  // The glue is the biggest bundle in the build — it is the engine's
  // Emscripten output. Find the file that holds it rather than
  // assuming a name, because the name is hashed and changes with
  // every release.
  let patched = null;
  const glue = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes('glGetError')) glue.push(file);
    if (src.includes(MARKER)) patched = file;
  }

  if (glue.length === 0) {
    console.error(
      '[check-xash-glue] ERROR: no bundle contains the engine glue. ' +
        'The build is missing the engine — that is a different problem, ' +
        'but this check cannot confirm the patch either.'
    );
    process.exitCode = 1;
    return;
  }

  if (!patched) {
    console.error(
      `[check-xash-glue] ERROR: the built engine glue is NOT patched.\n` +
        `[check-xash-glue] The bundle in ${glue.map((f) => path.basename(f)).join(', ')} ` +
        'still has the engine calling glGetError() about ten times a frame, ' +
        'which is a GPU round-trip each time — measured at 52% of the engine frame.\n' +
        '[check-xash-glue] Run `node scripts/patch-xash-gl-geterror.cjs` and build again. ' +
        'If you have just patched it, your Vite dependency cache is stale: ' +
        'the patch script drops `node_modules/.vite` for exactly this reason.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[check-xash-glue] ${path.basename(patched)}: the engine glue is patched ` +
      '— the per-frame glGetError round-trip is rate-limited.'
  );
}

main().catch((err) => {
  console.error(`[check-xash-glue] ERROR: ${err.message}`);
  process.exitCode = 1;
});
