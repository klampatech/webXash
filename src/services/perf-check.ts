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
   * This is NOT the display's rate when the engine cannot keep up:
   * the browser then misses vsyncs and this drops. It is the honest
   * answer to "how many frames a second is the game drawing".
   */
  displayHz: number;
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
  /** How many display ticks arrived late in the measurement window. */
  lateTicks: number;
  /** How many display ticks the measurement window saw. */
  measuredTicks: number;
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
  /** How many display ticks arrived late. */
  lateTicks: number;
  /** How many display ticks the measurement window saw. */
  measuredTicks: number;
  /** The game's real render width, in device pixels. */
  backingWidth: number;
  /** The game's real render height, in device pixels. */
  backingHeight: number;
  /** The GPU the client was running on. */
  renderer: string;
  /** When it was measured, in epoch milliseconds. */
  measuredAt: number;
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
    /** The rate the browser delivers. */
    panelHz: number;
    engineWorkMs: number;
    budgetMs: number;
    /** How much of the frame budget the engine uses, as a percentage. */
    budgetUsedPct: number;
    backingPixels: number;
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
  return {
    ...live,
    // THE GAME'S NUMBERS: the session's, because the live page cannot
    // measure a game that is not running.
    displayHz: session.displayHz,
    engineWorkMs: session.engineWorkMs,
    sustainableFps: session.sustainableFps,
    capFps: session.capFps,
    everyNth: session.everyNth,
    lateTicks: session.lateTicks,
    measuredTicks: session.measuredTicks,
    backingWidth: session.backingWidth,
    backingHeight: session.backingHeight,
    // THE DISPLAY'S RATE: the live one, because the budget question is
    // "can this machine hit the display's budget", and the engine's
    // frame cost does not change with the display rate.
    panelHz: panelHzIsLive ? live.panelHz : session.panelHz,
    panelHzFromSession: !panelHzIsLive,
    // THE GPU: the live probe, because it reports the same GPU off a
    // throwaway canvas — and the session's, if the probe failed.
    renderer: live.renderer || session.renderer,
    // AND WHERE THEY CAME FROM.
    fromLastSession: true,
    measuredAt: session.measuredAt,
  };
}

/** The checklist for the browser, filtered to what the facts make relevant. */
function buildChecklist(facts: PerfFacts, browser: PerfBrowser): PerfChecklistItem[] {
  const items: PerfChecklistItem[] = [];

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

  if (refreshRateLooksThrottled(facts)) {
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

  return items;
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
    findings.push({
      id: 'refresh-ok',
      severity: 'ok',
      title: browserNow
        ? `Your browser is delivering ${rate.toFixed(0)} refreshes a second`
        : `Your browser was delivering ${rate.toFixed(0)} refreshes a second`,
      detail:
        facts.sustainableFps > 0
          ? fromSession
            ? `The game could sustain ${facts.sustainableFps.toFixed(0)} fps, so it had room to spare.`
            : `The game can sustain ${facts.sustainableFps.toFixed(0)} fps, so it has room to spare.`
          : fromSession
            ? 'The game ran, but how fast it was drawing was not measured.'
            : 'The game has room to spare.',
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
    findings.push({
      id: 'capped',
      severity: 'info',
      title: fromSession
        ? `The game was capped to ${facts.capFps.toFixed(0)} fps`
        : `The game is capped to ${facts.capFps.toFixed(0)} fps`,
      detail: fromSession
        ? `Your display ran at ${facts.displayHz.toFixed(0)} Hz, and the game could not finish a ` +
          `frame inside that. It was drawing one frame in ${facts.everyNth} so that the frames it ` +
          `did draw landed evenly — a lower frame rate that felt smooth beats a higher one that judders.`
        : `Your display runs at ${facts.displayHz.toFixed(0)} Hz, and the game cannot finish a ` +
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

  // --- what the game is actually drawing ---------------------------------
  if (facts.displayHz > 0 && rate > 0 && facts.displayHz < rate * 0.9) {
    findings.push({
      id: 'delivering',
      severity: 'info',
      title: fromSession
        ? `The game was drawing ${facts.displayHz.toFixed(0)} fps on a ${rate.toFixed(0)} Hz display`
        : `The game is drawing ${facts.displayHz.toFixed(0)} fps on a ${rate.toFixed(0)} Hz display`,
      detail: fromSession
        ? "That was the engine's own limit, not the display's — the game was asking for " +
          'more frames than it could finish.'
        : "That is the engine's own limit, not the display's — the game is asking for " +
          'more frames than it can finish.',
    });
  }

  // --- the pacing --------------------------------------------------------
  if (facts.measuredTicks > 0 && facts.lateTicks > 0) {
    const pct = (facts.lateTicks / facts.measuredTicks) * 100;
    if (pct > 5) {
      findings.push({
        id: 'late-frames',
        severity: 'warn',
        title: `${pct.toFixed(0)}% of frames arrived late`,
        detail: fromSession
          ? 'Late frames were the judder: the game was missing the display\'s deadline and the ' +
            'browser was catching up. The cap above existed to prevent this.'
          : 'Late frames are the judder: the game is missing the display\'s deadline and the ' +
            'browser is catching up. The cap above exists to prevent this.',
      });
    }
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
    findings.push({
      id: 'render-size',
      severity: 'info',
      title: fromSession
        ? `The game was drawing ${formatMegapixels(backingPixels)}`
        : `The game is drawing ${formatMegapixels(backingPixels)}`,
      detail:
        `${facts.backingWidth}×${facts.backingHeight} device pixels` +
        (facts.dpr > 1 ? ` (a ${facts.dpr}× display)` : '') +
        '. Lowering the render resolution in the options makes the game lighter on the GPU.',
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
  const hasBad = findings.some((f) => f.severity === 'bad');
  const hasWarn = findings.some((f) => f.severity === 'warn');
  const measured = rate > 0 || facts.engineWorkMs > 0;
  const summary = hasBad
    ? fromSession
      ? 'Your browser was not set up for this game. The fixes are below.'
      : 'Your browser is not set up for this game yet.'
    : hasWarn
      ? fromSession
        ? 'Your browser was holding the game back in your last game. The fixes are below.'
        : 'Your browser is holding the game back. The fixes are below.'
      : measured
        ? fromSession
          ? 'Your client was set up properly in your last game. Nothing to do.'
          : 'Your browser is set up properly. Nothing to do.'
        : fromSession
          ? 'Your last game has not been measured yet.'
          : 'Your client has not been measured yet.';

  return {
    browser,
    source: fromSession ? 'last-session' : 'live',
    measuredAt: facts.measuredAt ?? 0,
    findings,
    checklist: buildChecklist(facts, browser),
    summary,
    numbers: {
      displayHz: facts.displayHz,
      panelHz: rate,
      engineWorkMs: facts.engineWorkMs,
      budgetMs,
      budgetUsedPct,
      backingPixels,
    },
  };
}
