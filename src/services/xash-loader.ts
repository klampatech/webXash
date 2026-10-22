import { type Xash3D } from 'xash3d-fwgs';
import { type Xash3DWebRTC } from '/@/services/xash-webrtc.ts';
import type { FilesWithPath } from '/@/utils/directory-open.ts';
import type { ConsoleCallback, Enumify } from '/@/types.ts';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { UnzipFile, AsyncFlateStreamHandler } from 'fflate';
import { getTsmodArchive } from '/@/services/ts-mod-assets';
import SaveManager from '/@/services/save-manager.ts';
import { tsPump } from '/@/services/ts-pump.ts';
import { useXashStore } from '/@/stores/store.ts';
import { delay } from '/@/utils/helpers.ts';
import { DEFAULT_GAME_DIR } from '/@/services/save-manager.ts';

// Xash WASM Imports
// @ts-ignore -- vite url imports
import filesystemURL from 'xash3d-fwgs/filesystem_stdio.wasm?url';
// @ts-ignore -- vite url imports
import xashURL from 'xash3d-fwgs/xash.wasm?url';
// @ts-ignore -- vite url imports
import menuURL from 'xash3d-fwgs/libmenu.wasm?url';
// @ts-ignore -- vite url imports
import webgl2URL from 'xash3d-fwgs/libref_webgl2.wasm?url';
// @ts-ignore -- vite url imports
import extrasURL from 'xash3d-fwgs/extras.pk3?url';
// STUB: hlsdk-portable and cs16-client npm packages 404 from npm registry.
// Phase 0 patch: stub the WASM URLs to empty strings so the page renders.
// HL client.dll + hl.dll compiled to WASM via emscripten
// Build recipe in /tmp/hlsdk-portable (FWGS/hlsdk-portable) with
// emcmake. Output renamed from *.so → *.wasm for webXash's loader.
// Note: vite config has base: '/webXash/' so paths must include it.
const HLClientURL = '/webXash/cl_dlls/client_emscripten_wasm32.wasm';
const HLServerURL = '/webXash/dlls/hl_emscripten_wasm32.wasm';

// D.7.29 — Neutralise the engine's modal `alert()`.
//
// The Xash WASM build calls `alert()` from C when
// `COM_MemAlloc`'s command-slot pool runs dry:
//     _Mem_Alloc: pool == NULL (alloc at ../engine/common/cmd.c:638)
//
// A modal alert fired from inside a WebAssembly frame does two
// harmful things:
//   1. It blocks the JS main thread until the user clicks OK, which
//      suspends Emscripten's rAF-driven engine loop mid-frame.
//   2. On dismiss, SDL2's Emscripten keyboard queue is left in a
//      broken state — mouse look keeps working (polled via
//      requestAnimationFrame) but every keypress is dropped.
//
// Observed in real Chrome (Vivaldi): after dismissing the alert the
// game renders and mouselook responds, but W/A/S/D, Escape, and the
// console are all dead.
//
// We verified the alert is pre-existing (reproduces on a pristine
// D.7.27 baseline with zero launcher-side changes), so the fix
// belongs here: route engine alerts to the console instead of a
// modal. Non-blocking, so the engine loop never suspends.
if (typeof window !== 'undefined' && !(window as any).__xashAlertShimmed) {
  (window as any).__xashAlertShimmed = true;
  const nativeAlert = window.alert.bind(window);
  window.alert = (message?: any) => {
    const text = String(message ?? '');
    console.error('[xash-alert]', text);
    // Surface it in-app rather than modally — emit an event so any
    // overlay (TSHud) can render it as a toast without blocking.
    window.dispatchEvent(
      new CustomEvent('xash:alert', { detail: { message: text } })
    );
    void nativeAlert;
  };
}
// Bridge engine-side print/printErr to a window event bus — D.7.27
// stdout sniffer. The launcher HUD overlay subscribes to
// 'xash:stdout' and pattern-matches known lines to feed live
// state into the overlay (cash, timer, killfeed, weapon). The
// underlying browser console.log is preserved so Playwright
// smokes still capture the lines.
//
// D.7.32 — noise filter. At boot the engine execs a dozen .cfg
// files that reference ~200 cvars from decades of GoldSrc
// evolution. The GL2/ref_gl backend dropped most of them
// (s_max_distance, r_mmx, gl_ztrick, cl_laser, ati_npatch, …),
// and the TS-specific ones (roundtime, slowmatch, mp_teammodels)
// are missing because our server DLL is vanilla HL1, not a TS
// port. None of it is actionable and it buries the lines that
// matter in ~250 lines of noise at every launch.
//
// So: collapse the repeats into a one-line summary per command,
// and mark TS-cvar rejections distinctly so the real WASM-rebuild
// gap stays visible instead of drowning.
//
const _noiseCounts = new Map<string, number>();

function isNoiseCommand(line: string): { cmd: string } | null {
  // "Warning: Unknown command "foo"" / "Unknown command: foo"
  const m = line.match(/Unknown command:?\s*"?([^"\s]+)"?/);
  return m ? { cmd: m[1] } : null;
}

/** TS cvars that fail purely because our server DLL is HL1, not TS. */
const TS_ONLY_CVARS = new Set([
  'roundtime', 'slowmatch', 'lastmanstanding',
  'mp_teammodels', 'mp_teamlist', 'mp_roundtime',
  'mp_firemode', 'mp_weaponban', 'mp_cashlimit', 'mp_limitteams',
  'mp_teammenu', 'mp_autoteambalance', 'mp_limitteams',
]);

