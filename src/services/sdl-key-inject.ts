// Inject real key events into the engine's SDL event queue.
//
// WHY THIS EXISTS
// ---------------
// The Xash3D-FWGS WASM build's SDL *keyboard* input is dead. Emscripten
// registers a `keydown`/`keyup` listener via `registerKeyEventCallback`,
// but it never fires — so no keypress ever reaches the engine. Mouse is
// fine (mouse look tracks, crosshair moves).
//
// Proven in real Chrome: `bind F9 "echo SDLKEY_WORKS"`, then a trusted
// F9 keystroke produces zero engine output. The bind table itself is
// healthy (`bindlist` prints every default binding).
//
// That is fatal for The Specialists, because the loadout/team menu lives
// in the client DLL's `HUD_Key_Event`, reachable only via:
//
//   Platform_RunEvents -> SDL_PollEvent -> SDLash_KeyEvent
//                       -> Key_Event -> pfnKey_Event (HUD_Key_Event)
//
// With no keyboard events, the menu can never be dismissed and the
// player can never leave spectator.
//
// THE FIX
// -------
// The engine already exports `SDL_PushEvent` (verified: 7,978 func
// exports in xash.wasm) but the Emscripten glue never puts it on
// `Module`. `scripts/patch-xash-exports.cjs` stashes the raw table as
// `Module.__rawExports`; we push a synthetic SDL_KeyboardEvent into
// SDL's own queue from here.
//
// From there the engine treats it as a native keypress. Crucially
// `SDLash_KeyEvent` (host_sdl2.c:33-36) does:
//
//     int keynum = key.keysym.scancode;
//
// — it uses the scancode DIRECTLY as the engine keynum. There is no
// translation table to get wrong, which is why this is the structurally
// correct injection point rather than a shim above it.
//
// See Obsidian projects/specialists-browser-rust-port.md -> "Route B".

/** SDL_EventType values (SDL_events.h). */
const SDL_KEYDOWN = 0x300;
const SDL_KEYUP = 0x301;

/** SDL_ButtonState-ish state bytes for keyboard events. */
const SDL_PRESSED = 1;
const SDL_RELEASED = 0;

/**
 * Byte offsets inside `SDL_KeyboardEvent`, per emscripten's
 * SDL_events.h / SDL_keyboard.h:
 *
 *   typedef struct SDL_KeyboardEvent {
 *     Uint32 type;       // +0
 *     Uint32 windowID;   // +4
 *     Uint8  state;      // +8
 *     Uint8  repeat;     // +9
 *     Uint8  padding2;   // +10
 *     Uint8  padding3;   // +11
 *     SDL_Keysym keysym; // +12
 *   } SDL_KeyboardEvent;
 *
 * SDL_Keysym is { Sint32 scancode (+0); Sint32 sym (+4);
 * Uint16 mod (+8); Uint32 unicode (+12); } — so the engine-facing
 * scancode lands at absolute byte 12.
 *
 * sizeof(SDL_KeyboardEvent) is 28; we allocate 32 for alignment.
 */
const OFF_TYPE = 0;
const OFF_WINDOW_ID = 4;
const OFF_STATE = 8;
const OFF_REPEAT = 9;
const OFF_KEYSYM_SC0DE = 12;

/** Size we hand to _malloc for one event. */
const EVENT_BYTES = 32;

/**
 * `KeyboardEvent.code` -> SDL_Scancode (SDL_scancode.h).
 *
 * Only the keys we actually bind. SDL scancodes are a stable public
 * enum, and the engine consumes them directly as keynums.
 */
const SDL_SCANCODE: Record<string, number> = {
  // letters
  KeyA: 4, KeyB: 5, KeyC: 6, KeyD: 7, KeyE: 8, KeyF: 9,
  KeyG: 10, KeyH: 11, KeyI: 12, KeyJ: 13, KeyK: 14, KeyL: 15,
  KeyM: 16, KeyN: 17, KeyO: 18, KeyP: 19, KeyQ: 20, KeyR: 21,
  KeyS: 22, KeyT: 23, KeyU: 24, KeyV: 25, KeyW: 26, KeyX: 27,
  KeyY: 28, KeyZ: 29,
  // digits
  Digit1: 30, Digit2: 31, Digit3: 32, Digit4: 33, Digit5: 34,
  Digit6: 35, Digit7: 36, Digit8: 37, Digit9: 38, Digit0: 39,
  // control / editing
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
  // arrows
  ArrowLeft: 79, ArrowUp: 82, ArrowDown: 81, ArrowRight: 80,
  Insert: 86, Delete: 87, Home: 74, End: 77, PageUp: 75, PageDown: 78,
  // modifiers
  ShiftLeft: 225, ShiftRight: 226, ControlLeft: 224, ControlRight: 228,
  AltLeft: 227, AltRight: 230, CapsLock: 231,
  // punctuation
  Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 52,
  Comma: 54, Period: 55, Slash: 56,
  // function keys
  F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63,
  F7: 64, F8: 65, F9: 66, F10: 67, F11: 68, F12: 69,
};

/** Minimal shape of the Emscripten module we need. */
interface RawModule {
  __rawExports?: Record<string, (...a: unknown[]) => unknown>;
  /**
   * NOTE: the Emscripten glue keeps `HEAPU8` in a module-private closure,
   * so it is NOT reachable on `Module`. We re-derive a view from the
   * exported `WebAssembly.Memory` instead. Verified: `memory` is a live
   * 256 MB instance and `malloc` returns usable pointers into it.
   */
  wasmMemory?: WebAssembly.Memory;
  ccall?: (id: string, ret: string | null, argTypes: string[], args: unknown[]) => unknown;
}

