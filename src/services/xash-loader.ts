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
import { logDebug } from '/@/services/debug-log.ts';
import { armBrowserChordGate, disarmBrowserChordGate } from '/@/services/browser-chord-gate.ts';
import {
  applyRenderResolution,
  armRenderResolution,
  detectDisplay,
  renderResolutionArgs,
  resolveRenderResolution,
  setRenderResolutionTarget,
  type RenderResolution,
} from '/@/services/video-settings.ts';
import { prepareEngineContext } from '/@/services/webgl-context.ts';
import {
  applyFrameCap,
  forceFrameCap,
  getPacingState,
  installFramePacingShim,
  wantsNoFrameCap,
} from '/@/services/frame-pacing-apply.ts';
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
// The HL client.dll and hl.dll are compiled to WASM with emscripten and
// served from the app's own asset paths — NOT from npm.
//
// They used to come from the `hlsdk-portable` and `cs16-client` packages,
// which were unpublished from npm on 2026-09-08. A dependency that cannot
// be installed is not a dependency, and leaving it in package.json meant
// every fresh `bun install` failed with a 404 — including CI's.
//
// The build recipe is in /tmp/hlsdk-portable (FWGS/hlsdk-portable) with
// emcmake. Output renamed from *.so → *.wasm for webXash's loader.
// Note: vite config has base: '/', so these are root-relative.
const HLClientURL = '/cl_dlls/client_emscripten_wasm32.wasm';
const HLServerURL = '/dlls/hl_emscripten_wasm32.wasm';

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
  // The deliberate reconnect sets this flag: it is navigating on
  // purpose, and a confirmation dialog in front of the recovery is
  // exactly what the player does not need. The flag lives on the
  // window, not in this module, because the module can be loaded more
  // than once (the dev server resolves '/@/services/xash-loader' and
  // '/@/services/xash-loader.ts' to two instances, each with its own
  // copy of this closure) and a window-level flag is the only thing
  // all of them can see.
  if ((window as unknown as { __xashUnloadAllowed?: boolean }).__xashUnloadAllowed) {
    return;
  }
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

/**
 * The bridge's own address, when the launch options name one explicitly.
 *
 *   +bridge bulletballet.dev:443
 *
 * WHY THIS IS SEPARATE FROM `+connect`
 * ------------------------------------
 * `+connect` names the GAME SERVER — the address the engine dials and the
 * address every inbound packet is attributed to. It stays a raw ip:port
 * because that is what the engine's own filter compares against.
 *
 * `+bridge` names the BRIDGE — where the BROWSER opens a WebSocket. In
 * production those are different hosts: the game peer is a raw UDP address
 * while the bridge is reached through a TLS hostname (Caddy terminates it
 * on the same domain as the page). A hostname is allowed here — and only
 * here — because the bridge address is never compared against engine
 * state.
 *
 * Without this, the browser would have to open a WebSocket to an IP, which
 * means a certificate that does not match the domain the page was served
 * from, and a `ws://` URL on an `https://` page, which the browser blocks
 * as mixed content.
 */
