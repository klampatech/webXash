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

type ProbeKey = (typeof PROBE_CVARS)[number];

/** TS-specific cvars we probe once to document the gap. */
const TS_CVAR_PROBES = ['roundtime', 'slowmatch', 'lastmanstanding', 'mp_teammodels'];

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
let tsProbeTimer: number | null = null;
let tsProbeIdx = 0;
let tsProbeDone = false;
/** cvar name we just asked for, so we know what to parse next. */
let awaiting: ProbeKey | null = null;
/** TS cvar name we're expecting an "Unknown command" for. */
let awaitingTs: string | null = null;
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
    if (name === awaiting) {
      awaiting = null;
      if (name === 'hostmap') state.mapName = value;
      else if (name === 'mp_teamlist') state.teamList = value;
      else if (name === 'host_framerate') state.hostFramerate = value;
      else if (name === 'sv_cheats') state.svCheats = value;
      else if (name === 'name') state.playerName = value;
      notify();
      return;
    }
  }

  state.recentLines.push(line);
  if (state.recentLines.length > 60) state.recentLines.shift();

  // --- TS cvar rejection: `Unknown command: roundtime`
  const unknownMatch = line.match(/^Unknown command:\s*"?([^"\s]+)"?/);
  if (unknownMatch && unknownMatch[1] === awaitingTs) {
    awaitingTs = null;
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

  // Poll the readable cvars on a rolling schedule — one cvar every
  // 700ms so we cover the full set roughly every 3.5s without
  // spamming the engine console.
  let idx = 0;
  probeTimer = window.setInterval(() => {
    const key = PROBE_CVARS[idx % PROBE_CVARS.length];
    idx++;
    awaiting = key;
    // Bare cvar name — that IS the read command in Xash3D.
    XashLoader.exec(key);
  }, 900);

  // Probe the TS cvars once (they'll be rejected — that's the point).
  // We capture that rejection as documentation of what's missing.
  if (!tsProbeDone) {
    tsProbeTimer = window.setInterval(() => {
      if (tsProbeIdx >= TS_CVAR_PROBES.length) {
        if (tsProbeTimer) window.clearInterval(tsProbeTimer);
        tsProbeTimer = null;
        tsProbeDone = true;
        return;
      }
      const cvar = TS_CVAR_PROBES[tsProbeIdx++];
      awaitingTs = cvar;
      XashLoader.exec(cvar);
    }, 400);
  }

  return stopLiveState;
}

export function stopLiveState() {
  if (probeTimer) window.clearInterval(probeTimer);
  if (tsProbeTimer) window.clearInterval(tsProbeTimer);
  probeTimer = null;
  tsProbeTimer = null;
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