#!/usr/bin/env node
/**
 * Patch the xash3d-fwgs wasm's MEMORY SECTION: raise the initial memory.
 *
 * WHY
 * ---
 * The published xash3d-fwgs 1.2.2 wasm declares:
 *
 *     initial = 4096 pages = 256 MB
 *     maximum = 4096 pages = 256 MB
 *
 * The maximum EQUALS the initial: **the client's heap cannot grow at
 * all.** When a map change needs more room, `WebAssembly.Memory.grow()`
 * fails, Emscripten's `emscripten_resize_heap` calls `abortOOM`, and the
 * engine dies with `RuntimeError: Aborted(OOM)` — a few hundred
 * milliseconds after the map change, with the page still showing the last
 * frame. The player is left in a frozen world with no error.
 *
 * It was intermittent because how much the client needs depends on the
 * map and the entity state.
 *
 * THE FIX
 * -------
 * Give it room: a 512 MB initial heap and a 2 GB maximum. The initial
 * is what matters — with the space present from the start, the map
 * change never has to grow at all.
 *
 * THE PATCH IS A REBUILD, NOT AN IN-PLACE WRITE
 * ----------------------------------------------
 * The limits are LEB128, and their ENCODED WIDTHS differ between the
 * published module and the target:
 *
 *     min: 4096  -> 8192    0x80 0x20  -> 0x80 0x40        2 bytes, 2 bytes
 *     max: 4096  -> 32768   0x80 0x20  -> 0x80 0x80 0x02   2 bytes, 3 bytes
 *
 * The new maximum needs ONE MORE BYTE than the old one, so the memory
 * section is rebuilt and re-emitted with its new length. Everything
 * before and after it is copied verbatim: the wasm format stores no
 * absolute file offsets (the data section's segment offsets are relative
 * to the data section), so inserting a byte here is safe.
 *
 * Writing the new maximum into the old 2-byte slot would silently
 * truncate it — 65536 does not fit in two LEB bytes — and produce a
 * module that fails validation ("maximum memory size (0 pages) is less
 * than initial"). That is exactly the bug this script is written to
 * avoid, so the script COMPILES THE RESULT and fails loudly if it does
 * not validate.
 *
 *   usage: node scripts/patch-xash-memory.cjs [wasmPath] [initialMB] [maximumMB]
 */
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.resolve(
  process.argv[2] || 'node_modules/xash3d-fwgs/dist/xash.wasm'
);
const INITIAL_MB = Number(process.argv[3] || 512);
const MAXIMUM_MB = Number(process.argv[4] || 2048);

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

/** LEB128 encode, minimal width. */
function lebEncode(value) {
  const out = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

/** The limits of a wasm's memory section, for verification. */
function readLimits(buf) {
  let i = 8;
  while (i < buf.length) {
    const sectionId = buf[i++];
    const [size, afterSize] = lebDecode(buf, i);
    const contentStart = afterSize;
    const contentEnd = contentStart + size;
    if (sectionId === 5) {
      let j = contentStart;
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

/**
 * Rewrite the memory section's limits, rebuilding the section when the
 * new encoding is a different width. Returns the new file bytes, or
 * null when it is already patched.
 */
function patchBuffer(buf, newMin, newMax) {
  let i = 8; // skip the magic + version
  while (i < buf.length) {
    const sectionStart = i;
    const sectionId = buf[i++];
    const [size, afterSize] = lebDecode(buf, i);
    const contentStart = afterSize;
    const contentEnd = contentStart + size;

    if (sectionId === 5) {
      let j = contentStart;
      let count;
      [count, j] = lebDecode(buf, j);
      const parts = [];
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
        console.log(
          `[patch-xash-memory] memory: flags=${flags} min=${minPages} ` +
            `(${(minPages * 64) / 1024}MB)` +
            (maxPages !== null
              ? ` max=${maxPages} (${(maxPages * 64) / 1024 / 1024}GB)`
              : '')
        );
        if (!(flags & 1)) {
          throw new Error(
            'the memory declares no maximum; it cannot be patched to allow growth'
          );
        }
        if (minPages === newMin && maxPages === newMax) {
          console.log('[patch-xash-memory] already patched.');
          return null;
        }
        parts.push(Buffer.from([flags]));
        parts.push(lebEncode(newMin));
        parts.push(lebEncode(newMax));
      }
      const newContent = Buffer.concat([lebEncode(count), ...parts]);
      const headerAndId = Buffer.concat([
        Buffer.from([sectionId]),
        lebEncode(newContent.length),
      ]);
      return Buffer.concat([
        buf.subarray(0, sectionStart),
        headerAndId,
        newContent,
        buf.subarray(contentEnd),
      ]);
    }
    i = contentEnd;
  }
  throw new Error('no memory section found');
}

async function main() {
  if (!fs.existsSync(TARGET)) {
    console.log(`[patch-xash-memory] ${TARGET} not found; skipping.`);
    return;
  }
  const original = fs.readFileSync(TARGET);
  if (original.readUInt32LE(0) !== 0x6d736100) {
    console.log('[patch-xash-memory] not a wasm module; skipping.');
    return;
  }
  const newMin = (INITIAL_MB * 1024) / 64;
  const newMax = (MAXIMUM_MB * 1024) / 64;

  const patched = patchBuffer(original, newMin, newMax);
  if (!patched) return; // already patched

  // VERIFY. A wasm that does not validate is worse than no patch at
  // all: the client cannot start. So the result must compile, and its
  // limits must be what we asked for.
  try {
    await WebAssembly.compile(patched);
  } catch (err) {
    console.error(
      `[patch-xash-memory] ERROR: the patched module does not compile: ${err.message}`
    );
    process.exitCode = 1;
    return;
  }
  const limits = readLimits(patched);
  const limit = limits && limits[0];
  if (!limit || limit.minPages !== newMin || limit.maxPages !== newMax) {
    console.error(
      `[patch-xash-memory] ERROR: the patched module has the wrong limits: ` +
        JSON.stringify(limit)
    );
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(TARGET, patched);
  console.log(
    `[patch-xash-memory] patched: min=${newMin} (${INITIAL_MB}MB) ` +
      `max=${newMax} (${MAXIMUM_MB}MB) — the module compiles`
  );
}

main().catch((err) => {
  console.error(`[patch-xash-memory] ERROR: ${err.message}`);
  process.exitCode = 1;
});
