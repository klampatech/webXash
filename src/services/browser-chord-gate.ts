// Keep the browser's own shortcuts out of a live match.
//
// WHY THIS EXISTS
// ---------------
// Kyle, playing a fullscreen match: "if i hit CTRL + a movement key (like
// WASD) it would trigger a browser modal to confirm if i wanted to leave
// the page or stay. ... we should probably block that so users can
// crouch and not get popups (very distracting)."
//
// The chord is Ctrl+W, the browser's "close this tab". Chromium RESERVES
// it: the W keydown is never dispatched to the renderer, so no DOM
// handler can cancel it. The browser attempts the close, which fires
// `beforeunload`, and the app's own unload guard (services/xash-loader.ts)
// cancels the unload — which is what turns the browser's close attempt
// into the "Leave site?" dialog.
//
// The fix has two halves, because Chromium treats chords in two ways
// (measured in real Chromium with real X11 chords, 2026-10-26 — see
// browser-chords.ts for the full matrix):
//
//   1. A DOM GATE for the chords Chromium delivers: a capture-phase
//      keydown listener that calls preventDefault(). That cancels the
//      browser's action (reload, save, find, print, tab switch, ...).
//
//   2. The KEYBOARD LOCK for the chords Chromium reserves: Ctrl+W,
//      Ctrl+T, Ctrl+N and Ctrl+Tab. `navigator.keyboard.lock()` makes
//      the browser hand those keys to the page instead of acting on
//      them, and then the same DOM gate cancels them.
//
// THE ENGINE STILL GETS THE KEY
// -----------------------------
// The gate calls preventDefault() and NOT stopImmediatePropagation().
// The engine's bind table has `bind "CTRL" "+duck"` and `bind "w"
// "+forward"`, so Ctrl+W is duck+forward IN THE GAME, and swallowing the
// key from the engine too would break crouching.
//
// preventDefault() is safe to use on a key the engine needs, because
// the engine cannot see it: the key event struct the generated glue
// builds carries ctrlKey/shiftKey/altKey/metaKey and the key/code, and
// has no `defaultPrevented` field at all.
//
// WHEN THE GATE IS ARMED
// ----------------------
// Only while a match is running. On the landing page the browser's
// shortcuts are the player's own — Ctrl+R to reload the page, Ctrl+F to
// search it — and the beforeunload guard that produces the dialog is not
// installed either. The gate is armed from the same place the guard is
// installed, and disarmed where the guard is removed.
//
// THE KEYBOARD LOCK'S LIMITS
// --------------------------
// Measured, not assumed:
//   - It only has effect in JS-initiated fullscreen. The game enters
//     fullscreen from the launch click (services/fullscreen.ts), so the
//     lock is taken on the fullscreenchange that follows.
//   - Chrome drops the lock when the tab is hidden, so it is re-taken on
//     visibilitychange.
//   - Chrome also drops it when fullscreen ends, so the same listener
//     re-takes it.
//   - It needs no live user gesture: measured, a lock requested 12
//     seconds after the click (past any transient activation) is granted
//     AND effective.
//   - No browser UI appears while it is held — checked by screenshotting
//     the whole X11 root window, not just the viewport, because browser
//     chrome is not in the viewport.
//   - Escape IS locked (since 2026-11-03). Locking it means a tap of
//     Escape reaches the page instead of being consumed by the browser
//     to leave fullscreen, so the game's own Escape flow runs: press
//     once to release the mouse, press again for the options overlay -
//     and the fullscreen stays put, so there is no resize and no lag.
//     The way out is the options overlay's "Leave fullscreen" button.
//   - The lock can be lost SILENTLY. Opening a second window and coming
//     back drops it with no event to announce it — not visibilitychange,
//     not blur, not focus. So the lock is re-asserted rather than being
//     taken once and trusted: when the player starts a chord (the
//     modifier keydown always reaches the page), when the window regains
//     focus, and on a slow heartbeat as a backstop.
//
// Firefox and Safari have no Keyboard Lock API, so on those browsers the
// reserved chords stay reserved. The DOM gate still covers everything
// Chromium delivers, which is most of it, and the beforeunload guard
// still catches the rest — the player gets the dialog rather than a
// silently closed tab, which is the safe failure mode.

