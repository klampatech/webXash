// D.7.31 — Keyboard bridge.
//
// WHAT CHANGED, AND WHY
// ---------------------
// This file used to translate DOM keys into engine commands (`+forward`,
// `messagemode`, `thirdperson`, …) because the engine's own keyboard path
// was believed to be dead. It is not.
//
// Measured in a real Chromium against a live local server (2026-10-24),
// with the client's own `ts_dev_keylog 1`:
//
//   [ts key] HUD_Key_Event escape down=1 binding="cancelselect" -> 1
//   [ts key] cancelselect: escape
//
// The engine's keydown listener DOES fire, DOES reach `HUD_Key_Event`, and
// DOES run the engine's own bind table. The earlier conclusion — recorded in
// this file's own old header, and in the how-to-play copy — was wrong. The
// probe built on that conclusion (`sdl-key-inject.ts`, which pushed
// synthetic SDL events into the engine's queue) was deleted on 2026-10-24:
// it was never imported, and its header still asserted the withdrawn
// theory.
//
// The engine's bind table (ts/config.cfg) already covers everything:
//
//   bind "w" "+forward"      bind "s" "+back"
//   bind "a" "+moveleft"     bind "d" "+moveright"
//   bind "SPACE" "+jump"     bind "CTRL" "+duck"
//   bind "1".."0" "slot1".."slot10"
//   bind "r" "+reload"       bind "e" "+use"
//   bind "x" "thirdperson"   bind "y" "messagemode"
//   bind "b" "buy"           bind "`" "toggleconsole"
//   bind "ESCAPE" "cancelselect"
//
// Translating keys as well meant every one of those keys ran TWICE: once
// from the engine's bind table and once from us. That is the whole of the
// reported "in game typing triggers hot keys AND types at the same time"
// bug (Y opened the chat twice — the engine's `messagemode` and ours), and
// it is why third person appeared broken: X ran `thirdperson` twice, so it
// toggled on and straight back off.
//
// So this bridge no longer sends commands. It does one thing: open TS's
// anti-script gate for the keys whose native binding is gated, because the
// gate only opens on a real key event and the engine runs the binding
// itself.
//
// The DOM→SDL injection is gone too. It never worked: `SDL_PushEvent` puts
// the event IN the queue and the drain probe then asks whether the queue is
// empty, so the probe could never pass and the service disabled itself. The
// log said `REFUSED by SDL` on every key.

import XashLoader from '/@/services/xash-loader';
import { logDebug } from './debug-log';

export type BridgeKey =
  | 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD'
  | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  | 'Space' | 'ControlLeft' | 'ControlRight'
  | 'KeyQ' | 'KeyE' | 'KeyR' | 'Digit1' | 'Digit2' | 'Digit3' | 'Digit4'
  | 'KeyF' | 'KeyC';

// Mouse buttons we still bridge through Cmd_ExecuteString.
const MOUSE_BUTTON_TO_CMD: Record<string, string> = {
  '0': 'attack',     // left: fire
  '2': 'attack2',    // right: alt-fire / firemode
};

/** If non-null, install the mouse bridge at the next possible moment. */
let mouseListener: ((e: MouseEvent) => void) | null = null;

// D.7.36 — while a DOM modal owns the keyboard (the options overlay), the
// bridge must stay quiet.
let bridgeSuspended = false;

export function setBridgeSuspended(v: boolean) {
  bridgeSuspended = v;
  if (v) {
    // Release anything currently held so nothing sticks.
    for (const code of Array.from(heldKeys)) {
      const held = GATED_KEYS[code];
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
    logDebug(
      `[mouse] ${e.type} button=${e.button} -> ${cmd ?? '(unmapped)'}` +
        (bridgeSuspended ? ' [SUSPENDED]' : '')
    );
    if (!cmd) return;
    e.preventDefault();
    if (e.type === 'mousedown') {
      if (held.has(e.button)) return;
      held.add(e.button);
      logDebug(`[mouse] exec +${cmd}`);
      execHeld(cmd);
    } else {
      if (!held.has(e.button)) return;
      held.delete(e.button);
      logDebug(`[mouse] exec -${cmd}`);
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
 * TS's anti-script gate: only a real keypress opens it, and every gated `+`
 * command (`+attack`, `+jump`, `+duck`, `+forward`, ...) is silently dropped
 * without it.
 *
 * The engine's own binding is what runs the command; we only hold the gate
 * open for the frame it lands in. 200ms is the same lifetime a held key
 * gives it before `HUD_Frame` re-arms the gate.
 *
 * The value is the command the ENGINE will run for that key — used to decide
 * whether the gate is needed, and to release the matching button on keyup.
 */
const GATED_KEYS: Record<string, string> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'moveleft', ArrowLeft: 'moveleft',
  KeyD: 'moveright', ArrowRight: 'moveright',
  Space: 'jump',
  ControlLeft: 'duck', ControlRight: 'duck',
  KeyR: 'reload',
};

/** Fire a held `+` command, opening TS's anti-script gate first if it needs it. */
function execHeld(cmd: string): void {
  logDebug(`[gate] opening for +${cmd}`);
  XashLoader.exec('ts_gate 200');
  XashLoader.exec(`+${cmd}`);
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
    const gated = GATED_KEYS[e.code];
    logDebug(
      `[key] DOWN code=${e.code} key=${e.key} repeat=${e.repeat} ` +
        `gated=${gated ?? '-'}` +
        (bridgeSuspended ? ' [SUSPENDED]' : '')
    );
    if (e.repeat) return;
    if (bridgeSuspended) return;
    if (!gated) {
      // Not a gated key: the engine's own bind table runs it. Nothing to do.
      return;
    }
    if (heldKeys.has(e.code)) return;
    heldKeys.add(e.code);
    // Open the gate, then let the engine run its own binding. We do NOT send
    // the command ourselves — sending it as well is what made every key
    // fire twice.
    execHeld(gated);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const gated = GATED_KEYS[e.code];
    if (!heldKeys.has(e.code)) {
      logDebug(`[key] UP   code=${e.code} (not held; ignoring)`);
      return;
    }
    heldKeys.delete(e.code);
    if (gated) {
      logDebug(`[key] ${e.code} -> exec -${gated}`);
      XashLoader.exec(`-${gated}`);
    }
  };

  // Releasing focus while a key is held would strand the engine in a
  // "still moving" state. Release everything on blur.
  const onBlur = () => {
    for (const code of heldKeys) {
      const gated = GATED_KEYS[code];
      if (gated) XashLoader.exec(`-${gated}`);
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
