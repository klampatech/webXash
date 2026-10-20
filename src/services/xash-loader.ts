import { type Xash3D } from 'xash3d-fwgs';
import { type Xash3DWebRTC } from '/@/services/xash-webrtc.ts';
import type { FilesWithPath } from '/@/utils/directory-open.ts';
import type { ConsoleCallback, Enumify } from '/@/types.ts';
import { unzipSync } from 'fflate';
import { getZip } from '/@/utils/zip-helpers';
import SaveManager from '/@/services/save-manager.ts';
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
// CS/MP/opfor/bshift games aren't built — but the engine still tries
// to fetch these via locateFile at startup. Point them all at hl.dll
// so the engine gets valid WASM bytes (even though they're the wrong
// game logic, the engine will only use them if you start a CS game).
const CSMenuURL = HLServerURL;
const CSClientURL = HLClientURL;
const CSServerURL = HLServerURL;

const XASH_BASE_DIR = '/rodir/';

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

export interface StartGameOptions extends GameLoaderOptions {
  onStartLoading?: () => void;
  onEndLoading?: () => void;
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
    // on TS maps. -console is intentionally left to BASE_GAME.
    name: 'The Specialists',
    launchArgs: ['-game', 'ts', '+map', 'ts_apartments'],
    publicDir: 'hl/',
    libraries: {
      ...XASH_LIBS,
      client: HLClientURL,
      server: HLServerURL,
    },
    ...BASE_GAME_SETTINGS,
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

class XashLoader {
  private async _getXashInstance(): Promise<
    typeof Xash3D | typeof Xash3DWebRTC
  > {
    // XashMultiplayerIP.vue stores its config at window.__multiplayerConfig
    // (server, role, room) — and ONLY when the user has explicitly
    // enabled the multiplayer checkbox. server is a host:port that
    // resolves to a WebSocket signaling server. When present, we route
    // through Xash3DMultiplayer (a Xash3DWebRTC subclass); otherwise
    // use vanilla Xash3D (single-player).
    const cfg = (window as any).__multiplayerConfig;
    const server = cfg?.server;
    if (server && /\d/.test(server)) {
      const { Xash3DMultiplayer } = await import('../services/xash-multiplayer.ts');
      const Ctor = Xash3DMultiplayer as unknown as typeof Xash3D;
      return Ctor;
    } else {
      const { Xash3D } = await import('xash3d-fwgs');
      return Xash3D;
    }
  }

  public async initXash(options: GameLoaderOptions): Promise<Xash3D> {
    const Xash3D = await this._getXashInstance();

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
    const xash = new Xash3D({
      arguments: options.launchArgs,
      multiplayerIP: store.multiplayerIP,
      onError: XashLoader.removeReloadListener,
      module: {
        // Forward engine stdout/stderr to browser console so headless
        // smokes (Playwright) can capture engine-side events:
        // - "Loading DLL dlls/hl_emscripten_wasm32.wasm" → confirms
        //   our TS server WASM is the one being dlopened
        // - "Unknown command: buy" / "Got command \"buy\"" → D.7.18 P1
        //   signal for whether the server DLL accepted TS commands
        // - "game rules: <class>" / "CTSGameRules" → confirms our
        //   patched InstallGameRules factory returned our subclass
        print: (log: string) => console.log(`[xash-stdout] ${log}`),
        printErr: (log: string) => console.log(`[xash-stderr] ${log}`),
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
    });

    await xash.init();
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

  public async processZip(zipBuffer: ArrayBuffer, xash: Xash3D): Promise<void> {
    const zipData = new Uint8Array(zipBuffer);
    const files = unzipSync(zipData);

    xash.em.FS.mkdirTree(XASH_BASE_DIR);

    for (const [filename, content] of Object.entries(files)) {
      const path = XASH_BASE_DIR + filename;
      if (filename.endsWith('/')) {
        xash.em.FS.mkdirTree(path);
      } else {
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) {
          xash.em.FS.mkdirTree(dir);
        }
        xash.em.FS.writeFile(path, content);
      }
    }

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
  ): Promise<Xash3D> {
    const xash = await this.initXash(options);

    // Load zip and extras in parallel
    const [, extrasBuffer] = await Promise.all([
      this.processZip(zipBuffer, xash),
      this.fetchExtras(),
    ]);

    await this.writeExtras(xash, extrasBuffer);
    xash.main();
    return xash;
  }

  public async downloadZip(
    selectedZip: string,
    publicDir: string,
    onProgress?: (progress: number) => void,
  ): Promise<ArrayBuffer | undefined> {
    if (!selectedZip) return;
    return await getZip(selectedZip, publicDir, onProgress!);
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

    let zipBuffer = zip;

    // Download zip and fetch extras in parallel if needed
    if (!zipBuffer && selectedZip && publicDir) {
      const [downloadedZip, extrasBuffer] = await Promise.all([
        this.downloadZip(selectedZip, publicDir, onDownloadProgress),
        this.fetchExtras(),
      ]);
      zipBuffer = downloadedZip;

      if (!zipBuffer) {
        throw new Error('Failed to download or provide zip file');
      }

      // Init xash and process zip, then write extras
      const xash = await this.initXash({
        canvas: options.canvas,
        selectedGame: options.selectedGame,
        launchArgs: options.launchArgs,
      });

      await this.processZip(zipBuffer, xash);
      await this.writeExtras(xash, extrasBuffer);
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
    const args = [
      ...baseArgs,
      ...(options.launchOptions?.split(' ').filter(Boolean) || []),
    ];

    if (options.enableConsole) {
      args.push(CONSOLE_ARG);
    }

    if (options.selectedLocalFolder) {
      args.push('-game');
      args.push(options.selectedLocalFolder);
    }

    return args;
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
}

export default new XashLoader();
