// The browser chords a match must swallow, and which mechanism can.
//
// WHY THIS FILE EXISTS
// --------------------
// Kyle, playing a fullscreen match: "if i hit CTRL + a movement key (like
// WASD) it would trigger a browser modal to confirm if i wanted to leave
// the page or stay. ... we should probably block that so users can crouch
// and not get popups (very distracting)."
//
// The chord behind it is Ctrl+W: the browser's own "close this tab".
// Chromium RESERVES it — the W keydown is never dispatched to the
// renderer, so no DOM handler can cancel it. The browser then attempts
// the close, which fires `beforeunload`, and OUR beforeunload guard
// (services/xash-loader.ts) cancels the unload — which is what makes
// Chrome ask "Leave site?".
//
// TWO MECHANISMS, AND A CHORD NEEDS THE RIGHT ONE
// ------------------------------------------------
// Measured in real Chromium against real X11 chords (2026-10-26). The
// first matrix was wrong — a dialog and a new tab poisoned the later
// readings — so it was re-run with a fresh page per chord:
//
//   RESERVED (the keydown never reaches the page — only the keyboard
//   lock can free it):
//     Ctrl+W  close tab      Ctrl+Shift+W close window
//     Ctrl+T  new tab        Ctrl+N     new window
//     Ctrl+Tab / Ctrl+Shift+Tab  switch tab
//
//   DELIVERED (the keydown reaches the page — a DOM gate can cancel it
//   with preventDefault):
//     Ctrl+R reload   Ctrl+S save page   Ctrl+F find in page
//     Ctrl+P print    Ctrl+O open file    Ctrl+D bookmark
//     Ctrl+0..Ctrl+9 jump to browser tab N
//     Alt+Left / Alt+Right  back / forward
//
// So: the reserved chords need `navigator.keyboard.lock()`, and the
// delivered ones need a `preventDefault()` gate. The gate ALSO covers
// the reserved chords, because the lock hands them to the page — belt
// and braces, and it is what makes the fix work if the lock is refused.
//
// THE ENGINE STILL GETS THE KEY
// -----------------------------
// The gate calls preventDefault() and NOT stopImmediatePropagation(), so
// the key still reaches the engine's own listener. That matters: the
// engine's bind table has `bind "CTRL" "+duck"` and `bind "w" "+forward"`,
// so Ctrl+W is duck+forward IN THE GAME. Swallowing the key for the
// engine as well would break crouching.
//
// It is safe to preventDefault() a key the engine needs, because the
// engine cannot see it: its key event struct carries ctrlKey/shiftKey/
// altKey/metaKey and the key/code, and has no `defaultPrevented` field
// at all (checked in the generated xash.js glue and in xash.wasm).
//
// THIS FILE IS PURE DATA AND PURE FUNCTIONS
// -----------------------------------------
// No imports, no DOM. The parent repository's unit suite imports it
// directly to check the chord sets, and in particular to check that
// Escape is not in the locked set — see the note on RESERVED_CHORD_CODES.

/**
 * The chords Chromium reserves: their keydown is never dispatched to the
 * renderer, so a DOM gate cannot see them at all.
 * `navigator.keyboard.lock()` is the only way to get them back — and it
 * only works while the document is in JS-initiated fullscreen.
 *
 * Escape is deliberately NOT here. Locking Escape changes what a tap of
 * Escape does (measured: with Escape locked, a tap arrives at the page
 * and fullscreen is NOT left; without it, a tap is consumed by the
 * browser and leaves fullscreen), and the game's two-step Escape is
 * built on the current behaviour. The escape hatch survives anyway:
 * Chrome drops the lock when fullscreen ends, and a long Escape hold
 * releases it.
 *
 * KeyQ is deliberately NOT here either: Cmd+Q is how a Mac user quits
 * Chrome, and taking that away from them is not worth the accident it
 * would prevent. Q is not bound to anything in the game.
 *
 * Tab IS here. Ctrl+Tab and Ctrl+Shift+Tab switch browser tabs, and
 * both are reserved. Locking Tab does not break plain Tab: measured,
 * focus traversal still works (the browser still moves focus between
 * elements), and the engine still receives the Tab keydown.
 */
export const RESERVED_CHORD_CODES: readonly string[] = ['KeyW', 'KeyT', 'KeyN', 'Tab'];

/**
 * The chords Chromium delivers to the page, where a `preventDefault()`
 * gate cancels the browser's action.
 *
 *   KeyR  reload the page (the engine binds "r" to "+reload", so this is
 *         crouch + weapon reload — the same class of accident as Ctrl+W,
 *         and it fires beforeunload too)
 *   KeyS  save the page (Chrome's own save dialog)
 *   KeyF  find in page (steals focus from the game)
 *   KeyP  print the page
 *   KeyO  open a file
 *   KeyD  bookmark the page
 *   Tab   switch browser tab (also in RESERVED_CHORD_CODES: the lock
 *         hands it over, and the gate then cancels it)
 *   Digit0..Digit9  jump to browser tab N (the engine binds these to
 *         weapon slots, so crouch + slot is a real in-game combination)
 *
 * KeyA is NOT here. Ctrl+A is select-all, which is not a browser action
 * that disturbs the player, and it is a shortcut people expect to work
 * in a text field. KeyQ is not here either — see RESERVED_CHORD_CODES.
 */
export const GATE_CHORD_CODES: readonly string[] = [
  // The reserved chords are in here too, and that is not redundant.
  // The keyboard lock is what makes them arrive at the page at all, and
  // then this gate is what cancels them. But the lock only exists in
  // Chromium, and only in fullscreen: on Firefox and Safari these chords
  // DO reach the page (which is why the gate alone is enough there), and
  // on Chromium in a windowed game they do not reach it at all. Listing
  // them costs nothing and covers the case where the lock is refused.
  'KeyW',
  'KeyT',
  'KeyN',
  'KeyR',
  'KeyS',
  'KeyF',
  'KeyP',
  'KeyO',
  'KeyD',
  'Tab',
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
];

/**
 * Alt + these are browser back and forward. Alt+Left navigates away
 * from the page, which fires beforeunload and produces the very dialog
 * this gate exists to stop. The engine binds no Alt chords, so there is
 * no in-game action to protect here.
 */
export const ALT_CHORD_CODES: readonly string[] = ['ArrowLeft', 'ArrowRight'];

/** Which modifier keys are held, for the chord test. */
export interface ChordModifiers {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

/**
 * Is this keydown a browser chord the game must swallow?
 *
 * Only chords count — a bare "w" is the movement key and must pass
 * through untouched, and a bare arrow is movement too.
 *
 * `meta` is the Mac Command key. Kyle plays on a MacBook, and there
 * Cmd+W is the close-tab chord, exactly as Ctrl+W is on the others.
 */
export function isBrowserChord(code: string, mods: ChordModifiers): boolean {
  if (mods.ctrl || mods.meta) return GATE_CHORD_CODES.includes(code);
  if (mods.alt) return ALT_CHORD_CODES.includes(code);
  return false;
}
