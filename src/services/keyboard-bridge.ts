// D.7.31 — Keyboard→command bridge.
//
// WHY THIS EXISTS
// ---------------
// The engine WASM's SDL2 keyboard listener is registered on `window`
// (WASM calls `emscripten_set_keydown_callback(2, ...)`; in
// xash3d-fwgs's runtime `specialHTMLTargets = [0, document, window]`,
// so target index 2 == window). Kyle's `[KEY]` diagnostic log proves
// keydown events DO reach `window` in real Chrome (target=BODY,
// active=BODY, bubbling up). Yet the engine never acts on them.
//
// So the event reaches the same window the engine listens on, and the
// engine ignores it. That's an SDL2-internal issue we can't fix from
// the launcher. The `_Mem_Alloc: pool == NULL` failure during
// `SDL_KeyboardInit` is the likely culprit — SDL's internal keymap
// never finishes building, so the callback never matches a scancode.
//
// WORKAROUND
// ----------
// We already have a proven command channel: `Cmd_ExecuteString`.
// The engine accepts every movement command without error (verified:
// `+forward`, `-forward`, `+back`, `+moveleft`, `+moveright`, `+jump`,
// `+duck`, `+attack`, `impulse`, `weapon`, `slot1` — all "ok").
//
// So: bridge keydown/keyup to the equivalent engine commands.
// `+cmd` on keydown, `-cmd` on keyup, exactly like a real bind.

import XashLoader from '/@/services/xash-loader';
import { logDebug } from './debug-log';
import { injectKey, scancodeFor } from './sdl-key-inject';

export type BridgeKey =
  | 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Space' | 'ControlLeft' | 'ControlRight'
  | 'KeyQ' | 'KeyE' | 'KeyR' | 'Digit1' | 'Digit2' | 'Digit3' | 'Digit4'
  | 'KeyF' | 'KeyC';

/** Key code → engine command. Value is the `+cmd` form; we append `-`. */
/**
 * Keys we translate into an engine command, because the engine's native
 * keyboard path is dead in the WASM build.
 *
 * Split by kind, because the engine treats them differently:
 *
 *  - HELD (`+cmd` on down, `-cmd` on up): movement and the fire buttons.
 *    The engine needs both edges to set and clear the button state.
 *  - INSTANT (`cmd` once, on down only): `slot1`, `use`, `reload`,
 *    `impulse`. These are not buttons. Sending them as `+slot1` makes the
 *    engine wait for a matching `-slot1`, and it ignores the command
 *    entirely — which is exactly the "unknown keybind" symptom: the
 *    weapon never switches.
 *
 * Anything NOT listed here is passed to the engine as a real key event,
 * so the ENGINE's own bindings run (the console toggle, and anything the
 * port registers that we have not mapped).
 */
const KEY_HELD_CMD: Record<string, string> = {
  // Movement
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'moveleft', ArrowLeft: 'moveleft',
  KeyD: 'moveright', ArrowRight: 'moveright',
  // Buttons
  Space: 'jump',
  ControlLeft: 'duck', ControlRight: 'duck',
  // Scoreboard. Held, not instant: the engine binds it `+showscores` /
  // `-showscores`, and sending only `showscores` opens it and never closes.
  Tab: 'showscores',
  // Backquote opens the console as a held button too in GoldSrc
  // (`+toggleconsole` / `-toggleconsole`). Verified: held for 1.5s it
  // opens; a zero-length press does not render.
  Backquote: 'toggleconsole',
};

/** Instant commands: fired once on keydown, never negated. */
const KEY_INSTANT_CMD: Record<string, string> = {
  KeyQ: 'lastinv',
  KeyE: 'use',
  KeyR: 'reload',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4',
  Digit5: 'slot5', Digit6: 'slot6', Digit7: 'slot7', Digit8: 'slot8',
  Digit9: 'slot9', Digit0: 'slot10',
  KeyF: 'impulse 100', // flashlight
  KeyB: 'buy',
  // Console toggle and the TS-specific client-DLL menus. These are plain
  // engine commands (both symbols are present in the client WASM), so they
  // go through the command channel rather than needing HUD_Key_Event.
  KeyM: 'messagemode2', // open mic
  KeyY: 'messagemode',  // team chat
  KeyX: 'thirdperson',
  KeyZ: 'usepowerup',
  KeyG: 'useitems',   // toggle attachments
  KeyT: 'drop',
  KeyH: 'impulse 201', // taunt
  BracketLeft: 'invprev', BracketRight: 'invnext',
};

/**
 * True when we translate this key ourselves. Everything else is passed to
 * the engine as a real key event so its own bindings run.
 */
function isMapped(code: string): boolean {
  return code in KEY_HELD_CMD || code in KEY_INSTANT_CMD;
}

/**
 * Install the bridge. Returns a stop function.
 *
 * Uses keydown/keyup on window with capture=false so we coexist with
 * the engine's own (broken) listener rather than pre-empting it. If the
 * engine's handler ever starts working, we simply become redundant —
 * the engine would see both the real key and our injected command,
 * which is harmless for movement (the command is what the key is bound
 * to anyway).
 */
// Mouse buttons we want to bridge through Cmd_ExecuteString.
const MOUSE_BUTTON_TO_CMD: Record<string, string> = {
  '0': 'attack',     // left: fire
  '2': 'attack2',    // right: alt-fire / firemode
};

