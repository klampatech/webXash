// server-banner.ts — wait for the engine to say it is in a game.
//
// WHY THIS EXISTS
// ---------------
// A reconnect has to be PROVEN, not assumed. The ways to be wrong are
// all easy to mistake for success:
//
//   - the page is alive               → says nothing about the game
//   - the WebSocket is open           → the transport, not the player
//   - the bridge counts a connection  → an inference, and the registry
//                                       cannot even see it (the bridge
//                                       keys its map by target id, the
//                                       registry by instance id)
//   - the countdown reached zero      → a timer, not an outcome
//
// The engine prints the server's banner on the console the moment the
// game server answers the handshake:
//
//   Server #1  "bulletballet TS" ( ...) ...
//
// That is the engine's own word that the handshake completed and the
// client is in the game. The deploy's browser gate uses the same line
// for the same reason — it is the only signal in the whole system that
// means "the player got in".
//
// The print arrives through the loader's stdout bridge as an
// `xash:stdout` window event, the same channel the buy-menu's `TSBUY`
// records come on.

/**
 * The engine's banner line.
 *
 * The same shape the deploy's browser gate matches on
 * (`tools/deploy/play-button-e2e.cjs`).
 */
const SERVER_BANNER = /Server #\d+/;

export interface BannerWaitOptions {
  /**
   * A cheap check on whether the fast path can still succeed.
   *
   * The engine's handshake runs over the WebSocket. If that socket dies
   * AGAIN while we wait, no banner can ever arrive — the fast path is
   * over, and the fallback (a page reload, which brings a fresh
   * transport) has to take over NOW rather than after the full window.
   *
   * Returns false to end the wait early.
   */
  stillPossible?: () => boolean;
  /** How often to ask `stillPossible`. */
  pollMs?: number;
}

/**
 * Resolve true when the engine reports the server's banner within
 * `timeoutMs`, false when it does not.
 *
 * The listener is attached before the caller triggers the reconnect, so
 * the banner cannot be missed between the trigger and the wait.
 */
export function waitForServerBanner(
  timeoutMs: number,
  options: BannerWaitOptions = {},
): Promise<boolean> {
  const { stillPossible, pollMs = 250 } = options;
  return new Promise((resolve) => {
    let settled = false;
    let poll = 0;

    const onOut = (e: Event) => {
      const detail = (e as CustomEvent).detail as { line?: string } | undefined;
      if (!detail?.line) return;
      if (!SERVER_BANNER.test(detail.line)) return;
      finish(true);
    };

    const timer = window.setTimeout(() => finish(false), timeoutMs);

    if (stillPossible) {
      poll = window.setInterval(() => {
        if (!stillPossible()) finish(false);
      }, pollMs);
    }

    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (poll) window.clearInterval(poll);
      window.removeEventListener('xash:stdout', onOut);
      resolve(ok);
    }

    window.addEventListener('xash:stdout', onOut);
  });
}