import { isBrowserChord, LOCKED_KEY_CODES } from './browser-chords';
import { logDebug } from './debug-log';

/** Is the gate swallowing browser chords right now? */
let armed = false;

/** Is the keyboard lock currently held? */
let lockHeld = false;

/**
 * TypeScript's lib.dom has no Keyboard Lock API (it is still a WICG
 * draft), so the two members we use are declared here rather than
 * pulling in a whole @types package for them.
 */
interface KeyboardLockCapable {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockCapable | null {
  const nav = navigator as Navigator & { keyboard?: KeyboardLockCapable };
  return nav.keyboard ?? null;
}

/**
 * Take the keyboard lock, if the browser will give it.
 *
 * Only worth attempting while in fullscreen: that is the only state in
 * which Chromium honours it. The request is idempotent — Chrome allows
 * a second lock() over an existing one, and rejects the request only if
 * the document is not allowed to hold a lock at all.
 *
 * AND ONLY WHILE THE GAME HAS THE POINTER (2026-11-04)
 * ----------------------------------------------------
 * The lock claims Escape, and the first Escape has to keep the
 * fullscreen — which it only does while the lock is held. So the lock
 * is held exactly while the game has the pointer: the player is
 * playing, the mouse is captured, and the chords need protecting.
 *
 * When the pointer is let go (the Escape, the buy panel, the options
 * overlay) the lock is handed BACK. That is what lets the second
 * Escape reach the browser at all: a locked Escape is swallowed by the
 * lock, so ESC #2 would be lost and the options overlay would never
 * open. With the lock gone, ESC #2 leaves the fullscreen and the page
 * sees it as `fullscreenchange`.
 *
 * The reserved chords fall back to the `beforeunload` guard while the
 * lock is handed back, which is the defence that does not need it.
 */
async function takeKeyboardLock(): Promise<void> {
  if (!armed) return;
  if (!document.fullscreenElement) return;
  if (pointerReleased) {
    releaseKeyboardLock();
    return;
  }
  const kb = keyboardApi();
  if (!kb) return;
  try {
    await kb.lock([...LOCKED_KEY_CODES]);
    lockHeld = true;
    logDebug(`[chords] keyboard lock held: ${LOCKED_KEY_CODES.join(', ')}`);
  } catch (e) {
    // A refused lock is not fatal: the DOM gate still covers the chords
    // the browser delivers, and the reserved ones fall back to the
    // beforeunload guard.
    lockHeld = false;
    logDebug('[chords] keyboard lock refused:', e);
  }
}

/**
 * Is the pointer lock gone — i.e. does the game NOT have the mouse?
 *
 * The keyboard lock follows it (see `takeKeyboardLock`). Set from the
 * `pointerlockchange` event, and at arming time.
 */
let pointerReleased = false;

function onPointerLockChange(): void {
  pointerReleased = !document.pointerLockElement;
  if (pointerReleased) {
    // The mouse is free: hand the keyboard back, so the next Escape can
    // reach the browser (and the page).
    releaseKeyboardLock();
    return;
  }
  // The player is back in the game: take the protection again.
  void takeKeyboardLock();
}

/**
 * Is the keyboard lock currently held?
 *
 * The escape gate needs this: when the lock is held, the browser cannot
 * take the fullscreen with an Escape (the lock claims the key), so
 * there is nothing to put back. When it is NOT held — the browsers that
 * do not implement the Keyboard Lock API, or a lock the browser
 * refused — the browser is free to leave the fullscreen, and the page
 * can ask for it back.
 */
export function isKeyboardLockHeld(): boolean {
  return lockHeld;
}

function releaseKeyboardLock(): void {
  if (!lockHeld) return;
  const kb = keyboardApi();
  lockHeld = false;
  try {
    kb?.unlock();
  } catch {
    // Nothing to do — the browser has already dropped it.
  }
}

/**
 * The DOM gate.
 *
 * Capture phase on `window`, so it runs before the engine's own listener
 * — though that only matters for stopImmediatePropagation(), which this
 * deliberately does NOT call.
 *
 * It does double duty. Besides swallowing the chord, it re-asserts the
 * keyboard lock when a MODIFIER goes down — see the note on
 * `relockOnModifier` below.
 */
function onKeyDown(e: KeyboardEvent): void {
  if (!armed) return;
  if (isModifierKey(e.code)) {
    relockOnModifier();
    return;
  }
  if (!isBrowserChord(e.code, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey })) return;
  // preventDefault() and NOT stopImmediatePropagation(): the engine must
  // still receive this key, or Ctrl+W stops being duck+forward.
  e.preventDefault();
  logDebug(`[chords] swallowed ${e.code}`);
}

