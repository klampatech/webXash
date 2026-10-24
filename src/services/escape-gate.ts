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
  }, 3500);
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
  const onFullscreenChange = () => {
    if (document.fullscreenElement) return;
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }
    stage.value = 'released';
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
  document.addEventListener('fullscreenchange', onFullscreenChange);
  logDebug('[escape] gate installed');

  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    (window as unknown as Record<string, unknown>)[key] = false;
  };
}
