/**
 * ts-bridge.ts — TypeScript contract layer for ts_shim_v2 (C server DLL shim).
 *
 * The shim DLL (dlls/hl_emscripten_wasm32.wasm) forwards every interesting
 * DLL_FUNCTIONS slot into JavaScript via EM_JS trampolines that read
 * `Module.ctsBridge.<name>`.  The bridge must be installed *before* the
 * engine dlopens the DLL (i.e. before xash.main()).
 *
 * Each trampoline tolerates a missing handler by returning a safe no-op
 * default (0 / false), so the engine can always boot a map with zero real
 * game logic in place.
 *
 * The 14 trampolines (shim EM_JS signatures, all return int):
 *
 *   gameInit(unused)                   — pfnGameInit
 *   spawn(e, op, flags)                — pfnSpawn
 *   think(e, op, flags)                — pfnThink
 *   use(a, b, op)                      — pfnUse
 *   touch(a, b, op)                    — pfnTouch
 *   clientConnect(e, nameAddr, addrAddr)— pfnClientConnect
 *   clientDisconnect(e, op, flags)     — pfnClientDisconnect
 *   putInServer(e, op, flags)         — pfnClientPutInServer
 *   clientCommand(e, op, flags)        — pfnClientCommand
 *   playerPreThink(e, op, flags)       — pfnPlayerPreThink
 *   playerPostThink(e, op, flags)     — pfnPlayerPostThink
 *   startFrame(op, unused, flags)      — pfnStartFrame
 *   cmdStart(playerAddr, cmdAddr, flags)— pfnCmdStart
 *   precache(pathAddr, isSound, flags) — pfnPrecacheModel / pfnPrecacheSound
 *
 * Integer parameters are opaque WASM pointers/handles — the bridge does not
 * dereference them.  Callers replace individual handlers via setBridgeHandler
 * or replaceBridge; they never copy the whole default object.
 */

// ─── CTSBridge interface ────────────────────────────────────────────────────

/** Every handler receives WASM-level integers (pointers/handles) as args and
 *  returns an integer that the engine interprets.  Sub-types may narrow args. */
export interface CTSBridge {
  // pfnGameInit — called once at world spawn; no entity involved.
  gameInit(unused: number): number;

  // pfnSpawn — new entity born into the world.
  spawn(e: number, op: number, flags: number): number;

  // pfnThink — entity running its simulation tick.
  think(e: number, op: number, flags: number): number;

  // pfnUse — entity is triggered by another.
  use(a: number, b: number, op: number): number;

  // pfnTouch — entity physically contacts another.
  touch(a: number, b: number, op: number): number;

  // pfnClientConnect — player first connects to the server.
  clientConnect(e: number, nameAddr: number, addrAddr: number): number;

  // pfnClientDisconnect — player leaves the server.
  clientDisconnect(e: number, op: number, flags: number): number;

  // pfnClientPutInServer — player spawns into the game world.
  putInServer(e: number, op: number, flags: number): number;

  // pfnClientCommand — server-side console command from a player entity.
  clientCommand(e: number, op: number, flags: number): number;

  // pfnPlayerPreThink — runs before player movement for a server frame.
  playerPreThink(e: number, op: number, flags: number): number;

  // pfnPlayerPostThink — runs after player movement for a server frame.
  playerPostThink(e: number, op: number, flags: number): number;

  // pfnStartFrame — called once at the start of each server frame.
  startFrame(op: number, unused: number, flags: number): number;

  // pfnCmdStart — called at the start of each usercmd processing.
  cmdStart(playerAddr: number, cmdAddr: number, flags: number): number;

  // pfnPrecacheModel / pfnPrecacheSound — asset registration at load time.
  precache(pathAddr: number, isSound: number, flags: number): number;
}

// ─── Module augmentation ────────────────────────────────────────────────────

/** Installed on `Module` by installCTSBridge() so EM_JS trampolines can
 *  reach it without a separate import. */
declare global {
  // eslint-disable-next-line no-var
  var Module: {
    ctsBridge?: CTSBridge;
  };
}

// ─── Default no-op bridge ──────────────────────────────────────────────────

function defaultBridge(): CTSBridge {
  return {
    gameInit: () => 0,
    spawn: () => 0,
    think: () => 0,
    use: () => 0,
    touch: () => 0,
    clientConnect: () => 0,
    clientDisconnect: () => 0,
    putInServer: () => 0,
    clientCommand: () => 0,
    playerPreThink: () => 0,
    playerPostThink: () => 0,
    startFrame: () => 0,
    cmdStart: () => 0,
    precache: () => 0,
  };
}

// ─── Bridge installation ───────────────────────────────────────────────────

/**
 * Install the CTSBridge onto `Module.ctsBridge`.
 *
 * Idempotent: if a bridge is already present it is *not* replaced, because
 * callers that pre-install real handlers before xash.main() must not be
 * overwritten by a subsequent call that would restore the no-op defaults.
 *
 * Must be called *before* the engine dlopens hl_emscripten_wasm32.wasm.
 */
export function installCTSBridge(): void {
  if (typeof window === 'undefined') return; // SSR guard

  const g = globalThis as typeof globalThis & { Module: { ctsBridge?: CTSBridge } };
  if (!g.Module) g.Module = {};
  if (!g.Module.ctsBridge) {
    g.Module.ctsBridge = defaultBridge();
  }
}

// ─── Runtime handler replacement ───────────────────────────────────────────

/**
 * Replace a single handler on the live bridge.
 * Fails loudly if the bridge has not been installed (call installCTSBridge first).
 */
export function setBridgeHandler<K extends keyof CTSBridge>(
  name: K,
  fn: CTSBridge[K],
): void {
  const g = globalThis as typeof globalThis & { Module: { ctsBridge?: CTSBridge } };
  if (!g.Module?.ctsBridge) {
    throw new Error(
      '[ts-bridge] setBridgeHandler called before installCTSBridge — ' +
        'call installCTSBridge() first, then replace individual handlers.',
    );
  }
  g.Module.ctsBridge[name] = fn;
}

/**
 * Merge a partial bridge object onto the live bridge.
 * Any handler not provided retains its current value.
 */
export function replaceBridge(partial: Partial<CTSBridge>): void {
  const g = globalThis as typeof globalThis & { Module: { ctsBridge?: CTSBridge } };
  if (!g.Module?.ctsBridge) {
    throw new Error(
      '[ts-bridge] replaceBridge called before installCTSBridge — ' +
        'call installCTSBridge() first, then replace individual handlers.',
    );
  }
  Object.assign(g.Module.ctsBridge, partial);
}
