/**
 * Canvas "loading" class — the Half-Life lambda spinner drawn behind the
 * WASM canvas.
 *
 * IMPORTANT CONTEXT: this is entirely frontend. `hl-spin.svg` is our
 * asset, styled by a scoped `.loading` rule in XashCanvas.vue. Nothing in
 * the WASM engine draws it. It is therefore fully ours to change — which
 * matters, because it used to sit on screen UNLABELLED during engine
 * start-up and read as a hang rather than as work in progress.
 *
 * The class was originally only ever added, never removed, so the spinner
 * background stayed on the canvas for the life of the session. It was
 * invisible in-game (the engine paints opaque pixels over it) but it was
 * dead state, and it meant the spinner could linger over a canvas the
 * engine had not drawn to yet.
 *
 * The original also appended to `className` as a string, which re-parses
 * the whole attribute and does nothing about idempotency; `classList`
 * handles both.
 */

const LOADING_CLASS = 'loading';

export function setCanvasLoading(): void {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  canvas.classList.add(LOADING_CLASS);
}

/** Remove the spinner background. Safe to call when it is not set. */
export function clearCanvasLoading(): void {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  canvas.classList.remove(LOADING_CLASS);
}

export default setCanvasLoading;