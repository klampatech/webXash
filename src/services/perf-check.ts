/**
 * What the player's client is actually doing, and what they can do
 * about it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The client measures everything it needs to know and shows the player
 * NONE of it. The frame pacer knows the browser's real refresh rate and
 * the engine's real per-frame cost; the WebGL context knows which GPU
 * it is running on. None of it reaches the screen.
 *
 * So a player whose browser is quietly halving their refresh rate
 * sees "the game runs at 40-50 fps sometimes and feels smooth at 60",
 * and has no way to find out why. The answer is almost always in
 * THEIR browser, not in the game:
 *
 *   - Chrome's Energy Saver (chrome://settings/performance) reduces the
 *     DISPLAY refresh rate when the machine is unplugged. Measured on
 *     Kyle's MacBook, 2026-11-07: the browser was delivering 120 Hz on
 *     one run and 78 Hz minutes later on the same machine, on
 *     battery. Chrome's own documentation says Energy Saver "reduces
 *     the display refresh rate, affecting scrolling and animation
 *     fidelity", and that a rAF loop which assumes 16.67 ms "will run
 *     twice as slow when Energy Saver mode is enabled".
 *   - macOS Low Power Mode caps a ProMotion panel at 60 Hz.
 *   - Firefox's `layout.frame_rate` defaults to "auto", which falls
 *     back to SOFTWARE vsync at 60 Hz when hardware vsync is
 *     unavailable — on a 144 Hz panel, silently.
 *
 * None of these are the game's fault and all of them are fixable by
 * the player in about thirty seconds. The game can only say so.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The POLICY: it takes the facts and produces the report. It is PURE
 * and has NO IMPORTS, on purpose, so the parent's unit suite can
 * exercise it directly — the same constraint `video-settings.ts` and
 * `frame-pacing.ts` are written under.
 *
 * The facts are gathered by `perf-collect.ts`, which is the part that
 * touches the browser.
 *
 * THE ONE RULE
 * ------------
 * Every finding here is derived from a MEASUREMENT, and the report
 * says which measurement. A readout that guesses is worse than no
 * readout: it teaches the player to ignore it.
 */

/** The facts a report is built from. Every one is measured. */
export interface PerfFacts {
  /**
   * The WebGL renderer string, as the browser reports it.
   *
   * `ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, ...)` on a
   * modern Mac, `ANGLE (AMD, Vulkan 1.4.305 (AMD Radeon ...), radv)`
   * on a Linux box with a real GPU, and
   * `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)),
   * SwiftShader driver)` when there is no GPU at all.
   */
  renderer: string;
  /** The browser's user agent. */
  userAgent: string;
  /**
   * The rate the GAME is delivering right now, in Hz.
   *
   * This is the GAME's rate — the engine's own frames — and not the
   * display's rate when the engine cannot keep up. It is the honest
   * answer to "how many frames a second is the game drawing".
   */
  displayHz: number;
  /**
   * The rate the GAME is drawing frames at, measured directly from
   * the engine's own frame starts.
   *
   * THIS IS THE NUMBER THE READOUT USES. The old `displayHz` meant
   * two different things depending on whether the cap was engaged:
   * before the cap it was the game's tick rate, after it the panel's
   * rate, because the browser keeps ticking while the engine draws
   * every Nth tick. Measuring the engine's frames removes the
   * ambiguity.
   */
  engineFps: number;
  /**
   * The rate the BROWSER is delivering ticks at, right now.
   *
   * This is the browser's own tick rate, measured from the intervals
   * between the ticks. It is what the browser-bound attribution
   * compares against the panel's rate.
   */
  browserHz: number;
  /**
   * The rate the BROWSER delivers, measured while the page was idle.
   *
   * This is the number the frame budget is computed against: it is
   * the display's frame period as the browser sees it. It is measured
   * separately because the live rate above is stretched by the
   * engine's own work — see `measureIdleDisplayHz`.
   */
  panelHz: number;
  /** The engine's per-frame cost, in milliseconds. 0 = not measured. */
  engineWorkMs: number;
  /** The frame rate the engine can sustain. 0 = not measured. */
  sustainableFps: number;
  /** The cap the pacer chose, in fps. 0 = no cap in force. */
  capFps: number;
  /** How many display ticks pass per engine frame. 1 = every tick. */
  everyNth: number;
  /**
   * How many of the ENGINE's frames arrived late in the measurement
   * window.
   *
   * The engine's frames, not the browser's ticks, and measured
   * against the GATE's period — so a game that is landing its
   * frames on time reads zero.
   */
  lateFrames: number;
  /** How many of the ENGINE's frames the measurement window saw. */
  measuredFrames: number;
  /** The device pixel ratio. */
  dpr: number;
  /** The canvas's drawing buffer width, in device pixels. */
  backingWidth: number;
  /** The canvas's drawing buffer height, in device pixels. */
  backingHeight: number;
  /**
   * TRUE when these facts came from the LAST MATCH rather than from a
   * live measurement on this page.
   *
   * The game is not running when this is true, so every claim the
   * report makes about the game has to be in the past tense — and the
   * report says where the numbers came from and how old they are.
   */
  fromLastSession?: boolean;
  /**
   * When the facts were measured, in epoch milliseconds.
   *
   * 0 when there is no stamp: the live facts are "right now", and
   * saying so is better than pretending they have a timestamp.
   */
  measuredAt?: number;
  /**
   * TRUE when the DISPLAY's rate came from the last match rather than
   * from a live idle measurement.
   *
   * The browser's refresh rate is the one number the landing page can
   * measure for itself, so it is usually live — and then the claim
   * about it is in the present tense. Only when there is no live
   * measurement does it come from the session.
   */
  panelHzFromSession?: boolean;
  /**
   * THE DISPLAY'S RATE, MEASURED RIGHT NOW.
   *
   * When the facts come from the last match, this is the rate the
   * landing page's own measurement gives — and it is kept apart from
   * `panelHz` on purpose: `panelHz` is the rate the game's numbers
   * belong to, and this one is a fact about the browser as it is now.
   */
  livePanelHz?: number;
  /**
   * When the ENGINE'S COST was measured, in epoch milliseconds.
   *
   * This is NOT `measuredAt`: that one is the provenance — when the
   * game ended — and this one is when the numbers in the report were
   * taken. The readout says when, because "measured 32 seconds into
   * your last game" and "measured in the first seconds after the
   * game started" are different claims.
   */
  costMeasuredAt?: number;
  /**
   * Was that cost measurement past the engine's warm-up?
   *
   * False means the reading describes the engine WARMING UP, not the
   * machine, and the report says so.
   */
  costSettled?: boolean;
  /**
   * When the engine's FIRST FRAME was, in epoch milliseconds.
   *
   * The cost measurement's age is measured from here.
   */
  gameStartAt?: number;
  /**
   * The DISPLAY's rate as it was measured while the page was IDLE.
   *
   * This is the panel's own rate, taken before the engine existed, and
   * it is the only reading that can tell a THROTTLED browser from a
   * slow engine: the live tick rate is stretched by both, so it
   * cannot, but the idle rate was taken before either could stretch
   * it.
   *
   * Chrome's Energy Saver is the usual culprit — it drops a 120 Hz
   * panel to 60 Hz, or to 78 Hz on some machines, when the machine is
   * unplugged — and the player's only symptom is a game that feels
   * worse than the display can show.
   */
  idlePanelHz?: number;
  /**
   * The shape of the engine's frame spacing.
   *
   * The gap between the frames the player SEES. The engine's own
   * counter says how many frames it drew; this says how far apart
   * they were, and the spread between the median and the 99th
   * percentile IS the judder.
   */
  pacing?: FrameSpacingFacts | null;
}

/**
 * THE SHAPE OF THE ENGINE'S FRAME SPACING.
 *
 * The percentiles are the honest summary — a median with a long tail
 * is a different thing from a median with a short one — and the
 * buckets are the picture: one dominant bucket means the frames are
 * evenly spaced, several mean the gaps are uneven.
 */
export interface FrameSpacingFacts {
  /** The median gap between frames, in milliseconds. */
  p50: number;
  /** The 90th percentile. */
  p90: number;
  /** The 99th percentile. */
  p99: number;
  /** The worst gap in the window. */
  max: number;
  /** The most common gaps, rounded to a tenth of a millisecond. */
  buckets: Array<{ ms: number; count: number }>;
  /** How many gaps the window saw. */
  samples: number;
}

