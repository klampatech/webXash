/**
 * What this browser can actually do.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Escape/fullscreen/pointer business is the one place where the
 * browsers genuinely disagree, and every disagreement is a bug report
 * waiting to happen:
 *
 *   - The **Keyboard Lock API** is Chromium only (Chrome 68+, Edge 79+,
 *     Opera 55+, Vivaldi — Firefox and Safari do not have it). So the
 *     page cannot count on owning the Escape key.
 *   - The **browser's own "Escape leaves fullscreen"** is hard-coded
 *     behaviour. Chromium's first Escape releases the POINTER LOCK
 *     instead and leaves the fullscreen alone; Firefox, Safari and
 *     Vivaldi leave the fullscreen straight away.
 *   - **Safari cannot lock the pointer while fullscreen** (a WebKit
 *     bug, reported in 2024): the mouse has to be captured FIRST and
 *     the fullscreen entered after, or the lock is refused outright.
 *
 * So the game cannot rely on any of it: it has to be told what is
 * there, and it has to have a way out that does not depend on the
 * browser's goodwill.
 *
 * WHAT IS REPORTED
 * ----------------
 * A one-line summary, logged at startup at `info` level (so it is
 * always there — it is the first thing to ask for when a player reports
 * something browser-shaped), and readable from the console.
 */

/** What the browser can do, as far as we can tell. */
export interface BrowserCapabilities {
  /** The DOM fullscreen API is present. */
  fullscreen: boolean;
  /** The Keyboard Lock API is present (`navigator.keyboard.lock`). */
  keyboardLock: boolean;
  /** The Pointer Lock API is present. */
  pointerLock: boolean;
  /** The user agent, trimmed to something readable. */
  userAgent: string;
}

/**
 * Detect what the browser can do.
 *
 * NOTHING HERE TAKES THE POINTER LOCK. The promise form of
 * `requestPointerLock()` is deliberately not probed: calling it would
 * take the pointer, and the whole business of this project is that the
 * pointer belongs to the game. A capability check must never take it.
 */
export function detectBrowserCapabilities(): BrowserCapabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const doc = typeof document !== 'undefined' ? document : undefined;
  const el = doc?.documentElement as
    | (Element & { requestFullscreen?: unknown })
    | undefined;

  return {
    fullscreen:
      typeof el?.requestFullscreen === 'function' &&
      typeof doc?.exitFullscreen === 'function',
    keyboardLock:
      !!(nav as unknown as { keyboard?: { lock?: unknown } }).keyboard?.lock,
    pointerLock:
      typeof doc !== 'undefined' &&
      'pointerLockElement' in doc &&
      typeof (globalThis as unknown as {
        Element?: { prototype?: { requestPointerLock?: unknown } };
      }).Element?.prototype?.requestPointerLock === 'function',
    userAgent: String(nav?.userAgent ?? 'unknown').slice(0, 120),
  };
}

/** A one-line, readable summary for the console. */
export function describeBrowserCapabilities(c: BrowserCapabilities): string {
  const yn = (v: boolean) => (v ? 'yes' : 'NO');
  return (
    `[browser] fullscreen=${yn(c.fullscreen)} ` +
    `keyboard-lock=${yn(c.keyboardLock)} ` +
    `pointer-lock=${yn(c.pointerLock)} ` +
    `| ${c.userAgent}`
  );
}

/** Detect and log in one call. */
export function logBrowserCapabilities(): BrowserCapabilities {
  const caps = detectBrowserCapabilities();
  console.log(describeBrowserCapabilities(caps));
  return caps;
}
