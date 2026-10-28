// Player identity: the name you play under, and the character you play as.
//
// WHY THIS FILE EXISTS
// --------------------
// Three things the player should be able to change, in two places:
//
//   1. the name, in the ESC options overlay (mid-match),
//   2. the name, BEFORE joining a server (the landing page),
//   3. the character model, in both of those places.
//
// They were separate problems with separate code, and the model one did
// not work at all. This module is the single place that knows how to
// read the current identity, how to change it, and how to remember it.
//
// WHAT THE ENGINE ACTUALLY EXPOSES (measured 2026-10-27)
// ---------------------------------------------------------
// The engine has two USERINFO cvars — `name` and `model` — and the
// `setinfo` command:
//
//   cvarlist model -> model   "gordon"  player model ('player' is a singleplayer model)
//   cvarlist name  -> name    "Specialist"  player name
//
// `setinfo name "PROBENAME"` changed the client's `name` cvar to
// PROBENAME, and the SERVER then knew the player by that name (the
// server log recorded "PROBENAME timed out" / "PROBENAME disconnected"
// — a name only the client could have sent).
//
// `setinfo model hitman` likewise changed the client's `model` cvar.
//
// So the MECHANISM works from the browser. What the options overlay got
// wrong was that it never FOCUSED its input, so the keystrokes never
// went into the field at all (see XashOptionsOverlay.vue).
//
// THE CAVEAT — READ THIS BEFORE PROMISING A MODEL CHOICE
// --------------------------------------------------------
// `model` is a USERINFO cvar, so the server sees it on the next
// userinfo update. Whether the server KEEPS it is the server's
// decision, and TS 3.0's ruleset resets it:
//
//   crates/server/src/rules/lifecycle.rs :: multiplay_userinfo_changed
//     — a `model` that differs from the team name and is not one of the
//       nine HLDM models is ALLOWED through, unchanged.
//   crates/server/src/rules/teams.rs :: userinfo_changed
//     — with a team limit and the 3.0 ruleset, the model key is REPLACED
//       with `model_for(&team)` — a RANDOM model from that team's list.
//
// The live server runs `mp_teamlist "team1;team2;team3;team4"` with
// `mp_teammodels "seal;merc|gordon;laurence|agent|hitman;castor"`, so
// the model a player ends up with is chosen by the server from their
// team's list. The browser can ASK for a model; whether the server
// grants it depends on the ruleset the server is running.
//
// This module therefore reports what the CLIENT knows, and never claims
// the server agreed. `applyModel` returns whether the client-side cvar
// changed — not whether the server accepted it.
//
// THE MODEL LIST
// --------------
// The models are TS's own, and the list is the server's
// `mp_teammodels` value, split on `|`. It is kept here as data so the
// picker and the launch-argument builder cannot disagree about it.

import { ref, computed } from 'vue';
import XashLoader from '/@/services/xash-loader';
import { readCvar } from '/@/services/engine-cvars';
import { logDebug } from '/@/services/debug-log';

/**
 * TS's player models, grouped by the team that owns them.
 *
 * The groups come from the server's `mp_teammodels` cvar, which is
 * `team1;team2|...`-separated: `seal;merc|gordon;laurence|agent|hitman;castor`.
 * The teams are `team1`..`team4`, and each pipe-separated group is one
 * team's models.
 */
export const TS_MODEL_GROUPS: readonly (readonly string[])[] = [
  ['seal', 'merc'],
  ['gordon', 'laurence'],
  ['agent'],
  ['hitman', 'castor'],
];

/** Every model, flattened, in the server's own order. */
export const TS_MODELS: readonly string[] = TS_MODEL_GROUPS.flat();

/** The model the player has chosen, or '' for the server's default. */
export const chosenModel = ref<string>('');

/** The name the player has chosen. */
export const chosenName = ref<string>('');

/** The name the engine currently reports. */
export const engineName = ref<string>('');

/** The model the engine currently reports. */
export const engineModel = ref<string>('');

/** Has the engine been asked for its identity yet? */
export const identityLoaded = ref(false);

/**
 * The name to show in a text field: the player's choice if they made
 * one, otherwise what the engine says.
 *
 * A fresh install has no choice yet, and showing an empty box where
 * the engine knows a name ("Specialist") reads as "your name is
 * blank". So the fallback is the engine's own value.
 */
export const displayName = computed(() => chosenName.value || engineName.value);

