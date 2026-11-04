// Escape handling for the browser client.
//
// WHY THIS EXISTS
// ---------------
// The engine's own bind table (ts/config.cfg) has `bind "ESCAPE" "cancelselect"`,
// and `cancelselect` opens the GoldSrc main menu — the "dump out of the
// server and land in the Half-Life menu" problem, with a Quit button in it.
// Kyle's route out of the game today is: Escape → HL menu → Quit → black screen.
//
// The engine's key listener is registered on `window`, so keeping Escape away
// from it means stopping the DOM event BEFORE the engine's listener runs.
// Three things make that reliable:
//
//   1. We register on `window` with `capture: true`, at MODULE LOAD —
//      before the WASM engine boots and registers its own listener. Listeners
//      on the same node fire in registration order, so ours is first. The
//      engine's Emscripten build registers on window (`specialHTMLTargets =
//      [0, document, window]`, target index 2).
//   2. We call `stopImmediatePropagation()`, not `stopPropagation()`. In the
//      capture phase at `window` that kills the remaining listeners on that
//      node AND the rest of the propagation — so it does not matter whether
//      the engine registered with `useCapture` true or false.
//   3. We ALSO rebind ESCAPE in the engine's own bind table (see
//      `UNWANTED_BINDS` in xash-loader.ts). Belt and braces: even if an event
//      slipped past us, the engine has nothing bound to run.
//
// THE TWO-STEP ESCAPE
// -------------------
//   Escape #1  releases the pointer lock, so the mouse is free and the
//              player can reach the browser chrome. A short hint says so.
//   Escape #2  opens the options overlay.
//
// This is a state machine rather than a read of `document.pointerLockElement`,
// because the browser ALSO exits pointer lock on Escape, on its own, before
// our handler necessarily runs. Reading the live pointer-lock state would
// therefore make the first press look like the second.
//
// ESCAPE #1 IS DETECTED FROM THE POINTER LOCK, NOT FROM THE KEY (2026-11-04)
// -----------------------------------------------------------------------
// The keyboard lock claims Escape, so in Chromium the keydown NEVER reaches
// the page - a locked key is not delivered to the renderer at all. Measured
// in real Chrome 151 on a virtual display, with real X11 key events:
//
//   - with the keyboard lock on Escape: the fullscreen SURVIVES the Escape,
//     the page sees NO keydown, and the browser releases the pointer lock;
//   - without it: the browser eats the Escape, exits the fullscreen, and
//     the page still sees no keydown.
//
// So in the locked case the ONLY signal that Escape #1 happened is the
// POINTER LOCK going away - which the browser does on Escape, and which
// arrives as `pointerlockchange`. That event is now what advances the
// state machine. Without this, the first press would be lost and the
// second press would be read as the first.
//
// The keydown path stays, and is what the browsers WITHOUT the keyboard
// lock use (Firefox, Safari, and Chromium when the lock was refused): in
// those, the page does hear the Escape.
//
// The SECOND press is taken by the BROWSER, not by the page: the chord
// gate hands the keyboard lock back when the pointer is let go (the
// chords no longer need protecting once the mouse is free), so the
// second Escape reaches the browser, which takes the fullscreen with it
// and eats the key. The `fullscreenchange` handler below is that
// signal.
//
// THE FULLSCREEN
// --------------
// With the keyboard lock held, an Escape no longer leaves the fullscreen:
// there is no resize behind it, and so no re-scaling and no lag. The way
// out of the fullscreen is the options overlay's "Leave fullscreen"
// button. Without the keyboard lock (Firefox, Safari, a refused lock) the
// browser still takes the fullscreen, and the `fullscreenchange` handler
// below stands in for the lost step.

import { ref } from 'vue';
import { logDebug } from './debug-log';
import { enterFullscreen } from './fullscreen';
import { isKeyboardLockHeld } from './browser-chord-gate';
import { exitFullscreen } from './fullscreen';
import { logBrowserCapabilities } from './browser-capabilities';
import { isDomMenuOnScreen } from './pointer-ownership';

/** Is the options overlay open? */
export const overlayOpen = ref(false);

/** 'game' = in play, 'released' = the mouse has been let go. */
const stage = ref<'game' | 'released'>('game');

/** Transient hint text shown after the mouse is released. */
export const hint = ref<string | null>(null);

let hintTimer: ReturnType<typeof setTimeout> | null = null;

function showHint(text: string) {
  hint.value = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hint.value = null;
    hintTimer = null;
  }, 6000);
}

/** Open the options overlay. */
export function openOverlay() {
  overlayOpen.value = true;
  logDebug('[escape] options overlay opened');
}

/** Close the options overlay and return to the game. */
export function closeOverlay() {
  overlayOpen.value = false;
  logDebug('[escape] options overlay closed');
}

/**
 * The player re-engaged the game (clicked the canvas), so the next Escape
 * starts from the beginning of the sequence again.
 */
