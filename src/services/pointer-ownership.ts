// Who owns the pointer.
//
// WHY THIS EXISTS
// ---------------
// The modern buy menu is a DOM MENU: it is a panel of real buttons over the
// game canvas, and the player clicks it. The canvas, meanwhile, holds the
// game's POINTER LOCK, and under the lock the browser delivers every mouse
// event to the lock target - the canvas - no matter what is painted on top
// of it. So a lock that comes back while the panel is open makes every
// button on the panel DEAD: they look normal, they are enabled, and
// clicking them does nothing.
//
// The panel normally keeps the lock out: `syncPointerLock()` in `TSHud.vue`
// exits the lock when the panel opens and re-acquires it when the panel
// closes. But the lock can be taken back from OUTSIDE that path, and there
// are TWO ways in:
//
//   1. `engageInput` in `XashCanvas.vue` - the canvas's own `@pointerdown`
//      handler, which calls `requestPointerLock()` on every press.
//
//   2. THE ENGINE. `emscripten_set_mousedown_callback` registers a
//      `mousedown` listener on the canvas, and the engine's C code calls
//      `emscripten_request_pointerlock` from it. Measured in a real
//      browser (2026-11-02), the stack was:
//
//        at _emscripten_request_pointerlock (xash3d-fwgs.js)
//        at wasm-function[2790]              <- the engine's C code
//        at mouseEventHandlerFunc (xash3d-fwgs.js)
//
//      The engine is a prebuilt WASM module, so this one cannot be fixed
//      in the engine. It has to be fixed IN FRONT of it.
//
// The result is the bug in issue #118: open the buy menu, click on the
// game view, and the panel's buttons stop responding until the menu is
// closed and reopened.
//
// THE RULE
// --------
// While a DOM menu is on screen, the canvas must not take the pointer.
// A menu wants the pointer, not the game.
//
// This mirrors what the keyboard bridge already does: `setBridgeSuspended`
// in `keyboard-bridge.ts` stops the game's keys while the panel is open,
// and this stops the game's mouse. The two halves of "the panel owns the
// input" belong together.
//
// WHY A DOM CHECK AND NOT A STATE FLAG
// ------------------------------------
// The port's `buyMenuState.open` is NOT the right signal: it stays true
// after the player dismisses the panel with B (the port's menu stays open
// underneath, on purpose - see `toggleBuyMenu` in `TSHud.vue`). Guarding
// on that would mean the player could never get the mouse back.
//
// What we want is "is the panel ON SCREEN", and the DOM already answers
// that exactly: `TSBuyMenuPanel`'s root is `<div class="bm">`, and it is
// only in the document while the panel is up. The panel is mounted and
// unmounted by Vue's `v-if` on `showBuyPanel`, so the element's presence
// IS the panel's visibility.
//
// `data-buy-menu` is the same element seen through a different attribute
// (`TSHud.vue` puts it on `<TSBuyMenuPanel>` and Vue falls it through to
// the root). Either selector works; `.bm` is the one the panel's own CSS
// and the probe scripts already use.
//
// A DOM CHECK AND NOT A REACTIVE FLAG, AGAIN, FOR THE MOUSE GUARD: Vue
// removes the element on the NEXT TICK after `showBuyPanel` goes false, so
// a flag read at the wrong moment says "the menu is up" while it is
// closing. A user CLICK cannot land in that window - the player is looking
// at a rendered panel - so the DOM check is right here, and wrong only for
// deciding to RELEASE a lock (which is `syncPointerLock`'s job, and which
// runs off the reactive flag).

/**
 * Is a DOM menu on screen right now?
 *
 * The buy panel's root carries `class="bm"`. It is in the document only
 * while the panel is up, so this is the panel's visibility, exactly.
 *
 * The options overlay is a different problem - it is opened from the
 * Escape sequence, which RELEASES the lock rather than fighting it, and
 * it has no buttons that a stray canvas click could steal a click from.
 * So only the buy panel is checked here.
 */
export function isDomMenuOnScreen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('.bm') !== null;
}

/**
 * Keep the canvas from taking the mouse while a DOM menu is on screen.
 *
 * The engine's `mousedown` handler lives on the canvas and takes the
 * pointer lock from C. A listener on the canvas cannot stop it - the
 * engine's listener is on the SAME element, and `stopPropagation()` does
 * not stop other listeners on the same node.
 *
 * So this listens on `window` in the CAPTURE phase. The capture phase at
 * `window` runs BEFORE the event descends to the canvas at all, and
 * `stopPropagation()` there stops it reaching the canvas - the engine
 * never sees the press, so it never asks for the lock. That is also the
 * pattern the Escape gate already uses for the same kind of problem (see
 * `escape-gate.ts`).
 *
 * Only presses that TARGET the canvas are stopped. A press on a panel
 * button is not the canvas's, and the panel's own buttons keep working.
 *
 * Stopping the engine's `mousedown` also stops the game's mouse buttons
 * (`+attack` and friends) while the menu is up - which is right, and is
 * what the keyboard bridge already does through `setBridgeSuspended`.
 *
 * @param canvas the game canvas
 * @returns an uninstall function
 */
export function installCanvasMouseGuard(canvas: HTMLElement): () => void {
  const onMouseDown = (e: MouseEvent) => {
    if (!isDomMenuOnScreen()) return;
    const target = e.target as Node | null;
    if (!target || !(target === canvas || canvas.contains(target))) return;
    // The engine's `mousedown` handler is on the canvas, and its C code
    // takes the pointer lock. Stop the event before it gets there.
    e.stopPropagation();
  };
  window.addEventListener('mousedown', onMouseDown, { capture: true });
  return () => window.removeEventListener('mousedown', onMouseDown, { capture: true });
}
