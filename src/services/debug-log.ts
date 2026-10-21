/**
 * Central logging gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * Per-packet tracing (`[bridge-send]` at netchan rates is thousands of
 * lines/minute) buried every other message in the console, including the
 * engine's own errors — so we literally could not see the keybind
 * failures we were trying to diagnose. Throttling alone was not enough
 * because the *useful* logs were just as buried.
 *
 * POLICY
 * ------
 *   - `info`  : always on. Errors, lifecycle, anything we always want.
 *   - `debug` : OFF unless asked for, via either
 *                 - URL flag:  ?debug=1  (or 1,trace,verbose,all)
 *                 - localStorage: xash.debug = '1'
 *   - `trace` : per-packet. Off unless ?debug=trace, so even a debug
 *               session stays readable.
 *
 * Enable it for a session with:
 *   https://<host>/webXash/?debug=trace
 * and turn it off again by removing the flag (no reload needed — the
 * gate reads the flag on every call, so editing the URL mid-session
 * takes effect immediately).
 */

const DEBUG_KEY = 'xash.debug';

export type LogLevel = 'info' | 'debug' | 'trace';

let cachedFlag: string | null | undefined;

/** The raw value from the URL, or null. Cached after the first read. */
function urlFlag(): string | null | undefined {
  if (cachedFlag !== undefined) return cachedFlag;
  try {
    cachedFlag = new URLSearchParams(window.location.search).get('debug');
  } catch {
    cachedFlag = null;
  }
  return cachedFlag;
}

/** Persisted opt-in, for when you don't want to edit the URL each time. */
function storedFlag(): string | null {
  try {
    return localStorage.getItem(DEBUG_KEY);
  } catch {
    return null;
  }
}

function enabled(level: LogLevel): boolean {
  const flag = urlFlag() ?? storedFlag();
  if (flag === null) return level === 'info';
  const v = flag.toLowerCase();
  if (v === '' || v === '0' || v === 'false' || v === 'off') return level === 'info';
  if (v === 'trace' || v === 'all') return true;
  // '1', 'true', 'debug', 'verbose', 'on' -> info + debug
  return level !== 'trace';
}

/** Always shown: errors, lifecycle, and anything the engine prints. */
export function logInfo(...args: unknown[]): void {
  console.log(...args);
}

/** Session detail: net layer setup, command dispatch, key injection. */
export function logDebug(...args: unknown[]): void {
  if (enabled('debug')) console.log(...args);
}

/** Per-packet. Only with ?debug=trace. */
export function logTrace(...args: unknown[]): void {
  if (enabled('trace')) console.log(...args);
}

/** True when debug logging is on — for gating expensive work. */
export function debugEnabled(): boolean {
  return enabled('debug');
}

/** Toggle from the console without editing the URL: `xashDebug('trace')`. */
export function xashDebug(level: string | null): string {
  try {
    if (level === null) localStorage.removeItem(DEBUG_KEY);
    else localStorage.setItem(DEBUG_KEY, level);
  } catch {
    /* private mode: the URL flag still works */
  }
  cachedFlag = undefined;
  return `xashDebug is now "${level ?? '(url only)'}" — reload to re-read the URL flag`;
}