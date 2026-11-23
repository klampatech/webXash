/**
 * Collecting the facts, and turning them into the report the player
 * reads.
 *
 * WHY THIS IS SEPARATE FROM `perf-check.ts`
 * -----------------------------------------
 * `perf-check.ts` is the POLICY and has no imports, so the parent's
 * unit suite can exercise it directly. This file is the part that
 * touches the browser, and it is the only part that can be wrong
 * about the world.
 *
 * WHAT IT Gathers
 * ---------------
 *   - the GPU the client is running on (the ANGLE string),
 *   - the browser's user agent,
 *   - the pacer's live state (what the game is delivering RIGHT NOW),
 *   - the pacer's idle-measured panel rate (what the display can do),
 *   - the canvas's drawing buffer size.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not GUESS. If a number was not measured, it is 0 and the
 * report says "not measured yet" rather than inventing a plausible
 * figure. A readout that guesses teaches the player to ignore it.
 */
import {
  applyFrameCap,
  getPacingState,
  getIdleDisplayHz,
  getPacingHistory,
  measureIdleDisplayHz,
  type PacingState,
  type PacingWindow,
} from './frame-pacing-apply.ts';
import { engineRendererInfo } from './webgl-context.ts';
import {
  currentRenderResolution,
  detectDisplay,
  displayedRenderResolution,
  getCurrentResolutionChoice,
} from './video-settings.ts';
import {
  buildPerfReport,
  resolvePerfFacts,
  type FrameSpacingFacts,
  type PerfBrowser,
  type PerfDisplayGeometry,
  type PerfFacts,
  type PerfReport,
  type PerfSessionSnapshot,
  type PacingWindowFacts,
} from './perf-check.ts';

/**
 * The renderer, from a throwaway canvas when the engine has no context
 * yet.
 *
 * The landing page shows the readout BEFORE the engine has booted, and
 * the renderer is one of the two things worth telling the player then
 * (a software rasteriser is the worst news the game can deliver). A
 * probe canvas reports the same GPU — it is the same browser, the
 * same process, the same driver.
 *
 * The probe canvas is released immediately; it is never attached to
 * the document.
 *
 * AND IT RUNS ONCE PER SESSION. EVER.
 * -----------------------------------
 * Measured, 2026-11-20: `clientRenderer()` was creating a WebGL
 * context on EVERY call, because `engineRendererInfo()` returns
 * nothing once the engine's context is gone — and a context that is
 * gone is exactly when the readout is asked the most questions. Chrome
 * keeps about sixteen live WebGL contexts and evicts the OLDEST when
 * the seventeenth arrives, so a client that creates one per call
 * evicts the ENGINE's context out from under the game. Measured on
 * Kyle's M3 Pro: forty calls to `window.__xashPacing()` produced 186
 * "Too many active WebGL contexts. Oldest context will be lost"
 * warnings, and the page went white with the engine still running.
 *
 * The GPU does not change mid-session, so the answer is worth keeping.
 * A probe that FAILED (no context to be had) is not cached: a failed
 * probe creates no context, so retrying it is free.
 */
let probedRenderer: { name: string; vendor: string } | null = null;

function probeRenderer(): { name: string; vendor: string } {
  if (probedRenderer) return probedRenderer;
  if (typeof document === 'undefined') return { name: '', vendor: '' };
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGL2RenderingContext | null;
    if (!gl) return { name: '', vendor: '' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return { name: '', vendor: '' };
    const name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    const vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
    // Release the probe's context so the browser can reclaim it.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    probedRenderer = { name, vendor };
    return probedRenderer;
  } catch {
    return { name: '', vendor: '' };
  }
}

/** The GPU the client is running on. */
export function clientRenderer(): { name: string; vendor: string } {
  const live = engineRendererInfo();
  if (live.name) return live;
  return probeRenderer();
}

/** The canvas's drawing buffer size, in device pixels. */
function canvasBacking(): { width: number; height: number } {
  if (typeof document === 'undefined') return { width: 0, height: 0 };
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas) return { width: 0, height: 0 };
  return { width: canvas.width || 0, height: canvas.height || 0 };
}

