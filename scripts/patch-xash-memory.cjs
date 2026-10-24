#!/usr/bin/env node
/**
 * Patch the xash3d-fwgs wasm's MEMORY SECTION: raise the initial memory.
 *
 * WHY
 * ---
 * The client aborts with `RuntimeError: Aborted(OOM)` a few hundred
 * milliseconds after a map change. The wasm's memory section declares:
 *
 *     initial = 4096 pages = 256 MB
 *     maximum = 32768 pages = 2 GB
 *
 * The heap does not grow before the abort, and the abort is Emscripten's
 * `abortOOM` — which is what `emscripten_resize_heap` calls when
 * `WebAssembly.Memory.grow()` FAILS. So the client wants more than the
 * 256 MB it starts with, and the growth is being refused.
 *
 * Raising the INITIAL memory means the map change never has to grow at
 * all: the space is there from the start.
 *
 * THE PATCH
 * ---------
 * The memory section's limits are LEB128, and both new values encode to
 * the same number of bytes as the old ones:
 *
 *     min: 4096  -> 8192    0x80 0x20     -> 0x80 0x40          2 bytes, 2 bytes
 *     max: 32768 -> 65536   0x80 0x80 0x02 -> 0x80 0x80 0x04    3 bytes, 3 bytes
 *
 * So the bytes are replaced in place: no section resizing, no
 * relocation, the module stays valid.
 *
 * MEASURED
 * --------
 * With the patched wasm the client survived map changes that had been
 * aborting it: the heap starts at 512 MB, stays there, and the engine
 * keeps playing (canvas alive, server banner received on every map).
 *
 *   usage: node scripts/patch-xash-memory.cjs [wasmPath] [initialMB] [maximumMB]
 */
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.resolve(
  process.argv[2] || 'node_modules/xash3d-fwgs/dist/xash.wasm'
);
const INITIAL_MB = Number(process.argv[3] || 512);
const MAXIMUM_MB = Number(process.argv[4] || 4096);

/** LEB128 decode: returns [value, nextOffset]. */
function lebDecode(buf, i) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result >>> 0, i];
    shift += 7;
  }
}

/** LEB128 encode, padded to exactly `width` bytes. */
function lebFixed(value, width) {
  const out = Buffer.alloc(width);
  let v = value >>> 0;
  for (let i = 0; i < width; i++) {
    let byte = v & 0x7f;
    v >>>= 7;
    if (i !== width - 1) byte |= 0x80;
    out[i] = byte;
  }
  return out;
}

function patch() {
  if (!fs.existsSync(TARGET)) {
    console.log(`[patch-xash-memory] ${TARGET} not found; skipping.`);
    return;
  }
  const buf = fs.readFileSync(TARGET);
  if (buf.readUInt32LE(0) !== 0x6d736100) {
    console.log('[patch-xash-memory] not a wasm module; skipping.');
    return;
  }
  const newMin = (INITIAL_MB * 1024) / 64;
  const newMax = (MAXIMUM_MB * 1024) / 64;

  let i = 8;
  while (i < buf.length) {
    const sectionId = buf[i++];
    const [size, afterSize] = lebDecode(buf, i);
    const end = afterSize + size;
    if (sectionId === 5) {
      // memory section
      let j = afterSize;
      let count;
      [count, j] = lebDecode(buf, j);
      for (let m = 0; m < count; m++) {
        const flags = buf[j++];
        let minPages, afterMin;
        [minPages, afterMin] = lebDecode(buf, j);
        const minWidth = afterMin - j;
        j = afterMin;
        let maxPages = null, afterMax = j, maxWidth = 0;
        if (flags & 1) {
          [maxPages, afterMax] = lebDecode(buf, j);
          maxWidth = afterMax - j;
          j = afterMax;
        }
        console.log(
          `[patch-xash-memory] memory: flags=${flags} min=${minPages} ` +
            `(${(minPages * 64) / 1024}MB)` +
            (maxPages !== null
              ? ` max=${maxPages} (${(maxPages * 64) / 1024 / 1024}GB)`
              : '')
        );
        if (!(flags & 1)) {
          console.log('[patch-xash-memory] no maximum declared; cannot patch in place.');
          return;
        }
        if (minPages === newMin && maxPages === newMax) {
          console.log('[patch-xash-memory] already patched.');
          return;
        }
        const minBytes = lebFixed(newMin, minWidth);
        const maxBytes = lebFixed(newMax, maxWidth);
        if (minBytes.length !== minWidth || maxBytes.length !== maxWidth) {
          console.error(
            `[patch-xash-memory] ERROR: the new values do not fit the old ` +
              `encoding widths (${minWidth}/${maxWidth} bytes).`
          );
          process.exitCode = 1;
          return;
        }
        minBytes.copy(buf, afterMin - minWidth);
        maxBytes.copy(buf, afterMax - maxWidth);
        fs.writeFileSync(TARGET, buf);
        console.log(
          `[patch-xash-memory] patched: min=${newMin} (${INITIAL_MB}MB) ` +
            `max=${newMax} (${MAXIMUM_MB}MB)`
        );
        return;
      }
    }
    i = end;
  }
  console.log('[patch-xash-memory] no memory section found.');
}

try {
  patch();
} catch (err) {
  console.error(`[patch-xash-memory] ERROR: ${err.message}`);
  process.exitCode = 1;
}