let cachedModule: RawModule | null = null;
let cachedPushEvent: ((ptr: number) => number) | null = null;
let cachedMalloc: ((n: number) => number) | null = null;
let cachedFree: ((p: number) => void) | null = null;
let cachedMemory: WebAssembly.Memory | null = null;
let cachedHeapU8: Uint8Array | null = null;

/**
 * Resolve the live Emscripten module. The loader stashes it on
 * `window.__xash` (set by xash-loader.ts when the engine boots).
 */
function resolveModule(): RawModule {
  if (cachedModule) return cachedModule;
  const g = globalThis as unknown as {
    __xash?: { em?: { Module?: RawModule } };
  };
  const mod = g.__xash?.em?.Module;
  if (!mod) {
    throw new Error(
      '[sdl-key-inject] engine Module not ready (window.__xash?.em?.Module)'
    );
  }
  cachedModule = mod;
  return mod;
}

/**
 * Pull the raw WASM export table + the heap accessors we need.
 *
 * Throws (rather than silently no-op) when the vendor patch is absent
 * — that means `xash3d-fwgs` was upgraded and the anchor in
 * `scripts/patch-xash-exports.cjs` needs re-deriving. Failing loud here
 * is deliberate: a silent fallback would look like "keyboard is still
 * broken" with no explanation.
 */
function ensureReady(): void {
  if (cachedPushEvent && cachedMalloc && cachedFree && cachedMemory) return;
  const mod = resolveModule();

  const raw = mod.__rawExports;
  if (!raw) {
    throw new Error(
      '[sdl-key-inject] Module.__rawExports missing — the engine vendor ' +
        'patch did not run. Re-run `npm run postinstall` (or ' +
        '`node scripts/patch-xash-exports.cjs`) after an npm install.'
    );
  }

  const push = raw['SDL_PushEvent'];
  const malloc = raw['malloc'];
  const free = raw['free'];
  if (
    typeof push !== 'function' ||
    typeof malloc !== 'function' ||
    typeof free !== 'function'
  ) {
    throw new Error(
      '[sdl-key-inject] expected SDL_PushEvent/malloc/free in the engine ' +
        'export table; the engine build changed shape.'
    );
  }
  const mem = raw['memory'];
  if (!(mem instanceof WebAssembly.Memory)) {
    throw new Error(
      '[sdl-key-inject] engine memory export missing or not a ' +
        'WebAssembly.Memory; cannot write SDL events.'
    );
  }

  cachedPushEvent = push as (p: number) => number;
  cachedMalloc = malloc as (n: number) => number;
  cachedFree = free as (p: number) => void;
  cachedMemory = mem;
  cachedHeapU8 = new Uint8Array(mem.buffer);
}

/** True when the engine is up and the export table is reachable. */
export function isReady(): boolean {
  try {
    ensureReady();
    return true;
  } catch {
    return false;
  }
}

/**
 * Push one SDL key event into the engine's queue.
 *
 * @param code  `KeyboardEvent.code` (e.g. "KeyW").
 * @param down  true = keydown, false = keyup.
 * @returns true if SDL accepted the event. SDL_PushEvent returns 1 on
 *          success, 0 when the event was *filtered* (e.g. no matching
 *          window / disabled event state). A persistent 0 is the signal
 *          that the queue itself is unhealthy — see Route B Risk 1.
 */
export function injectKey(code: string, down: boolean): boolean {
  const scancode = SDL_SCANCODE[code];
  if (scancode === undefined) return false;

  ensureReady();
  // Re-derive the view each call: the engine can grow its memory, which
  // detaches the old ArrayBuffer and leaves a zero-length view.
  const heap = cachedHeapU8!.byteLength === cachedMemory!.buffer.byteLength
    ? cachedHeapU8!
    : new Uint8Array(cachedMemory!.buffer);
  cachedHeapU8 = heap;

  const ptr = cachedMalloc!(EVENT_BYTES);
  if (!ptr) return false;

  try {
    // Zero the struct, then fill. SDL_PollEvent reads it by value.
    heap.fill(0, ptr, ptr + EVENT_BYTES);

    const u8 = new DataView(heap.buffer, ptr, EVENT_BYTES);
    u8.setUint32(OFF_TYPE, down ? SDL_KEYDOWN : SDL_KEYUP, true);
    u8.setUint32(OFF_WINDOW_ID, 1, true); // windowID; see Risk 4
    u8.setUint8(OFF_STATE, down ? SDL_PRESSED : SDL_RELEASED);
    u8.setUint8(OFF_REPEAT, 0);
    u8.setInt32(OFF_KEYSYM_SC0DE, scancode, true);

    // SDL_PushEvent returns 1 on success, 0 when filtered. Treat any
    // non-zero as accepted so a future bool-returning build still works.
    const ok = cachedPushEvent!(ptr);
    return Number(ok) !== 0;
  } finally {
    cachedFree!(ptr);
  }
}

/** SDL_SCANCODE for a code, or undefined. Exposed for diagnostics/tests. */
export function scancodeFor(code: string): number | undefined {
  return SDL_SCANCODE[code];
}