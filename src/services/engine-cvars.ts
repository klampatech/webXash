// Read and write engine cvars from the page.
//
// HOW
// ---
// The engine WASM exports `Cmd_ExecuteString(cmd)`. That gives us a
// read/write channel into the running engine without touching the server
// DLL — which matters because the WASM engine is unloadable in a browser.
//
// Reading a cvar: `Cmd_ExecuteString('<name>')` — a BARE cvar name is how
// Xash3D reads a cvar's value. The engine prints
// `"<name>" is "<value>" ( "<default>" )` to stdout, which the loader's
// stdout bridge forwards as an `xash:stdout` window event.
//
// NOTE: there is no `cvar` subcommand in Xash3D — `cvar hostmap` returns
// "Unknown command: cvar". The bare name is the mechanism.
//
// Writing a cvar: `Cmd_ExecuteString('<name> <value>')`.

import XashLoader from '/@/services/xash-loader';
import { logDebug } from './debug-log';

interface StdoutDetail {
  line?: string;
}

/**
 * A cvar's value, and the default it falls back to.
 *
 * The engine prints both:
 *
 *     "fov" is "0" ( "90" )
 *
 * The value in the middle is what the cvar HOLDS, and the one in the
 * brackets is what it FALLS BACK TO. They are not always the same:
 * the client library creates `fov` with a default of 90 and does not
 * write the value until a view exists, so a fresh client holds 0 and
 * would draw at 0 degrees — which is why the default is worth having.
 */
export interface CvarReading {
  /** The value the cvar holds, or null if the engine did not answer. */
  value: string | null;
  /** The cvar's own default, or null if the engine did not name one. */
  defaultValue: string | null;
}

/**
 * Read a cvar's value AND its default.
 *
 * Resolves with nulls if the engine did not answer in time.
 */
export function readCvarFull(name: string, timeoutMs = 2000): Promise<CvarReading> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: CvarReading) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('xash:stdout', onLine);
      clearTimeout(timer);
      resolve(v);
    };
    const onLine = (e: Event) => {
      const detail = (e as CustomEvent<StdoutDetail>).detail;
      const line = detail?.line ?? '';
      // `"sensitivity" is "2" ( "2" )`
      const m = line.match(new RegExp(`"${name}"\\s+is\\s+"([^"]*)"`));
      if (!m) return;
      const d = line.match(new RegExp(`"${name}"\\s+is\\s+"[^"]*"\\s*\\(\\s*"([^"]*)"`));
      finish({ value: m[1], defaultValue: d ? d[1] : null });
    };
    const timer = setTimeout(() => finish({ value: null, defaultValue: null }), timeoutMs);
    window.addEventListener('xash:stdout', onLine);
    logDebug(`[cvar] read ${name}`);
    XashLoader.exec(name);
  });
}

/**
 * Read a cvar's current value.
 *
 * Resolves with the value, or null if the engine did not answer in time.
 */
export function readCvar(name: string, timeoutMs = 2000): Promise<string | null> {
  return readCvarFull(name, timeoutMs).then((r) => r.value);
}

/** Write a cvar. */
export function writeCvar(name: string, value: string | number): void {
  logDebug(`[cvar] write ${name} = ${value}`);
  XashLoader.exec(`${name} ${value}`);
}