/** The modifier keys that can start a browser chord. */
function isModifierKey(code: string): boolean {
  return (
    code === 'ControlLeft' ||
    code === 'ControlRight' ||
    code === 'MetaLeft' ||
    code === 'MetaRight' ||
    code === 'AltLeft' ||
    code === 'AltRight'
  );
}

/**
 * Re-assert the keyboard lock the moment the player starts a chord.
 *
 * WHY THIS IS THE RIGHT TRIGGER
 * -----------------------------
 * Chromium drops the keyboard lock when the document loses focus, and it
 * does not always say so. Measured in real Chromium, 2026-10-26:
 *
 *   - Two chords in a row with no focus change: BOTH delivered. So the
 *     chord does not consume the lock.
 *   - Open a second window, then come back: the next Ctrl+W was
 *     RESERVED again — the lock was gone — and NO event had fired.
 *     Not `visibilitychange` (the tab was never hidden: the second page
 *     was a separate window), not `blur`, not `focus`.
 *
 * A silent loss cannot be handled by reacting to an event, because
 * there is no event. But there IS a signal that arrives exactly when
 * the protection is needed: the modifier keydown.
 *
 * Chromium's reserved chords swallow the LETTER, never the modifier —
 * every reserved-chord measurement showed the ControlLeft keydown
 * arriving at the page while the W did not. So the moment the player
 * starts crouching is the moment to re-assert the lock, and it is the
 * moment the lock has to be held for.
 *
 * The race is not a race in practice: measured, lock() resolves in
 * about 1 ms, and a chord fired with a 0 ms gap between the ControlLeft
 * keydown and the W keydown still arrived at the page. The player's own
 * finger takes longer than that.
 */
function relockOnModifier(): void {
  // Only worth doing if the lock might actually be gone. Re-asserting
  // an intact lock is free (Chrome allows a second lock() over an
  // existing one), but there is no reason to do it when the game is
  // not in fullscreen — the lock has no effect there anyway.
  if (!document.fullscreenElement) return;
  void takeKeyboardLock();
}

/**
 * Chrome drops the keyboard lock when the tab is hidden and when
 * fullscreen ends. Both are visible as events, so both are handled here.
 */
function onFullscreenChange(): void {
  if (!document.fullscreenElement) {
    releaseKeyboardLock();
    return;
  }
  void takeKeyboardLock();
}

function onVisibilityChange(): void {
  if (document.hidden) {
    releaseKeyboardLock();
    return;
  }
  void takeKeyboardLock();
}

