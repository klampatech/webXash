/**
 * BulletBallet — the brand guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine hijacks `document.title`. Verified on the live site: the
 * static HTML said "The Specialists", but the runtime title was
 * "🐴 The Specialists" — xash3d-fwgs sets `document.title` from the
 * engine's own window title once it boots (`document.title =
 * UTF8ToString(title)` in `dist/raw.js`).
 *
 * So `index.html` governs the landing page, which is where the brand
 * matters most — but the tab reverts to the game's title the moment you
 * enter a match. This takes the title back and KEEPS it: a
 * MutationObserver on the `<title>` element fires when the engine
 * overwrites it, and we put ours back.
 *
 * It does not loop. Our own write triggers the observer again, and the
 * observer only writes when the title is not already ours.
 */

export const BRAND_TITLE = 'BulletBallet — The Specialists in your browser';

export function claimDocumentTitle(): void {
  if (typeof document === 'undefined') return;

  const set = () => {
    if (document.title !== BRAND_TITLE) document.title = BRAND_TITLE;
  };

  set();

  const titleEl = document.querySelector('title');
  if (!titleEl) return;

  const observer = new MutationObserver(set);
  observer.observe(titleEl, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}