/**
 * THE GEOMETRY, IN FULL.
 *
 * WHY THIS IS COLLECTED AT ALL
 * ---------------------------
 * On 2026-11-21 a play test on Kyle's gaming rig produced a canvas of
 * 1274x1303 device pixels -- ALMOST SQUARE -- and the export could not
 * say why: it recorded the canvas and nothing about the display the
 * canvas came from. The mode is the BOX's shape by construction (see
 * `fitRenderResolution`), so a nearly-square box means a nearly-square
 * window, and only the display's own size says whether that is the
 * player's setup or the client's.
 *
 * Four numbers, and they are not the same number:
 *
 *   the DISPLAY   what `window.screen` says   -- what 'auto' means
 *   the BOX       the canvas's CSS size        -- what the browser shows
 *   the MODE      what the engine was told     -- what it renders
 *   the BACKING   the canvas's drawing buffer  -- what it costs
 *
 * Plus the player's choice, because 'auto' and '640x360' are the same
 * picture on the wrong display, and a file that cannot tell them apart
 * cannot answer "is 'auto' really native?".
 */
function collectDisplayGeometry(): PerfDisplayGeometry {
  const display = detectDisplay();
  const box = displayedRenderResolution();
  const mode = currentRenderResolution();
  const win = typeof window !== 'undefined' ? window : null;
  return {
    displayWidth: display.width,
    displayHeight: display.height,
    windowInnerWidth: win?.innerWidth || 0,
    windowInnerHeight: win?.innerHeight || 0,
    canvasBoxWidth: box?.width || 0,
    canvasBoxHeight: box?.height || 0,
    modeWidth: mode?.width || 0,
    modeHeight: mode?.height || 0,
    resolutionChoice: getCurrentResolutionChoice(),
  };
}

/**
 * The facts, gathered.
 *
 * THREE RATES, THREE DIFFERENT THINGS.
 *
 *   `engineFps`  how many frames the GAME is drawing, counted from
 *                the engine's own frame starts;
 *   `browserHz`  how many refreshes the BROWSER is offering;
 *   `panelHz`    what the DISPLAY can do, measured while the page
 *                was idle.
 *
 * They are different numbers whenever the engine cannot keep up, or
 * whenever the cap is in force (the browser keeps ticking at the
 * panel's rate while the engine draws every Nth tick), and the
 * report needs all of them.
 */
export function collectLivePerfFacts(): PerfFacts {
  const pacing = getPacingState();
  const renderer = clientRenderer();
  const backing = canvasBacking();
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // The idle measurement is the panel's rate. If it was never taken
  // (the player clicked PLAY before the landing page had a chance to
  // measure), fall back to the browser's live tick rate, which is the
  // right answer whenever the engine keeps up.
  const panelHz = Math.max(pacing.panelHz || 0, pacing.browserHz || 0, getIdleDisplayHz());
  const engineFps = pacing.engineFps || 0;

  return {
    renderer: renderer.name,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    // The GAME's rate is the engine's own frame rate. It used to be
    // the browser's tick rate, which meant two different things
    // depending on whether the cap was engaged.
    displayHz: engineFps,
    engineFps,
    browserHz: pacing.browserHz || 0,
    panelHz,
    engineWorkMs: pacing.engineWorkMs || 0,
    sustainableFps: pacing.sustainableFps || 0,
    capFps: pacing.capFps || 0,
    everyNth: pacing.everyNth || 1,
    lateFrames: pacing.lateFrames || 0,
    measuredFrames: pacing.measuredFrames || 0,
    // WHEN the engine's cost was measured, and whether that reading
    // was past the engine's warm-up. The readout says both.
    costMeasuredAt: pacing.measuredAt || 0,
    costSettled: pacing.settled === true,
    gameStartAt: pacing.gameStartAt || 0,
    // THE WARM-UP ANCHOR AND THE MAP.
    //
    // The engine's warm-up restarts every time the server rotates the
    // map, so the readout needs to know WHICH map the reading was
    // taken on and when that map was loaded.
    costAnchorAt: pacing.costAnchorAt || 0,
    mapName: pacing.mapName || '',
    mapChangedAt: pacing.mapChangedAt || 0,
    // THE DISPLAY'S RATE AS IT WAS MEASURED AT LOAD.
    //
    // This is the reference the throttle test compares the live rate
    // against: the live tick rate is stretched by the engine's own
    // work, so it cannot tell a throttled browser from a slow engine,
    // and the idle rate — taken before the engine existed — can.
    idlePanelHz: pacing.idlePanelHz || getIdleDisplayHz(),
    // THE SHAPE OF THE FRAME SPACING: the gaps between the frames the
    // player saw. The engine's own counter cannot report these.
    pacing: pacing.pacing,
    dpr,
    backingWidth: backing.width,
    backingHeight: backing.height,
    // THE GEOMETRY, so the export can explain the render size instead
    // of only reporting it.
    display: collectDisplayGeometry(),
  };
}

