// D.7.28 — Live-state bridge for the TS HUD overlay.
//
// The engine WASM exports `Cmd_ExecuteString(cmd)` as a public
// method on the Xash3D wrapper class. That gives us a read/write
// channel into the running engine without touching the server DLL
// at all — which matters because the 283-import WASM is unloadable
// in any browser.
//
// Reading a cvar: `Cmd_ExecuteString('<name>')` — a BARE cvar name
// is how Xash3D reads a cvar's value. The engine prints
// `"<name>" is "<value>" ( "<default>" )` to stdout, which our
// emitXashLog bridge forwards to the `xash:stdout` window event. We
// match the emitted line back to the requested slot.
//
// NOTE: there is no `cvar` subcommand in Xash3D — `cvar hostmap`
// returns "Unknown command: cvar". The bare name is the mechanism.
//
// Verified output shapes (Playwright, D.7.28):
//   "host_framerate" is "0" ( "0" )
//   "mp_teamlist" is "hgrunt;scientist"
//   "name" is "Specialist" ( "Player" )
//   Unknown command: roundtime      <- TS cvars are NOT registered
//
// That last one is the honest state of affairs: the engine does not
// know `roundtime` or `slowmatch`, because our server DLL is
// vanilla HL1. So the live bridge reports what the engine DOES know
// (map, teamlist, framerate, player name, cheat state) and counts
// the TS entities it failed to spawn.

import XashLoader from '/@/services/xash-loader';

export interface LiveState {
  /** Value of the engine's `hostmap` cvar — the live map name. */
  mapName: string;
  /** Value of `mp_teamlist` — the server's team model list. */
  teamList: string;
  /** Value of `host_framerate`. */
  hostFramerate: string;
  /** Value of `sv_cheats`. */
  svCheats: string;
  /** The local player's name. */
  playerName: string;
  /** TS cvars we asked for that the engine rejected (proves gap). */
  missingTsCvars: string[];
  /** Distinct TS entities that failed to spawn (deduped). */
  missingSpawnEntities: string[];
  /** Recent engine stdout lines, capped. */
  recentLines: string[];
}

const PROBE_CVARS = [
  'hostmap',
  'mp_teamlist',
  'host_framerate',
  'sv_cheats',
  'name',
] as const;


/** TS-specific cvars we probe once to document the gap. */
// TS cvar probes removed in D.7.28c — these only ever produced
// 'Unknown command' responses (vanilla HL1 server DLL doesn't
// register them). Kept here as a comment for future reference.
// const TS_CVAR_PROBES = ['roundtime', 'slowmatch', 'lastmanstanding', 'mp_teammodels'];

const state: LiveState = {
  mapName: '',
  teamList: '',
  hostFramerate: '',
  svCheats: '',
  playerName: '',
  missingTsCvars: [],
  missingSpawnEntities: [],
  recentLines: [],
};

const listeners = new Set<(s: LiveState) => void>();
let probeTimer: number | null = null;
let unwatch: Array<() => void> = [];

function notify() {
  for (const fn of listeners) fn(state);
}

