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
  type PerfBrowser,
  type PerfFacts,
  type PerfReport,
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
  } catch (e) {
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
 * The pacer's `displayHz` is what the GAME is delivering; `panelHz` is
 * what the DISPLAY can do. They are different numbers whenever the
 * engine cannot keep up, and the report needs both.
 */
export function collectPerfFacts(): PerfFacts {
  const pacing = getPacingState();
  const renderer = clientRenderer();
  const backing = canvasBacking();
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // The idle measurement is the panel's rate. If it was never taken
  // (the player clicked PLAY before the landing page had a chance to
  // measure), fall back to the live rate, which is the right answer
  // whenever the engine keeps up.
  const panelHz = Math.max(pacing.panelHz || 0, pacing.displayHz || 0, getIdleDisplayHz());

  return {
    renderer: renderer.name,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    displayHz: pacing.displayHz || 0,
    panelHz,
    engineWorkMs: pacing.engineWorkMs || 0,
    sustainableFps: pacing.sustainableFps || 0,
    capFps: pacing.capFps || 0,
    everyNth: pacing.everyNth || 1,
    lateTicks: pacing.lateTicks || 0,
    measuredTicks: pacing.measuredTicks || 0,
    dpr,
    backingWidth: backing.width,
    backingHeight: backing.height,
  };
}

/** The report, for the player. */
export function clientReport(): PerfReport {
  return buildPerfReport(collectPerfFacts());
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