export function _dedicatedBridgeHostPort(
  launchOptions: string
): string | null {
  if (!launchOptions) return null;
  const m = launchOptions.match(/\+bridge\s+([^\s]+)/i);
  if (!m) return null;
  const v = m[1];
  const idx = v.lastIndexOf(':');
  if (idx === -1) return null;
  const host = v.slice(0, idx);
  const port = v.slice(idx + 1);
  if (!host || !/^\d+$/.test(port)) return null;
  return v;
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

  /**
   * True once the engine has run a frame.
   *
   * The engine's command pool does not exist before its first frame, and
   * `Cmd_ExecuteString` before that makes the engine raise a fatal error
   * of its own (`_Mem_Alloc: pool == NULL`). Anything that talks to the
   * engine has to ask this first.
   */
  private static engineUp = false;

  /** Callbacks waiting for the engine's first frame. */
  private static engineUpHooks: Array<() => void> = [];

  /** Has the engine run its first frame? */
  public static isEngineUp(): boolean {
    return XashLoader.engineUp;
  }

  /**
   * Run `fn` once the engine is up — immediately if it already is.
   *
   * The session-start work (the buy menu's hidden flag, the first state
   * request) hangs off this: it has to happen after the first frame and
   * before the player can die, and "after the first frame" is not a
   * moment a caller can wait for on its own.
   */
  public static onEngineUp(fn: () => void): void {
    if (XashLoader.engineUp) {
      fn();
      return;
    }
    XashLoader.engineUpHooks.push(fn);
  }

  /** Mark the engine as up and run the hooks that were waiting for it. */
  private static markEngineUp(): void {
    if (XashLoader.engineUp) return;
    XashLoader.engineUp = true;
    const hooks = XashLoader.engineUpHooks;
    XashLoader.engineUpHooks = [];
    for (const fn of hooks) {
      try {
        fn();
      } catch (e) {
        console.warn('[xash] engine-up hook failed:', e);
      }
    }
  }

  /**
   * Read a file out of the engine's own filesystem.
   *
   * The game's files are unpacked into the WASM filesystem at boot, so
   * this is how the frontend reads the game's OWN data — its
   * `titles.txt`, for instance, rather than a table of its own.
   *
   * `relPath` is relative to the game's base directory (`ts/titles.txt`).
   */
  public static readGameFile(relPath: string): string | null {
    const em = XashLoader.liveInstance?.em;
    if (!em?.FS) return null;
    try {
      const bytes = em.FS.readFile(XASH_BASE_DIR + relPath);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (_) {
      // No such file (or not readable yet): the caller decides what to
      // do about it.
      return null;
    }
  }

  /**
   * Run an engine console command (no-op if not booted).
   *
   * Returns true when the engine took it. The engine's command system
   * does not exist until its first frame, and a command sent before
   * that makes the engine raise a fatal error of its own — so the
   * caller needs to know whether the command landed.
   */
  public static exec(cmd: string): boolean {
    try {
      if (!XashLoader.liveInstance) return false;
      XashLoader.liveInstance.Cmd_ExecuteString(cmd);
      return true;
    } catch (e) {
      console.warn('[xash-exec] failed:', cmd, e);
      return false;
    }
  }

  /**
   * Is the game's transport up right now?
   *
   * False for single-player (there is no transport at all) — the caller
   * reads that as "the fast path cannot succeed".
   */
  public static isTransportOpen(): boolean {
    const inst = XashLoader.liveInstance as unknown as {
      isTransportOpen?: () => boolean;
    } | null;
    if (!inst || typeof inst.isTransportOpen !== 'function') return false;
    return inst.isTransportOpen();
  }

  /**
   * Reconnect to the game server without reloading the page.
   *
   * WHY
   * ---
   * The old recovery was a page reload — re-unpack the 517 MB archive,
   * re-boot the WASM engine, re-run the handshake. That is a minute of
   * loading after a blip, and it is exactly the window the server's
   * connect timeout was waiting on: a browser reconnect is slower than
   * a normal client, and the engine's `sv_connect_timeout_ban` was
   * punishing the whole fleet for it (every browser player reaches the
   * server as the same address).
   *
   * The engine does not need any of that. It has a `retry` command —
   * "retry connection to last server" — that disconnects the stale
   * channel and re-runs the handshake against the address it already
   * knows (`cls.servername`, set by the launch's `+connect`). The only
   * thing that has to be put back is the transport, because the engine
   * keeps running when the WebSocket closes; it just stops receiving.
   *
   * Returns false when the fast path is not available, so the caller
   * can fall back to the reload. This is never allowed to be the ONLY
   * way back into the game.
   */
  public static async reconnectToServer(): Promise<boolean> {
    const inst = XashLoader.liveInstance;
    if (!inst) return false;
    const transport = inst as unknown as {
      reconnect?: () => Promise<void>;
    };
    // Single-player, or a transport that cannot be re-opened.
    if (typeof transport.reconnect !== 'function') return false;
    try {
      await transport.reconnect();
    } catch (e) {
      console.warn('[xash-reconnect] the transport would not come back:', e);
      return false;
    }
    // The engine's own reconnect. `retry` re-connects to the last
    // server, which is the one the launch options named.
    if (!XashLoader.exec('retry')) {
      console.warn('[xash-reconnect] the engine took no "retry"');
      return false;
    }
    return true;
  }

  /**
   * Drop the "are you sure you want to leave?" guard.
   *
   * WHY
   * ---
   * The app registers a `beforeunload` handler so a player cannot
   * accidentally close the tab mid-game. That guard fires on EVERY
   * navigation — including our OWN deliberate one: the CONNECTION LOST
   * overlay's reconnect reloads the page to put the player back in.
   *
   * So the recovery puts a browser confirmation dialog in front of
   * itself. A player staring at a frozen world then has to find and
   * click "Leave" before the reload happens, and some browsers
   * suppress the dialog entirely — in which case the reload never
   * happens at all and the player sits on the dead screen with no way
   * forward except closing the tab by hand.
   *
   * (Measured: the reload fired the handler, the dialog appeared, and
   * the page never navigated.)
   *
   * So the deliberate reconnect removes the guard first. The player
   * who closes the tab by hand still gets the prompt — that is what it
   * is for.
   */
  public static allowUnload() {
    // The window-level flag is what the guard checks — see
    // `onBeforeUnload`. The listener is removed too, for the case
    // where this module is the only copy.
    (window as unknown as { __xashUnloadAllowed?: boolean }).__xashUnloadAllowed = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
    // The chord gate goes with it: it exists to defuse the chords that
    // would trip this guard, and this guard is coming off.
    disarmBrowserChordGate();
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
      // An explicit `+bridge host:port` wins over the derived
      // `<game-ip>:<bridgeport>`, because in production the bridge lives
      // behind a TLS hostname rather than on the game server's IP.
      const explicitBridge = _dedicatedBridgeHostPort(launchOptions ?? '');
      (window as any).__xashBridgeAddress = explicitBridge ?? connectTarget;
      (window as any).__xashServerAddress = connectPeer ?? null;
      const Ctor = Xash3DBridge as unknown as typeof Xash3D;
      return Ctor;
    } else {
      const { Xash3D } = await import('xash3d-fwgs');
      return Xash3D;
    }
  }

  public async initXash(options: GameLoaderOptions): Promise<Xash3D> {
    // PRE-CREATE THE WEBGL CONTEXT, before the engine asks for one.
    //
    // The engine's renderer creates its own context through
    // `_emscripten_webgl_create_context`, which takes its attributes
    // from the WASM side. The usual Emscripten lever,
    // `Module.webGLContextAttributes`, does not reach it: this glue
    // never reads it, and the live context reports
    // `desynchronized: false`.
    //
    // A canvas has ONE WebGL context for its lifetime, and
    // `getContext` returns the same one every time. So creating the
    // context here, with the attributes we want, means the engine's
    // later call returns OURS.
    //
    // This is here, and not in `startWithFiles`, because BOTH boot
    // paths call `initXash` -- and the real one is the ZIP path. An
    // earlier version put this in `startWithFiles`, which the ZIP
    // path never touches, so the context was never pre-created and
    // `desynchronized` was never set.
    //
    // The loader's canvas IS the canvas the engine renders into, so
    // this is the authoritative pre-creation. It runs before the
    // engine module is created, so the engine's renderer gets OUR
    // context rather than making its own.
    prepareEngineContext(options.canvas);

    // Install the frame-pacing measuring shim BEFORE the engine's
    // first frame, so it sees every tick from the start. It only
    // measures until `applyFrameCap` decides what to do, and it gates
    // the engine's callback only if the engine turns out to need it.
    //
    // Unless the player has switched the cap off for this session
    // (`?nocap=1`). Then the global rAF is left alone entirely: the
    // page runs exactly as it did before the cap existed. The default
    // is still ON -- the cap exists because the uncapped engine
    // arrives unevenly on a fast display.
    if (!wantsNoFrameCap()) {
      installFramePacingShim();
    }

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
      // Tell the UI when the transport to the game server dies. Without
      // this the engine keeps running, keeps rendering the last frame,
      // and the player is left looking at a frozen world with no
      // explanation and no way back.
      onDisconnect: (reason: string) => store.setConnectionLost(reason),
    };
    const xash = new (Xash3D as unknown as new (o: unknown) => Xash3D)(ctorOpts);

    await xash.init();
    // D.7.28 — publish the live engine so the HUD overlay can issue
    // console commands (cvar reads) against the running WASM.
    XashLoader.setLiveInstance(xash as Xash3D | Xash3DWebRTC);
    // Also expose it on window so Playwright probes and devtools can
    // poke the engine console directly while iterating.
    (window as any).__xash = xash;
    // The frame-pacing state, for the diagnostics and for a player who
    // is asked what their client is doing.
    (window as any).__xashPacing = getPacingState;
    // The force hook, for the A/B harness. It is not reachable from
    // the UI on purpose: it exists so the harness can measure what the
    // cap DOES, on a display where it would otherwise never engage.
    (window as any).__xashForceFrameCap = (everyNth = 2) =>
      forceFrameCap(everyNth);
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
    // The engine runs its config on its first frame, so the bind has to
    // wait for that frame or the config's `unbindall` wipes it. The
    // second bind is belt and braces: if the config somehow ran after
    // the first frame, this one is the one that sticks.
    requestAnimationFrame(() => XashLoader.afterFirstFrame(xash));
    setTimeout(() => XashLoader.bindTsKeys(xash), 2000);
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
    // The engine runs its config on its first frame, so the bind has to
    // wait for that frame or the config's `unbindall` wipes it. The
    // second bind is belt and braces: if the config somehow ran after
    // the first frame, this one is the one that sticks.
    requestAnimationFrame(() => XashLoader.afterFirstFrame(xash));
    setTimeout(() => XashLoader.bindTsKeys(xash), 2000);
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


  /**
   * Bind the keys TS's own config.cfg binds, which the engine's config
   * does not end up carrying.
   *
   * THE BUG
   * -------
   * TS's config.cfg binds "b" to "buy" -- the key that opens the buy
   * menu AGAIN after the player has closed it ("0 Cancel"). That bind is
   * missing from the engine's bind table, so the buy menu could be
   * opened when the server opened it (the Spectator message, which the
   * client turns into Effect::OpenBuyMenu) and never again: close it and
   * nothing brings it back.
   *
   * WHY IT WAS MISSING
   * ------------------
   * Not because the game's config failed to bind it. The config DOES bind
   * "b" to "buy" -- and the engine executed that file: every one of TS's
   * binds was in the engine's bind table (x -> thirdperson, f ->
   * firemode, t -> drop, z -> usepowerup, g -> useitems, 0 -> slot10,
   * MOUSE3 -> +alt1), and asking the engine said `"b" = ""`.
   *
   * The bind was removed by US: this loader used to run `bind b ""` at
   * boot, a leftover from the "stop sending every key twice" fix, when
   * the frontend sent "buy" itself and the engine's own bind had to be
   * cleared so the menu did not open twice. That unbind outlived the
   * command map it belonged to.
   *
   * THE FIX
   * -------
   * Two parts, and the second is the belt to the first's braces:
   *
   *  1. The loader no longer clears "b" (see the list above). The game's
   *     own config is the source of truth for its own keys.
   *  2. It is also bound here explicitly, on the frame after the engine
   *     starts, so the key works even if the config's line is ever
   *     disturbed. `Cmd_ExecuteString` is the engine's LOCAL command
   *     buffer -- the client's `client_cmd` would send it to the SERVER
   *     instead, which is how the first attempt at this fix failed.
   *
   * It is bound on the frame after the engine starts rather than the
   * instant `main()` returns, because the engine's own first frame is
   * what runs its config.
   */
  private static bindTsKeys(xash: Xash3D): void {
    try {
      xash.Cmd_ExecuteString('bind b buy');
    } catch (e) {
      console.warn('[xash] could not bind the TS keys:', e);
    }
  }

  /**
   * The engine's first frame.
   *
   * Two things are true only after it: the engine has run its config
   * (so the binds stick), and its command pool exists (so a console
   * command does not raise a fatal error). The session-start work hangs
   * off the second one — see `onEngineUp`.
   */
  private static afterFirstFrame(xash: Xash3D): void {
    XashLoader.bindTsKeys(xash);
    XashLoader.markEngineUp();
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
      // The engine runs its config on its first frame, so the bind has to
      // wait for that frame or the config's `unbindall` wipes it. The
      // second bind is belt and braces: if the config somehow ran after
      // the first frame, this one is the one that sticks.
      requestAnimationFrame(() => XashLoader.afterFirstFrame(xash));
      setTimeout(() => XashLoader.bindTsKeys(xash), 2000);

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

  /**
   * The render resolution this session will use.
   *
   * The player's choice comes from the store; the display comes from the
   * browser; the policy that turns one into the other is in
   * services/video-settings.ts.
   *
   * The result is ALSO parked in that module, because the resize
   * watchdog needs it later and the watchdog is installed at import
   * time — before the Vue app, and therefore before the store, exists.
   */
  private _resolveRenderResolution(): RenderResolution {
    const store = useXashStore();
    const resolution = resolveRenderResolution(
      store.renderResolution,
      detectDisplay(),
    );
    setRenderResolutionTarget(resolution);
    return resolution;
  }

  private _buildLaunchArgs(options: FullStartOptions): string[] {
    const baseArgs = options.fullScreen ? FULLSCREEN_ARGS : WINDOW_ARGS;
    const rawLaunch = options.launchOptions?.split(' ').filter(Boolean) || [];

    // The render resolution goes on the command line too.
    //
    // `-width`/`-height` are the engine's own switches, and the engine
    // creates its window at that size during renderer init — so the very
    // first frame is already at the right resolution instead of the
    // viewport's, which on a 1440p display is four times the pixels.
    //
    // It is not the load-bearing half. The engine re-syncs its render
    // resolution to the browser viewport on every resize (SDL's resize
    // event -> VID_SaveWindowSize -> R_SaveVideoMode), so going
    // fullscreen throws this away; onAfterLoad re-applies it, and the
    // resize watchdog re-applies it after that.
    const video = this._resolveRenderResolution();
    const videoArgs = renderResolutionArgs(video);

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

    const launch = [...baseArgs, ...videoArgs, ...args];

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
    // The unload guard above is what turns the browser's Ctrl+W ("close
    // this tab") into a "Leave site?" dialog, and Chromium reserves that
    // chord — the keydown never reaches the page, so no DOM handler can
    // cancel it. The chord gate swallows it (and its neighbours) for the
    // length of the match, so a player who is only crouching does not
    // get a modal thrown at them. Armed here, in the same place as the
    // guard it exists to defuse.
    armBrowserChordGate();

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

    // Take the keys we do not want away from the player.
    //
    // The engine's own bind table (ts/config.cfg) is the source of truth,
    // and it binds all of these. Removing our own bindings is not enough:
    // the engine would still run its own. So we clear them in the engine's
    // bind table, which is the only place they exist now that keys reach
    // the engine natively.
    //
    //   ` and ~ -> toggleconsole  the console, and the way out of the server
    //   ESCAPE  -> cancelselect   opens the GoldSrc main menu — the
    //                             "dump out of the match" menu, whose Quit
    //                             button ends on a black screen
    //
    // ESCAPE is handled in the page instead (services/escape-gate.ts): the
    // first press releases the pointer lock, the second opens the options
    // overlay. The rebind here is the belt to that braces.
    // "b" -> "buy" WAS in this list, and it was WRONG (2026-10-24).
    //
    // It was here because the frontend used to SEND "buy" itself (the
    // command map that also sent every other key a second time), so
    // clearing the engine's bind stopped the menu opening twice. When that
    // command map was deleted -- the "stop sending every key twice" fix --
    // the unbind was left behind, and the buy menu lost its key: the
    // server opens it when you become an observer, "0 Cancel" closes it,
    // and afterwards NOTHING could bring it back. Kyle's report, verbatim:
    // "while dead, after you accidentally close the buy menu it doesn't
    // reopen."
    //
    // The engine's own ts/config.cfg binds "b" to "buy", and that bind is
    // the source of truth -- the page's job is to stop BREAKING it, not to
    // manage it. So "b" is no longer cleared here.
    for (const cmd of ['bind ` ""', 'bind ~ ""', 'bind ESCAPE ""']) {
      logDebug(`[bind] ${cmd}`);
      options.xash.Cmd_ExecuteString(cmd);
    }

    // THE RENDER RESOLUTION.
    //
    // The engine renders at the browser viewport's resolution, and the
    // frame cost is the pixel count — measured against production:
    //
    //     viewport      engine render res   engine frames/s
    //     640x480       640x480             69.5
    //     1280x720      1280x720            30.2
    //     1920x1080     1920x1080            8.6
    //     2560x1440     2560x1440            4.5
    //
    // So going fullscreen on a 1440p display is a 4x hit, and the
    // "150 ms" the 2026-10-27 capacity report could not explain is
    // this: the engine's own frame time, during which the page's main
    // thread is blocked. It was never server latency.
    //
    // The command line set the initial size; this sets it again, because
    // the engine re-syncs to the viewport on every resize and the page
    // has been fullscreen since before the engine booted.
    this._resolveRenderResolution();

    // The engine's command system is up by now — the loader's own apply
    // is the first command the engine ever takes, and it has never
    // failed. That matters, because the RESIZE WATCHDOG is installed at
    // import time and hears the resize events that happen while the
    // engine is still booting. A command sent then lands in an
    // uninitialised command pool and the engine answers it with its own
    // fatal error (measured: `_Mem_Alloc: pool == NULL`, thrown at the
    // JavaScript side as the bare value `Infinity`).
    //
    // So the watchdog stays disarmed until this point.
    armRenderResolution();

    const applyVideo = (force: boolean) =>
      applyRenderResolution(
        (cmd) => {
          options.xash.Cmd_ExecuteString(cmd);
          return true;
        },
        logDebug,
        force,
      );

    // `force` on the first call, deliberately: the launch arguments set
    // the canvas's backing store, but the engine's own `vid_width`/
    // `vid_height` cvars can still be sitting at the viewport's size.
    // The engine's own `vid_setmode` path is what leaves the two
    // agreeing, and only the engine can do that.
    applyVideo(true);

    // The engine may still have been starting when the line above ran
    // — the video system is not up until the renderer has initialised.
    // Try again shortly after; the check is free (it reads the canvas
    // backing store) and does nothing if the resolution already took.
    setTimeout(() => applyVideo(false), 1500);

    // CAP THE ENGINE'S TICK RATE, if it needs one.
    //
    // The engine has no frame limiter in the browser: with vsync on,
    // `fps_max` is never consulted, so the engine renders on every
    // tick the browser offers it. Its per-frame work was measured at
    // ~7-8 ms, which is comfortable at 60 Hz (16.7 ms of budget) and
    // OVER budget at 144 Hz (6.9 ms). A display faster than the
    // engine can sustain makes the engine miss deadlines, the browser
    // drop ticks to catch up, and the frames arrive unevenly -- which
    // is judder, and which the engine's own FPS counter cannot see
    // because it counts the frames it drew, not the gaps between them.
    //
    // The cap is measured, not assumed: the shim times the engine's
    // own callback (which IS its frame) and reads the display's
    // refresh rate from the tick intervals. If the engine keeps up,
    // nothing is gated at all.
    //
    // It runs on a delay so the engine is warm -- the first frames
    // after boot include shader compilation and map streaming, and
    // capping on those would be measuring the wrong thing.
    setTimeout(() => {
      void applyFrameCap()
        .then((s) => {
          logDebug(`[frame-pacing] ${s.reason}`);
          console.log('[frame-pacing]', s.reason);
        })
        .catch((e) => {
          console.warn('[frame-pacing] the measurement failed:', e);
        });
    }, 3000);
  }

  public static removeReloadListener() {
    window.removeEventListener('beforeunload', onBeforeUnload);
    // The match is over (or never started): give the browser its own
    // shortcuts back, so the landing page behaves like a normal web page.
    disarmBrowserChordGate();
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
  public isEngineUp(): boolean {
    return XashLoader.isEngineUp();
  }
  public onEngineUp(fn: () => void) {
    XashLoader.onEngineUp(fn);
  }
  public readGameFile(relPath: string): string | null {
    return XashLoader.readGameFile(relPath);
  }
  public setLiveInstance(inst: Xash3D | Xash3DWebRTC | null) {
    XashLoader.setLiveInstance(inst);
  }
  public allowUnload() {
    XashLoader.allowUnload();
  }
  public reconnectToServer(): Promise<boolean> {
    return XashLoader.reconnectToServer();
  }
  public isTransportOpen(): boolean {
    return XashLoader.isTransportOpen();
  }
}

export default new XashLoader();
