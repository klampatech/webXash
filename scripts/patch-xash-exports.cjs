#!/usr/bin/env node
/**
 * postinstall: expose the engine's raw WASM export table to JS.
 *
 * WHY
 * ---
 * The Xash3D-FWGS WASM build's SDL *keyboard* input is dead: Emscripten
 * registers a `keydown` listener, but it never fires, so no key ever
 * reaches the engine. Mouse works. Proof: bind F9 to `echo …`, press a
 * real F9, nothing prints. (See Obsidian
 * projects/specialists-browser-rust-port.md, "Known issue #1".)
 *
 * That is fatal for TS: the loadout/team menu lives in the client DLL's
 * `HUD_Key_Event`, which is only reachable via
 *   Platform_RunEvents -> SDL_PollEvent -> SDLash_KeyEvent -> Key_Event -> HUD_Key_Event
 * so the player can never dismiss the menu or leave spectator.
 *
 * THE FIX (src/services/sdl-key-inject.ts)
 * ---------------------------------------
 * The engine already exports `SDL_PushEvent`. It is just not reachable
 * from JS, because the Emscripten glue's `assignWasmExports()` copies
 * only a small hand-picked set onto `Module`. So we stash the whole
 * table on `Module.__rawExports`, and `sdl-key-inject.ts` pushes a
 * synthetic `SDL_KeyboardEvent` into SDL's own queue. From there the
 * engine handles it exactly as it would a native keypress —
 * `SDLash_KeyEvent` reads `key.keysym.scancode` and uses it *directly*
 * as the engine keynum.
 *
 * WHY A SCRIPT AND NOT patch-package
 * ----------------------------------
 * Exactly one patch, and it must be reproducible on a clean checkout.
 * `patch-package` would add a dependency (and its postinstall runs
 * before this file could be applied). This is smaller and auditable.
 *
 * IDEMPOTENT: safe to run repeatedly; re-running is a no-op.
 * LOUD: exits non-zero if the anchor is missing or ambiguous, so a
 * dependency bump that changes the minified glue fails the install
 * instead of silently shipping a dead keyboard.
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  'xash3d-fwgs',
  'dist',
  'generated',
  'xash.js'
);

const MARKER = 'Module.__rawExports=wasmExports';

/**
 * Anchor: the first statement of assignWasmExports' body. We insert our
 * one-liner immediately before it, so we do not have to find (and
 * survive minifier re-flowing) the end of the function.
 */
const ANCHOR = 'function assignWasmExports(wasmExports) {';

function main() {
  if (!fs.existsSync(TARGET)) {
    // Dependency not installed yet (e.g. postinstall ordering, or a
    // production install with --omit=dev). Nothing to patch; the guard
    // in sdl-key-inject.ts will surface the problem at runtime.
    console.log('[patch-xash-exports] xash.wasm glue not present; skipping.');
    return;
  }

  const src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(MARKER)) {
    console.log('[patch-xash-exports] already applied; nothing to do.');
    return;
  }

  const first = src.indexOf(ANCHOR);
  if (first === -1) {
    fail(`could not find ${JSON.stringify(ANCHOR)} in ${TARGET}.`);
  }
  if (src.indexOf(ANCHOR, first + 1) !== -1) {
    fail(
      `${JSON.stringify(ANCHOR)} is ambiguous (appears more than once); ` +
        'refusing to guess. Re-derive the anchor against the new ' +
        'xash3d-fwgs version.'
    );
  }

  const insertAt = first + ANCHOR.length;
  const patched =
    src.slice(0, insertAt) + MARKER + ';' + src.slice(insertAt);

  fs.writeFileSync(TARGET, patched, 'utf8');
  console.log(
    `[patch-xash-exports] patched ${path.relative(process.cwd(), TARGET)} ` +
      '— engine WASM export table now reachable as Module.__rawExports.'
  );
}

function fail(msg) {
  console.error(`[patch-xash-exports] ERROR: ${msg}`);
  console.error(
    '[patch-xash-exports] This is expected when xash3d-fwgs is upgraded ' +
      'to a version whose minified glue differs.\n' +
      '[patch-xash-exports] See Obsidian ' +
      'projects/specialists-browser-rust-port.md -> "Route B" for the ' +
      'current anchor and a template for re-deriving it.'
  );
  process.exit(1);
}

main();