function emitXashLog(prefix: 'stdout' | 'stderr', log: string) {
  const noise = isNoiseCommand(log);
  if (noise) {
    const { cmd } = noise;
    _noiseCounts.set(cmd, (_noiseCounts.get(cmd) ?? 0) + 1);
    // Suppress the raw line; the summary lands at engine shutdown
    // or when someone explicitly asks via ?xashnoise=1.
    if (!new URLSearchParams(window.location.search).has('xashnoise')) {
      // Still dispatch to the event bus: live-state.ts counts TS cvar
      // rejections for the HUD's MISSING row.
      try {
        window.dispatchEvent(
          new CustomEvent(`xash:${prefix}`, { detail: { line: log } })
        );
      } catch (_) { /* ignore */ }
      return;
    }
  }
  console.log(`[xash-${prefix}] ${log}`);
  try {
    window.dispatchEvent(
      new CustomEvent(`xash:${prefix}`, { detail: { line: log } })
    );
  } catch (_) {
    /* modern browsers only — no IE shim */
  }
}

/** Dump the suppressed-command summary. Called on engine shutdown. */
function flushNoiseSummary() {
  if (_noiseCounts.size === 0) return;
  const ts = [..._noiseCounts.keys()].filter((c) => TS_ONLY_CVARS.has(c));
  const legacy = [..._noiseCounts.entries()]
    .filter(([c]) => !TS_ONLY_CVARS.has(c))
    .sort((a, b) => b[1] - a[1]);
  const total = [..._noiseCounts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[xash-noise] suppressed ${total} "Unknown command" lines ` +
      `across ${_noiseCounts.size} cvars.`
  );
  if (ts.length) {
    console.log(
      `[xash-noise] ${ts.length} TS-only cvars (need a TS server DLL, ` +
        `not vanilla HL1): ${ts.join(', ')}`
    );
  }
  console.log(
    `[xash-noise] ${legacy.length} legacy GoldSrc cvars (dropped by the ` +
      `GL2/ref_gl renderer backend): ${legacy
        .slice(0, 12)
        .map(([c, n]) => `${c}×${n}`)
        .join(', ')}${legacy.length > 12 ? ', …' : ''}`
  );
  _noiseCounts.clear();
}
window.addEventListener('beforeunload', flushNoiseSummary);
// Also flush once the engine reports the game has started, so the
// summary lands in the console during a normal session. The engine
// prints "Game started" as its last boot step; we listen for that on
// the same stdout bus emitXashLog already publishes to.
window.addEventListener('xash:stdout', (e) => {
  const d = (e as CustomEvent).detail as { line?: string };
  if (d?.line?.includes('Game started')) {
    // Give the remaining .cfg execs a beat to land first.
    window.setTimeout(flushNoiseSummary, 3000);
  }
});
// CS/MP/opfor/bshift games aren't built — but the engine still tries
// to fetch these via locateFile at startup. Point them all at hl.dll
// so the engine gets valid WASM bytes (even though they're the wrong
// game logic, the engine will only use them if you start a CS game).
const CSMenuURL = HLServerURL;
const CSClientURL = HLClientURL;
const CSServerURL = HLServerURL;

const XASH_BASE_DIR = '/rodir/';
/**
 * Total uncompressed byte count of a ZIP archive, read from its central
 * directory without decompressing anything.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Progress used to be measured as bytes pushed INTO the unzipper, which
 * made the bar stall at ~97% and sit there looking frozen. The tail of a
 * ZIP is not like the rest of it: the final few percent of INPUT can
 * carry a large fraction of the OUTPUT, because the biggest members live
 * at the end. Measured on tsmod.zip:
 *
 *     5297 entries, 492.3MB compressed -> 884.9MB uncompressed (1.80x)
 *     largest single member: 36.2MB
 *
 * So ~3% of input took as long as the previous 30%, and reporting input
 * made that visible as a dead bar. Reporting OUTPUT against the real
 * total moves smoothly and reaches an honest 100%.
 *
 * The central directory is parsed directly because fflate will not report
 * a total until it has already decompressed the archive - which is the
 * thing being avoided here.
 */
function zipTotalUncompressed(data: Uint8Array): number {
  // End of central directory: 0x06054b50, scanned back from the tail
  // (it sits within the last 22 bytes plus a variable-length comment).
  const floor = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = data.length - 22; i >= floor; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 0;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  let total = 0;
  for (let i = 0; i < count; i++) {
    // 0x02014b50 = central directory file header.
    if (
      !(data[p] === 0x50 && data[p + 1] === 0x4b &&
        data[p + 2] === 0x01 && data[p + 3] === 0x02)
    ) {
      break;
    }
    total += view.getUint32(p + 24, true); // uncompressed size
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}


// xash3d.js already loads filesystem_stdio.wasm, libmenu.wasm,
// hl.dll, and client.dll automatically (in that order) via
// DEFAULT_FILESYSTEM_LIBRARY / DEFAULT_MENU_LIBRARY /
// DEFAULT_SERVER_LIBRARY / DEFAULT_CLIENT_LIBRARY. Only add
// libraries that are NOT in the engine's default list.
const DYNAMIC_LIBRARIES = [
  'libref_webgl2.wasm',
];

export interface GameLoaderOptions {
  canvas: HTMLCanvasElement;
  selectedGame: Enumify<typeof GAME_SETTINGS>;
  launchArgs: string[];
}

export interface LoadProgress {
  current: number;
  total: number;
}

/**
 * The boot sequence, as real await boundaries in `startWithZip`.
 *
 * Only `download` has a byte count. Everything after it is a single
 * opaque await — fetching xash.wasm (3.9MB) and the client side module,
 * then unzipping the mod and writing the extras into the wasm FS — so
 * those phases report `indeterminate` and the UI shows a sweep instead of
 * a percentage. Labelling them is factual: each id is emitted at an
 * actual boundary, not on a timer.
 */
export type BootPhase =
  | 'download'
  | 'engine'
  | 'client-module'
  | 'filesystem'
  | 'starting';

export interface BootPhaseInfo {
  phase: BootPhase;
  /** 0-100 when known; null when the phase cannot report progress. */
  percent: number | null;
}

export interface StartGameOptions extends GameLoaderOptions {
  /** `?nocache=1` — force a cold zip download for testing. */
  bypassZipCache?: boolean;
  onStartLoading?: () => void;
  onEndLoading?: () => void;
  onPhase?: (info: BootPhaseInfo) => void;
  onProgress?: (progress: LoadProgress) => void;
  setCanvasLoading?: () => void;
}

export interface PostLoadOptions {
  xash: Xash3D;
  selectedGame: Enumify<typeof GAME_SETTINGS>;
  customGameArg: string;
  enableCheats?: boolean;
}

export interface FullStartOptions {
  /** `?nocache=1` — force a cold zip download for testing. */
  bypassZipCache?: boolean;
  canvas: HTMLCanvasElement;
  selectedGame: Enumify<typeof GAME_SETTINGS>;
  selectedZip?: string;
  selectedLocalFolder?: string;
  launchOptions?: string;
  fullScreen?: boolean;
  enableConsole?: boolean;
  enableCheats?: boolean;
  onStartLoading?: () => void;
  onEndLoading?: () => void;
  onProgress?: (progress: LoadProgress) => void;
  onPhase?: (info: BootPhaseInfo) => void;
  setCanvasLoading?: () => void;
  setMaxLoadingAmount?: (amount: number) => void;
}

// Constants

const XASH_LIBS = {
  filesystem: filesystemURL,
  xash: xashURL,
  menu: menuURL,
};

// Perform these callbacks when the matching command is emitted from the xash console
export const BASE_GAME_SETTINGS = {
  consoleCallbacks: [
    {
      id: 'onExit',
      match: 'exit',
      callback: () => XashLoader.onExit(),
    },
    {
      id: 'onQuit',
      match: 'quit',
      callback: () => XashLoader.onExit(),
    },
    {
      id: 'onShutdown',
      match: 'CL_Shutdown()',
      callback: () => XashLoader.onExit(),
    },
    {
      id: 'onTest',
      match: 'test',
      callback: () => console.log('test'),
    },
    {
      id: 'onSave',
      match: 'save',
      callback: () => SaveManager.onSave(), // We set what this does after xash launches.
    },
  ] as ConsoleCallback[],
};

export const GAME_SETTINGS = {
  HL: {
    name: 'Half-Life',
    launchArgs: [],
    publicDir: 'hl/',
    libraries: {
      ...XASH_LIBS,
      client: HLClientURL,
      server: HLServerURL,
    },
    ...BASE_GAME_SETTINGS,
  },
  TS: {
    // The Specialists — mod lives in ts/ inside the tsmod.zip.
    // gamedll in ts/liblist.gam points to dlls/hl.dll (no WASM
    // port of ts_i386.so exists), so we get HL1 vanilla gameplay
    // on TS maps.
    //
    // D.7.26: with the launcher HUD overlay rendering cash/timer/
    // killfeed/buy-menu, the engine's console (-console arg) would
    // compete with that overlay for top-left screen real estate.
    // Default to console OFF for the TS game so the HUD has clean
    // visuals; users can re-enable in the Advanced panel if they
    // need raw engine console.
    name: 'The Specialists',
    launchArgs: ['-game', 'ts', '+map', 'ts_apartments'],
    publicDir: 'hl/',
    libraries: {
      ...XASH_LIBS,
      client: HLClientURL,
      server: HLServerURL,
    },
    ...BASE_GAME_SETTINGS,
    // Override AFTER spread (D.7.26 — TS HUD renders cleaner
    // without the engine's console drawer overlaying the cash
    // panel).
    enableConsole: false,
  },
  CS: {
    name: 'Counter-Strike',
    launchArgs: ['-game', 'cstrike', '+_vgui_menus', '0'],
    publicDir: 'cs/',
    libraries: {
      ...XASH_LIBS,
      menu: CSMenuURL,
      client: CSClientURL,
      server: CSServerURL,
    },
    ...BASE_GAME_SETTINGS,
  },
} as const;

export const DEFAULT_GAME = 'valve';
const DEFAULT_ARGS = ['+hud_scale', '2.5', '+volume', '0.05', '-ref', 'webgl2'];
const WINDOW_ARGS = ['-windowed', ...DEFAULT_ARGS];
const FULLSCREEN_ARGS = ['-fullscreen', ...DEFAULT_ARGS];
const CONSOLE_ARG = '-console';

const onBeforeUnload = (event: Event) => {
  event.preventDefault();
  event.returnValue = false;
};

/**
 * Parse the effective launch-options string for a `+connect <host>:<port>`
 * pair and return it as `host:port`, or null if absent.
 *
 * The dedicated-server bridge listens on `<host>:<bridgePort>` (default
 * 27017, distinct from the game's UDP 27015 so they don't collide). We
 * accept two forms:
 *
 *   +connect 100.95.111.112:27015    → "100.95.111.112:27017"
 *   +connect 100.95.111.112:27015 +bridgeport 27020
 *                                        → "100.95.111.112:27020"
 *
 * The game port is the one the ENGINE dials; the bridge port is the one
 * the BROWSER dials over WebSocket. Keeping them separate means Kyle can
 * move the bridge without touching the launch options the engine reads.
 */
export function _dedicatedConnectHostPort(
  launchOptions: string
): string | null {
  if (!launchOptions) return null;
  const connect = launchOptions.match(/\+connect\s+([^\s]+)/i);
  if (!connect) return null;
  const target = connect[1];
  // Only handle explicit host:port. Named hosts aren't supported (the
  // bridge is always addressed by IP on the tailscale interface).
  const m = target.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/);
  if (!m) return null;
  const host = m[1];
  const bridge = launchOptions.match(/\+bridgeport\s+(\d+)/i);
  const bridgePort = bridge ? bridge[1] : '27017';
  return `${host}:${bridgePort}`;
}

class XashLoader {
  // D.7.28 live-state bridge. The running Xash3D instance exposes a
  // public `Cmd_ExecuteString(cmd)` that runs an engine console
  // command. That is our channel for reading real game state out of
  // the running WASM without touching the server DLL — we don't need
  // new server code, just the engine's own cvar reader.
  private static liveInstance: Xash3D | Xash3DWebRTC | null = null;

  /** Register the running engine so callers can issue console commands. */
  public static setLiveInstance(inst: Xash3D | Xash3DWebRTC | null) {
    XashLoader.liveInstance = inst;
  }

  /** Run an engine console command (no-op if not booted). */
  public static exec(cmd: string) {
    try {
      XashLoader.liveInstance?.Cmd_ExecuteString(cmd);
    } catch (e) {
      console.warn('[xash-exec] failed:', cmd, e);
    }
  }

  private async _getXashInstance(
    launchOptions: string | null
  ): Promise<typeof Xash3D | typeof Xash3DWebRTC> {
    // XashMultiplayerIP.vue stores its config at window.__multiplayerConfig
    // (server, role, room) — and ONLY when the user has explicitly
    // enabled the multiplayer checkbox. server is a host:port that
    // resolves to a WebSocket signaling server. When present, we route
    // through Xash3DMultiplayer (a Xash3DWebRTC subclass); otherwise
    // use vanilla Xash3D (single-player).
    //
    // 2026-10-21 M5: dedicated-server path. When the user explicitly sets
    // `+connect <host>:<port>` in launch options we route through the
    // WebSocket->UDP bridge (Xash3DBridge), which talks to
    // scripts/ts-udp-bridge.js running on the dedicated server's box.
    // We don't gate this on the multiplayer checkbox — the bridge only
    // requires a running ts-udp-bridge.js (the URL is local to the
    // dedicated server's host).
    const connectTarget = _dedicatedConnectHostPort(launchOptions ?? '');
    const connectPeer = launchOptions?.match(
      /\+connect\s+(\d{1,3}(?:\.\d{1,3}){3}:\d+)/
    )?.[1];

    const cfg = (window as any).__multiplayerConfig;
    const server = cfg?.server;
    if (server && /\d/.test(server) && !connectTarget) {
      const { Xash3DMultiplayer } = await import('../services/xash-multiplayer.ts');
      const Ctor = Xash3DMultiplayer as unknown as typeof Xash3D;
      return Ctor;
    } else if (connectTarget) {
      const { Xash3DBridge } = await import('../services/xash-bridge.ts');
      // Bridge transport needs two addresses:
      //   bridgeAddress  — host:port the BROWSER opens a WebSocket to
      //                    (defaults to <gamehost>:27017, overridable
      //                    via +bridgeport)
      //   serverAddress  — host:port the dedicated server is actually
      //                    on, attributed as the source of every inbound
      //                    packet. Must match what `+connect <ip>:<port>`
      //                    named; cls.serveradr gets compared against it
      //                    to decide whether to accept each reply.
      (window as any).__xashBridgeAddress = connectTarget;
      (window as any).__xashServerAddress = connectPeer ?? null;
      const Ctor = Xash3DBridge as unknown as typeof Xash3D;
      return Ctor;
    } else {
      const { Xash3D } = await import('xash3d-fwgs');
      return Xash3D;
    }
  }

  public async initXash(options: GameLoaderOptions): Promise<Xash3D> {
    const launchOptsStr = options.launchArgs?.join(' ') ?? '';
    const Xash3D = await this._getXashInstance(launchOptsStr);

    if (!Xash3D) {
      throw new Error('No Xash found.');
    }

    const store = useXashStore();

    // CRITICAL: launchArgs must be set at top-level (not module.arguments)
    // because xash3d-fwgs's runEm() does:
    //   this.em = await Xash({ arguments: ['-ref', 'webgl2', ...opts.arguments],
    //                          ...(opts.module ?? {}) })
    // and the spread overrides our args with module.arguments, dropping
    // the -ref webgl2 renderer flag. Putting them at top-level lets
    // initRender() prepend the renderer arg.
    // `Xash3D` here is the dynamic constructor we resolved in
    // _getXashInstance — vanilla Xash3D, Xash3DMultiplayer, or
    // Xash3DBridge. The bridge one adds `bridgeAddress`, which the base
    // Xash3DOptions doesn't declare, hence the widened cast.
    const ctorOpts = {
      arguments: options.launchArgs,
      multiplayerIP: store.multiplayerIP,
      onError: XashLoader.removeReloadListener,
      bridgeAddress: (window as any).__xashBridgeAddress,
      serverAddress: (window as any).__xashServerAddress,
      module: {
        // Forward engine stdout/stderr to browser console so headless
        // smokes (Playwright) can capture engine-side events:
        // - "Loading DLL dlls/hl_emscripten_wasm32.wasm" → confirms
        //   our TS server WASM is the one being dlopened
        // - "Unknown command: buy" / "Got command \"buy\"" → D.7.18 P1
        //   signal for whether the server DLL accepted TS commands
        // - "game rules: <class>" / "CTSGameRules" → confirms our
        //   patched InstallGameRules factory returned our subclass
        print: (log: string) => emitXashLog('stdout', log),
        printErr: (log: string) => emitXashLog('stderr', log),
        locateFile: (path: string) => {
          console.log(path);
          switch (path) {
            case 'xash.wasm':
              return xashURL;
            case 'filesystem_stdio.wasm':
              return filesystemURL;
            case 'cl_dlls/menu_emscripten_wasm32.wasm':
              return menuURL;
            case 'dlls/hl_emscripten_wasm32.wasm':
              return HLServerURL;
            // bshift fix
            case 'dlls/bshift_emscripten_wasm32.wasm':
              return HLServerURL;
            //opfor fix
            case 'dlls/opfor_emscripten_wasm32.wasm':
              return HLServerURL;
            case 'cl_dlls/client_emscripten_wasm32.wasm':
              return HLClientURL;
            // cs
            case 'dlls/cs_emscripten_wasm32.wasm':
              return CSServerURL;
            case 'dlls/mp_emscripten_wasm32.wasm':
              return CSServerURL;
            case 'libref_webgl2.wasm':
              return webgl2URL;
            // Check this (not supported yet)
            case 'libvgui_support.wasm':
              return menuURL;
          }
          return path;
        },
      },
      canvas: options.canvas,
      libraries: options.selectedGame.libraries,
      dynamicLibraries: DYNAMIC_LIBRARIES,
    };
    const xash = new (Xash3D as unknown as new (o: unknown) => Xash3D)(ctorOpts);

    await xash.init();
    // D.7.28 — publish the live engine so the HUD overlay can issue
    // console commands (cvar reads) against the running WASM.
    XashLoader.setLiveInstance(xash as Xash3D | Xash3DWebRTC);
    // Also expose it on window so Playwright probes and devtools can
    // poke the engine console directly while iterating.
    (window as any).__xash = xash;
    return xash;
  }

  public async processFiles(
    filesArray: FilesWithPath[],
    xash: Xash3D,
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<void> {
    if (!filesArray?.length) {
      console.warn('No files selected to start Xash.');
      return;
    }

    xash.em.FS.mkdirTree(XASH_BASE_DIR);

    // Determine the root directory from the selected files so we can strip it from all paths.
    // This ensures the contents of the selected folder are placed directly in XASH_BASE_DIR.
    // e.g., if a file path is "Half-Life/valve/config.cfg", we want to remove "Half-Life/".
    const firstPath = filesArray[0].path;
    const rootDirEndIndex = firstPath.indexOf('/');
    const pathPrefixToRemove =
      rootDirEndIndex !== -1 ? firstPath.substring(0, rootDirEndIndex + 1) : '';

    const allDirs = new Set<string>();

    // Collect directories first
    for (const entry of filesArray) {
      const relativePath = entry.path.substring(pathPrefixToRemove.length);
      if (!relativePath) continue;

      const path = XASH_BASE_DIR + relativePath;
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) {
        allDirs.add(dir);
      }
    }

    // Create directories
    for (const dir of allDirs) {
      xash.em.FS.mkdirTree(dir);
    }

    // Write files
    let current = 0;
    for (const entry of filesArray) {
      const relativePath = entry.path.substring(pathPrefixToRemove.length);
      if (!relativePath) {
        current++;
        onProgress?.({ current, total: filesArray.length });
        continue;
      }

      const path = XASH_BASE_DIR + relativePath;
      const data = await entry.file.arrayBuffer();
      xash.em.FS.writeFile(path, new Uint8Array(data));

      current++;
      onProgress?.({ current, total: filesArray.length });
    }

    xash.em.FS.chdir(XASH_BASE_DIR);
  }

  /**
   * Unzip the mod archive into the WASM filesystem.
   *
   * STREAMED, NOT BUFFERED. This used to be `unzipSync(zipData)`, which
   * for tsmod.zip is one synchronous call expanding 492MB into 885MB
   * across 5297 files. Three consequences, all visible to a user:
   *
   *   1. The main thread was blocked for the entire duration, so no CSS
   *      animation could run — the boot ring froze solid.
   *   2. It reported no progress at all, because there was nothing to
   *      report until the single call returned.
   *   3. unzipSync returns EVERY file as a Uint8Array before the caller
   *      can write any of them, so all 885MB was resident at once.
   *
   * fflate's `Unzip` CLASS is what streams. The top-level `unzip()`
   * helper is also async but still collects every file into one
   * `Unzipped` object before calling back — no progress, all 885MB
   * resident — so it would have fixed nothing that matters here.
   *
   * Progress is measured as bytes of archive consumed, which is honest
   * and needs no up-front total-uncompressed-size estimate.
   */
  public async processZip(
    zipBuffer: ArrayBuffer,
    xash: Xash3D,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const zipData = new Uint8Array(zipBuffer);
    const CHUNK = 1 << 20; // 1MB into the unzipper at a time
    const totalOut = zipTotalUncompressed(zipData);

    xash.em.FS.mkdirTree(XASH_BASE_DIR);

    // Progress is OUTPUT bytes against the real total, not input consumed.
    // Reported from the inflate callback as well as from the push loop, so
    // a single large member (tsmod.zip's biggest is 36.2MB) decompressing
    // and writing to the WASM filesystem still advances the bar instead of
    // freezing it for a second. Takes the max of the two signals so it can
    // never appear to go backwards.
    let written = 0;
    let lastReported = -1;
    const report = (forced?: number) => {
      let pct: number;
      if (totalOut > 0) {
        pct = Math.min(100, Math.round((written / totalOut) * 100));
      } else if (forced != null) {
        pct = Math.round(forced * 100);
      } else {
        return;
      }
      if (pct !== lastReported) {
        lastReported = pct;
        onProgress?.(pct);
      }
    };

    await new Promise<void>((resolve, reject) => {
      let failed: unknown = null;
      let finished = false;

      const fail = (e: unknown) => {
        if (failed) return;
        failed = e;
        finish(new Error(typeof e === 'string' ? e : ((e as Error)?.message ?? e)));
      };
      const finish = (e?: unknown) => {
        if (finished) return;
        finished = true;
        if (e) reject(e);
        else resolve();
      };

      const uz = new Unzip((f: UnzipFile) => {
        const name = f.name;
        if (name.endsWith('/')) {
          xash.em.FS.mkdirTree(XASH_BASE_DIR + name);
          return;
        }

        const path = XASH_BASE_DIR + name;
        const dir = path.substring(0, path.lastIndexOf('/'));
        // fflate may emit a file before its directory entry, so create
        // on demand rather than relying on archive ordering.
        if (dir) xash.em.FS.mkdirTree(dir);

        // ORDER MATTERS: fflate's `start()` throws err(5)
        // ("no stream handler") when `ondata` is not already assigned, so
        // the handler must be attached first. Reversing these two lines
        // fails on the first file with a bare, untraceable error.
        //
        // Accumulate per file, then write once. The archive is 5297 files
        // averaging ~167KB, so this holds one file in memory rather than
        // the whole 885MB, without needing FS append semantics we cannot
        // rely on in every WASM FS shim.
        const parts: Uint8Array[] = [];
        let bytes = 0;

        f.ondata = ((err, chunk, final) => {
          if (err) return fail(err);
          if (chunk && chunk.length) {
            parts.push(chunk);
            bytes += chunk.length;
            written += chunk.length;
            report();
          }
          if (final) {
            const out = new Uint8Array(bytes);
            let at = 0;
            for (const p of parts) {
              out.set(p, at);
              at += p.length;
            }
            try {
              xash.em.FS.writeFile(path, out);
            } catch (e) {
              fail(e);
            }
          }
        }) as AsyncFlateStreamHandler;

        f.start();
      });

      // REQUIRED. The top-level unzip() helper registers decoders for you;
      // the Unzip class does not, and without this every push throws
      // "no stream handler". A zip may also carry methods other than
      // deflate, so fall back to the transparent pass-through.
      uz.register(UnzipInflate);
      uz.register(UnzipPassThrough);

      let offset = 0;
      // Yield to the event loop periodically so the boot ring can
      // actually animate between pushes. Without this the loop below is
      // itself a long task, which is the problem we are fixing.
      const step = async () => {
        if (finished) return;
        const sliceEnd = Math.min(offset + CHUNK * 16, zipData.length);
        while (offset < sliceEnd) {
          const end = Math.min(offset + CHUNK, zipData.length);
          const isFinal = end >= zipData.length;
          try {
            uz.push(zipData.subarray(offset, end), isFinal);
          } catch (e) {
            return fail(e);
          }
          offset = end;
          // Fallback signal for when the central directory could not be
          // read; input consumed is a poorer metric but better than none.
          report(offset / zipData.length);
          if (isFinal) {
            // Hold the completed state long enough to be PAINTED. Without
            // this the final 100% and the phase tick-off happen in the
            // same task as the hand-off, so the browser never renders them
            // and the bar appears to stop at ~90% and skip to the game.
            // The value is real; it just never got a frame.
            if (lastReported >= 100) await delay(450);
            return finish();
          }
        }
        setTimeout(step, 0);
      };
      step();

      // Safety net: never hang the boot on a malformed archive.
      setTimeout(() => fail('unzip timed out before completion'), 180_000);
    });

    xash.em.FS.chdir(XASH_BASE_DIR);
  }

  public async startWithFiles(
    options: GameLoaderOptions,
    filesArray: FilesWithPath[],
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<Xash3D> {
    const xash = await this.initXash(options);

    // Load files and extras in parallel
    const [, extrasBuffer] = await Promise.all([
      this.processFiles(filesArray, xash, onProgress),
      this.fetchExtras(),
    ]);

    await this.writeExtras(xash, extrasBuffer);
    xash.main();
    return xash;
  }

  public async startWithZip(
    options: GameLoaderOptions,
    zipBuffer: ArrayBuffer,
    onPhase?: (info: BootPhaseInfo) => void,
  ): Promise<Xash3D> {
    onPhase?.({ phase: 'engine', percent: null });
    const xash = await this.initXash(options);

    onPhase?.({ phase: 'filesystem', percent: null });
    // Load zip and extras in parallel
    const [, extrasBuffer] = await Promise.all([
      this.processZip(zipBuffer, xash, (p) =>
        onPhase?.({ phase: 'filesystem', percent: p }),
      ),
      this.fetchExtras(),
    ]);

    await this.writeExtras(xash, extrasBuffer);
    onPhase?.({ phase: 'starting', percent: null });
    xash.main();
    // D.7.56 — start the TS game-loop pump. The engine's loopback
    // connect never completes in webXash, so its server frame loop
    // never dispatches g_pGameRules->Think(). The pump issues
    // `ts_pump_think` over the console-command bridge instead, so TS
    // gameplay logic runs at ~60Hz. See services/ts-pump.ts for the
    // full why (this is a deliberate engine workaround, not a hack).
    tsPump.start(xash);
    return xash;
  }

  /**
   * Fetch the mod archive.
   *
   * The archive is chunked into 64MB parts (see ts-mod-assets.ts and
   * docs/ASSET-DELIVERY.md) because a 517MB single object exceeds every
   * storage ceiling between here and the browser. `selectedZip` and
   * `publicDir` are ignored - there is one artifact and it is described by
   * its manifest - but they stay in the signature so the call sites do not
   * churn.
   */
  public async downloadZip(
    selectedZip: string,
    publicDir: string,
    onProgress?: (progress: number) => void,
    opts?: { bypassCache?: boolean },
  ): Promise<ArrayBuffer | undefined> {
    void selectedZip;
    void publicDir;
    return await getTsmodArchive(
      (p) => onProgress?.(p.percent),
      { bypassCache: opts?.bypassCache },
    );
  }

  public async fetchExtras(): Promise<ArrayBuffer> {
    const response = await fetch(extrasURL);
    if (!response.ok) {
      throw new Error(`Failed to fetch extras.pk3: ${response.statusText}`);
    }
    return await response.arrayBuffer();
  }

  public async writeExtras(
    xash: Xash3D,
    extrasBuffer: ArrayBuffer,
  ): Promise<void> {
    const extrasPath = XASH_BASE_DIR + 'extras.pk3';
    xash.em.FS.writeFile(extrasPath, new Uint8Array(extrasBuffer));
  }

  public async startGameWithFiles(
    options: StartGameOptions,
    filesArray: FilesWithPath[],
  ): Promise<Xash3D> {
    if (!options.canvas) {
      throw new Error('Canvas is not available');
    }

    options.setCanvasLoading?.();
    options.onStartLoading?.();

    const xash = await this.startWithFiles(
      {
        canvas: options.canvas,
        selectedGame: options.selectedGame,
        launchArgs: options.launchArgs,
      },
      filesArray,
      options.onProgress,
    );

    options.onEndLoading?.();
    return xash;
  }

  public async startGameWithZip(
    options: StartGameOptions,
    zip?: ArrayBuffer,
    selectedZip?: string,
    publicDir?: string,
    onDownloadProgress?: (progress: number) => void,
  ): Promise<Xash3D> {
    if (!options.canvas) {
      throw new Error('Canvas is not available');
    }

    options.onStartLoading?.();
    options.onPhase?.({ phase: 'download', percent: 0 });

    let zipBuffer = zip;

    // Download zip and fetch extras in parallel if needed
    if (!zipBuffer && selectedZip && publicDir) {
      const [downloadedZip, extrasBuffer] = await Promise.all([
        this.downloadZip(
          selectedZip,
          publicDir,
          (p) => {
            options.onPhase?.({ phase: 'download', percent: p });
            onDownloadProgress?.(p);
          },
          { bypassCache: options.bypassZipCache },
        ),
        this.fetchExtras(),
      ]);
      zipBuffer = downloadedZip;

      if (!zipBuffer) {
        throw new Error('Failed to download or provide zip file');
      }

      // Same reasoning as the dwell in processZip: the download reports
      // 100% and hands straight to the engine phase in one task, so the
      // browser never paints the completion and the bar appears to stop
      // at ~97%. The value is real, it just needs a frame.
      await delay(300);

      options.onPhase?.({ phase: 'engine', percent: null });
      const xash = await this.initXash({
        canvas: options.canvas,
        selectedGame: options.selectedGame,
        launchArgs: options.launchArgs,
      });

      options.onPhase?.({ phase: 'filesystem', percent: null });
      await this.processZip(zipBuffer, xash, (p) =>
        options.onPhase?.({ phase: 'filesystem', percent: p }),
      );
      await this.writeExtras(xash, extrasBuffer);
      options.onPhase?.({ phase: 'starting', percent: null });
      xash.main();

      options.onEndLoading?.();
      return xash;
    }

    if (!zipBuffer) {
      throw new Error('Failed to download or provide zip file');
    }

    const xash = await this.startWithZip(
      {
        canvas: options.canvas,
        selectedGame: options.selectedGame,
        launchArgs: options.launchArgs,
      },
      zipBuffer,
      options.onPhase,
    );

    options.onEndLoading?.();
    return xash;
  }

  public async initConsoleCallbacks(
    xash: Xash3D,
    callbacks: Array<{ match: string; callback: () => void }>,
  ): Promise<void> {
    await Promise.all(
      callbacks.map(async (callback) => {
        const run = true;
        while (run) {
          try {
            await xash.waitLog(callback.match, undefined, 1000);
            callback.callback();
          } catch (_error) {
            // noop
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }),
    );
  }

  private _buildLaunchArgs(options: FullStartOptions): string[] {
    const baseArgs = options.fullScreen ? FULLSCREEN_ARGS : WINDOW_ARGS;
    const rawLaunch = options.launchOptions?.split(' ').filter(Boolean) || [];

    // 2026-10-21: strip -noip / -noip6 whenever the user is asking to
    // connect to a remote server. FWGS net_ws.c:2018 does
    //   net.allow_ip  = !Sys_CheckParm("-noip");
    //   net.allow_ip6 = !Sys_CheckParm("-noip6");
    // and NET_DetermineLocalAddress() bails with "TCP/IP Disabled." when
    // both are false — the engine never calls socket(), so the emulated
    // Net layer never gets an fd and `+connect` retries forever against
    // nothing. These flags are only meaningful for a local-only listen
    // server, so drop them the moment a +connect target is present.
    const wantsRemote = rawLaunch.some((a) => /^\+connect\b/i.test(a));
    const args = wantsRemote
      ? rawLaunch.filter((a) => !/^-noip6?$/i.test(a))
      : rawLaunch;
    if (wantsRemote && args.length !== rawLaunch.length) {
      console.warn(
        '[xash-loader] removed -noip/-noip6 from launch args; they disable ' +
          'TCP/IP entirely and break +connect.',
      );
    }

    const launch = [...baseArgs, ...args];

    if (options.enableConsole) {
      launch.push(CONSOLE_ARG);
    }

    if (options.selectedLocalFolder) {
      launch.push('-game');
      launch.push(options.selectedLocalFolder);

      // D.7.34 — `-game ts` sets the engine's primary search path to
      // `ts/` ONLY. That drops `valve/` from the search path, and
      // `valve/` is where the engine's shared UI resources live:
      //
      //   Localize_AddToDict( resource/mainui_english.txt )   → engine menu strings
      //   UI_ApplyCustomColors: colors.lst not found          → menu colours
      //   resource/*.res                                   → menu layout
      //
      // The TS mod was built as a plain GoldSrc mod that *inherited*
      // Valve's resource dir, so its own cfg references those files.
      // Without the valve fallback we lose localized strings and
      // menu theming — not fatal for gameplay, but it's a real
      // regression versus running the mod under Steam HL1.
      //
      // `-basedir` keeps the engine's own resources reachable while
      // leaving `ts/` as the highest-priority search path, so TS
      // assets still win any collision (e.g. ts/specialists.wad vs
      // valve/halflife.wad).
      launch.push('-basedir');
      launch.push('valve');
    }

    return launch;
  }

  public async startGameFiles(
    filesArray: FilesWithPath[],
    options: FullStartOptions,
  ): Promise<Xash3D> {
    if (!options.canvas) {
      throw new Error('Canvas is not available');
    }

    try {
      const launchArgs = this._buildLaunchArgs(options);

      const xash = await this.startGameWithFiles(
        {
          canvas: options.canvas,
          selectedGame: options.selectedGame,
          launchArgs,
          setCanvasLoading: options.setCanvasLoading,
          onStartLoading: () => {
            options.onStartLoading?.();
            options.setMaxLoadingAmount?.(filesArray.length);
          },
          onEndLoading: options.onEndLoading,
          onProgress: options.onProgress,
        },
        filesArray,
      );

      return xash;
    } catch (error) {
      console.error('Failed to start Xash with files:', error);
      options.onEndLoading?.();
      throw error;
    }
  }

  public async startGameZip(
    zip: ArrayBuffer | undefined,
    options: FullStartOptions,
  ): Promise<Xash3D> {
    if (!options.canvas) {
      throw new Error('Canvas is not available');
    }

    try {
      const launchArgs = this._buildLaunchArgs(options);

      const xash = await this.startGameWithZip(
        {
          canvas: options.canvas,
          selectedGame: options.selectedGame,
          launchArgs,
          onStartLoading: options.onStartLoading,
          onEndLoading: options.onEndLoading,
          onPhase: options.onPhase,
        },
        zip,
        options.selectedZip,
        options.selectedGame.publicDir,
        // @ts-ignore -- ignore type in this case.
        options.onProgress!,
      );

      return xash;
    } catch (error) {
      console.error('Failed to start Xash with zip:', error);
      options.onEndLoading?.();
      throw error;
    }
  }

  public async onAfterLoad(options: PostLoadOptions): Promise<void> {
    window.addEventListener('beforeunload', onBeforeUnload);

    await delay(500); // Wait for xash to fully load first

    SaveManager.init(options.xash);

    // Determine the game ID for save transfer
    const gameId =
      options.customGameArg === DEFAULT_GAME_DIR
        ? options.selectedGame.name
        : options.customGameArg;

    await SaveManager.transferSavesToGame(gameId);

    if (options.enableCheats) {
      options.xash.Cmd_ExecuteString('sv_cheats 1');
    }
  }

  public static removeReloadListener() {
    window.removeEventListener('beforeunload', onBeforeUnload);
  }

  public static onExit() {
    this.removeReloadListener();
    window.location.reload();
  }

  // Instance-level delegates so consumers that already hold the
  // default-exported XashLoader singleton can reach the static
  // live-state bridge without importing the class.
  public exec(cmd: string) {
    XashLoader.exec(cmd);
  }
  public setLiveInstance(inst: Xash3D | Xash3DWebRTC | null) {
    XashLoader.setLiveInstance(inst);
  }
}

export default new XashLoader();
