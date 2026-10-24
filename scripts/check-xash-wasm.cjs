#!/usr/bin/env node
/**
 * The build must not ship a wasm the client cannot start.
 *
 * WHY
 * ---
 * A memory-section patch once wrote a new maximum into a two-byte LEB
 * slot where the value needed three bytes. It was silently truncated to
 * zero, and the module failed validation:
 *
 *     maximum memory size (0 pages) is less than initial (8192 pages)
 *
 * The page still booted, downloaded the game, and then died with a
 * CompileError — so the deploy's browser check (which looks at HTTP
 * responses) was green while the game was unplayable. That reached
 * production.
 *
 * So this check runs at the END of the build: it compiles the wasm that
 * was actually bundled and asserts the heap limits the engine needs.
 * A broken wasm fails the build, which fails the deploy, which never
 * reaches production.
 *
 *   usage: node scripts/check-xash-wasm.cjs [distDir]
 */
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.resolve(process.argv[2] || 'dist');
const EXPECTED_MIN_PAGES = 8192; // 512 MB
const EXPECTED_MAX_PAGES = 32768; // 2 GB

/** LEB128 decode: returns [value, nextOffset]. */
function lebDecode(buf, i) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [result, i];
    shift += 7;
  }
}

/** The limits of a wasm's memory section. */
function readLimits(buf) {
  let i = 8;
  while (i < buf.length) {
    const sectionId = buf[i++];
    const [size, afterSize] = lebDecode(buf, i);
    const contentEnd = afterSize + size;
    if (sectionId === 5) {
      let j = afterSize;
      let count;
      [count, j] = lebDecode(buf, j);
      const limits = [];
      for (let m = 0; m < count; m++) {
        const flags = buf[j++];
        let minPages, afterMin;
        [minPages, afterMin] = lebDecode(buf, j);
        j = afterMin;
        let maxPages = null, afterMax = j;
        if (flags & 1) {
          [maxPages, afterMax] = lebDecode(buf, j);
          j = afterMax;
        }
        limits.push({ flags, minPages, maxPages });
      }
      return limits;
    }
    i = contentEnd;
  }
  return null;
}

async function main() {
  const assets = path.join(DIST, 'assets');
  if (!fs.existsSync(assets)) {
    console.error(`[check-xash-wasm] ${assets} does not exist`);
    process.exitCode = 1;
    return;
  }
  const wasms = fs
    .readdirSync(assets)
    .filter((f) => f.endsWith('.wasm'))
    .map((f) => path.join(assets, f));
  if (wasms.length === 0) {
    console.error('[check-xash-wasm] no wasm in the build output');
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const file of wasms) {
    const buf = fs.readFileSync(file);
    try {
      await WebAssembly.compile(buf);
    } catch (err) {
      console.error(
        `[check-xash-wasm] ERROR: ${path.basename(file)} does not compile: ` +
          err.message
      );
      failed = true;
      continue;
    }
    const limits = readLimits(buf);
    const limit = limits && limits[0];
    const mb = (pages) => (pages * 64) / 1024;
    // The engine's support modules (the filesystem, the menu library,
    // the renderer) have no memory section of their own — they live in
    // the main module's memory. Only the engine itself carries the heap
    // limits, and only the engine's limits are worth asserting.
    const isEngine = /^xash-.*\.wasm$/.test(path.basename(file));
    if (!limit) {
      if (isEngine) {
        console.error(
          `[check-xash-wasm] ERROR: ${path.basename(file)} has no memory section`
        );
        failed = true;
      } else {
        console.log(
          `[check-xash-wasm] ${path.basename(file)}: compiles; no heap of its own`
        );
      }
      continue;
    }
    console.log(
      `[check-xash-wasm] ${path.basename(file)}: compiles; heap ` +
        `${mb(limit.minPages)}MB initial, ` +
        `${mb(limit.maxPages)}MB maximum`
    );
    if (
      isEngine &&
      (limit.minPages !== EXPECTED_MIN_PAGES ||
        limit.maxPages !== EXPECTED_MAX_PAGES)
    ) {
      console.error(
        `[check-xash-wasm] ERROR: expected ${mb(EXPECTED_MIN_PAGES)}MB initial ` +
          `and ${mb(EXPECTED_MAX_PAGES)}MB maximum, got ` +
          `${mb(limit.minPages)}MB and ${mb(limit.maxPages)}MB. ` +
          `The client's heap cannot grow — check scripts/patch-xash-memory.cjs.`
      );
      failed = true;
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log('[check-xash-wasm] the bundled engine will start.');
}

main().catch((err) => {
  console.error(`[check-xash-wasm] ERROR: ${err.message}`);
  process.exitCode = 1;
});