/**
 * THE LAST MATCH, KEPT ACROSS THE PAGE LOAD.
 *
 * Quitting to the web UI is a full page load, and everything the
 * readout knows lives in module state that dies with the page. This is
 * the snapshot that survives the hop — `sessionStorage`, so it belongs
 * to THIS TAB and dies with it.
 */
export interface PerfSessionSnapshot {
  /** The rate the GAME was delivering. */
  displayHz: number;
  /** The rate the GAME was drawing, measured from the engine's frames. */
  engineFps: number;
  /** The rate the BROWSER was delivering ticks at. */
  browserHz: number;
  /** The rate the BROWSER was delivering. */
  panelHz: number;
  /** The engine's per-frame cost, in milliseconds. */
  engineWorkMs: number;
  /** The frame rate the engine could sustain. */
  sustainableFps: number;
  /** The cap that was in force. */
  capFps: number;
  /** How many display ticks passed per engine frame. */
  everyNth: number;
  /** How many of the ENGINE's frames arrived late. */
  lateFrames: number;
  /** How many of the ENGINE's frames the measurement window saw. */
  measuredFrames: number;
  /** The game's real render width, in device pixels. */
  backingWidth: number;
  /** The game's real render height, in device pixels. */
  backingHeight: number;
  /** The GPU the client was running on. */
  renderer: string;
  /** When it was measured, in epoch milliseconds. */
  measuredAt: number;
  /** When the engine's cost was measured, in epoch milliseconds. */
  costMeasuredAt: number;
  /** Was that cost measurement past the engine's warm-up? */
  costSettled: boolean;
  /** When the engine's first frame was, in epoch milliseconds. */
  gameStartAt: number;
  /**
   * The DISPLAY's rate as it was measured while the page was idle.
   *
   * The reference the throttle test needs: without it, the landing
   * page cannot tell a throttled browser from a slow engine.
   */
  idlePanelHz: number;
  /**
   * The shape of the engine's frame spacing.
   *
   * The gaps between the frames the player saw, which is the thing
   * the engine's own counter cannot report.
   */
  pacing: FrameSpacingFacts | null;
}

/** How bad a finding is. */
export type PerfSeverity = 'ok' | 'info' | 'warn' | 'bad';

/** One thing the player should know. */
export interface PerfFinding {
  /** A stable id — the UI keys off it and the tests assert on it. */
  id: string;
  severity: PerfSeverity;
  /** The headline. */
  title: string;
  /** The detail, including the number it is based on. */
  detail: string;
}

/** The browser families the checklist knows about. */
export type PerfBrowser = 'chromium' | 'firefox' | 'safari' | 'unknown';

/** One line of the checklist. */
export interface PerfChecklistItem {
  id: string;
  /** What to do, in one sentence. */
  action: string;
  /** Where to do it. */
  where: string;
  /** Why, in one sentence. */
  why: string;
}

/** The whole readout. */
export interface PerfReport {
  /** The browser family, detected from the user agent. */
  browser: PerfBrowser;
  /**
   * WHERE THE NUMBERS CAME FROM.
   *
   * `live` means they were measured on this page, right now.
   * `last-session` means they were measured during the last match in
   * this tab and restored from the session — the game is NOT running,
   * and every claim about it is in the past tense.
   */
  source: 'live' | 'last-session';
  /**
   * When the numbers were measured, in epoch milliseconds. 0 when they
   * are live: "right now" has no timestamp worth printing.
   */
  measuredAt: number;
  /**
   * WHEN THE NUMBERS IN THE REPORT WERE MEASURED, in epoch
   * milliseconds.
   *
   * `measuredAt` is the PROVENANCE — when the game ended, for a
   * restored report. This one is when the pacer took its reading, and
   * it is the number that says "these are 40 seconds old" while the
   * game is running.
   */
  costMeasuredAt: number;
  /** The findings, most serious first. */
  findings: PerfFinding[];
  /** The checklist — only the items that apply to these facts. */
  checklist: PerfChecklistItem[];
  /** The one-line summary. */
  summary: string;
  /** The headline numbers, for the readout's own display. */
  numbers: {
    /** The rate the game is delivering right now. */
    displayHz: number;
    /**
     * The rate the GAME is drawing frames at, measured from the
     * engine's own frames.
     *
     * This is what the readout's "the game was drawing N fps" row
     * uses — never the browser's tick rate, which says something else
     * entirely once the cap is in force.
     */
    engineFps: number;
    /** The rate the browser is delivering ticks at. */
    browserHz: number;
    /** The rate the browser delivers. */
    panelHz: number;
    engineWorkMs: number;
    budgetMs: number;
    /** How much of the frame budget the engine uses, as a percentage. */
    budgetUsedPct: number;
    backingPixels: number;
    /**
     * THE SHAPE OF THE ENGINE'S FRAME SPACING.
     *
     * `null` when it was not measured — the readout shows a number
     * when it has one and says nothing when it does not.
     */
    pacing: FrameSpacingFacts | null;
    /**
     * HOW FAR THE GAME IS FROM THE NEXT FRAME RATE UP.
     *
     * `null` when there is no next step: the game is uncapped, or the
     * numbers needed to say are missing.
     */
    nextRate: NextRateGap | null;
    /**
     * THE DISPLAY'S RATE AS IT WAS MEASURED AT LOAD.
     *
     * The reference the throttle test compares the live rate against.
     */
    idlePanelHz: number;
  };
}

/**
 * The browser family, from the user agent.
 *
 * The Chromium family is one bucket because the settings that matter
 * (`chrome://settings/performance`, `chrome://settings/system`,
 * `chrome://gpu`) are the same in Chrome, Edge, Brave, Vivaldi and
 * Opera — Vivaldi and Edge both expose the `chrome://` scheme.
 */
