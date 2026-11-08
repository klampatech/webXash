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
import { getPacingState, getIdleDisplayHz, measureIdleDisplayHz } from './frame-pacing-apply.ts';
import { engineRendererInfo } from './webgl-context.ts';
import {
  buildPerfReport,
  resolvePerfFacts,
  type PerfBrowser,
  type PerfFacts,
  type PerfReport,
  type PerfSessionSnapshot,
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
 */
function probeRenderer(): { name: string; vendor: string } {
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
    return { name, vendor };
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
    dpr,
    backingWidth: backing.width,
    backingHeight: backing.height,
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
      renderer: typeof parsed.renderer === 'string' ? parsed.renderer : '',
      measuredAt: num(parsed.measuredAt),
      costMeasuredAt: num(parsed.costMeasuredAt),
      costSettled: parsed.costSettled === true,
      gameStartAt: num(parsed.gameStartAt),
    };
  } catch {
    return null;
  }
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
  };
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
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
 * The browser family, for the readout's own wording.
 *
 * Exported here rather than read from `perf-check.ts` directly so the
 * UI has one import for the whole thing.
 */
export function clientBrowser(): PerfBrowser {
  return buildPerfReport(collectPerfFacts()).browser;
}