/**
 * THE SESSION KEY.
 *
 * `sessionStorage`, not `localStorage`: the same tab survives the hop
 * back to the landing page and dies with the tab. A measurement from
 * another day, on possibly-changed hardware, is a different claim — and
 * the request is specifically "played a game and quit back to the web
 * ui", which is the same tab.
 */
const SESSION_KEY = 'xash.perf.session.v1';
/**
 * READ THE GEOMETRY BACK, or nothing at all.
 *
 * All or nothing: a geometry with three of its four numbers is a
 * geometry that would explain the render size wrongly, and a wrong
 * explanation in an export is worse than a missing one.
 */
function readGeometry(value: unknown): PerfDisplayGeometry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && isFinite(v) ? v : 0;
  const displayWidth = num(raw.displayWidth);
  const displayHeight = num(raw.displayHeight);
  // A display with no size is not a display.
  if (!(displayWidth > 0) || !(displayHeight > 0)) return undefined;
  return {
    displayWidth,
    displayHeight,
    windowInnerWidth: num(raw.windowInnerWidth),
    windowInnerHeight: num(raw.windowInnerHeight),
    canvasBoxWidth: num(raw.canvasBoxWidth),
    canvasBoxHeight: num(raw.canvasBoxHeight),
    modeWidth: num(raw.modeWidth),
    modeHeight: num(raw.modeHeight),
    resolutionChoice:
      typeof raw.resolutionChoice === 'string' ? raw.resolutionChoice : '',
  };
}

/**
 * THE LAST MATCH, IF THIS TAB HAS ONE.
 *
 * A snapshot that never measured a frame is worthless, so it is
 * rejected here rather than restored as a set of zeroes.
 *
 * AND A SNAPSHOT WITH NO TIMESTAMP IS REJECTED TOO. The age of the
 * numbers is part of what the readout claims about them — "your last
 * game, 12 minutes ago" — and a snapshot whose age is unknown cannot
 * say it. The writer always stamps it, so this only ever bites a
 * corrupted entry, and a corrupted entry is not worth restoring.
 */
export function readPerfSession(): PerfSessionSnapshot | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PerfSessionSnapshot> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!(Number(parsed.engineWorkMs) > 0)) return null;
    if (!(Number(parsed.measuredAt) > 0)) return null;
    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
    return {
      displayHz: num(parsed.displayHz),
      engineFps: num(parsed.engineFps),
      browserHz: num(parsed.browserHz),
      panelHz: num(parsed.panelHz),
      engineWorkMs: num(parsed.engineWorkMs),
      sustainableFps: num(parsed.sustainableFps),
      capFps: num(parsed.capFps),
      everyNth: num(parsed.everyNth) || 1,
      lateFrames: num(parsed.lateFrames),
      measuredFrames: num(parsed.measuredFrames),
      backingWidth: num(parsed.backingWidth),
      backingHeight: num(parsed.backingHeight),
      // THE GEOMETRY, carried through. It is a nested object, so it is
      // validated rather than coerced: a half-valid geometry is worse
      // than none, because it would explain the render size wrongly.
      display: readGeometry(parsed.display),
      renderer: typeof parsed.renderer === 'string' ? parsed.renderer : '',
      measuredAt: num(parsed.measuredAt),
      costMeasuredAt: num(parsed.costMeasuredAt),
      costSettled: parsed.costSettled === true,
      gameStartAt: num(parsed.gameStartAt),
      idlePanelHz: num(parsed.idlePanelHz),
      pacing: readSpacing(parsed.pacing, num),
      costAnchorAt: num(parsed.costAnchorAt),
      mapName: typeof parsed.mapName === 'string' ? parsed.mapName : '',
      mapChangedAt: num(parsed.mapChangedAt),
      timeline: readTimeline(parsed.timeline, num),
    };
  } catch {
    return null;
  }
}