/**
 * Re-assert the lock when the window regains focus.
 *
 * WHY THIS EXISTS — and it is not a guess
 * ---------------------------------------
 * Chromium drops the keyboard lock when the DOCUMENT loses focus, and
 * it does not always say so. Measured in real Chromium, 2026-10-26:
 *
 *   - Two chords in a row, no focus change: BOTH delivered. So the
 *     chord does not consume the lock.
 *   - Open a second window, then come back: the next Ctrl+W was
 *     RESERVED again — the lock was gone — and NO event had fired.
 *     Not `visibilitychange` (the tab was never hidden: the second
 *     page was a separate window), not `blur`, not `focus`.
 *   - A lock CAN be taken while the document is unfocused, so
 *     re-locking is possible; it just has to be asked for.
 *
 * So the loss can be silent, and the only reliable way to be sure the
 * reserved chords are still blocked is to keep asking for the lock.
 *
 * The cost is one lock() call per focus gain and one per heartbeat.
 * Chrome allows a second lock() over an existing one (measured), so the
 * re-assert is a no-op in the normal case rather than an error.
 */
function onWindowFocus(): void {
  void takeKeyboardLock();
}

/**
 * The heartbeat: re-assert the lock periodically while a match is live.
 *
 * This is the belt to the braces. The crouch-key trigger (see
 * `relockOnModifier`) is the primary defence — it fires at the exact
 * moment the protection is needed. The focus handler covers a
 * regained window. The heartbeat covers what neither can: a silent
 * loss followed by a chord typed with no modifier keydown in between.
 *
 * Measured: re-asserting the lock opens no gap, at any interval
 * tested (150 ms, 400 ms, 1 s — chords fired continuously through the
 * heartbeat were all delivered, none reserved). Five seconds is
 * therefore plenty: it is the backstop, not the mechanism.
 */
const RELOCK_INTERVAL_MS = 5_000;
let relockTimer: ReturnType<typeof setInterval> | null = null;

function startRelockHeartbeat(): void {
  if (relockTimer !== null) return;
  relockTimer = setInterval(() => {
    if (!armed) return;
    // While the pointer is released the lock is deliberately NOT held:
    // it claims Escape, and a locked Escape never reaches the browser
    // or the page.
    if (pointerReleased) return;
    void takeKeyboardLock();
  }, RELOCK_INTERVAL_MS);
}

function stopRelockHeartbeat(): void {
  if (relockTimer === null) return;
  clearInterval(relockTimer);
  relockTimer = null;
}

/**
 * Install the gate. Idempotent.
 *
 * Called at module load from main.ts, so the listener exists before the
 * engine boots — and, more importantly, so that the fullscreen request
 * the launch click makes is followed by a fullscreenchange we are
 * already listening for.
 */
export function installBrowserChordGate(): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = '__xashBrowserChordGateInstalled';
  if ((window as unknown as Record<string, unknown>)[key]) return () => {};
  (window as unknown as Record<string, unknown>)[key] = true;

  window.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('focus', onWindowFocus);
  logDebug('[chords] gate installed');

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('focus', onWindowFocus);
    stopRelockHeartbeat();
    releaseKeyboardLock();
    armed = false;
  };
}

/**
 * Start swallowing browser chords.
 *
 * Called when the match starts. Takes the keyboard lock too, if the
 * game is already in fullscreen (it is: the launch click asked for
 * fullscreen before the download began).
 */
export function armBrowserChordGate(): void {
  if (armed) return;
  armed = true;
  logDebug('[chords] gate armed');
  // The lock follows the pointer: at the start of a match the player has
  // not clicked into the game yet, so the mouse is free and the lock is
  // not taken.
  pointerReleased = !document.pointerLockElement;
  void takeKeyboardLock();
  startRelockHeartbeat();
}

/**
 * Stop swallowing browser chords and hand the keyboard lock back.
 *
 * Called when the match ends, so the landing page behaves like a normal
 * web page again.
 */
export function disarmBrowserChordGate(): void {
  if (!armed) return;
  armed = false;
  pointerReleased = false;
  stopRelockHeartbeat();
  releaseKeyboardLock();
  logDebug('[chords] gate disarmed');
}