export function notePointerLocked() {
  stage.value = 'game';
  // The mouse is back in the game: the hint has done its job.
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
  hint.value = null;
}

/**
 * Handle one Escape press.
 *
 * Split out from the listener so it can be exercised without synthesising a
 * DOM event.
 */
export function handleEscape(): void {
  if (overlayOpen.value) {
    closeOverlay();
    stage.value = 'released';
    return;
  }
  if (stage.value === 'game') {
    stage.value = 'released';
    // The browser exits pointer lock on Escape too; this makes it
    // deterministic and covers the case where the browser does not.
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }
    // Same rule as the pointer-lock signal: the Escape sequence's hint
    // belongs to the GAME, not to a menu that has the mouse.
    if (!isDomMenuOnScreen()) {
      showHint('Mouse released — press Esc again for options');
    }
    logDebug('[escape] pointer lock released');
    return;
  }
  openOverlay();
}

/**
 * When the pointer lock was released, in page time.
 *
 * This tells the two kinds of fullscreen exit apart:
 *
 *   - CHROMIUM: ESC #1 releases the POINTER and leaves the fullscreen
 *     alone; ESC #2 leaves the fullscreen. So a fullscreen exit with
 *     the pointer already free is ESC #2, and the options overlay opens.
 *   - FIREFOX / SAFARI: ESC #1 leaves the fullscreen AND releases the
 *     pointer. Those two events arrive together, so that fullscreen exit
 *     is NOT ESC #2 - the pointer was let go in the same breath.
 *
 * A press and its release are milliseconds apart; two presses are a
 * human's second apart. So "was the pointer released in this same
 * moment" is the question, and the answer is a timestamp.
 */
let pointerReleasedAt = 0;

/** Two events this close together are one press. */
const SAME_MOMENT_MS = 120;

/**
 * The player asked to leave the fullscreen (the options overlay's
 * toggle). The browser taking it is what they wanted, so it is not put
 * back.
 */
let fullscreenExitRequested = false;

/**
 * We asked for the fullscreen back, and are waiting to see whether the
 * browser kept it.
 *
 * The browser can take the fullscreen with an Escape when the keyboard
 * lock is not held — the browsers that do not implement the Keyboard
 * Lock API (Vivaldi among them, measured on Kyle's MacBook), or a lock
 * the browser refused. In those, the Escape leaves the fullscreen and
 * the page hears nothing, because the browser ate the key.
 *
 * So the page asks for the fullscreen back: the Escape press is still a
 * live user gesture, and `requestFullscreen()` only works from one.
 */
let restoreInFlight = false;

/**
 * The player asked to leave the fullscreen.
 *
 * Called by the options overlay's toggle, so that the browser's exit is
 * not undone.
 */
export function noteFullscreenExitRequested(): void {
  fullscreenExitRequested = true;
}

/**
 * Put the fullscreen back.
 *
 * The keyboard lock does NOT stop the browser leaving the fullscreen in
 * every browser: Vivaldi 8.2 implements the Keyboard Lock API (the
 * Blink bindings are in its binary) and still leaves the fullscreen on
 * Escape, because the browser UI's "Escape leaves fullscreen" is not
 * gated by the page's key lock. So the lock's state is only worth
 * LOGGING here, not deciding on.
 *
 * In Chromium the lock IS honoured, the browser never takes the
 * fullscreen, and this is never called — so there is no flicker there.
 */
function restoreFullscreen(): void {
  restoreInFlight = true;
  logDebug(
    '[escape] asking for the fullscreen back (keyboard lock held:',
    isKeyboardLockHeld(),
    ')',
  );
  void enterFullscreen().then((ok) => {
    logDebug('[escape] fullscreen restored:', ok);
    if (!ok) restoreInFlight = false;
  });
}

/**
 * The pointer lock went away (or came back).
 *
 * THIS IS THE "ESCAPE #1" SIGNAL (2026-11-04). The keyboard lock claims
 * Escape, so a locked Escape never reaches the page - but the browser
 * still releases the pointer lock when Escape is pressed, and THAT
 * arrives here. Measured in real Chrome: with the lock on Escape, the
 * page saw no keydown at all, and the pointer lock went away.
 *
 * So the state machine advances on this event, not on the key. Without
 * it the first press would be lost and the second would be read as the
 * first, and the options overlay would never open.
 *
 * The pointer lock can also go away for other reasons (the player
 * pressed Escape in a menu, the browser dropped it). They all mean the
 * same thing to the player: the mouse is free.
 */