/**
 * Read the engine's current name and model.
 *
 * Both are USERINFO cvars, and a bare cvar name is how Xash3D reads
 * one (there is no `cvar` subcommand — `cvar hostmap` is an unknown
 * command).
 */
export async function refreshIdentity(): Promise<void> {
  const [n, m] = await Promise.all([readCvar('name'), readCvar('model')]);
  if (n !== null) engineName.value = n;
  if (m !== null) engineModel.value = m;
  identityLoaded.value = true;
  logDebug(`[identity] engine name="${engineName.value}" model="${engineModel.value}"`);
}

/**
 * The engine command that sets a USERINFO cvar.
 *
 * `setinfo <key> <value>` is the mechanism: it sets the cvar AND marks
 * the userinfo dirty, so the server gets the new value on the next
 * userinfo update. Writing the cvar directly (`writeCvar`) sets the
 * value but does not necessarily push it to the server.
 *
 * The quotes matter: the value is a single token, and an unquoted
 * `setinfo name Some Name` sets the name to `Some`.
 */
function setUserinfo(key: string, value: string): void {
  const safe = value.replace(/["\\]/g, '');
  XashLoader.exec(`setinfo ${key} "${safe}"`);
  logDebug(`[identity] setinfo ${key} "${safe}"`);
}

/**
 * Set the player's name.
 *
 * Returns false for an empty or whitespace-only name — a blank name is
 * not a name, and the server has its own default for that.
 */
export function applyName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  chosenName.value = n;
  setUserinfo('name', n);
  return true;
}

/**
 * Set the player's character model.
 *
 * Returns false for an empty model or one TS does not ship: sending an
 * unknown model would be rejected by the server, and the TS ruleset
 * treats the `model` key as a TEAM name in teamplay, so a bogus value
 * can read as a team change.
 */
export function applyModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (!TS_MODELS.includes(m)) {
    logDebug(`[identity] refusing unknown model "${m}"`);
    return false;
  }
  chosenModel.value = m;
  setUserinfo('model', m);
  return true;
}

/**
 * The launch arguments that apply a saved identity BEFORE the connect.
 *
 * WHY THIS EXISTS
 * ---------------
 * A model chosen on the landing page has to be in the userinfo the
 * client sends with its CONNECT, or the server never learns about it —
 * changing it later is a different code path (and, under the 3.0
 * ruleset with a team limit, a different outcome).
 *
 * The engine takes `+setinfo <key> <value>` on the command line the
 * same way it takes it in the console, and the launch arguments are
 * processed before the first frame — so the value is in place before
 * the server sees the player.
 *
 * `+setinfo` with a quoted value is used rather than `+name`, because
 * `+name` would set a cvar that the engine treats as a cvar (not as
 * userinfo) and the server would never see it.
 */
export function identityLaunchArgs(): string[] {
  const args: string[] = [];
  const n = chosenName.value.trim();
  const m = chosenModel.value.trim().toLowerCase();
  if (n) args.push(`+setinfo name "${n.replace(/["\\]/g, '')}"`);
  if (m && TS_MODELS.includes(m)) args.push(`+setinfo model "${m}"`);
  return args;
}

/**
 * Restore a saved identity from local storage.
 *
 * The choice is remembered across sessions because re-typing a name on
 * every visit is the kind of friction that gets a player to leave.
 */
const STORAGE_KEY = 'bulletballet.identity';

export interface SavedIdentity {
  name?: string;
  model?: string;
  /** False when the player asked not to be remembered. */
  remember?: boolean;
}

export function loadSavedIdentity(): SavedIdentity {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SavedIdentity;
    if (parsed.remember === false) return {};
    if (typeof parsed.name === 'string' && parsed.name.trim()) {
      chosenName.value = parsed.name.trim();
    }
    if (typeof parsed.model === 'string' && TS_MODELS.includes(parsed.model)) {
      chosenModel.value = parsed.model;
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveIdentity(identity: SavedIdentity): void {
  try {
    if (identity.remember === false) {
      window.localStorage.removeItem(STORAGE_KEY);
      chosenName.value = '';
      chosenModel.value = '';
      return;
    }
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        name: chosenName.value || undefined,
        model: chosenModel.value || undefined,
        // The identity is only written when it is meant to be
        // remembered, so the stored copy always says so.
        remember: true,
      }),
    );
  } catch {
    // A browser with storage disabled is not a reason to fail a launch.
  }
}
