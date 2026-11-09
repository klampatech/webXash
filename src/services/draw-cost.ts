/**
 * THE DRAW-COST SWITCHES.
 *
 * WHAT THEY ARE
 * -------------
 * The engine's own cvars for what it draws every frame. They are the
 * only levers the player has on the cost of a frame, and the readout
 * (ESC → Performance) measures the result — so a player can turn one
 * off, press Re-measure, and read the new frame cost in
 * milliseconds.
 *
 * WHY THEY ARE NOT A DEFAULT
 * --------------------------
 * Because the project's own measurement said the effect was smaller
 * than the noise. A cvar sweep over `hud_scale`, `r_drawviewmodel`,
 * `r_lockpvs`, `r_novis` and `cl_weather` drifted by 53% over the
 * run, and in every cycle the build that ran SECOND won — a position
 * effect, not a build effect. The honest conclusion was "no lever is
 * recommended".
 *
 * So nothing here is CLAIMED to help. What is offered is the
 * instrument: a readout with the frame cost in it, and the controls
 * that number responds to. That is a different thing from a promise,
 * and it is the thing that was missing.
 *
 * THE CVARS ARE THE ENGINE'S, NOT OURS
 * -------------------------------------
 * Every one of them was read out of the SHIPPED renderer's own
 * WebAssembly module — `libref_webgl2.wasm` — rather than assumed
 * from a GoldSrc manual, because a cvar that does not exist reads
 * back as "not found" and does nothing at all. `cl_weather`, which
 * the sweep had tried, is NOT in this build, so it is not here
 * either.
 *
 * AND ONE OF THEM IS NOT OFFERED AT ALL
 * -------------------------------------
 * `r_novis` stops the engine checking what is visible, which makes
 * the player see through walls. That is not a performance option; it
 * is cheating, and it is not in this list.
 */

/** One switch the player can flip. */
export interface DrawCostSwitch {
  /** The engine cvar this switch writes. */
  cvar: string;
  /** The name the player sees. */
  label: string;
  /** One line: what the cheaper setting does. */
  effect: string;
  /**
   * The value that costs LESS.
   *
   * It is not always "0": `r_lockpvs` is cheaper when it is ON, so
   * its cheap value is "1".
   */
  cheapValue: string;
  /**
   * The value that costs MORE.
   *
   * The engine's own default is used instead of this whenever the
   * engine will name it, so a switch that is turned back on restores
   * the engine's own setting rather than a guess.
   */
  fullValue: string;
}

/**
 * THE SWITCHES, IN THE ORDER THEY ARE SHOWN.
 *
 * The order is by how much they change the picture, most first: the
 * weapon model is the biggest visual change, and the detailed player
 * models are the smallest.
 */
export const DRAW_COST_SWITCHES: readonly DrawCostSwitch[] = [
  {
    cvar: 'r_drawviewmodel',
    label: 'Weapon model',
    effect: 'the gun in your hands is not drawn',
    cheapValue: '0',
    fullValue: '1',
  },
  {
    cvar: 'r_lockpvs',
    label: 'Lock visibility',
    effect:
      'the engine stops re-checking what is in view every frame — turn it back if the map looks wrong',
    cheapValue: '1',
    fullValue: '0',
  },
  {
    cvar: 'r_shadows',
    label: 'Shadows',
    effect: 'no dynamic shadows',
    cheapValue: '0',
    fullValue: '1',
  },
  {
    cvar: 'r_detailtextures',
    label: 'Detail textures',
    effect: 'no detail textures on the walls',
    cheapValue: '0',
    fullValue: '1',
  },
  {
    cvar: 'cl_himodels',
    label: 'Detailed players',
    effect: 'other players are drawn with the simple model',
    cheapValue: '0',
    fullValue: '1',
  },
];

/**
 * IS THIS CVAR IN ITS CHEAP STATE?
 *
 * A cvar that could not be read is not in its cheap state: the
 * switch shows the FULL setting, which is the safe thing to show for
 * a setting that is not known.
 */
export function isCheap(sw: DrawCostSwitch, value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return value.trim() === sw.cheapValue;
}

/**
 * THE VALUE THAT PUTS THE SWITCH INTO A STATE.
 *
 * The engine's own default is preferred for the expensive state,
 * because the default is the engine's setting and not a guess — and
 * the engine's default is what the switch restores when the player
 * turns it back.
 */
export function valueFor(
  sw: DrawCostSwitch,
  cheap: boolean,
  engineDefault: string | null | undefined,
): string {
  if (cheap) return sw.cheapValue;
  const def = (engineDefault || '').trim();
  return def !== '' ? def : sw.fullValue;
}