/**
 * THE FRAME SPACING, IF THE SNAPSHOT CARRIES A USABLE ONE.
 *
 * A snapshot written by an older build has no pacing at all, and one
 * written by a build that measured nothing has an empty one. Both
 * restore as `null`, which the report reads as "not measured" rather
 * than as "measured, and it was zero".
 */
function readSpacing(
  raw: unknown,
  num: (v: unknown) => number,
): FrameSpacingFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<FrameSpacingFacts>;
  const p50 = num(r.p50);
  if (!(p50 > 0)) return null;
  const buckets = Array.isArray(r.buckets)
    ? r.buckets
        .filter((b): b is { ms: number; count: number } => !!b && typeof b === 'object')
        .map((b) => ({ ms: num(b.ms), count: num(b.count) }))
        .filter((b) => b.ms > 0 && b.count > 0)
    : [];
  return {
    p50,
    p90: num(r.p90),
    p99: num(r.p99),
    max: num(r.max),
    buckets,
    samples: num(r.samples),
  };
}

/**
 * THE TIMELINE, IF THE SNAPSHOT CARRIES A USABLE ONE.
 *
 * A window is a dozen numbers; a corrupt one is DROPPED rather than
 * repaired, because a timeline with a hole in it is still a timeline
 * and a timeline with a lie in it is not. The map name is the one
 * field worth keeping even when the rest of the window is thin -- it
 * is the column that says which map the cost belongs to.
 */
function readTimeline(
  raw: unknown,
  num: (v: unknown) => number,
): PacingWindowFacts[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PacingWindowFacts[] = [];
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue;
    const r = w as Partial<PacingWindowFacts>;
    const at = num(r.at);
    if (!(at > 0)) continue;
    out.push({
      at,
      mapName: typeof r.mapName === 'string' ? r.mapName : '',
      engineWorkMs: num(r.engineWorkMs),
      engineFps: num(r.engineFps),
      browserHz: num(r.browserHz),
      panelHz: num(r.panelHz),
      everyNth: num(r.everyNth) || 1,
      lateFraction: num(r.lateFraction),
      settled: r.settled === true,
      frameP50Ms: num(r.frameP50Ms),
      frameP99Ms: num(r.frameP99Ms),
      fullscreen: r.fullscreen === true,
    });
  }
  return out.length ? out : null;
}

/**
 * KEEP THE LAST MATCH.
 *
 * GUARDED ON A MEASURED FRAME **AND** A MEASURED RATE, AND THIS IS
 * THE WHOLE POINT.
 *
 * Without the guard the LANDING page writes its own empty facts on the
 * way out and destroys the very session it is supposed to show: it has
 * no engine, so its frame cost is 0, and the snapshot it would write
 * would be a session of zeroes. The landing canvas is a 300×150
 * placeholder too, so it would also overwrite the game's real render
 * size. This is the single easiest way to get this whole thing wrong,
 * so the guard is here, in one place, on every write.
 *
 * Returns true when a snapshot was written.
 */
