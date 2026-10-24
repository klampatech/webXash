// Inject real key events into the engine's SDL event queue.
//
// WHY THIS EXISTS
// ---------------
// The Xash3D-FWGS WASM build's SDL keyboard input is dead: nothing
// drains its SDL event queue (not even the engine's own window/text
// events). The TS team's VGUI menu therefore cannot be dismissed via
// `HUD_KeyEvent`, and a client stuck in spectator cannot spawn.
//
// See Obsidian projects/specialists-browser-rust-port.md -> Route B for
// the full investigation.
//
// MEMORY SAFETY
// -------------
// Every `SDL_PushEvent` malloc's a slot in the wasm heap. If the queue
// is never drained (Route B proved it isn't, on this build), the heap
// grows unbounded and the engine OOM-aborts on the next createWasm
// (D.7.38, reproduced live). So before we push anything, we do ONE
// synchronous probe: push a synthetic key, ask SDL_HasEvents whether
// anything is queued. If the queue is empty, the engine drained our
// event and we can keep pushing. If not, we set a permanent disable
// flag and never push again - the keyboard is broken either way on
// this build, but at least the heap survives. On a future build where
// the pump works (upstream fix), the probe passes and we are safe to
// push real keys.

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
 * Uint16 mod (+8); Uint32 unicode (+12); } - so the engine-facing
 * scancode lands at absolute byte 12. sizeof(SDL_KeyboardEvent) is 28;
 * we allocate 32 for alignment.
 */
const OFF_TYPE = 0;
const OFF_WINDOW_ID = 4;
const OFF_STATE = 8;
const OFF_REPEAT = 9;
const OFF_KEYSYM_SC0DE = 12;

/** Size we hand to _malloc for one event. */
const EVENT_BYTES = 32;

/**
 * `KeyboardEvent.code` -> SDL_Scancode (SDL_scancode.h). Only the keys
 * we actually bind; the engine consumes scancodes directly.
 */
const SDL_SCANCODE: Record<string, number> = {
  KeyA: 4, KeyB: 5, KeyC: 6, KeyD: 7, KeyE: 8, KeyF: 9,
  KeyG: 10, KeyH: 11, KeyI: 12, KeyJ: 13, KeyK: 14, KeyL: 15,
  KeyM: 16, KeyN: 17, KeyO: 18, KeyP: 19, KeyQ: 20, KeyR: 21,
  KeyS: 22, KeyT: 23, KeyU: 24, KeyV: 25, KeyW: 26, KeyX: 27,
  KeyY: 28, KeyZ: 29,
  Digit1: 30, Digit2: 31, Digit3: 32, Digit4: 33, Digit5: 34,
  Digit6: 35, Digit7: 36, Digit8: 37, Digit9: 38, Digit0: 39,
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
  ArrowLeft: 79, ArrowUp: 82, ArrowDown: 81, ArrowRight: 80,
  Insert: 86, Delete: 87, Home: 74, End: 77, PageUp: 75, PageDown: 78,
  ShiftLeft: 225, ShiftRight: 226, ControlLeft: 224, ControlRight: 228,
  AltLeft: 227, AltRight: 230, CapsLock: 231,
  Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 52,
  Comma: 54, Period: 55, Slash: 56,
  F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63,
  F7: 64, F8: 65, F9: 66, F10: 67, F11: 68, F12: 69,
};

/** Minimal shape of the Emscripten module we need. */
interface RawModule {
  __rawExports?: Record<string, (...a: unknown[]) => unknown>;
  /**
   * The Emscripten glue keeps `HEAPU8` in a module-private closure,
   * so it is NOT reachable on `Module`. We re-derive a view from the
   * exported `WebAssembly.Memory` instead.
   */
  wasmMemory?: WebAssembly.Memory;
}

let cachedModule: RawModule | null = null;
let cachedPushEvent: ((ptr: number) => number) | null = null;
let cachedMalloc: ((n: number) => number) | null = null;
let cachedFree: ((p: number) => void) | null = null;
let cachedHasEvents: ((min: number, max: number) => number) | null = null;
let cachedMemory: WebAssembly.Memory | null = null;
let cachedHeapU8: Uint8Array | null = null;

/**
 * Tri-state drain-probe result:
 *   null  -> not yet run
 *   true  -> confirmed drained; pushing is safe
 *   false -> confirmed NOT drained; pushing is disabled forever
 *
 * On the published WASM build the queue is never drained, so this
 * starts as null (probe pending) and flips to false on first use.
 * On a future build where the pump works, it flips to true.
 */
let drainProbePassed: boolean | null = null;

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

