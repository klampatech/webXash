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
 * Read a cvar's current value.
 *
 * Resolves with the value, or null if the engine did not answer in time.
 */
export function readCvar(name: string, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
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
      if (m) finish(m[1]);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('xash:stdout', onLine);
    logDebug(`[cvar] read ${name}`);
    XashLoader.exec(name);
  });
}

/** Write a cvar. */
export function writeCvar(name: string, value: string | number): void {
  logDebug(`[cvar] write ${name} = ${value}`);
  XashLoader.exec(`${name} ${value}`);
}

/** Run an engine command (not a cvar). */
export function runCommand(cmd: string): void {
  logDebug(`[cvar] exec ${cmd}`);
  XashLoader.exec(cmd);
}