export function detectBrowser(userAgent: string): PerfBrowser {
  const ua = String(userAgent || '');
  if (/Firefox\/|FxiOS\//i.test(ua)) return 'firefox';
  // Safari's UA contains "Safari", and so does every Chromium one, so
  // the Chromium test has to come first.
  if (/Chrome\/|Chromium\/|Edg\/|OPR\/|Vivaldi\/|Brave\//i.test(ua)) return 'chromium';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'unknown';
}

/**
 * Is the browser rendering the game in software?
 *
 * A software rasteriser is the single most expensive thing that can
 * happen to this engine, and it is INVISIBLE unless you go and look
 * for it. The project's own perf README records the trap: a whole
 * round of performance work was built on SwiftShader measurements
 * before anyone checked the renderer string, and the "150 ms of
 * client lag" turned out to be the software rasteriser.
 */
export function isSoftwareRenderer(renderer: string): boolean {
  const r = String(renderer || '').toLowerCase();
  return (
    r.includes('swiftshader') ||
    r.includes('llvmpipe') ||
    r.includes('softpipe') ||
    r.includes('basic render') ||
    r.includes('software rasterizer') ||
    r.includes('microsoft basic')
  );
}

/**
 * Is the refresh rate suspiciously LOW?
 *
 * The browser's rAF rate is the display's rate, unless something has
 * throttled it.
 *
 * THE FIRST VERSION OF THIS WAS WRONG, AND THE UNIT SUITE CAUGHT IT.
 * It asked "can the engine do more than twice what the browser is
 * offering?" — and a HEALTHY client on a 120 Hz panel (engine 4 ms,
 * 212 fps sustainable) fails that test, because the engine CAN do
 * more than the panel can show. That is not throttling; that is the
 * engine being fast. The test would have told every player on a
 * modern display that their browser was broken.
 *
 * THE RULE THAT IS ACTUALLY RIGHT
 * ------------------------------
 * Two things have to be true:
 *
 *   1. THE RATE IS BELOW 60 Hz. No modern display runs at 30 Hz, and
 *      60 Hz is a real rate that a real display runs at — nagging every
 *      60 Hz player about Energy Saver is how a readout gets ignored.
 *      30 Hz and below is the signature of a power-saving mode
 *      (Chrome's Energy Saver halves the refresh rate; macOS Low
 *      Power Mode caps a ProMotion panel at 60; Firefox's software
 *      vsync fallback is 60).
 *
 *   2. THE ENGINE COULD USE MORE. If the engine cannot sustain even
 *      the throttled rate, then the throttle is not what is holding
 *      the game back, and telling the player to fix it would be
 *      sending them to the wrong settings.
 */
export function refreshRateLooksThrottled(facts: PerfFacts): boolean {
  const rate = facts.panelHz > 0 ? facts.panelHz : facts.displayHz;
  if (rate <= 0) return false;
  if (rate >= 60) return false;
  if (facts.sustainableFps <= 0) return false;
  return facts.sustainableFps > rate * 1.6;
}

/** The frame budget for a refresh rate, in milliseconds. */
export function frameBudgetMs(displayHz: number): number {
  if (!isFinite(displayHz) || displayHz <= 0) return 0;
  return 1000 / displayHz;
}

/**
 * THE SAFETY FACTOR THE PACER APPLIES.
 *
 * The engine must not merely FIT the frame budget; it must fit it
 * with room to spare, because a frame that overruns occasionally is
 * exactly what produces the uneven pacing the cap exists to remove.
 *
 * It is written out here rather than imported, because this module
 * has NO IMPORTS on purpose — the parent's unit suite runs it
 * directly with `node --experimental-strip-types`. The unit suite
 * asserts that this and `frame-pacing.ts` agree, so the two cannot
 * drift apart silently.
 */
export const SAFETY_FACTOR = 0.85;

/**
 * THE COST HYSTERESIS THE PACER APPLIES WHEN IT NARROWS A GATE.
 *
 * Same reasoning as above: this has to match
 * `NARROW_COST_HYSTERESIS` in `frame-pacing.ts`, and the unit suite
 * asserts that it does.
 */
export const NARROW_COST_HYSTERESIS = 0.04;

/**
 * HAS THE BROWSER TAKEN REFRESHES AWAY SINCE THE PAGE LOADED?
 *
 * THE ONE QUESTION THE LIVE TICK RATE CANNOT ANSWER ON ITS OWN.
 *
 * The browser's live tick rate is the display's frame period PLUS
 * the engine's own work, so it reads LOW both when the browser is
 * throttling the page and when the engine is too slow to finish its
 * frame. Telling those two apart is the whole job: the first is
 * fixed in the browser's settings, the second is fixed in the game.
 *
 * So the comparison is between two readings:
 *
 *   - the rate measured while the page was IDLE (before the engine
 *     existed, so nothing could stretch it), and
 *   - the live rate now.
 *
 * AND THE ENGINE MUST NOT BE THE REASON. If the engine's frame does
 * not fit the panel's budget, then the slow tick is the engine's
 * fault and blaming the browser would send the player to the wrong
 * settings — which is the exact mistake this readout already made
 * once.
 */
export function refreshRateWasDropped(facts: PerfFacts): boolean {
  const idle = facts.idlePanelHz || 0;
  const live = facts.browserHz || 0;
  if (idle <= 0 || live <= 0) return false;
  // Ten per cent: the measurement drifts by a fraction of a percent,
  // and anything less than that is noise, not a throttle.
  if (live >= idle * 0.9) return false;
  // THE ENGINE GETS THE BENEFIT OF THE DOUBT. If the engine's frame
  // does not fit the panel's budget, the slow tick is explained.
  const budget = frameBudgetMs(facts.panelHz > 0 ? facts.panelHz : idle);
  if (facts.engineWorkMs > 0 && budget > 0 && facts.engineWorkMs > budget) return false;
  return true;
}

/**
 * HOW FAR IS THE GAME FROM THE NEXT FRAME RATE UP?
 *
 * THIS IS THE MOST ACTIONABLE NUMBER THE READOUT HAS, AND IT IS THE
 * ONE THAT WAS MISSING.
 *
 * "The game is capped to 72 fps" tells a player they are being
 * held back. It does not tell them how much of the gap is theirs to
 * close, and a player who cannot see the size of the gap cannot go
 * and close it.
 *
 * So the gap is measured, in the only unit that matters: MILLI-
 * SECONDS OF FRAME COST.
 *
 * The pacer's gate is a whole number of display ticks per engine
 * frame, so the rates it can hold are the display's own divisors —
 * 144, 72, 48, 36 Hz on a 144 Hz panel. The next step up from the
 * gate in force is the next divisor, and the engine's frame has to
 * get below a THRESHOLD for the pacer to open it.
 *
 * The threshold is the pacer's own: the sustainable rate has to
 * clear the target, which is the safety factor's 0.85 of the slot,
 * plus the hysteresis the pacer applies so a reading that straddles
 * the threshold does not open and close the gate again.
 */
export interface NextRateGap {
  /** The frame rate the game is being held at now. */
  currentFps: number;
  /** The frame rate one step up would be. */
  targetFps: number;
  /**
   * The frame cost at which the pacer would open that step, in
   * milliseconds.
   */
  targetCostMs: number;
  /**
   * How many milliseconds cheaper the frame has to be to get there.
   *
   * Zero means the game is ALREADY at that rate, and there is nothing
   * to chase.
   */
  gapMs: number;
}

/**
 * The next frame rate up, and the gap to it.
 *
 * `null` when there is no next step: the game is uncapped (the
 * display is the ceiling), the numbers needed are missing, or the
 * panel's rate is unknown.
 */
export function nextRateGap(facts: PerfFacts): NextRateGap | null {
  const panelHz = facts.panelHz || 0;
  const everyNth = Math.max(1, Math.round(facts.everyNth || 1));
  const workMs = facts.engineWorkMs || 0;
  if (panelHz <= 0 || workMs <= 0) return null;
  // No next step when the gate is already open: the display's own
  // rate is the ceiling and the game is running at it.
  if (everyNth <= 1) return null;

  const targetEveryNth = everyNth - 1;
  const targetFps = panelHz / targetEveryNth;
  const currentFps = panelHz / everyNth;

  // THE PACER'S OWN THRESHOLD, in cost. The cap's threshold is the
  // safety factor's share of the slot; the slot's own threshold is
  // the whole period; and the gate opens on the EASIER of the two.
  const capThreshold = (1000 * SAFETY_FACTOR * targetEveryNth) / panelHz;
  const slotThreshold = 1000 / panelHz;
  const threshold = Math.min(capThreshold, slotThreshold);
  // And the pacer only moves on a reading that clears it by more than
  // the measurement noise.
  const targetCostMs = threshold * (1 + NARROW_COST_HYSTERESIS);

  return {
    currentFps,
    targetFps,
    targetCostMs,
    // HOW MUCH CHEAPER THE FRAME HAS TO BE. The pacer opens the gate
    // when the cost is at or BELOW the threshold, so the gap is what
    // the engine has to shave off, not what it has to reach.
    gapMs: Math.max(0, workMs - targetCostMs),
  };
}

/**
 * THE FRAME SPACING, IN ONE SENTENCE.
 *
 * "Your frames are 13.9 ms apart, and 1 in 100 of them takes 41.7 ms"
 * is a measurement. "Your frame timing is uneven" is a verdict, and
 * the verdict is only worth making when the numbers are there.
 */
export function describeFramePacing(pacing: FrameSpacingFacts | undefined): string {
  if (!pacing || !pacing.samples || pacing.p50 <= 0) return '';
  const tail = pacing.p99 > pacing.p50 * 1.2 ? `, and the worst 1 in 100 took ${pacing.p99.toFixed(1)} ms` : '';
  return `Your frames are ${pacing.p50.toFixed(1)} ms apart${tail}.`;
}

/**
 * THE RATE THE GAME IS DRAWING FRAMES AT.
 *
 * `engineFps` is the engine's own frames, counted from the engine's
 * frame starts; `displayHz` is the game's rate as the facts carry
 * it. They are the same number in the live path -- the collector
 * fills the game's rate from the engine's frames -- and the engine's
 * own number is preferred, because it is the one that was measured
 * from the thing the sentence is about.
 */
export function gameFrameRate(facts: PerfFacts): number {
  return facts.engineFps > 0 ? facts.engineFps : facts.displayHz;
}

/**
 * WHO IS HOLDING THE GAME BACK.
 *
 * Kyle's screenshot said "Your browser was holding the game back in
 * your last game", and the browser was delivering 120 of 120 Hz. The
 * summary was hardcoded to blame the browser whenever ANY finding
 * was a warning, and the only warning in that report was a late-frame
 * count that was measuring the wrong thing.
 *
 * So the attribution is decided from the facts:
 *
 *   BROWSER-BOUND  the browser is offering materially less than the
 *                  display's rate, and the engine's cost FITS the
 *                  budget -- so the engine would be fine if the
 *                  browser let it run;
 *   ENGINE-BOUND   the engine's cost EXCEEDS the budget, or its
 *                  frames are missing their slots;
 *   NEITHER        nothing to fix.
 */
export type PerfBottleneck = 'browser' | 'engine' | 'neither';

export function attributeBottleneck(facts: PerfFacts): PerfBottleneck {
  const panelHz = facts.panelHz;
  const budgetMs = frameBudgetMs(panelHz);
  const engineKnown = facts.engineWorkMs > 0;
  const engineFits = engineKnown && budgetMs > 0 && facts.engineWorkMs <= budgetMs;
  const engineOver = engineKnown && budgetMs > 0 && facts.engineWorkMs > budgetMs;

  // THE BROWSER'S OWN TICK RATE, against the display's.
  //
  // The browser is materially short when it is offering less than
  // nine tenths of the display's rate. With no measurement of its
  // own there is nothing to compare, and nothing is claimed.
  const browserHz = facts.browserHz > 0 ? facts.browserHz : facts.displayHz;
  const browserShort =
    browserHz > 0 && panelHz > 0 && browserHz < panelHz * 0.9;

  // THE ENGINE'S FRAMES MISSING THEIR SLOTS.
  //
  // More than 5% of the engine's frames arriving late means the
  // engine is not landing its frames on time, whatever the cost
  // says. That is the engine's problem, not the browser's.
  const lateFraction = facts.measuredFrames > 0 ? facts.lateFrames / facts.measuredFrames : 0;
  const missingSlots = lateFraction > 0.05;

  // BROWSER-BOUND: the browser is offering less than the display can
  // show, and the engine would be comfortable if it were allowed to
  // run. The browser is the thing to fix.
  if (browserShort && engineFits) return 'browser';
  // The browser's refresh rate is being POWERED DOWN -- Energy Saver,
  // Low Power Mode, Firefox's software vsync. The rate itself is the
  // symptom, and it is in the browser's hands.
  if (refreshRateLooksThrottled(facts)) return 'browser';
  // ENGINE-BOUND: the engine's cost does not fit the budget, or its
  // frames are missing their slots.
  if (engineOver || missingSlots) return 'engine';
  return 'neither';
}

/**
 * THE RENDER SIZE, IN A FORM A HUMAN CAN READ.
 *
 * A 300×150 canvas is 0.045 megapixels, and one decimal place rounds
 * that to "0.0" — a number that reads like "nothing is being drawn".
 * Under a megapixel, two decimals; over it, one is enough; and a canvas
 * too small for megapixels to say anything useful is counted in pixels.
 */
export function formatMegapixels(pixels: number): string {
  if (!isFinite(pixels) || pixels <= 0) return '0 pixels';
  const mp = pixels / 1e6;
  if (mp >= 1) return `${mp.toFixed(1)} megapixels`;
  // THREE decimals below a tenth of a megapixel, because two is not
  // enough: 300×150 is 0.045 MP, and `toFixed(2)` calls that "0.04" —
  // a number that is not the number.
  if (mp >= 0.1) return `${mp.toFixed(2)} megapixels`;
  if (mp >= 0.01) return `${mp.toFixed(3)} megapixels`;
  return `${Math.round(pixels)} pixels`;
}

/**
 * HOW OLD A MEASUREMENT IS, IN WORDS.
 *
 * "your last game, 12 minutes ago" is a claim the player can check
 * against their own memory. "your last game" is not.
 *
 * AND A MEASUREMENT WITH NO TIMESTAMP HAS NO AGE. Saying "moments
 * ago" about a number whose age is unknown is a recency claim the
 * readout cannot back, so it says so instead.
 */
export function describeSessionAge(measuredAt: number, now: number): string {
  if (!isFinite(measuredAt) || measuredAt <= 0) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((now - measuredAt) / 1000));
  if (seconds < 60) return 'moments ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * THE MERGE: LIVE WINS, THE SESSION FILLS THE GAPS.
 *
 * The rule is one sentence long: *live wins for anything live can
 * measure; the session fills the gaps the live page cannot.*
 *
 *   - the game is running (`engineWorkMs > 0`), so the live facts are
 *     the real ones and the session is ignored — the in-game readout
 *     must never show a stale number;
 *   - the game is NOT running, so the live page can measure the
 *     browser's rate and the GPU but NOT the engine's frame cost, the
 *     rate the game was delivering or its render size — those come
 *     from the session.
 *
 * THE TRAP THIS FUNCTION EXISTS TO AVOID: the landing page's canvas is
 * a 300×150 PLACEHOLDER. The live `backingWidth`/`backingHeight` are
 * that placeholder, and the session's are the game's real render size.
 * The session's win, always — otherwise the readout would report the
 * game's render size as 0.045 megapixels.
 */
export function resolvePerfFacts(
  live: PerfFacts,
  session: PerfSessionSnapshot | null | undefined
): PerfFacts {
  // No session: nothing to restore.
  if (!session) return live;
  // The game is running: the live facts ARE the facts.
  if (live.engineWorkMs > 0) return live;
  // A session that never measured a frame is worthless — restoring it
  // would restore zeroes.
  if (!(session.engineWorkMs > 0)) return live;

  const panelHzIsLive = live.panelHz > 0;
  // THE RATE THE GAME'S NUMBERS BELONG TO.
  //
  // The budget is the display's frame period, so a frame cost has to
  // be compared against the rate the game was MEASURED at — not
  // against a rate measured later, on another page, on the same
  // machine.
  //
  // They are normally the same number, because it is the same
  // monitor. When they are not, the SECOND one is the wrong one: a
  // 7.20 ms frame measured on a 144 Hz panel is OVER that panel's
  // 6.94 ms budget, and comparing it against a 60 Hz budget would
  // tell the player they were using 43% of it and everything was
  // fine. The readout would be cheerful and wrong, which is the
  // worst thing a readout can be.
  const sessionPanelHz = session.panelHz > 0 ? session.panelHz : 0;
  const panelHzIsFromSession = sessionPanelHz > 0;
  return {
    ...live,
    // THE GAME'S NUMBERS: the session's, because the live page cannot
    // measure a game that is not running.
    displayHz: session.displayHz,
    engineFps: session.engineFps > 0 ? session.engineFps : session.displayHz,
    browserHz: session.browserHz,
    engineWorkMs: session.engineWorkMs,
    sustainableFps: session.sustainableFps,
    capFps: session.capFps,
    everyNth: session.everyNth,
    lateFrames: session.lateFrames,
    measuredFrames: session.measuredFrames,
    backingWidth: session.backingWidth,
    backingHeight: session.backingHeight,
    // THE DISPLAY'S RATE: the session's, because that is the rate the
    // frame cost above was measured against — so the budget is the
    // budget that applies to it.
    panelHz: panelHzIsFromSession ? sessionPanelHz : live.panelHz,
    panelHzFromSession: panelHzIsFromSession,
    // AND THE RATE MEASURED RIGHT NOW, which is worth saying when it
    // is not the same: the browser throttling the landing page is a
    // fact about the browser, and the game's numbers cannot show it.
    livePanelHz: panelHzIsLive ? live.panelHz : 0,
    // THE GPU: the live probe, because it reports the same GPU off a
    // throwaway canvas — and the session's, if the probe failed.
    renderer: live.renderer || session.renderer,
    // AND WHERE THEY CAME FROM.
    fromLastSession: true,
    measuredAt: session.measuredAt,
    // WHEN THE COST WAS MEASURED, and whether that reading was past
    // the engine's warm-up. The report says both, because a number
    // taken while the engine was still warming up is a picture of the
    // warm-up and not of the machine.
    costMeasuredAt: session.costMeasuredAt,
    costSettled: session.costSettled,
    gameStartAt: session.gameStartAt,
    // THE DISPLAY'S RATE AT LOAD, and the shape of the frame times.
    //
    // Both come from the session, because the landing page cannot
    // measure either: the idle rate is measured once, before the
    // engine exists, and the frame spacing only exists while the
    // game is running.
    idlePanelHz: session.idlePanelHz,
    pacing: session.pacing,
  };
}

/** The checklist for the browser, filtered to what the facts make relevant. */
function buildChecklist(facts: PerfFacts, browser: PerfBrowser): PerfChecklistItem[] {
  const items: PerfChecklistItem[] = [];

  // THE BROWSER IS THROTTLING, BY EITHER SIGN.
  //
  // Two different measurements say the same thing, and both are
  // fixed in the browser's settings:
  //
  //   - the rate is below what any modern display runs at, and the
  //     engine could use more (`refreshRateLooksThrottled`), or
  //   - the rate has fallen since the page loaded, while the engine
  //     was not the reason (`refreshRateWasDropped`).
  //
  // The second one is the one that catches Chrome's Energy Saver
  // dropping a 144 Hz panel to 78 Hz: 78 is above the 60 Hz floor the
  // first test uses, so the first test says nothing, and the player
  // is told their browser is delivering 78 refreshes a second as
  // though that were the display's own rate.
  const throttled = refreshRateLooksThrottled(facts) || refreshRateWasDropped(facts);

  if (isSoftwareRenderer(facts.renderer)) {
    if (browser === 'firefox') {
      items.push({
        id: 'firefox-accel',
        action: 'Turn hardware acceleration on',
        where: 'Firefox → Settings → General → scroll to the bottom → Performance → "Use hardware acceleration when available"',
        why: 'Your browser is drawing the game with the CPU, not the GPU. This is the difference between unplayable and playable.',
      });
      items.push({
        id: 'firefox-webrender',
        action: 'Force the WebRender compositor',
        where: 'about:config → layers.acceleration.force-enabled → true, and gfx.webrender.all → true',
        why: 'Firefox falls back to software compositing on some drivers. WebRender is the GPU path.',
      });
    } else if (browser === 'safari') {
      items.push({
        id: 'safari-accel',
        action: 'Check that Safari is using the GPU',
        where: 'Safari → Settings → Advanced → "Show features for web developers", then Develop → "WebGL Renders Info"',
        why: 'Your browser is drawing the game with the CPU, not the GPU.',
      });
    } else {
      items.push({
        id: 'chrome-accel',
        action: 'Turn hardware acceleration on',
        where: 'chrome://settings/system → "Use graphics acceleration when available"',
        why: 'Your browser is drawing the game with the CPU, not the GPU. This is the difference between unplayable and playable.',
      });
      items.push({
        id: 'chrome-gpu',
        action: 'Confirm the GPU is being used',
        where: 'chrome://gpu → the "WebGL" row',
        why: 'It must say "Hardware accelerated". If it says anything else, the game is being drawn in software.',
      });
    }
  }

  if (throttled) {
    if (browser === 'firefox') {
      items.push({
        id: 'firefox-frame-rate',
        action: 'Set the browser\'s refresh rate to your monitor\'s',
        where: 'about:config → layout.frame_rate → your monitor\'s rate (144, 165, 240…)',
        why: 'Firefox defaults to "auto", which falls back to software vsync at 60 Hz when hardware vsync is unavailable. On a fast panel the game then runs at a third of the rate you paid for.',
      });
      items.push({
        id: 'firefox-accel-2',
        action: 'Turn hardware acceleration on',
        where: 'about:config → layers.acceleration.force-enabled → true',
        why: 'Without it, Firefox uses software vsync, and software vsync is 60 Hz.',
      });
    } else if (browser === 'safari') {
      items.push({
        id: 'safari-low-power',
        action: 'Turn off Low Power Mode',
        where: 'System Settings → Battery → "Low Power Mode" → off',
        why: 'Low Power Mode caps a ProMotion display at 60 Hz, and Safari cannot go above 120 Hz on macOS at all.',
      });
    } else {
      items.push({
        id: 'chrome-energy-saver',
        action: 'Turn Energy Saver off',
        where: 'chrome://settings/performance → Energy Saver → off',
        why: 'Energy Saver reduces the DISPLAY refresh rate when the machine is unplugged. Your game is being handed half the refreshes it should be.',
      });
      items.push({
        id: 'chrome-keep-active',
        action: 'Keep the game\'s tab active',
        where: 'chrome://settings/performance → "Always keep these sites active" → add bulletballet.dev',
        why: 'Chrome deactivates idle tabs, and a deactivated tab gets no animation frames at all.',
      });
    }
  }

  if (browser === 'safari') {
    items.push({
      id: 'safari-refresh-cap',
      action: 'Know the ceiling',
      where: 'Safari on macOS',
      why: 'Safari does not run above 120 Hz, and not above 60 Hz with an external display. The game adapts; it is worth knowing why the number is what it is.',
    });
  }

  // ── THE ENGINE IS THE LIMIT ─────────────────────────────────────────
  //
  // THE CASE THAT HAD NO ADVICE AT ALL, AND IT IS THE COMMON ONE.
  //
  // Everything above this line is about the BROWSER. A player whose
  // engine cannot finish a frame inside their display's frame period
  // — the case this whole feature was built for, and the case every
  // fast machine is in — was told "the game could not keep up" and
  // then handed an EMPTY list of things to do.
  //
  // So the engine-bound case gets its own items, and they are the
  // ones that can actually move the number.
  //
  // AND THEY ARE ORDERED BY WHAT THEY ARE WORTH: the game's own
  // draw cost first (it is the only one that changes the frame the
  // engine has to draw), then the machine, then the compositor.
  const gap = nextRateGap(facts);
  const engineBound =
    facts.engineWorkMs > 0 &&
    (facts.capFps > 0 || (gap !== null && gap.gapMs > 0) || budgetIsExceeded(facts));
  const judder = facts.measuredFrames > 0 && facts.lateFrames / facts.measuredFrames > 0.05;

  if (engineBound) {
    items.push({
      id: 'engine-draw-cost',
      action: 'Turn down what the game draws',
      where: 'In game: ESC → Game → Draw cost',
      why:
        `A frame costs ${facts.engineWorkMs.toFixed(2)} ms and your display gives it ` +
        `${frameBudgetMs(facts.panelHz).toFixed(2)} ms. The draw-cost switches cut the work the ` +
        'engine does every frame — the weapon model, the shadows, the detail textures, the ' +
        'visibility pass and the other players\' models. None of them is claimed to help: the ' +
        'readout shows the frame cost, so you can see which one actually did. ' +
        'Turn them back if the picture is not worth it.',
    });
    items.push({
      id: 'engine-give-the-machine',
      action: 'Give the game the whole machine',
      where: 'Close every other tab, and check the taskbar for a download, a scan, or a game running behind this one',
      why:
        'The browser and the game share one CPU thread and one GPU, and anything else running takes ' +
        'from the frame the game has to draw. A measured frame cost is a property of the machine as ' +
        'well as the game.',
    });
    items.push({
      id: 'engine-overlays',
      action: 'Turn off the overlays',
      where: 'Steam → Settings → In Game → uncheck "Enable Steam Overlay"; the Discord and NVIDIA overlays; and any browser extensions',
      why:
        'Overlays hook into the compositor and draw on top of every frame the game renders. That is ' +
        'work the game never asked for, and it is spent on the GPU the game is trying to use.',
    });
    if (browser === 'chromium') {
      items.push({
        id: 'chrome-memory-saver',
        action: 'Stop the browser from putting the game to sleep',
        where: 'chrome://settings/performance → Memory Saver → off',
        why:
          'Memory Saver can evict a tab or stop giving it animation frames. A game that stutters for ' +
          'no reason is usually this.',
      });
    }
  }

  if (judder) {
    items.push({
      id: 'judder-interruptions',
      action: 'Find what is interrupting the frame',
      where: 'Task Manager → sort by CPU, and watch for a download, an antivirus scan, or a second game',
      why:
        'Uneven frames are the machine being interrupted, not the game being slow. The game is ' +
        'hitting its budget; something else is stealing the thread when the frames arrive late.',
    });
  }

  // THE FULLSCREEN QUESTION, AS A MEASUREMENT THE PLAYER CAN TAKE.
  //
  // Fullscreen asks the browser to present at the display's own rate,
  // which is the rate the engine then has to keep up with. Windowed
  // presents more gently, and on some machines that is the difference
  // between a game that keeps up and one that does not. The game
  // cannot know which is better for THIS machine, but it can measure
  // both and show the player the numbers.
  if (engineBound || judder) {
    items.push({
      id: 'compare-fullscreen',
      action: 'Compare fullscreen and windowed, with the numbers in front of you',
      where: 'In game: ESC → Game → Fullscreen, then hit Re-measure on this page and read the frame cost again',
      why:
        'Fullscreen presents at the display\'s own refresh rate, and the engine has to finish its ' +
        'frame inside that. Windowed is gentler. The readout measures the frame cost in both, so ' +
        'you can see which one your machine prefers — in milliseconds.',
    });
  }

  return items;
}

/**
 * IS THE ENGINE'S FRAME OVER THE DISPLAY'S BUDGET?
 *
 * The one helper the checklist needs that is not already a fact: the
 * engine's cost against the panel's frame period.
 */
function budgetIsExceeded(facts: PerfFacts): boolean {
  const budget = frameBudgetMs(facts.panelHz > 0 ? facts.panelHz : facts.displayHz);
  if (budget <= 0 || facts.engineWorkMs <= 0) return false;
  return facts.engineWorkMs > budget;
}

/**
 * Build the report.
 *
 * The findings are ordered most serious first, and the checklist only
 * carries the items the facts make relevant — a readout that shows
 * every warning every time is a readout nobody reads.
 *
 * THE PAST TENSE IS NOT A STYLE CHOICE
 * ------------------------------------
 * When the facts came from the last match, the game is NOT running, and
 * "the game is drawing 60 fps" is a lie: it is not drawing anything.
 * So every claim about the game moves to the past tense, and a
 * provenance finding names the source and the age. A readout that
 * shows last-match numbers as if they were measured now is exactly the
 * failure mode this whole feature was built to avoid.
 *
 * `now` is injected so the age in the provenance finding can be
 * tested. It is the only clock this function reads.
 */
export function buildPerfReport(facts: PerfFacts, now = Date.now()): PerfReport {
  const browser = detectBrowser(facts.userAgent);
  const findings: PerfFinding[] = [];

  // THE GAME IS NOT RUNNING (the facts are from the last match).
  const fromSession = facts.fromLastSession === true;

  // THE BROWSER'S OWN RATE: live unless the session had to supply it.
  const browserNow = !fromSession || !facts.panelHzFromSession;

  // The budget is against the BROWSER's rate, not the rate the game
  // is achieving: the engine has to fit inside the display's frame
  // period, and the display's frame period does not change because
  // the engine is slow.
  const rate = facts.panelHz > 0 ? facts.panelHz : facts.displayHz;
  const budgetMs = frameBudgetMs(rate);
  const backingPixels = Math.max(0, facts.backingWidth) * Math.max(0, facts.backingHeight);
  const budgetUsedPct =
    budgetMs > 0 && facts.engineWorkMs > 0 ? (facts.engineWorkMs / budgetMs) * 100 : 0;

  // --- the renderer ------------------------------------------------------
  //
  // The renderer is a property of the BROWSER, not of the game, and it
  // is probed live: the same machine, the same driver, the same GPU. So
  // it stays in the present tense even when the game is not running.
  if (isSoftwareRenderer(facts.renderer)) {
    findings.push({
      id: 'software-renderer',
      severity: 'bad',
      // A PROPERTY, NOT AN ACTIVITY. The game is not running when the
      // facts come from the last match, so "is drawing" describes
      // something that is not happening.
      title: 'Your browser draws this game in software',
      detail:
        `The renderer reports "${facts.renderer}". That means the CPU is doing the drawing ` +
        `instead of the graphics chip, and it is the single biggest thing you can change.`,
    });
  } else if (facts.renderer) {
    findings.push({
      id: 'renderer-ok',
      severity: 'ok',
      title: 'Graphics acceleration is on',
      detail: `Renderer: ${facts.renderer}`,
    });
  }

  // --- the refresh rate --------------------------------------------------
  //
  // A RESTORED REPORT NEVER SAYS THE GAME HAS NOT RUN.
  //
  // The game DID run — these are its numbers. But its DELIVERED rate
  // can still be unmeasured, because the pacer only trusts its own
  // display figure after ten intervals: a short match leaves
  // `displayHz` at 0 while the engine's frame cost is already known.
  // That is a half-measured snapshot, and it is a real one, so the
  // report has to cope with it honestly: the game ran, the rate is not
  // known, and the provenance finding says where the numbers came from.
  // Saying "the game has not run yet" next to "the game was drawing
  // 7.7 megapixels" is three contradictory claims on one screen.
  if (facts.displayHz <= 0 && !fromSession) {
    findings.push({
      id: 'refresh-unknown',
      severity: 'info',
      title: 'The game has not run yet, so its frame rate is not known',
      detail:
        "The display's rate is measured, and it is above. What is not known yet is what " +
        'the GAME can actually draw — that is measured as soon as it is running in a map.',
    });
  } else if (refreshRateLooksThrottled(facts)) {
    findings.push({
      id: 'refresh-throttled',
      severity: 'warn',
      // THE TITLE IS TENSED TOO, NOT ONLY THE DETAIL. On the first
      // render of the landing readout the report is built before the
      // idle measurement resolves, so the browser's rate can be the
      // session's — and then a present-tense title asserts a live
      // reading that is really the last match's.
      title: browserNow
        ? `Your browser is only offering ${rate.toFixed(0)} refreshes a second`
        : `Your browser was only offering ${rate.toFixed(0)} refreshes a second`,
      detail:
        (fromSession
          ? `The game could sustain ${facts.sustainableFps.toFixed(0)} fps`
          : `The game can sustain ${facts.sustainableFps.toFixed(0)} fps`) +
        (browserNow
          ? `, but the browser is only handing it ${rate.toFixed(0)} frames a second.`
          : `, but the browser was only handing it ${rate.toFixed(0)} frames a second.`) +
        ` No modern display runs at that rate, ` +
        `so something in the browser is powering it down — on a laptop, that is almost always ` +
        `Energy Saver or Low Power Mode.`,
    });
  } else {
    // THE HEADROOM CLAIM.
    //
    // "The game could sustain 53 fps, so it had room to spare" —
    // against a 120 Hz panel with an 8.33 ms budget, 53 fps is the
    // opposite of headroom. The sentence borrowed the browser's green
    // tick to attach an engine claim that was untrue.
    //
    // So the claim is made only when the engine's sustainable rate
    // really is at or above the panel's rate. Otherwise the finding
    // says what IS true -- the browser is keeping up -- and the
    // engine's story is left to the budget finding, which has the
    // numbers for it.
    const hasHeadroom = rate > 0 && facts.sustainableFps >= rate;
    findings.push({
      id: 'refresh-ok',
      severity: 'ok',
      title: browserNow
        ? `Your browser is delivering ${rate.toFixed(0)} refreshes a second`
        : `Your browser was delivering ${rate.toFixed(0)} refreshes a second`,
      detail: hasHeadroom
        ? fromSession
          ? `The game could sustain ${facts.sustainableFps.toFixed(0)} fps, so it had room to spare.`
          : `The game can sustain ${facts.sustainableFps.toFixed(0)} fps, so it has room to spare.`
        : fromSession
          ? `The browser was keeping up — it was delivering ${rate.toFixed(0)} refreshes a second.`
          : `The browser is keeping up — it is delivering ${rate.toFixed(0)} refreshes a second.`,
    });
  }

  // --- the display's rate, NOW, AGAINST THE ONE THE GAME RAN AT -------
  //
  // THE READOUT RESTORES THE LAST MATCH'S NUMBERS ON THE LANDING
  // PAGE, AND THE BROWSER IS STILL RUNNING WHILE IT DOES IT. So
  // there are two rates in play, and they can differ:
  //
  //   - the rate the game was measured at, which is the budget its
  //     frame cost is compared against; and
  //   - the rate the browser is delivering RIGHT NOW, measured on
  //     this page.
  //
  // They are normally the same number, because it is the same
  // monitor. When they are not, it is worth saying out loud — a
  // browser that has dropped to 60 Hz since the last match is
  // throttling now, and the last match's numbers cannot show it.
  if (
    fromSession &&
    (facts.livePanelHz ?? 0) > 0 &&
    rate > 0 &&
    Math.abs((facts.livePanelHz ?? 0) - rate) / rate > 0.1
  ) {
    const liveHz = facts.livePanelHz ?? 0;
    findings.push({
      id: 'refresh-now',
      severity: 'info',
      title: `Your browser is offering ${liveHz.toFixed(0)} refreshes a second right now`,
      detail:
        `Your last game ran at ${rate.toFixed(0)} Hz, and its numbers are measured against ` +
        `that. The page in front of you is being given ${liveHz.toFixed(0)} ` +
        `refreshes a second — so something in the browser has changed since you played.`,
    });
  }

  // --- the browser took refreshes away ---------------------------------
  //
  // THE THROTTLE THAT THE 60 Hz FLOOR MISSES.
  //
  // Chrome's Energy Saver does not always halve the refresh rate: on
  // Kyle's MacBook it took a 120 Hz panel to 78 Hz, and 78 is above
  // the floor the "throttled" test uses — so the readout called a
  // throttled client healthy, and told the player their browser was
  // "delivering 78 refreshes a second" as though that were the
  // display's own rate.
  //
  // The fix is a measurement on BOTH sides of the change: the rate
  // the page was given when it loaded, and the rate it is being given
  // now. Nothing else in the client can tell these apart.
  if (refreshRateWasDropped(facts)) {
    const idle = facts.idlePanelHz || 0;
    const live = facts.browserHz || 0;
    findings.push({
      id: 'refresh-dropped',
      severity: 'warn',
      title:
        fromSession
          ? `Your browser dropped your display from ${idle.toFixed(0)} Hz to ${live.toFixed(0)} Hz`
          : `Your browser has dropped your display from ${idle.toFixed(0)} Hz to ${live.toFixed(0)} Hz`,
      detail:
        `The page was given ${idle.toFixed(0)} refreshes a second when it loaded, and it is being ` +
        `given ${live.toFixed(0)} now. Your engine is not the reason — it finishes its frame inside ` +
        `the display's budget. Something in the browser took the refreshes away, and on a laptop that ` +
        `is almost always Energy Saver or Low Power Mode.`,
    });
  }

  // --- the engine's budget ----------------------------------------------
  if (facts.engineWorkMs > 0 && budgetMs > 0) {
    if (budgetUsedPct > 85) {
      const capped = facts.capFps > 0 && facts.everyNth > 1;
      findings.push({
        id: 'budget-tight',
        severity: capped ? 'info' : 'warn',
        title:
          budgetUsedPct > 100
            ? fromSession
              ? `A frame took longer than your display's frame period`
              : `A frame takes longer than your display's frame period`
            : fromSession
              ? `The game used ${budgetUsedPct.toFixed(0)}% of your frame budget`
              : `The game uses ${budgetUsedPct.toFixed(0)}% of your frame budget`,
        detail:
          (fromSession
            ? `A frame took ${facts.engineWorkMs.toFixed(2)} ms and your display gave you ` +
              `${budgetMs.toFixed(2)} ms.`
            : `A frame takes ${facts.engineWorkMs.toFixed(2)} ms and your display gives you ` +
              `${budgetMs.toFixed(2)} ms.`) +
          (capped
            ? fromSession
              ? ` It could not finish in time, so the game was capped to ` +
                `${facts.capFps.toFixed(0)} fps — a lower frame rate that arrived evenly beats a ` +
                `higher one that judders.`
              : ` It cannot finish in time, so the game is capped to ` +
                `${facts.capFps.toFixed(0)} fps — a lower frame rate that arrives evenly beats a ` +
                `higher one that judders.`
            : fromSession
              ? ` That was not enough headroom for a frame that ran long, and the frames that ` +
                `did run long arrived unevenly.`
              : ` That is not enough headroom for a frame that runs long, and the frames that do ` +
                `run long arrive unevenly.`),
      });
    } else {
      findings.push({
        id: 'budget-ok',
        severity: 'ok',
        title: fromSession
          ? `The game used ${budgetUsedPct.toFixed(0)}% of your frame budget`
          : `The game uses ${budgetUsedPct.toFixed(0)}% of your frame budget`,
        detail: fromSession
          ? `A frame took ${facts.engineWorkMs.toFixed(2)} ms and your display gave you ` +
            `${budgetMs.toFixed(2)} ms. That was comfortable.`
          : `A frame takes ${facts.engineWorkMs.toFixed(2)} ms and your display gives you ` +
            `${budgetMs.toFixed(2)} ms. That is comfortable.`,
      });
    }
  }

  // --- the cap in force --------------------------------------------------
  if (facts.capFps > 0 && facts.everyNth > 1) {
    // THE PANEL'S RATE. NEVER THE GAME'S.
    //
    // The sentence calls it the display's rate, so it has to BE the
    // display's rate. It used to print the game's delivered rate
    // here, which is how a 120 Hz panel was reported as "Your display
    // ran at 60 Hz".
    const panelRate = facts.panelHz > 0 ? facts.panelHz : rate;
    findings.push({
      id: 'capped',
      severity: 'info',
      title: fromSession
        ? `The game was capped to ${facts.capFps.toFixed(0)} fps`
        : `The game is capped to ${facts.capFps.toFixed(0)} fps`,
      detail: fromSession
        ? `Your display ran at ${panelRate.toFixed(0)} Hz, and the game could not finish a ` +
          `frame inside that. It was drawing one frame in ${facts.everyNth} so that the frames it ` +
          `did draw landed evenly — a lower frame rate that felt smooth beats a higher one that judders.`
        : `Your display runs at ${panelRate.toFixed(0)} Hz, and the game cannot finish a ` +
          `frame inside that. It is drawing one frame in ${facts.everyNth} so that the frames it ` +
          `does draw land evenly — a lower frame rate that feels smooth beats a higher one that judders.`,
    });
  } else if (facts.capFps > 0 && facts.everyNth === 1) {
    findings.push({
      id: 'uncapped',
      severity: 'ok',
      title: fromSession
        ? `The game was running at your display's full rate (${facts.capFps.toFixed(0)} fps)`
        : `The game is running at your display's full rate (${facts.capFps.toFixed(0)} fps)`,
      detail: fromSession
        ? 'No cap was needed — the game kept up with your display.'
        : 'No cap is needed — the game keeps up with your display.',
    });
  }

  // --- THE NEXT RATE UP -------------------------------------------------
  //
  // THE NUMBER THAT MAKES THE CAP ACTIONABLE.
  //
  // "The game is capped to 72 fps" says the player is being held
  // back. It does not say how much of the gap is theirs to close — and
  // a player who cannot see the size of the gap cannot go and close
  // it.
  //
  // So the gap is stated in the only unit that can be acted on: the
  // milliseconds of frame cost that have to go.
  const gap = nextRateGap(facts);
  if (gap && gap.gapMs > 0) {
    findings.push({
      id: 'next-rate',
      severity: 'info',
      title:
        fromSession
          ? `${gap.gapMs.toFixed(2)} ms cheaper a frame and the game would have run at ${gap.targetFps.toFixed(0)} fps`
          : `${gap.gapMs.toFixed(2)} ms cheaper a frame and the game would run at ${gap.targetFps.toFixed(0)} fps`,
      detail:
        `A frame costs ${facts.engineWorkMs.toFixed(2)} ms, and the game is being held at ` +
        `${gap.currentFps.toFixed(0)} fps. The next step up is ${gap.targetFps.toFixed(0)} fps, and ` +
        `the pacer opens it at ${gap.targetCostMs.toFixed(2)} ms of frame cost — so there is ` +
        `${gap.gapMs.toFixed(2)} ms to find. The draw-cost switches below are where to look for it.`,
    });
  }

  // --- what the game is actually drawing ---------------------------------
  const gameRate = gameFrameRate(facts);
  if (gameRate > 0 && rate > 0 && gameRate < rate * 0.9) {
    // WHO OWNS THE LOW FRAME RATE.
    //
    // With the cap in force, the low frame rate is the CAP'S DOING:
    // the game was paced to land evenly on the display, which is the
    // whole point of the cap. Calling that "the engine's own limit"
    // is the opposite of the truth. Only with no cap in force is the
    // engine the limit.
    const capped = facts.capFps > 0 && facts.everyNth > 1;
    findings.push({
      id: 'delivering',
      severity: 'info',
      title: fromSession
        ? `The game was drawing ${gameRate.toFixed(0)} fps on a ${rate.toFixed(0)} Hz display`
        : `The game is drawing ${gameRate.toFixed(0)} fps on a ${rate.toFixed(0)} Hz display`,
      detail: capped
        ? fromSession
          ? `That was the cap's doing, not the engine's: the game was paced to land evenly ` +
            `on your ${rate.toFixed(0)} Hz display.`
          : `That is the cap's doing, not the engine's: the game is paced to land evenly ` +
            `on your ${rate.toFixed(0)} Hz display.`
        : fromSession
          ? "That was the engine's own limit, not the display's — the game was asking for " +
            'more frames than it could finish.'
          : "That is the engine's own limit, not the display's — the game is asking for " +
            'more frames than it can finish.',
    });
  }

  // --- the pacing --------------------------------------------------------
  if (facts.measuredFrames > 0 && facts.lateFrames > 0) {
    const pct = (facts.lateFrames / facts.measuredFrames) * 100;
    if (pct > 5) {
      findings.push({
        id: 'late-frames',
        severity: 'warn',
        title: `${pct.toFixed(0)}% of frames arrived late`,
        detail: fromSession
          ? "Late frames were the judder: the game was missing its slots and arriving unevenly. " +
            'The cap above existed to prevent this.'
          : 'Late frames are the judder: the game is missing its slots and arriving unevenly. ' +
            'The cap above exists to prevent this.',
      });
    }
  }

  // --- THE SPREAD OF THE FRAME TIMES -----------------------------------
  //
  // THE ENGINE'S COUNTER CANNOT SEE THIS, AND THE PLAYER CAN.
  //
  // The engine's FPS number says how many frames it drew. The eye
  // reads the GAPS between them. A game drawing 60 frames a second
  // with a clean 16.7 ms between each of them feels like 60 fps; the
  // same 60 frames with a 41.7 ms gap every second feels like the
  // 40s-50s Kyle described, and the counter never moves.
  //
  // So the spread is reported, and it is reported from the frame
  // STARTS — the gaps the player actually sees.
  const pacing = facts.pacing;
  if (pacing && pacing.samples >= 10 && pacing.p50 > 0) {
    const uneven = pacing.p99 > pacing.p50 * 1.2;
    findings.push({
      id: 'frame-spacing',
      severity: uneven ? 'warn' : 'ok',
      title: uneven
        ? fromSession
          ? `Your frames were ${pacing.p50.toFixed(1)} ms apart, and the worst took ${pacing.p99.toFixed(1)} ms`
          : `Your frames are ${pacing.p50.toFixed(1)} ms apart, and the worst takes ${pacing.p99.toFixed(1)} ms`
        : fromSession
          ? `Your frames were evenly spaced at ${pacing.p50.toFixed(1)} ms`
          : `Your frames are evenly spaced at ${pacing.p50.toFixed(1)} ms`,
      detail: uneven
        ? `Most frames landed on time, but the gaps are not even: the 99th percentile is ` +
          `${pacing.p99.toFixed(1)} ms against a median of ${pacing.p50.toFixed(1)} ms. That spread is ` +
          `what judder is — it is the number of frames that moved, not the number of frames drawn.`
        : `Every frame landed on the display's grid, with a median gap of ${pacing.p50.toFixed(1)} ms ` +
          `and a worst case of ${pacing.max.toFixed(1)} ms. This is what a capped game is supposed to ` +
          `look like.`,
    });
  }

  // --- the render size ---------------------------------------------------
  //
  // ONLY WHEN THE GAME IS RUNNING.
  //
  // On the landing page the canvas is a 300×150 placeholder: there is no
  // game, and no render size, and reporting it as "the game is drawing
  // 0.0 megapixels" is both wrong and alarming. The engine's frame cost
  // is the signal that the game is running — it only exists once the
  // engine has measured a frame.
  const inGame = facts.engineWorkMs > 0;
  if (inGame && backingPixels > 0) {
    // THE ADVICE IS ABOUT WHAT ACTUALLY MOVES THE NUMBER.
    //
    // The research measured the engine's cost FLAT across an 8.4x
    // resolution sweep: the engine is CPU-bound, not fill-bound, and
    // 640x360 changed nothing on a machine with a GPU. So telling a
    // hardware-accelerated player to lower the resolution buys blur,
    // not frames.
    //
    // The render size is still a real fact and it is still reported.
    // Only the advice changed.
    const renderAdvice = isSoftwareRenderer(facts.renderer)
      ? ' On a software renderer every pixel is drawn by the CPU, so the size does matter here.'
      : " On a hardware-accelerated client the engine's per-frame cost is set by its own " +
        'work, not by the pixel count: the measured cost was flat across an 8.4x resolution ' +
        'sweep, so lowering the resolution buys blur, not frames.';
    findings.push({
      id: 'render-size',
      severity: 'info',
      title: fromSession
        ? `The game was drawing ${formatMegapixels(backingPixels)}`
        : `The game is drawing ${formatMegapixels(backingPixels)}`,
      detail:
        `${facts.backingWidth}×${facts.backingHeight} device pixels` +
        (facts.dpr > 1 ? ` (a ${facts.dpr}× display)` : '') +
        '.' +
        renderAdvice,
    });
  }

  // --- WHEN THE NUMBERS WERE MEASURED ----------------------------------
  //
  // "Your client was set up properly" is a claim about a MACHINE, and
  // a reading taken in the first seconds of a match is a claim about
  // the engine's WARM-UP: it is compiling shaders and streaming the
  // map, and it is the most expensive it will ever be. The report
  // says when the numbers were taken, and says so plainly when they
  // were taken before the engine had settled.
  if (facts.engineWorkMs > 0 && facts.costMeasuredAt && facts.costMeasuredAt > 0 && facts.gameStartAt && facts.gameStartAt > 0) {
    const ageSeconds = Math.max(
      0,
      Math.round((facts.costMeasuredAt - facts.gameStartAt) / 1000),
    );
    const settled = facts.costSettled === true;
    findings.push({
      id: 'cost-age',
      severity: 'info',
      title: settled
        ? fromSession
          ? `The numbers were measured ${ageSeconds} seconds into your last game`
          : `The numbers were measured ${ageSeconds} seconds into your game`
        : fromSession
          ? 'The numbers were measured in the first seconds after your last game started, ' +
            'before the engine had warmed up'
          : 'The numbers were measured in the first seconds after the game started, ' +
            'before the engine had warmed up',
      detail: settled
        ? `The engine's frame cost was measured ${ageSeconds} seconds after its first frame, ` +
          'so it describes the engine at steady state and not its warm-up.'
        : "The engine's frame cost was measured while it was still compiling shaders and " +
          'streaming the map, so it describes the warm-up rather than the machine.',
    });
  }

  // --- WHERE THE NUMBERS CAME FROM ---------------------------------------
  //
  // The provenance is not optional polish, it is the feature. A player
  // who quits back to the web UI must be able to tell that the numbers
  // on screen are the last match's and not a live reading.
  if (fromSession) {
    findings.push({
      id: 'last-session',
      severity: 'info',
      title: `These numbers are from your last game, ${describeSessionAge(facts.measuredAt ?? 0, now)}`,
      detail:
        'The game is not running now, so these are the numbers it measured then, on this ' +
        'machine, in this browser. Play again and they are measured afresh.',
    });
  }

  const order: Record<PerfSeverity, number> = { bad: 0, warn: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  // THE SUMMARY LOOKS AT THE PROBLEMS, NOT AT THE FIRST FINDING.
  //
  // The findings are sorted most-serious-first, and a NEUTRAL finding
  // ("the game is drawing 7.7 megapixels") sorts above an "ok" one.
  // Keying the summary off the first finding therefore reported "not
  // been measured yet" for a perfectly healthy client.
  //
  // AND IT IS THE ATTRIBUTION, NOT THE SEVERITY, THAT DECIDES WHAT
  // THE SUMMARY SAYS.
  //
  // The old summary blamed the BROWSER whenever any finding was a
  // warning. Kyle's screenshot said "Your browser was holding the
  // game back in your last game" while the browser was delivering
  // 120 of 120 Hz and the engine was using 191% of the frame
  // budget. The browser held nothing back; the engine could not keep
  // up. So the summary now says who the bottleneck is, from the
  // facts.
  const hasBad = findings.some((f) => f.severity === 'bad');
  const measured = rate > 0 || facts.engineWorkMs > 0;
  const bottleneck = attributeBottleneck(facts);
  const browserRate = facts.browserHz > 0 ? facts.browserHz : facts.displayHz;
  const summary = hasBad
    ? fromSession
      ? 'Your browser was not set up for this game. The fixes are below.'
      : 'Your browser is not set up for this game yet.'
    : bottleneck === 'browser'
      ? fromSession
        ? `Your browser was only offering ${browserRate.toFixed(0)} refreshes a second in ` +
          'your last game. The fixes are below.'
        : `Your browser is only offering ${browserRate.toFixed(0)} refreshes a second. ` +
          'The fixes are below.'
      : bottleneck === 'engine'
        ? fromSession
          ? `The game could not keep up with your ${rate.toFixed(0)} Hz display in your last game.`
          : `The game could not keep up with your ${rate.toFixed(0)} Hz display.`
      : measured
        ? fromSession
          ? 'Your client was set up properly in your last game. Nothing to do.'
          : 'Your client was set up properly. Nothing to do.'
        : fromSession
          ? 'Your last game has not been measured yet.'
          : 'Your client has not been measured yet.';

  return {
    browser,
    source: fromSession ? 'last-session' : 'live',
    measuredAt: facts.measuredAt ?? 0,
    costMeasuredAt: facts.costMeasuredAt ?? 0,
    findings,
    checklist: buildChecklist(facts, browser),
    summary,
    numbers: {
      displayHz: gameRate,
      engineFps: facts.engineFps,
      browserHz: facts.browserHz,
      panelHz: rate,
      engineWorkMs: facts.engineWorkMs,
      budgetMs,
      budgetUsedPct,
      backingPixels,
      pacing: facts.pacing && facts.pacing.samples > 0 ? facts.pacing : null,
      nextRate: gap,
      idlePanelHz: facts.idlePanelHz || 0,
    },
  };
}