/** If non-null, install the mouse bridge at the next possible moment. */
let mouseListener: ((e: MouseEvent) => void) | null = null;

// D.7.36 — while a DOM modal owns the keyboard (the buy menu), the
// bridge must stay quiet. Otherwise pressing "2" to switch category
// also sends `+slot2` to the engine and switches your weapon.
let bridgeSuspended = false;

export function setBridgeSuspended(v: boolean) {
  bridgeSuspended = v;
  if (v) {
    // Release anything currently held so nothing sticks.
    for (const code of Array.from(heldKeys)) {
      const held = KEY_HELD_CMD[code];
      if (held) XashLoader.exec(`-${held}`);
    }
    heldKeys.clear();
  }
}

function attachMouseBridge(canvas: HTMLCanvasElement) {
  if (mouseListener) return;
  const held = new Set<number>();
  const handler = (e: MouseEvent) => {
    const cmd = MOUSE_BUTTON_TO_CMD[String(e.button)];
    if (!cmd) return;
    e.preventDefault();
    if (e.type === 'mousedown') {
      if (held.has(e.button)) return;
      held.add(e.button);
      XashLoader.exec(`+${cmd}`);
    } else {
      if (!held.has(e.button)) return;
      held.delete(e.button);
      XashLoader.exec(`-${cmd}`);
    }
  };
  // attach to the canvas — same place mouse look is firing
  canvas.addEventListener('mousedown', handler);
  canvas.addEventListener('mouseup', handler);
  // Release on context menu (right-click without releasing fires it in some setups)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  mouseListener = handler;
}

export function tryAttachMouseBridge() {
  const c = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (c) attachMouseBridge(c);
}

/**
 * Hand a key to the engine as a real key press, so the ENGINE's own
 * bindings run.
 *
 * The engine's native keyboard path is dead in the WASM build (nothing
 * drains its SDL event queue), so we translate the DOM `code` to an SDL
 * scancode and push an `SDL_KeyboardEvent`. If the engine's event pump
 * is fixed upstream, this becomes a no-op fallback rather than a
 * dependency.
 *
 * Keys WE map (movement, fire) deliberately do not come through here:
 * those are exec'd as `+cmd` instead, because a command is unambiguous
 * and does not depend on the engine's bind table.
 */
function sendKey(code: string, down: boolean): void {
  const scancode = scancodeFor(code);
  if (scancode === undefined) {
    logDebug(`[key] ${code}: no SDL scancode; nothing sent`);
    return;
  }
  try {
    const ok = injectKey(code, down);
    logDebug(
      `[key] ${down ? 'DOWN' : 'UP  '} ${code} scancode=${scancode} -> ` +
        `${ok ? 'pushed to SDL queue' : 'REFUSED by SDL'}`
    );
  } catch (err) {
    logDebug(`[key] ${code}: inject failed: ${(err as Error).message}`);
  }
}

/** Keys currently mapped-to-engine-command and held down. */
const heldKeys = new Set<string>();

export function startKeyboardBridge(): () => void {

  const onKeyDown = (e: KeyboardEvent) => {
    // Don't hijack keys while the user is typing in a form field.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    const held = KEY_HELD_CMD[e.code];
    const instant = KEY_INSTANT_CMD[e.code];
    logDebug(
      `[key] DOWN code=${e.code} key=${e.key} repeat=${e.repeat} ` +
        `held=${held ?? '-'} instant=${instant ?? '-'}` +
        (isMapped(e.code) ? '' : ' -> passing to engine') +
        (bridgeSuspended ? ' [SUSPENDED]' : '')
    );
    if (e.repeat) return;
    if (held) {
      // A button: the engine needs both edges.
      if (heldKeys.has(e.code)) return;
      heldKeys.add(e.code);
      logDebug(`[key] ${e.code} -> exec +${held}`);
      XashLoader.exec(`+${held}`);
      return;
    }
    if (instant) {
      // Not a button: fire once, on keydown only.
      logDebug(`[key] ${e.code} -> exec ${instant} (once)`);
      XashLoader.exec(instant);
      return;
    }
    // No mapping: hand it to the engine as a real key press so the
    // ENGINE's own bindings run (the console toggle, and anything the
    // client DLL registers that we have not mapped).
    heldKeys.add(e.code);
    sendKey(e.code, true);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const held = KEY_HELD_CMD[e.code];
    if (!heldKeys.has(e.code)) {
      logDebug(`[key] UP   code=${e.code} (not held; ignoring)`);
      return;
    }
    heldKeys.delete(e.code);
    if (held) {
      logDebug(`[key] ${e.code} -> exec -${held}`);
      XashLoader.exec(`-${held}`);
    } else {
      logDebug(`[key] UP   ${e.code} -> release to engine`);
      sendKey(e.code, false);
    }
  };

  // Releasing focus while a key is held would strand the engine in a
  // "still moving" state. Release everything on blur.
  const onBlur = () => {
    for (const code of heldKeys) {
      const held = KEY_HELD_CMD[code];
      if (held) XashLoader.exec(`-${held}`);
    }
    heldKeys.clear();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    onBlur(); // release any stuck keys
  };
}
