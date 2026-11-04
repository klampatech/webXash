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
 * The options overlay's root carries `class="opts"`, and it counts for
 * the same reason: it is a DOM menu over the canvas, and under the
 * pointer lock the browser delivers every mouse event to the lock
 * target, so its buttons and its text fields would be dead too.
 */
export function isDomMenuOnScreen(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.querySelector('.bm') !== null || document.querySelector('.opts') !== null
  );
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
 * AND THE CLICK MUST BE STOPPED TOO - IT IS A SEPARATE EVENT
 * -----------------------------------------------------------
 * The engine has a SECOND way in, and stopping the mousedown does not
 * cover it. In `Browser.init` (xash3d-fwgs.js):
 *
 *     canvas.addEventListener("click", ev => {
 *       if (!Browser.pointerLock && Browser.getCanvas().requestPointerLock) {
 *         Browser.getCanvas().requestPointerLock();
 *
 * That is a `click` listener ON THE CANVAS, and it takes the pointer
 * lock. **A `click` is dispatched by the browser as part of the
 * mousedown/mouseup pair, and its target is the hit-test result - not
 * the propagation of the mousedown.** So swallowing the mousedown does
 * NOT swallow the click: the click still lands on the canvas and the
 * engine still asks for the lock. That is Kyle's report, exactly: the
 * pointer was free with the buy panel up, ONE CLICK later it was locked
 * and the panel said "PRESS ESC TO UNLOCK".
 *
 * (The engine has a third way in: its `fullscreenChange` handler calls
 * `canvas.requestPointerLock()` when the page ENTERS fullscreen. That
 * one cannot be stopped from the frontend at all - the standing rule
 * below is what answers it.)
 *
 * So the guard stops `click` as well as `mousedown`, with the same
 * target test: only a click that would reach the canvas is stopped, so
 * the panel's own buttons keep working.
 *
 * THE STANDING RULE, AND WHY A ONE-SHOT REPAIR IS NOT ENOUGH
 * -----------------------------------------------------------
 * The mouse guard above stops the press that would ASK for the lock. It
 * cannot stop a lock that the engine asks for on its own.
 *
 * MEASURED (2026-11-03, real browser against the local rig): the engine
 * asks the browser for the pointer lock BY ITSELF, from its C code, at
 * the moment the port's buy menu opens:
 *
 *     at Element.requestPointerLock
 *     at requestPointerLock          (xash3d-fwgs.js)
 *     at _emscripten_request_pointerlock (xash3d-fwgs.js)
 *
 * The port's menu opens the moment the player becomes an observer, so
 * this happens on EVERY join - and the frontend used to answer it with a
 * one-shot repair: `syncPointerLock()` in `TSHud.vue` watches the panel
 * mounting and releases the lock once. That is a RACE, and it was
 * measured to be one: the engine's request landed 347 ms before the
 * panel's watcher released it in the run that passed, and the order is
 * not guaranteed - the release only fires if the panel happens to be
 * mounted by then, and nothing re-checks afterwards.
 *
 * When the engine's request wins the race the pointer is locked while
 * the buy panel is open, and under the lock the browser delivers every
 * mouse event to the canvas: the panel's buttons go dead and the game
 * asks the player to press Escape to get the mouse back.
 *
 * So the rule is now STANDING: while a DOM menu is on screen, the canvas
 * must not hold the pointer - whenever the lock is taken, it is taken
 * back. `pointerlockchange` is the signal for that (it fires for every
 * acquisition, whoever asked for it).
 *
 * THE POINTER COMES BACK
 * ----------------------
 * Releasing the lock is only half of it: the player must get the mouse
 * back when the menu closes. So the release REMEMBERS that the pointer
 * was held (`hadPointerLock`), and `reclaimPointer()` gives it back.
 * That is why both live here and not in the HUD: one owner for the
 * pointer, so the "who had it" question has one answer.
 *
 * @param canvas the game canvas
 * @returns an uninstall function
 */
export function installPointerOwnership(canvas: HTMLElement): () => void {
  /**
   * Is this event aimed at the canvas?
   *
   * Only the canvas's own events are stopped. A press on a panel button
   * is not the canvas's, and the panel's buttons keep working.
   */
  const aimedAtCanvas = (e: Event): boolean => {
    const target = e.target as Node | null;
    return !!target && (target === canvas || canvas.contains(target));
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!isDomMenuOnScreen()) return;
    if (!aimedAtCanvas(e)) return;
    // The engine's `mousedown` handler is on the canvas, and its C code
    // takes the pointer lock. Stop the event before it gets there.
    e.stopPropagation();
  };

  const onClick = (e: MouseEvent) => {
    if (!isDomMenuOnScreen()) return;
    if (!aimedAtCanvas(e)) return;
    // The engine's OWN `click` handler on the canvas takes the pointer
    // lock too, and a click is a SEPARATE event from the mousedown -
    // stopping the mousedown does not stop it. This is the path that
    // took the pointer out of the player's hands on the first click with
    // the buy panel open.
    e.stopPropagation();
  };

  const onPointerLockChange = () => {
    // The engine asked for the lock (or the browser did). While a DOM
    // menu is on screen the menu owns the pointer, so give it back.
    if (!isDomMenuOnScreen()) return;
    releasePointerForMenu();
  };

  window.addEventListener('mousedown', onMouseDown, { capture: true });
  window.addEventListener('click', onClick, { capture: true });
  document.addEventListener('pointerlockchange', onPointerLockChange);
  return () => {
    window.removeEventListener('mousedown', onMouseDown, { capture: true });
    window.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('pointerlockchange', onPointerLockChange);
  };
}

/**
 * Did the game hold the pointer before a DOM menu took it?
 *
 * Module state on purpose: the release can be started by the panel
 * mounting, by the panel closing, or by the engine's own request landing
 * late - and the "give it back" decision has to see all three.
 */
let hadPointerLock = false;

/** The game canvas, if the engine is up. */
function gameCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('canvas') as HTMLCanvasElement | null;
}

/**
 * Give the pointer up, because a DOM menu is on screen.
 *
 * Remembers that the game had it, so `reclaimPointer()` can give it
 * back when the menu closes.
 *
 * @returns true if the lock was held and has been released
 */
export function releasePointerForMenu(): boolean {
  const canvas = gameCanvas();
  if (!canvas) return false;
  if (document.pointerLockElement !== canvas) return false;
  hadPointerLock = true;
  document.exitPointerLock?.();
  return true;
}

/**
 * Give the pointer back to the game, now that the menu is gone.
 *
 * The browser only grants a pointer lock from a user gesture, so this is
 * best-effort: if the request is refused the player clicks the canvas
 * and `engageInput` takes it, which is the normal flow anyway.
 *
 * @returns true if a lock was requested
 */
export function reclaimPointer(): boolean {
  const canvas = gameCanvas();
  if (!canvas) return false;
  if (!hadPointerLock) return false;
  hadPointerLock = false;
  if (document.pointerLockElement === canvas) return true;
  canvas.requestPointerLock?.().catch(() => {
    // Refused: the next click on the canvas takes it.
  });
  return true;
}
