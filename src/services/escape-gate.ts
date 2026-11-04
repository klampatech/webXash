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
    showHint('Mouse released — press Esc again for options');
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
    // The player clicked back into the game.
    stage.value = 'game';
    return;
  }
  if (stage.value !== 'game') return;
  stage.value = 'released';
  pointerReleasedAt = performance.now();
  showHint('Mouse released — press Esc again for options');
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
    if (document.fullscreenElement) return;
    const pointerHeld = !!document.pointerLockElement;
    const sameMoment = performance.now() - pointerReleasedAt < SAME_MOMENT_MS;

    if (pointerHeld) {
      // The browser is letting go of the pointer as it leaves the
      // fullscreen: one press, two effects (this is what Firefox and
      // Safari do on the FIRST Escape).
      document.exitPointerLock?.();
      if (stage.value === 'game') {
        stage.value = 'released';
        showHint('Mouse released — press Esc again for options');
      }
      pointerReleasedAt = performance.now();
      logDebug('[escape] left fullscreen; pointer released');
      return;
    }

    // The pointer was ALREADY free. In Chromium that is ESC #2: the
    // browser eats the Escape that leaves the fullscreen, so the keydown
    // never arrives and this event is the only signal there is.
    if (stage.value === 'released' && !sameMoment) {
      logDebug('[escape] left fullscreen after the pointer was let go; options');
      openOverlay();
      // The fullscreen is NOT put back here on purpose. The browser
      // latches "the user pressed Escape to leave the fullscreen", and a
      // fullscreen entered while that latch is set is dropped again
      // immediately - measured: the fullscreen came back and left again
      // in the same tick. That is a flicker, not a fix.
      //
      // So the browser's exit stands, the options overlay opens over it,
      // and the resize behind it is painless: the render resolution is a
      // pixel budget, so the engine never renders more pixels than the
      // window can show. The overlay has an "Enter fullscreen" button
      // for the player who wants it back.
      return;
    }

    if (stage.value === 'game') {
      stage.value = 'released';
      showHint('Mouse released — press Esc again for options');
    }
    logDebug('[escape] left fullscreen; pointer released');
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
  document.addEventListener('fullscreenchange', onFullscreenChange);
  logDebug('[escape] gate installed');

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    (window as unknown as Record<string, unknown>)[key] = false;
  };
}
