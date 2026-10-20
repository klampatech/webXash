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

export type BridgeKey =
  | 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Space' | 'ControlLeft' | 'ControlRight'
  | 'KeyQ' | 'KeyE' | 'KeyR' | 'Digit1' | 'Digit2' | 'Digit3' | 'Digit4'
  | 'KeyF' | 'KeyC';

/** Key code → engine command. Value is the `+cmd` form; we append `-`. */
const KEY_TO_CMD: Record<string, string> = {
  // Movement
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'moveleft', ArrowLeft: 'moveleft',
  KeyD: 'moveright', ArrowRight: 'moveright',
  // Actions
  Space: 'jump',
  ControlLeft: 'duck', ControlRight: 'duck',
  KeyQ: 'lastinv',
  KeyE: 'use',
  KeyR: 'reload',
  // Weapons
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4',
  // View / misc
  KeyF: 'impulse 100', // flashlight
};

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
export function startKeyboardBridge(): () => void {
  const held = new Set<string>();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    // Don't hijack keys while the user is typing in a form field.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    const cmd = KEY_TO_CMD[e.code];
    if (!cmd) return;
    if (held.has(e.code)) return;
    held.add(e.code);
    XashLoader.exec(`+${cmd}`);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const cmd = KEY_TO_CMD[e.code];
    if (!cmd) return;
    if (!held.has(e.code)) return;
    held.delete(e.code);
    XashLoader.exec(`-${cmd}`);
  };

  // Releasing focus while a key is held would strand the engine in a
  // "still moving" state. Release everything on blur.
  const onBlur = () => {
    for (const code of held) {
      const cmd = KEY_TO_CMD[code];
      if (cmd) XashLoader.exec(`-${cmd}`);
    }
    held.clear();
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