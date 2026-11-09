/**
 * THE OPTIONS SLIDERS: the numbers the player can change, and what
 * each one MEANS.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The rules in here are the ones that are easy to get wrong and hard
 * to see: what a slider shows when the engine's value is nonsense,
 * what gets written back, and where the ends of the range are. They
 * are pure, so the parent's unit suite runs them directly with
 * `node --experimental-strip-types` — no browser, no engine, no
 * game session.
 *
 * THE ZERO PROBLEM
 * ----------------
 * The engine's `fov` cvar can hold 0 while its DEFAULT is 90: the
 * client library creates the cvar, and the value is only written once
 * a view exists. So a slider that shows the raw value would show the
 * player "0" for their field of view, which is not a field of view,
 * and which is also OUTSIDE the range the slider can represent.
 *
 * So a value outside the range is not shown. The cvar's own default is
 * shown instead, and the row says it is the default, so the number on
 * screen is the number the game will actually use. A number that does
 * not mean what it says is worse than no number at all.
 *
 * `volume` is different, and the rule knows it: 0 is inside its range,
 * so 0 is shown as 0. Muting the game is a thing the player does.
 */

/** One of the numbers the options can change. */
export interface OptionSlider {
  /** The row's key, and the name of the value the UI holds. */
  key: 'sensitivity' | 'fov' | 'volume';
  /** The label on the row. */
  label: string;
  /** The engine cvar the value lives in. */
  cvar: string;
  /** The lowest value the slider can represent. */
  min: number;
  /** The highest value the slider can represent. */
  max: number;
  /** The step the slider moves in. */
  step: number;
  /**
   * The value to use when the cvar holds nothing usable AND the
   * cvar's own default is outside the range as well. This is the
   * engine's stock value for the setting.
   */
  fallback: number;
  /** How many decimals the value is shown with. */
  decimals: number;
}

/**
 * THE THREE SLIDERS.
 *
 * The ranges are the game's own: `sensitivity` is the mouse's
 * multiplier, `fov` is the field of view in degrees, and `volume` is
 * the engine's 0..1 master volume.
 */
export const OPTION_SLIDERS: readonly OptionSlider[] = [
  {
    key: 'sensitivity',
    label: 'Sensitivity',
    cvar: 'sensitivity',
    min: 0.1,
    max: 20,
    step: 0.1,
    fallback: 2,
    decimals: 1,
  },
  {
    key: 'fov',
    label: 'Field of view',
    cvar: 'fov',
    min: 30,
    max: 160,
    step: 1,
    fallback: 90,
    decimals: 0,
  },
  {
    key: 'volume',
    label: 'Volume',
    cvar: 'volume',
    min: 0,
    max: 1,
    step: 0.05,
    fallback: 1,
    decimals: 2,
  },
];

/** The slider for a key, or undefined. */
export function optionSlider(key: OptionSlider['key']): OptionSlider | undefined {
  return OPTION_SLIDERS.find((s) => s.key === key);
}

/** What a slider shows, and whether it is showing the default. */
export interface SliderReading {
  /** The value to show, and the value Apply writes. */
  value: number;
  /**
   * True when the cvar held nothing usable and the DEFAULT is being
   * shown. The row says so, so the player knows the number is the
   * game's and not a setting they chose.
   */
  isDefault: boolean;
}

/**
 * Work out what a slider shows.
 *
 * `raw` is the cvar's current value and `cvarDefault` is the cvar's
 * own default — both as strings, because that is how the engine
 * prints them. Either can be null: a cvar that does not exist, or an
 * engine that did not answer.
 */
export function readSlider(
  spec: OptionSlider,
  raw: string | null,
  cvarDefault: string | null,
): SliderReading {
  const parsed = parseNumber(raw);
  if (parsed !== null && parsed >= spec.min && parsed <= spec.max) {
    return { value: parsed, isDefault: false };
  }

  // The cvar's own default, when the engine named one and it is
  // inside the range. This is the case that matters: `fov` holds 0
  // and defaults to 90.
  const fallback = parseNumber(cvarDefault);
  if (fallback !== null && fallback >= spec.min && fallback <= spec.max) {
    return { value: fallback, isDefault: true };
  }

  // Nothing usable anywhere: the engine's stock value for the
  // setting.
  return { value: spec.fallback, isDefault: true };
}

/**
 * Parse a number the engine printed.
 *
 * The engine prints floats, so `2.000000` is a number and `foo` is
 * not. An empty string is not a number either.
 */
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Snap a value to the slider's step, and into its range.
 *
 * A number field lets the player type anything, so the value has to
 * be brought back onto the slider's own scale before it is shown or
 * written.
 */
export function clampToSlider(spec: OptionSlider, value: number): number {
  if (!Number.isFinite(value)) return spec.fallback;
  const stepped = Math.round(value / spec.step) * spec.step;
  // The float error of `round(x / 0.1) * 0.1` is visible in a field
  // that shows one decimal, so the value is rounded to the step's own
  // precision before it is clamped.
  const decimals = stepDecimals(spec.step);
  const clean = Number(stepped.toFixed(decimals));
  if (clean < spec.min) return spec.min;
  if (clean > spec.max) return spec.max;
  return clean;
}

/** How many decimals a step needs. */
export function stepDecimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Where the slider's thumb sits, as a percentage of its track.
 *
 * The number is clamped, because a value outside the range has no
 * position on the track and a thumb hanging off the end of it looks
 * like a broken control.
 */
export function sliderPercent(spec: OptionSlider, value: number): number {
  const span = spec.max - spec.min;
  if (span <= 0) return 0;
  const pct = ((value - spec.min) / span) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/**
 * The value as the player sees it.
 *
 * The decimals come from the slider's own step, so a step of 0.05
 * shows two decimals and a step of 1 shows none.
 */
export function formatSlider(spec: OptionSlider, value: number): string {
  return value.toFixed(spec.decimals);
}