function onPointerLockChange(): void {
  if (document.pointerLockElement) {
    // The player clicked back into the game — or the engine's own menu
    // took the pointer back.
    //
    // The hint has to GO with it: it is about the Escape sequence ("the
    // mouse is free, press Esc again for options"), and while it is up
    // next to the engine's own "PRESS ESC TO RELEASE POINTER" it reads
    // as a contradiction. Kyle reported exactly that: the engine's modal
    // and our message on screen at the same time.
    stage.value = 'game';
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = null;
    hint.value = null;
    return;
  }
  if (stage.value !== 'game') return;
  stage.value = 'released';
  pointerReleasedAt = performance.now();
  // Only tell the player about the Escape sequence when the GAME lost the
  // pointer. When a DOM MENU took it, the mouse being free is the menu's
  // doing and the panel says so itself — the hint would be wrong there
  // ("press Esc again for options" while the player is in a menu).
  if (!isDomMenuOnScreen()) {
    showHint('Mouse released — press Esc again for options');
  }
  logDebug('[escape] pointer lock released');
}

/**
 * Install the gate. Idempotent.
 *
 * Called at module load from main.ts, so the listener exists before the
 * engine can register its own.
 */
export function installEscapeGate(): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = '__xashEscapeGateInstalled';
  if ((window as unknown as Record<string, unknown>)[key]) return () => {};
  (window as unknown as Record<string, unknown>)[key] = true;

  // The browser CONSUMES an Escape that leaves fullscreen: the keydown
  // never reaches the page, so the state machine below would lose a step
  // (the next Escape would be read as "release the mouse" when the mouse
  // was released long ago). Leaving fullscreen means the same thing to
  // the player as Escape #1 — let go of the mouse — so it is treated as
  // one, from the signal the browser does deliver.
  //
  // In Chromium this is a FALLBACK: the keyboard lock claims Escape,
  // so a tap no longer leaves the fullscreen at all (see
  // `browser-chords.ts`). It still fires when the player leaves the
  // fullscreen deliberately — the options overlay's "Leave fullscreen".
  const onFullscreenChange = () => {
    if (document.fullscreenElement) {
      // The fullscreen is back — our restore landed.
      restoreInFlight = false;
      return;
    }
    const pointerHeld = !!document.pointerLockElement;
    const sameMoment = performance.now() - pointerReleasedAt < SAME_MOMENT_MS;

    if (fullscreenExitRequested) {
      // The player asked for this (the options overlay's toggle). Leave
      // it alone.
      fullscreenExitRequested = false;
      restoreInFlight = false;
      if (document.pointerLockElement) document.exitPointerLock?.();
      stage.value = 'released';
      pointerReleasedAt = performance.now();
      logDebug('[escape] left fullscreen at the player\'s request');
      return;
    }

    if (restoreInFlight) {
      // The browser dropped the fullscreen we asked for. That is the
      // browser's own exit, not a second Escape, so it must not be read
      // as one.
      restoreInFlight = false;
      logDebug('[escape] the browser kept the fullscreen exit');
      return;
    }

    if (stage.value === 'released' && !sameMoment && !pointerHeld) {
      // ESC #2: the browser took the fullscreen (it eats that key, so
      // the keydown never arrives) and this event is the only signal
      // there is. The options overlay opens over it.
      logDebug('[escape] left fullscreen after the pointer was let go; options');
      openOverlay();
      return;
    }

    // ESC #1, or the browser leaving the fullscreen on its own: the
    // player pressed Escape to let go of the MOUSE, not to leave the
    // fullscreen. So ask for the fullscreen back.
    //
    // This is the Vivaldi case: it implements the Keyboard Lock API and
    // still leaves the fullscreen on Escape, because the browser UI's
    // "Escape leaves fullscreen" is not gated by the page's key lock.
    // The Escape press is still a live user gesture, and
    // `requestFullscreen()` only works from one.
    if (pointerHeld) {
      document.exitPointerLock?.();
    }
    if (stage.value === 'game') {
      stage.value = 'released';
      showHint('Mouse released — press Esc again for options');
    }
    pointerReleasedAt = performance.now();
    logDebug('[escape] left fullscreen; pointer released; asking for it back');
    restoreFullscreen();
  };

  /**
   * The browser refused to lock the pointer.
   *
   * Safari cannot lock the pointer while the page is fullscreen (a
   * WebKit bug, reported in 2024): the lock is refused outright, and a
   * game with the mouse free and no cursor is unplayable.
   *
   * So when the lock fails while we are fullscreen, LEAVE the
   * fullscreen: the mouse is worth more than the screen, and the
   * options overlay's fullscreen toggle is there for the player who
   * wants it back.
   */
  const onPointerLockError = () => {
    if (!document.fullscreenElement) return;
    logDebug('[escape] the pointer lock failed while fullscreen; leaving it');
    exitFullscreen();
    showHint(
      'This browser cannot capture the mouse in fullscreen — left fullscreen',
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Escape' && e.key !== 'Escape') return;
    // Stop the engine from seeing it. See the note at the top of the file.
    e.stopImmediatePropagation();
    e.preventDefault();
    handleEscape();
  };

  window.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  logDebug('[escape] gate installed');

  // What this browser can do, on the console, at `info` level so it is
  // always there. It is the first thing to ask for when a player
  // reports something browser-shaped.
  logBrowserCapabilities();

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('pointerlockerror', onPointerLockError);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    (window as unknown as Record<string, unknown>)[key] = false;
  };
}