function ensureReady(): void {
  if (cachedPushEvent && cachedMalloc && cachedFree && cachedMemory) return;
  const mod = resolveModule();

  const raw = mod.__rawExports;
  if (!raw) {
    throw new Error(
      '[sdl-key-inject] Module.__rawExports missing - the engine vendor ' +
        'patch did not run. Re-run `npm run postinstall`.'
    );
  }

  const push = raw['SDL_PushEvent'];
  const malloc = raw['malloc'];
  const free = raw['free'];
  const hasEv = raw['SDL_HasEvents'];
  if (
    typeof push !== 'function' ||
    typeof malloc !== 'function' ||
    typeof free !== 'function' ||
    typeof hasEv !== 'function'
  ) {
    throw new Error(
      '[sdl-key-inject] expected SDL_PushEvent/malloc/free/SDL_HasEvents in ' +
        'the engine export table; the engine build changed shape.'
    );
  }
  const mem = raw['memory'];
  if (!(mem instanceof WebAssembly.Memory)) {
    throw new Error(
      '[sdl-key-inject] engine memory export missing or not a WebAssembly.Memory.'
    );
  }

  cachedPushEvent = push as (p: number) => number;
  cachedMalloc = malloc as (n: number) => number;
  cachedFree = free as (p: number) => void;
  cachedHasEvents = hasEv as (a: number, b: number) => number;
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

/** True when `injectKey` is actually pushing events to the engine. */
export function canInject(): boolean {
  return drainProbePassed === true;
}

/**
 * Synchronous drain probe. Push one synthetic key, ask SDL_HasEvents
 * whether any events remain. Empty -> the engine drained our event,
 * push is safe. Anything > 0 -> either our event or a leaked engine
 * event is sitting in the queue -> leak: disable ourselves.
 */
function runDrainProbe(): boolean {
  ensureReady();
  const ptr = cachedMalloc!(EVENT_BYTES);
  if (!ptr) return false;
  try {
    const heap = cachedHeapU8!;
    heap.fill(0, ptr, ptr + EVENT_BYTES);
    const dv = new DataView(cachedMemory!.buffer, ptr, EVENT_BYTES);
    dv.setUint32(OFF_TYPE, SDL_KEYDOWN, true);
    dv.setUint32(OFF_WINDOW_ID, 1, true);
    dv.setUint8(OFF_STATE, SDL_PRESSED);
    dv.setInt32(OFF_KEYSYM_SC0DE, 4, true);

    const pushRc = cachedPushEvent!(ptr);
    if (pushRc !== 1) return false;

    const queued = cachedHasEvents!(0, 0xffff);
    return queued === 0;
  } finally {
    cachedFree!(ptr);
  }
}

/**
 * Push one SDL key event into the engine's queue.
 *
 * @returns true if SDL accepted the event. Returns false when:
 *   - the key has no scancode mapping,
 *   - or the drain probe showed the engine does not process its queue
 *     (publishing would only leak heap toward OOM, so we don't).
 */
export function injectKey(code: string, down: boolean): boolean {
  const scancode = SDL_SCANCODE[code];
  if (scancode === undefined) return false;

  ensureReady();

  // Re-derive the view each call: the engine can grow its memory, which
  // detaches the old ArrayBuffer and leaves a zero-length view.
  const heap =
    cachedHeapU8!.byteLength === cachedMemory!.buffer.byteLength
      ? cachedHeapU8!
      : new Uint8Array(cachedMemory!.buffer);
  cachedHeapU8 = heap;

  if (drainProbePassed === null) {
    drainProbePassed = runDrainProbe();
    if (!drainProbePassed) {
      // Disable forever. Mapped commands (movement, fire, buy, slots)
      // still work via Cmd_ExecuteString; only the SDL_PushEvent path
      // is dead.
      return false;
    }
  } else if (!drainProbePassed) {
    return false;
  }

  const ptr = cachedMalloc!(EVENT_BYTES);
  if (!ptr) return false;

  try {
    heap.fill(0, ptr, ptr + EVENT_BYTES);
    const dv = new DataView(cachedMemory!.buffer, ptr, EVENT_BYTES);
    dv.setUint32(OFF_TYPE, down ? SDL_KEYDOWN : SDL_KEYUP, true);
    dv.setUint32(OFF_WINDOW_ID, 1, true);
    dv.setUint8(OFF_STATE, down ? SDL_PRESSED : SDL_RELEASED);
    dv.setUint8(OFF_REPEAT, 0);
    dv.setInt32(OFF_KEYSYM_SC0DE, scancode, true);

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