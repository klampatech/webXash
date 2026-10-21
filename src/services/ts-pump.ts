// ts-pump.ts — drives the TS server DLL's game loop from JS.
//
// WHY THIS EXISTS (the important bit)
//
// Xash3D-FWGS's loopback connect never completes in webXash. The
// client sits at `ca_connecting` forever because `-noip -noip6`
// disables the socket path the loopback handshake needs
// (cl_main.c:1394-1404 → :1739-1753). Because the client never
// connects, the engine never dispatches the server frame loop, so
// `g_pGameRules->Think()` never runs — and with it, every TS
// gameplay hook (InitHUD, PlayerSpawn, Think, ...).
//
// The fix is to be the engine's frame clock ourselves. The server
// DLL registers `ts_pump` / `ts_pump_think` / `ts_spawn_player`
// as console commands (via `g_engfuncs.pfnAddServerCommand`), and
// `xash.Cmd_ExecuteString()` is the JS→DLL channel the harness
// already used. So:
//
//   setInterval(() => xash.Cmd_ExecuteString('ts_pump_think'), 16)
//
// drives TS game logic at ~60Hz regardless of what the engine's
// networking layer thinks it's doing.
//
// WHY A CONSOLE COMMAND AND NOT A DIRECT WASM CALL
//
// The xash3d-fwgs wrapper keeps `wasmExports` in a closure and
// never puts it on the Module object, so `em.cwrap()` /
// `em['ts_pump']` are all undefined — side-module exports are
// unreachable from JS that way (verified: 4 lookup paths all miss).
// Console commands are the one JS→DLL path the engine actually
// exposes.
//
// WHAT IS SAFE TO CALL
//
//   ts_pump_think  — verified working. Calls g_pGameRules->Think().
//   ts_pump        — same plus InitHUD/PlayerSpawn entity walks.
//   ts_spawn_player — currently traps (pfnCreateEntity +
//                     DispatchSpawn need a connected client). Kept
//                     behind a flag, off by default — see below.

import type { Xash3D } from 'xash3d-fwgs';

export interface PumpStats {
  /** Total ts_pump_think commands issued. */
  ticks: number;
  /** Wall-clock ms between the first and last tick. */
  elapsedMs: number;
  /** Ticks per second, averaged. */
  hz: number;
  /** Last error thrown by Cmd_ExecuteString, if any. */
  lastError: string | null;
  /** True once the first tick succeeded. */
  live: boolean;
}

/** Interval between ticks. 16ms ≈ 60Hz, matching GoldSrc's sv_fps. */
const TICK_MS = 16;

/** How long to wait after start before attempting a player spawn. */
const SPAWN_RETRY_DELAYS_MS = [2500, 6000, 12000];

export class TSPump {
  private timer: number | null = null;
  private spawnTimers: number[] = [];
  private xash: Xash3D | null = null;
  private startedAt = 0;
  private tickCount = 0;
  private lastError: string | null = null;
  private live = false;
  /** Spawn attempts are opt-in — they trap without a connected client. */
  private spawnEnabled: boolean;

  constructor(opts: { spawn?: boolean } = {}) {
    // Default OFF. Flip with ?tsspawn=1 in the URL to try it.
    this.spawnEnabled =
      opts.spawn ??
      (typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('tsspawn') === '1');
  }

  /**
   * Begin driving the DLL. Safe to call twice — the second call is
   * a no-op so a remount doesn't double the tick rate.
   */
  start(xash: Xash3D): void {
    if (this.timer !== null) return;
    this.xash = xash;
    this.startedAt = performance.now();
    this.tickCount = 0;
    this.lastError = null;

    this.timer = window.setInterval(() => {
      // Throttle: if the previous tick threw, don't spam. A trap in
      // WASM is usually fatal to the module, so back off to 1Hz and
      // surface the error rather than hammering it.
      if (this.lastError) return;
      try {
        this.xash?.Cmd_ExecuteString('ts_pump_think');
        this.tickCount++;
        if (this.tickCount === 1) this.live = true;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error('[ts-pump] tick failed, backing off:', this.lastError);
      }
    }, TICK_MS);

    if (this.spawnEnabled) this.scheduleSpawnRetries();
  }

  private scheduleSpawnRetries(): void {
    for (const delay of SPAWN_RETRY_DELAYS_MS) {
      this.spawnTimers.push(
        window.setTimeout(() => {
          try {
            this.xash?.Cmd_ExecuteString('ts_spawn_player');
          } catch (e) {
            console.warn('[ts-pump] spawn attempt failed:', e);
          }
        }, delay),
      );
    }
  }

  /** Stop the pump. Called on game restart / teardown. */
  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.spawnTimers) window.clearTimeout(t);
    this.spawnTimers = [];
    this.xash = null;
    this.live = false;
  }

  /** Current tick statistics — surfaced in the HUD dev strip. */
  stats(): PumpStats {
    const elapsedMs = this.startedAt ? performance.now() - this.startedAt : 0;
    return {
      ticks: this.tickCount,
      elapsedMs: Math.round(elapsedMs),
      hz: elapsedMs > 0 ? Number(((this.tickCount / elapsedMs) * 1000).toFixed(1)) : 0,
      lastError: this.lastError,
      live: this.live,
    };
  }
}

/** Singleton — one pump per page. */
export const tsPump = new TSPump();