function onEngineLine(rawLine: string) {
  // Engine prefixes its prints with a [HH:MM:SS] timestamp.
  const line = rawLine.replace(/^\s*\[\d{2}:\d{2}:\d{2}\]\s*/, '').trim();
  if (!line) return;

  // --- cvar read response: `"name" is "value" ( "default" )`
  // Checked BEFORE recentLines so the probe traffic doesn't flood
  // the diagnostic buffer. These are our own echoes — consuming them
  // here keeps the console readable.
  const cvarMatch = line.match(/^"([^"]+)"\s+is\s+"([^"]*)"/);
  if (cvarMatch) {
    const [, name, value] = cvarMatch;
    // D.7.28c: drop the `awaiting` guard. The burst issues all 5
    // probes synchronously, so `awaiting` ends up set to the LAST
    // cvar and the earlier responses get filtered out as mismatches.
    // Match by name directly.
    if (name === 'hostmap') state.mapName = value;
    else if (name === 'mp_teamlist') state.teamList = value;
    else if (name === 'host_framerate') state.hostFramerate = value;
    else if (name === 'sv_cheats') state.svCheats = value;
    else if (name === 'name') state.playerName = value;
    notify();
    return;
  }

  state.recentLines.push(line);
  if (state.recentLines.length > 60) state.recentLines.shift();

  // --- TS cvar rejection: `Unknown command: roundtime`
  // Even though we no longer PROBE TS cvars at boot (D.7.28c), the
  // engine may still print Unknown-command lines when the user types
  // TS commands in the console drawer. Capture them passively so the
  // HUD's MISSING row stays informative.
  const unknownMatch = line.match(/^Unknown command:\s*"?([^"\s]+)"?/);
  if (unknownMatch) {
    const cvar = unknownMatch[1];
    if (!state.missingTsCvars.includes(cvar)) {
      state.missingTsCvars.push(cvar);
      notify();
    }
    return;
  }

  // --- TS entity spawn failure: `Error: No spawn function for "ts_powerup"`
  const spawnMatch = line.match(/No spawn function for "([^"]+)"/);
  if (spawnMatch) {
    const ent = spawnMatch[1];
    if (!state.missingSpawnEntities.includes(ent)) {
      state.missingSpawnEntities.push(ent);
      notify();
    }
  }
}

/** Begin polling the engine for live state. Returns a stop function. */
export function startLiveState(): () => void {
  const onOut = (e: Event) => {
    const d = (e as CustomEvent).detail as { line?: string };
    if (d?.line) onEngineLine(d.line);
  };
  window.addEventListener('xash:stdout', onOut);
  window.addEventListener('xash:stderr', onOut);

  // D.7.28c: the "_Mem_Alloc: pool == NULL" alert at
  // engine/common/cmd.c:638 is PRE-EXISTING, not caused by this
  // bridge. Verified by stashing live-state.ts entirely and
  // reproducing the identical dialog on a pristine D.7.27 baseline
  // (zero cvar probes, zero argv changes). It fires either way.
  //
  // Polling is kept because the strip needs to fill, but the cadence
  // is deliberately slow — one cvar every 4s, ~20s for a full cycle.
  // The cvars we read (hostmap, mp_teamlist, name) are all stable
  // boot-time values, so freshness costs nothing. The fast path is
  // D.7.28d: rolling poll only. The earlier "boot burst" was an
  // experiment — the engine silently swallowed probes issued during
  // its post-boot pre-ready window. Verified by [LS-trace] that
  // showed 4 of 5 burst probes come back, with hostmap (the first
  // one) being the lost one. The 4s rolling poll is enough: all
  // 5 cvars get probed within ~20s, the engine isn't pressured,
  // and the strip fills in steadily.
  //
  // exec() is a no-op until the engine bridge is live (XashLoader.
  // setLiveInstance fires from xash-loader.ts after init()), so
  // poll calls before then are safely ignored. The first 1-2 cvar
  // reads in the poll cycle might silently miss too, but they
  // retry automatically as the cycle continues.
  //
  // Start the first probe at t+6s (slightly after the engine
  // typically boots) and continue every 4s thereafter.
  let probeIdx = 0;
  window.setTimeout(() => {
    XashLoader.exec(PROBE_CVARS[probeIdx % PROBE_CVARS.length]);
    probeIdx++;
  }, 6000);
  probeTimer = window.setInterval(() => {
    XashLoader.exec(PROBE_CVARS[probeIdx % PROBE_CVARS.length]);
    probeIdx++;
  }, 4000);

  // TS-cvar probes removed (D.7.28c): those probes only ever
  // returned "Unknown command: <name>" — net negative value, plus
  // they pile onto the cmd-pool. The HUD strip now reports
  // TS cvars as "engine rejected at startup" via the boot-log
  // capture, no live probing needed.

  return stopLiveState;
}

export function stopLiveState() {
  if (probeTimer) { window.clearInterval(probeTimer); probeTimer = null; }
  for (const fn of unwatch) fn();
  unwatch = [];
}

export function onLiveState(fn: (s: LiveState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function getLiveState(): LiveState {
  return state;
}