export function savePerfSession(): boolean {
  const facts = collectLivePerfFacts();
  // THE GUARD. No engine, no snapshot.
  if (!(facts.engineWorkMs > 0)) return false;
  // AND NO DELIVERED RATE, NO SNAPSHOT EITHER.
  //
  // The pacer only trusts its own game rate after a window with
  // enough samples in it, so a short match can leave `displayHz` at 0
  // while the engine's frame cost is already known — a HALF-MEASURED
  // match. Persisting that verbatim would restore a session whose
  // game rate is unknown, and the readout would have to explain the
  // hole. The rate is the number the player actually came for, so a
  // match that did not produce one is not worth keeping.
  //
  // `sustainableFps` is deliberately NOT required: it is derived from
  // `engineWorkMs` (which is already required), and `displayHz > 0`
  // is the property that actually says "the pacer measured a window".
  if (!(facts.displayHz > 0)) return false;
  const snapshot: PerfSessionSnapshot = {
    displayHz: facts.displayHz,
    engineFps: facts.engineFps,
    browserHz: facts.browserHz,
    panelHz: facts.panelHz,
    engineWorkMs: facts.engineWorkMs,
    sustainableFps: facts.sustainableFps,
    capFps: facts.capFps,
    everyNth: facts.everyNth,
    lateFrames: facts.lateFrames,
    measuredFrames: facts.measuredFrames,
    backingWidth: facts.backingWidth,
    backingHeight: facts.backingHeight,
    display: facts.display,
    renderer: facts.renderer,
    // WHEN THE GAME ENDED. The provenance — "your last game, 12
    // minutes ago" — is measured from here, and it is NOT the same
    // thing as when the pacer took its reading.
    measuredAt: Date.now(),
    // WHEN THE PACER'S READING WAS TAKEN, and whether it was past
    // the engine's warm-up.
    costMeasuredAt: facts.costMeasuredAt ?? 0,
    costSettled: facts.costSettled === true,
    gameStartAt: facts.gameStartAt ?? 0,
    // THE DISPLAY'S RATE AT LOAD, and the shape of the frame times.
    //
    // Both are the session's own: the landing page cannot measure
    // either one, and a report that restored the game without them
    // would lose the throttle test and the judder measurement.
    idlePanelHz: facts.idlePanelHz ?? 0,
    pacing: facts.pacing ?? null,
    // THE WARM-UP ANCHOR AND THE MAP, so a restored report can say
    // WHICH map it is describing and whether the reading was taken
    // before the engine had settled on it.
    costAnchorAt: facts.costAnchorAt ?? 0,
    mapName: facts.mapName ?? '',
    mapChangedAt: facts.mapChangedAt ?? 0,
    // AND THE TIMELINE, because the export button lives on the landing
    // page and the timeline is module state that the page load at the
    // end of a match destroys.
    timeline: getPacingHistory(),
  };
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // A LONG MATCH CAN OUTGROW THE QUOTA. The timeline is the biggest
    // part of the snapshot and the part that can be shortened without
    // losing the claim: the oldest windows are the ones nobody is
    // going to ask about.
    const shorter: PerfSessionSnapshot = {
      ...snapshot,
      timeline: (snapshot.timeline ?? []).slice(-120),
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(shorter));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * KEEP THE SESSION WHENEVER THE PAGE GOES AWAY.
 *
 * `pagehide` and not `beforeunload`: the loader already owns a
 * `beforeunload` (the reload confirmation), and `pagehide` is the hook
 * that fires when the page is really going away — including the full
 * load back to the landing page.
 *
 * The write is guarded on a measured frame, so the landing page's own
 * `pagehide` cannot erase the session it is about to show.
 *
 * Returns the remover.
 */
export function installPerfSessionWriter(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onPageHide = () => {
    savePerfSession();
  };
  window.addEventListener('pagehide', onPageHide);
  return () => window.removeEventListener('pagehide', onPageHide);
}

/**
 * THE FACTS, WITH THE SESSION RESTORED.
 *
 * The live page measures the browser's rate and the GPU; the session
 * supplies the game's own numbers when the game is not running. The
 * merge itself is the pure policy in `perf-check.ts` — this is only the
 * browser-touching half.
 */
export function collectPerfFacts(): PerfFacts {
  return resolvePerfFacts(collectLivePerfFacts(), readPerfSession());
}

/** The report, for the player. The landing page's copy. */
export function clientReport(): PerfReport {
  return buildPerfReport(collectPerfFacts());
}

/**
 * The report for the IN-GAME copy.
 *
 * The game is running, so the live facts are the facts: the session
 * must never put a stale number in front of a player who is looking
 * at the game RIGHT NOW.
 */
export function liveReport(): PerfReport {
  return buildPerfReport(collectLivePerfFacts());
}

/**
 * Make sure the panel's refresh rate has been measured.
 *
 * It has to be measured while the page is IDLE, so this is called from
 * the landing page — before the engine exists — and again by the
 * loader if the player never gave it a chance.
 */
export async function ensurePanelRateMeasured(): Promise<number> {
  const known = getIdleDisplayHz();
  if (known > 0) return known;
  return measureIdleDisplayHz();
}

/**
 * MEASURE THE ENGINE'S FRAME COST AGAIN.
 *
 * THE SECOND HALF OF "Re-measure", AND THE HALF THAT MATTERS.
 *
 * The panel's refresh rate is measured while the page is idle, and
 * the engine's frame cost is measured while the game is running —
 * and the two cannot be measured at the same time. So this one is
 * only for the running game.
 *
 * AND IT IS THE POINT OF THE WHOLE FEATURE. The readout is an
 * instrument: the player turns a draw-cost switch off, presses
 * Re-measure, and reads the frame cost. Without a way to re-measure
 * the engine's cost, the readout can only report what it saw once,
 * and a player has no way to find out whether anything they changed
 * made a difference.
 *
 * The measurement is the pacer's own window — two seconds of the
 * engine's own frames — so it is exactly the number the cap decision
 * is made on, and the gate moves on it the same way it moves on the
 * pacer's own periodic reading.
 *
 * Returns true when a measurement was taken.
 */
export async function remeasureEngineCost(): Promise<boolean> {
  // No engine, no frame cost to measure. The landing page's canvas is
  // a placeholder and the engine is not running there.
  if (getPacingState().engineWorkMs <= 0) return false;
  await applyFrameCap();
  return true;
}

/**
 * THE PERFORMANCE LOG, AS A FILE.
 *
 * THE ARTIFACT THAT MAKES A COMPLAINT CHECKABLE.
 *
 * "It stutters in fullscreen" is a claim about a machine, and it is
 * a claim about a MOMENT — a player cannot tell whether the frame
 * they stuttered on was the engine's fault, the browser's, or the
 * display's, and they cannot tell it afterwards either.
 *
 * This is the whole timeline of the match: every measurement window
 * the pacer took, with the engine's frame cost, the rate the game was
 * drawing, the rate the browser was handing it, the gate in force and
 * how many of the engine's frames arrived late. The drops are in
 * there, and so is everything else that was happening when they
 * happened.
 *
 * It is exported FROM THE GAME, on the machine the game is running
 * on, and it measures the session the player is actually playing —
 * which a harness attached to a DIFFERENT browser profile would not.
 */
export interface PerfLogExport {
  /** The format's version, so a reader knows what it is looking at. */
  version: number;
  /** When the log was exported, in epoch milliseconds. */
  exportedAt: number;
  /** The browser. */
  userAgent: string;
  /** The GPU the client was running on. */
  renderer: string;
  /** The device pixel ratio. */
  dpr: number;
  /** The game's render size, in device pixels. */
  backingWidth: number;
  backingHeight: number;
  /**
   * THE GEOMETRY: the display, the window, the canvas's box, the mode
   * the engine was given, and the player's choice.
   *
   * Null when the page could not measure it. It is never guessed: a
   * number that is not measured is not a number.
   */
  display: PerfDisplayGeometry | null;
  /** The pacer's state at the moment of the export. */
  pacing: PacingState;
  /** The timeline of the match, oldest first. */
  timeline: PacingWindow[];
  /**
   * THE SAME TIMELINE, GROUPED BY WHETHER THE GAME WAS FULLSCREEN.
   *
   * This is the comparison everybody asks for and nobody can make:
   * "is fullscreen actually slower than windowed, on MY machine?"
   *
   * It is answered by MEDIANS and not by averages, because one
   * expensive window — a scene change, a texture load — would drag an
   * average far enough to make a difference that is not there.
   */
  byMode: {
    fullscreen: ModeSummary;
    windowed: ModeSummary;
  };
  /** The report, exactly as the player sees it. */
  report: PerfReport;
}

/**
 * ONE MODE'S WINDOWS, SUMMED.
 *
 * The median is the number that matters: the middle window, not the
 * average of all of them.
 */
export interface ModeSummary {
  /** How many windows there were. */
  windows: number;
  /** The median frame cost, in milliseconds. 0 when there were none. */
  medianWorkMs: number;
  /** The median rate the game was drawing, in fps. 0 when there were none. */
  medianFps: number;
  /** The worst frame cost in this mode, in milliseconds. */
  worstWorkMs: number;
}

/**
 * THE MEDIAN OF A LIST.
 *
 * A copy of the pacer's own, because the pacer's is not exported and
 * this file is not the pacer.
 */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * SUMMARISE ONE MODE.
 */
function summarizeMode(windows: PacingWindow[]): ModeSummary {
  if (!windows.length) {
    return { windows: 0, medianWorkMs: 0, medianFps: 0, worstWorkMs: 0 };
  }
  return {
    windows: windows.length,
    medianWorkMs: median(windows.map((w) => w.engineWorkMs)),
    medianFps: median(windows.map((w) => w.engineFps)),
    worstWorkMs: Math.max(...windows.map((w) => w.engineWorkMs)),
  };
}

/** The version of the export format. */
export const PERF_LOG_VERSION = 1;

/**
 * THE PACER'S STATE, AS THE SESSION SAW IT.
 *
 * The export's `pacing` block is the pacer's state at the moment of
 * the export. On the landing page the pacer has no state at all -- the
 * module was reloaded -- so the session's numbers are used instead. A
 * state built from the snapshot is the same state, minus the fields
 * the snapshot does not carry.
 */
function sessionPacingState(session: PerfSessionSnapshot | null): PacingState {
  const everyNth = Math.max(1, Math.round(session?.everyNth || 1));
  const measuredFrames = session?.measuredFrames ?? 0;
  return {
    capFps: session?.capFps ?? 0,
    browserHz: session?.browserHz ?? 0,
    panelHz: session?.panelHz ?? 0,
    engineFps: session?.engineFps ?? 0,
    engineWorkMs: session?.engineWorkMs ?? 0,
    sustainableFps: session?.sustainableFps ?? 0,
    active: everyNth > 1,
    everyNth,
    provisional: false,
    lateFrames: session?.lateFrames ?? 0,
    measuredFrames,
    lateFraction:
      measuredFrames > 0 ? (session?.lateFrames ?? 0) / measuredFrames : 0,
    measuredAt: session?.measuredAt ?? 0,
    settled: session?.costSettled === true,
    gameStartAt: session?.gameStartAt ?? 0,
    costAnchorAt: session?.costAnchorAt ?? 0,
    mapName: session?.mapName ?? '',
    mapChangedAt: session?.mapChangedAt ?? 0,
    idlePanelHz: session?.idlePanelHz ?? 0,
    pacing: session?.pacing
      ? { ...session.pacing, buckets: session.pacing.buckets ?? [] }
      : { p50: 0, p90: 0, p99: 0, max: 0, buckets: [], samples: 0 },
    reason: 'the last match in this tab',
  };
}

/**
 * BUILD THE LOG.
 *
 * THE EXPORT BUTTON LIVES ON THE LANDING PAGE, AND THE LANDING PAGE
 * HAS NO ENGINE.
 *
 * So the log is built from the LIVE page state when the game is
 * running, and from the SESSION when it is not -- the snapshot that
 * survives the page load at the end of a match. Building it from the
 * live state alone is what made the export empty: on the landing page
 * the live state is a 300x150 placeholder canvas with no engine behind
 * it, so every number in the file was zero and the timeline was empty.
 * The file Kyle sent to prove it was not subtle.
 */
export function buildPerfLog(): PerfLogExport {
  const live = collectLivePerfFacts();
  const session = readPerfSession();
  const gameRunning = live.engineWorkMs > 0;
  const facts = gameRunning ? live : resolvePerfFacts(live, session);
  const timeline = gameRunning
    ? getPacingHistory()
    : ((session?.timeline ?? []) as PacingWindow[]);
  return {
    version: PERF_LOG_VERSION,
    exportedAt: Date.now(),
    userAgent: facts.userAgent,
    renderer: facts.renderer,
    dpr: facts.dpr,
    backingWidth: facts.backingWidth,
    backingHeight: facts.backingHeight,
    display: facts.display ?? null,
    pacing: gameRunning ? getPacingState() : sessionPacingState(session),
    timeline,
    byMode: {
      fullscreen: summarizeMode(timeline.filter((w) => w.fullscreen)),
      windowed: summarizeMode(timeline.filter((w) => !w.fullscreen)),
    },
    report: buildPerfReport(facts),
  };
}

/**
 * DOWNLOAD THE LOG.
 *
 * A Blob and an anchor, and the browser does the rest. The file is
 * named after the moment it was taken, so a folder of them sorts.
 */
export function downloadPerfLog(): string {
  const log = buildPerfLog();
  const stamp = new Date(log.exportedAt).toISOString().replace(/[:.]/g, '-');
  const name = `bulletballet-perf-${stamp}.json`;
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // The object URL is released on the next tick, or the blob is kept
  // alive for the life of the page for nothing.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}

/**
 * The browser family, for the readout's own wording.
 *
 * Exported here rather than read from `perf-check.ts` directly so the
 * UI has one import for the whole thing.
 */
export function clientBrowser(): PerfBrowser {
  return buildPerfReport(collectPerfFacts()).browser;
}
