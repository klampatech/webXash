// buy-menu.ts — the frontend's end of the buy-menu bridge.
//
// WHO OWNS THE BUY MENU
// ---------------------
// The Rust client library (the port) owns it, and it has to: the prices
// are runtime data (a ruleset can override a weapon's cost at runtime),
// and the rules — the 30,000 budget, the 81-slot limit, the weapon
// restrictions, the attachment and akimbo multipliers, the ammo fill and
// the nine saved slots — all live there. The server applies whatever it
// is sent, so a browser that computed a loadout itself would make those
// rules advisory in two places at once.
//
// So this file is a CHANNEL, not a model:
//
//   - the port prints its state on stdout, one `TSBUY ` record per line,
//     and prints it again after every change;
//   - the frontend listens for those records and renders them;
//   - the frontend's only write path is a key: `ts_buy_key <n> [<page>]`,
//     which runs the same `BuyMenu::handle_key` the canvas menu runs.
//
// The frontend never computes a loadout, never sends the game's own
// config commands (the three that write a loadout into a config file),
// and keeps no copy of the slots. The saved loadouts live in the game's
// own `tsbuylist.tsa`, so the classic menu and this panel can never
// disagree about what the player bought.
//
// THE PROTOCOL
// ------------
// The port prints:
//
//   TSBUY state open=1 hidden=0 page=1 budget=30000 total=850 slots=10 ...
//   TSBUY page 1 #Buy_CATEGORY
//   TSBUY row 1 0 0 1 1 #Buy_Handguns
//   TSBUY entry 0 850 10 Glock-18
//   TSBUY end
//
// One record per line, `TSBUY end` closing the set. The frontend does
// not poll: it listens, and asks for a state once (`ts_buy_state`) when
// it mounts.

// THE FLOW
// --------
// The port has TWO flows and it picks one: the CLASSIC flow is the
// game's own canvas menu, and it is the port's DEFAULT. The modern
// flow is asked for, never assumed:
//
//   ts_buy_mode classic   the game's own canvas menu
//   ts_buy_mode modern    the loadout flow the redesigned panel draws
//
// The mode is on the state line (`mode=modern` / `mode=classic`), and
// the port is the one that has it: the redesigned panel is drawn when
// the state says `modern`, and the classic canvas menu is the port's
// own when it says `classic`. So the browser's setting is what the
// port was TOLD, and the state line is what the port IS — the panel
// follows the state, never the setting.
//
// The canvas menu's hidden flag (`ts_buy_hide`) is NOT the flow
// switch: the modern flow draws no canvas of its own accord, and the
// classic flow's canvas menu is the port's own. So the flag is
// cleared, never set — a flag left on would leave a player in the
// classic flow with no menu at all.

// THE MODERN FLOW
// ---------------
// The redesigned buy panel is the port's own buy menu, reorganised by
// slot. The port grows a second flow for it and prints the same kind
// of records, plus four new ones:
//
//   TSBUY state ... mode=modern screen=loadout slot=2 tab=0 slot_limit=81 ...
//   TSBUY slot 1 11 2 Melee weapons
//   TSBUY tab 0 Loadout A 1
//   TSBUY row 1 850 0 2 1 Glock-18
//   TSBUY short 4 950
//   TSBUY owned 3 1
//   TSBUY entry 0 2550 10 #Buy_Silencer,#Buy_Laser 2 11 Glock-18
//   TSBUY sum 2550 20850
//
//   - `mode`   is `classic` or `modern`.
//   - `screen` is `loadout`, `browse` or `attach`.
//   - `slot`   is the classic weapon slot being browsed (1..5), 0 on
//              the loadout screen.
//   - `tab`    is the active loadout tab (the config save slot).
//   - `slot` records are the slot cards: the slot's number, the
//              inventory slots its weapons take, how many weapons it
//              holds and its label. A slot numbered 6 is the player
//              accessory, which is not one of the five weapon slots.
//   - `tab` records are the loadout tabs: the tab's index, its label
//              and whether it is the active one.
//   - `short` records say how much more money a row needs.
//   - `owned` records say that a row is already in the loadout.
//
// The rules the port owns and the browser never second-guesses:
//
//   - The browser sends KEYS and nothing else. A row carries the page
//     its key acts on, and a click sends the key with that page; the
//     slot cards have no page of their own, so they send the key to
//     the port's current page, which is the screen the port is on.
//   - The modern entry record carries the weapon's classic slot. The
//     browser puts an entry in exactly that slot; it does not infer a
//     slot from the weapon's name or from the order of the records.
//     The old four-field entry record has no slot, so that shape keeps
//     the classic flow's counting fallback.
//   - "Need $X more" is the port's number (the `short` record), never
//     the browser's subtraction.
//   - The pending purchase's total and the money left after it are the
//     port's numbers (`sum`), never arithmetic in the browser.

// THE MODERN FLOW'S KEYS
// ----------------------
// The screen changes what a key means, so the screen's title and
// breadcrumb are always on screen. The port implements these:
//
//   loadout   1-5 open that slot · 6 the player accessory · R random
//             · X clear (which asks for a confirmation) · Enter
//             deploys, which with apply-on-purchase is the port's
//             close action (key 10).
//   browse    the list's own rows pick the weapon: 1-9 and then 11,
//             12, ... — the tenth weapon is key 11, because the key
//             10 is the game's own back key and stays reserved. The
//             keycap the panel draws is the row's PLACE in the list
//             (1-9, then A, B, C), and the port prints it. 0 (and the
//             game's own 10) go back to the loadout.
//   attach    1-4 toggle the attachments · Enter adds the gun and its
//             attachments to the loadout.
//
// The rows carry their own keys and pages, so a click never needs this
// table; the table is what a TYPED key means.

import { reactive } from 'vue';
import XashLoader from '/@/services/xash-loader';
import { useXashStore } from '/@/stores/store.ts';
import { logDebug } from './debug-log';

/** The prefix every record the port prints carries. */
const PREFIX = 'TSBUY ';

/**
 * The port's remove page.
 *
 * A loadout weapon is removed by running its remove key on this
 * page, exactly as the classic menu's remove column does.
 */
export const BUY_REMOVE_PAGE = 5;

/** The flags a row can carry. The port writes `0` for "no flags". */
const ROW_FLAGS = ['on', 'dim', 'x', 'sep'] as const;

export type BuyMenuMode = 'classic' | 'modern';

/** Which screen of the modern flow the port is on. */
export type BuyMenuScreen = 'loadout' | 'browse' | 'attach';

/**
 * One of the port's slot cards.
 *
 * The classic weapon slots are 1 (melee, grenades, swords), 2
 * (pistols), 3 (SMGs), 4 (rifles and shotguns) and 5 (the akimbo
 * weapons) — the HUD grid column of the weapon table. Slot 6 is the
 * player accessory, which is not one of the five.
 */
export interface BuySlotInfo {
  /** The slot's number: 1..5 for the weapon slots, 6 for the accessory. */
  number: number;
  /** The inventory slots the slot's weapons take. */
  slots: number;
  /** How many weapons the slot holds. */
  weapons: number;
  /** The label as the port printed it. */
  label: string;
  /** The label, resolved through the game's own titles. */
  text: string;
}

/** One of the port's loadout tabs — the config save slots. */
export interface BuyTabInfo {
  /** The tab's index. */
  index: number;
  /** The tab's label, as the port printed it. */
  label: string;
  /** The tab is the live one. */
  active: boolean;
}

export interface BuyRow {
  /**
   * The key this row answers to. 0 = the row takes no key.
   *
   * The classic flow's keys are 1..11. The modern flow's list rows
   * run past the game's key alphabet: 1-9 and then 11, 12, ... (the
   * key 10 is the game's own back key and stays reserved), so a long
   * list's tenth row is key 11.
   */
  key: number;
  /** The row's price. 0 = no price (a category row). */
  price: number;
  /**
   * The page the row's key acts on.
   *
   * The port draws the columns of the page it is on, and a row of a
   * parent column's key acts on that column's own page -- the canvas's
   * mouse picks the column the click was in. So a row says which page
   * it belongs to, and the click sends the key there.
   */
  page: number;
  /**
   * The number the canvas draws before the row's label: the key's own
   * prefix ("1", "0", "A"), the entry's number in the remove column
   * ("10"), or nothing when the number is part of the title (the saved
   * slots).
   */
  number: string;
  /** The flags the port reported, lower-cased. */
  flags: string[];
  /** The label as the port printed it: a title key (`#Buy_Handguns`) or text. */
  label: string;
  /** The label, resolved through the game's own titles. */
  text: string;
  /** The row is the selected one (`on`). */
  selected: boolean;
  /** The row cannot be acted on (`dim`). */
  dim: boolean;
  /** The row costs more than the budget (`x`). */
  unaffordable: boolean;
  /** The row is a separator (`sep`). */
  separator: boolean;
}

export interface BuyEntry {
  /** The entry's index in the config (0..15). */
  index: number;
  /** What the entry costs. */
  cost: number;
  /** The inventory slots the entry takes. */
  slots: number;
  /** The entry's name, as the port printed it. */
  label: string;
  /** The entry's name, resolved through the game's own titles. */
  name: string;
  /**
   * The classic weapon slot the entry belongs to (1..5).
   *
   * The modern entry record carries this. The old four-field record
   * does not, and then this is 0.
   */
  slot: number;
  /**
   * The key that removes this entry on the port's remove page.
   *
   * Zero means the record did not carry a removal key.
   */
  removeKey: number;
  /** The attachment labels, as the port printed them. */
  attachmentLabels: string[];
  /** The attachment labels, resolved through the game's own titles. */
  attachments: string[];
}

export interface BuyMenuState {
  /** True once the port has printed a state: the bridge exists. */
  available: boolean;
  /** True when the engine answered "Unknown command" for the port's commands. */
  unsupported: boolean;
  /**
   * True when the port's commands are not there: the engine answered
   * "Unknown command", or it never answered at all.
   *
   * The classic menu keeps working in that case (the hidden flag was
   * never set), so this is a notice, not an error.
   */
  bridgeMissing: boolean;
  /** The port's menu is open. */
  open: boolean;
  /** The canvas menu is hidden — the modern menu is on. */
  hidden: boolean;
  /** The port's current page. */
  page: number;
  /** The budget the port is working to. */
  budget: number;
  /** What the current config costs. */
  total: number;
  /** The inventory slots the current config takes. */
  slots: number;
  /**
   * The size of the slot pool, if the port reported it.
   *
   * The pool is the game's own (81 slots), and a ruleset can change
   * it, so the panel shows a limit only when the port says what it is.
   */
  slotLimit: number;
  /**
   * How many of the five weapon slots hold something.
   *
   * The port's own number (`slots_in_use`), for the modern flow: it
   * counts the slots, the way the port counts them. Zero when the
   * port did not report one (the classic flow does not have it), and
   * the panel counts the slots itself then.
   */
  slotsInUse: number;
  /** What the ammo fill spent. */
  ammoSpend: number;
  /** The config differs from the last one used. */
  newConfig: boolean;
  /** The selected category. */
  category: number;
  /** The weapon waiting for its options (-1 = none). */
  pending: number;
  /** The pending weapon's attachment bits. */
  attachments: number;
  /** The current page's title key. */
  pageTitle: string;
  /** The current page's name, for the panel's header. */
  pageName: string;
  /** The current page's rows, in the order the port drew them. */
  rows: BuyRow[];
  /** The config's entries. */
  entries: BuyEntry[];
  /**
   * The flow the port is in: the game's own menu, or the modern
   * loadout flow the redesigned panel draws.
   */
  mode: BuyMenuMode;
  /** Which screen of the modern flow the port is on. */
  screen: BuyMenuScreen;
  /**
   * The classic weapon slot the port is browsing (1..5). 0 on the
   * loadout screen.
   */
  slot: number;
  /** The active loadout tab — the config save slot. */
  tab: number;
  /** The screen's title, as the port printed it. */
  screenTitle: string;
  /** The slot cards: the port's slots and what is in them. */
  slotInfos: BuySlotInfo[];
  /** The loadout tabs. */
  tabs: BuyTabInfo[];
  /**
   * The rows that need more money: the row's key, and how much more.
   *
   * The port's number, not the browser's subtraction.
   */
  shortfalls: Record<number, number>;
  /** The rows that are already in the loadout: the row's key. */
  owned: Record<number, boolean>;
  /**
   * The pending gun and its attachments' total, from `TSBUY sum`.
   *
   * This is the port's total, because akimbo and full-load
   * multipliers can make it different from the gun's base price.
   */
  pendingTotal: number;
  /** The money left after the pending purchase, from `TSBUY sum`. */
  remainingAfterPurchase: number;
  /** True when the port printed a pending-purchase summary. */
  hasPurchaseSummary: boolean;
  /** Every key=value the port printed, including ones this file does not know. */
  raw: Record<string, string>;
  /** When the state arrived (ms since the epoch). */
  updatedAt: number;
}

function emptyState(): BuyMenuState {
  return {
    available: false,
    unsupported: false,
    bridgeMissing: false,
    open: false,
    hidden: false,
    page: 0,
    budget: 0,
    total: 0,
    slots: 0,
    slotLimit: 0,
    slotsInUse: 0,
    ammoSpend: 0,
    newConfig: false,
    category: 0,
    pending: -1,
    attachments: 0,
    pageTitle: '',
    pageName: '',
    rows: [],
    entries: [],
    mode: 'classic',
    screen: 'loadout',
    slot: 0,
    tab: 0,
    screenTitle: '',
    slotInfos: [],
    tabs: [],
    shortfalls: {},
    owned: {},
    pendingTotal: 0,
    remainingAfterPurchase: 0,
    hasPurchaseSummary: false,
    raw: {},
    updatedAt: 0,
  };
}

/**
 * The port's state, as a reactive object.
 *
 * A plain reactive object rather than a store: there is one buy menu,
 * it lives in the client library, and nothing else in the app writes to
 * it. The panel reads it; the panel's clicks go out as keys.
 */
export const buyMenuState = reactive<BuyMenuState>(emptyState());

// ---------------------------------------------------------------------------
// The titles
// ---------------------------------------------------------------------------

/**
 * The game's own titles, read out of the engine's filesystem.
 *
 * The port prints title KEYS (`#Buy_Handguns`), because the titles are
 * the game's and a ruleset can override them. The engine resolves them
 * through its own `titles.txt` — the same file the port's menu draws
 * through — so the frontend reads that file rather than inventing an
 * English table of its own. A ruleset that renames a category changes
 * the panel too, which is the point.
 */
const gameTitles = new Map<string, string>();
let gameTitlesLoaded = false;

/**
 * When the titles file was last looked for.
 *
 * The labels are resolved one by one, and a state dump resolves every
 * row it holds. A titles file that is not readable yet would then be
 * looked for again for every row, on every state. The engine's
 * filesystem is filled during boot, so the answer is usually "in a
 * moment": the file is looked for again, but at most every couple of
 * seconds.
 */
let lastTitleLookup = 0;

/** How long to wait between two looks for the titles file. */
const TITLE_LOOKUP_INTERVAL = 2000;

/**
 * Where the titles file may live inside the engine's filesystem.
 *
 * The engine loads it from the game directory (`-game ts` → `ts/`), and
 * the mod's files are unpacked into the WASM filesystem with the paths
 * they have in the archive. `valve/` is the fallback (the base game's
 * own titles), and a bare `titles.txt` covers a mod whose archive root
 * IS the game directory.
 */
const TITLES_PATHS = ['ts/titles.txt', 'valve/titles.txt', 'titles.txt'];

/**
 * Parse a `titles.txt`.
 *
 * Two shapes are in the wild and both are in the mod: the braced form
 * TS ships (`Key` / `{` / `Text` / `}`) and the quoted form Half-Life
 * ships (`"Key" "Text"`).
 */
function parseTitles(raw: string): Map<string, string> {
  const titles = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i += 1;
    if (!line || line.startsWith('//')) continue;
    if (line === '{' || line === '}') continue;

    // The braced form: the key, then the text up to the closing brace.
    if (lines[i]?.trim() === '{') {
      const key = unquote(line);
      i += 1;
      const text: string[] = [];
      while (i < lines.length && lines[i].trim() !== '}') {
        text.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing brace
      const value = unquote(text.join(' ').replace(/\s+/g, ' ').trim());
      if (key && value) titles.set(key, value);
      continue;
    }

    // The quoted form.
    const quoted = line.match(/^"([^"]*)"\s+"([^"]*)"/);
    if (quoted) {
      titles.set(quoted[1], quoted[2]);
      continue;
    }
  }
  return titles;
}

function unquote(s: string): string {
  const m = s.match(/^"([^"]*)"/);
  return (m ? m[1] : s).trim();
}

/**
 * The game's titles, loaded once.
 *
 * The engine's filesystem is filled during boot, so a miss here is not
 * fatal: the load is retried the next time a label needs resolving.
 */
function loadGameTitles(): void {
  if (gameTitlesLoaded) return;
  const now = Date.now();
  if (now - lastTitleLookup < TITLE_LOOKUP_INTERVAL) return;
  lastTitleLookup = now;
  for (const path of TITLES_PATHS) {
    const raw = XashLoader.readGameFile(path);
    if (!raw) continue;
    const parsed = parseTitles(raw);
    if (parsed.size === 0) continue;
    for (const [key, value] of parsed) gameTitles.set(key, value);
    gameTitlesLoaded = true;
    logDebug(`[buy] loaded ${parsed.size} game titles from ${path}`);
    // A state that arrived before the titles were readable (the
    // filesystem is filled during boot) gets its labels now.
    relabelState();
    return;
  }
}

/**
 * The game's titles, from a text.
 *
 * The production path reads them out of the engine's filesystem (see
 * `loadGameTitles`), and the engine resolves the very same keys. The
 * dev harness has no engine, so it seeds the same file here — through
 * the same parser — and a title resolves in the harness exactly as it
 * does in the game.
 *
 * This is not a table of English the browser invented: it is the
 * game's own titles file, handed over. The engine's own copy still
 * wins if it becomes readable later.
 */
export function seedBuyTitles(raw: string): number {
  const parsed = parseTitles(raw);
  for (const [key, value] of parsed) gameTitles.set(key, value);
  // A state that arrived before the titles were seeded gets its
  // labels now.
  relabelState();
  return parsed.size;
}

/**
 * Resolve every label of the current state again.
 *
 * The labels are the game's, and the game's titles file may only
 * become readable after the first state has been parsed.
 */
function relabelState(): void {
  if (!buyMenuState.rows.length && !buyMenuState.pageTitle) return;
  buyMenuState.rows = buyMenuState.rows.map((row) => ({
    ...row,
    text: resolveBuyLabel(row.label, row.key),
  }));
  buyMenuState.entries = buyMenuState.entries.map((entry) => ({
    ...entry,
    name: resolveBuyLabel(entry.label),
    attachments: entry.attachmentLabels.map((label) => resolveBuyLabel(label)),
  }));
  buyMenuState.slotInfos = buyMenuState.slotInfos.map((slot) => ({
    ...slot,
    text: resolveBuyLabel(slot.label),
  }));
  buyMenuState.pageTitle = resolveBuyLabel(lastPageTitleRaw);
  buyMenuState.pageName = buyPageName(lastPageTitleRaw, buyMenuState.pageTitle);
}

/**
 * The engine's word characters in a title token.
 *
 * `LocaliseTextString` takes the bytes from `A` to `z` — which takes in
 * `[\]^_` and the backtick — plus the digits. The port's own copy of the
 * rule says the same: a word byte that is not a letter or a digit
 * ends the token, so `#Buy_Buy.` resolves "Buy" and leaves the dot, and
 * `#Buy_Buy[` misses the titles entirely.
 */
const TITLE_TOKEN = /#([\x41-\x7a0-9]+)/g;

/**
 * Resolve a label the port printed.
 *
 * The port prints the game's own title KEYS (`#Buy_Handguns`), because
 * the titles are the game's and a ruleset can override them. The
 * engine resolves them through its own `titles.txt`, and this resolves
 * them the same way, token by token:
 *
 *   - a token the game knows is replaced by its text;
 *   - a token the game does not know is left exactly as it stands, `#`
 *     and all — a made-up English word would be a lie about what the
 *     menu says;
 *   - the rest of the label is literal, so `#Chg_Join Specialists`
 *     reads "Join Specialists" and not "Chg_Join Specialists".
 *
 * `arg` fills a numeric directive in the title. The canvas menu formats
 * the same titles the same way — `#Buy_SlotEmpty` is "Slot #%i (Empty)"
 * and the slot number is the row's key — so the panel's text matches
 * the canvas's text row for row.
 */
export function resolveBuyLabel(label: string, arg?: number): string {
  const text = (label ?? '').trim();
  if (!text) return '';
  if (!text.includes('#')) return text;
  loadGameTitles();
  const resolved = text.replace(TITLE_TOKEN, (whole, word: string) => {
    const found = gameTitles.get(word);
    // An unknown key stays as it was printed: the engine copies the
    // `#` alone and leaves the word literal.
    return found === undefined ? whole : found;
  });
  if (arg === undefined) return resolved;
  return resolved.replace(/%[di]/g, String(arg));
}

/**
 * The page's name, for the panel's header.
 *
 * The port prints the page's title KEY (`#Buy_CATEGORY`). The game's
 * titles resolve it — a ruleset that defines the key renames the
 * page, which is the point of reading the game's own titles.
 *
 * The mod's own titles file does not define the buy menu's page
 * titles, and it does not have to: the canvas menu draws columns of
 * rows and never draws a page title, so the game never needed one.
 * So for the pages the key comes back unresolved, and the panel shows
 * the port's own name for the page — the tail of its key,
 * "CATEGORY" — rather than a raw `#Buy_CATEGORY`.
 *
 * Nothing here is a table of English: the name is the port's, and the
 * game's own title wins over it whenever the game has one.
 */
export function buyPageName(rawTitle: string, resolvedTitle: string): string {
  const raw = (rawTitle ?? '').trim();
  if (!raw) return '';
  // The game knows the key: its text is the page's name.
  if (resolvedTitle && resolvedTitle !== raw) return resolvedTitle;
  const tail = raw.replace(/^#/, '').split('_').filter(Boolean).pop() ?? '';
  return tail || raw.replace(/^#/, '');
}

// ---------------------------------------------------------------------------
// Parsing the port's records
// ---------------------------------------------------------------------------

/** One record set, assembled from the lines between two `state` records. */
interface Dump {
  raw: Record<string, string>;
  pageTitle: string;
  rows: BuyRow[];
  entries: BuyEntry[];
  slotInfos: BuySlotInfo[];
  tabs: BuyTabInfo[];
  shortfalls: Record<number, number>;
  owned: Record<number, boolean>;
  pendingTotal: number;
  remainingAfterPurchase: number;
  hasPurchaseSummary: boolean;
}

function newDump(): Dump {
  return {
    raw: {},
    pageTitle: '',
    rows: [],
    entries: [],
    slotInfos: [],
    tabs: [],
    shortfalls: {},
    owned: {},
    pendingTotal: 0,
    remainingAfterPurchase: 0,
    hasPurchaseSummary: false,
  };
}

let pendingDump: Dump | null = null;

/** The page's title as the port printed it, before it was resolved. */
let lastPageTitleRaw = '';

/** The port's flags: `0`, or a `+`-joined set of them. */
function parseFlags(raw: string): string[] | null {
  const token = (raw ?? '').trim().toLowerCase();
  if (!token) return [];
  if (token === '0') return [];
  const parts = token.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  // Only a known flag set is a flag set. Anything else is a label that
  // happens to sit where the flags would be.
  if (!parts.every((p) => (ROW_FLAGS as readonly string[]).includes(p))) return null;
  return parts;
}

function toNumber(raw: string | undefined, fallback = 0): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const n = Number(raw);
  if (Number.isFinite(n)) return n !== 0;
  return raw.trim().toLowerCase() === 'true';
}

function makeRow(
  key: number,
  price: number,
  flags: string[],
  page: number,
  number: string,
  label: string,
): BuyRow {
  return {
    key,
    price,
    flags,
    page,
    number,
    label,
    text: resolveBuyLabel(label, key),
    selected: flags.includes('on'),
    dim: flags.includes('dim'),
    unaffordable: flags.includes('x'),
    separator: flags.includes('sep'),
  };
}

/**
 * Parse one entry record.
 *
 * The modern record is:
 *
 *   entry <index> <cost> <slots> <attachments> <slot> <remove_key> <name>
 *
 * The attachment field is a comma-separated list of the same title
 * keys the port prints everywhere else. It may be empty.
 *
 * The classic record is:
 *
 *   entry <index> <cost> <slots> <name>
 *
 * Both shapes are accepted. The classic one has no slot or removal
 * key, so those stay zero.
 */
function parseEntry(rest: string): BuyEntry {
  const modern = rest.match(
    /^(\d+)\s+(\d+)\s+(\d+)(?:[ \t]+([^\s]*))[ \t]+(\d+)\s+(\d+)\s+(.+)$/,
  );
  if (modern) {
    const label = modern[7].trim();
    const attachmentLabels = (modern[4] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value && value !== '-');
    return {
      index: toNumber(modern[1]),
      cost: toNumber(modern[2]),
      slots: toNumber(modern[3]),
      label,
      name: resolveBuyLabel(label),
      slot: toNumber(modern[5]),
      removeKey: toNumber(modern[6]),
      attachmentLabels,
      attachments: attachmentLabels.map((value) => resolveBuyLabel(value)),
    };
  }

  const parts = rest.split(/\s+/);
  const label = parts.slice(3).join(' ');
  return {
    index: toNumber(parts[0]),
    cost: toNumber(parts[1]),
    slots: toNumber(parts[2]),
    label,
    name: resolveBuyLabel(label),
    slot: 0,
    removeKey: 0,
    attachmentLabels: [],
    attachments: [],
  };
}

/**
 * Read one line of the port's output.
 *
 * The engine prefixes its prints with a `[HH:MM:SS]` timestamp, so the
 * prefix is stripped before the record is matched.
 */
function onEngineLine(rawLine: string): void {
  const line = rawLine.replace(/^\s*\[\d{1,2}:\d{2}:\d{2}\]\s*/, '').trim();
  if (!line) return;

  if (!line.startsWith(PREFIX)) {
    // A client build without the port's commands answers "Unknown
    // command: ts_buy_hide" (the engine writes it with a colon or
    // with quotes, so both are matched). The panel then says so
    // instead of pretending it has a state.
    if (/^Unknown command:?\s*"?ts_buy_/i.test(line)) {
      if (!buyMenuState.unsupported) {
        buyMenuState.unsupported = true;
        buyMenuState.bridgeMissing = true;
        logDebug('[buy] the engine does not know the buy-menu commands');
      }
    }
    return;
  }

  const body = line.slice(PREFIX.length);
  const space = body.indexOf(' ');
  const kind = space === -1 ? body : body.slice(0, space);
  const rest = space === -1 ? '' : body.slice(space + 1).trim();

  switch (kind) {
    case 'state': {
      // A new state record starts a new set: a dump that was cut short
      // must not bleed into the next one.
      pendingDump = newDump();
      for (const pair of rest.split(/\s+/)) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        pendingDump.raw[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      break;
    }
    case 'page': {
      if (!pendingDump) pendingDump = newDump();
      // `page <id> <title>` — the title is the rest of the line.
      pendingDump.pageTitle = rest.split(/\s+/).slice(1).join(' ');
      break;
    }
    case 'row': {
      if (!pendingDump) pendingDump = newDump();
      // `row <key> <price> <flags> <page> <number> <label>` -- the
      // label is the rest of the line (a title key, or text with
      // spaces in it).
      const parts = rest.split(/\s+/);
      const key = toNumber(parts[0]);
      const price = toNumber(parts[1]);
      const flags = parts[2] === undefined ? [] : (parseFlags(parts[2]) ?? []);
      const page = toNumber(parts[3], -1);
      // "-" is the port's "no number" (the saved slots carry theirs in
      // the title).
      const number = parts[4] === '-' || parts[4] === undefined ? '' : parts[4];
      const label = parts.slice(5).join(' ');
      pendingDump.rows.push(makeRow(key, price, flags, page, number, label));
      break;
    }
    case 'entry': {
      if (!pendingDump) pendingDump = newDump();
      pendingDump.entries.push(parseEntry(rest));
      break;
    }
    case 'slot': {
      if (!pendingDump) pendingDump = newDump();
      // `slot <number> <slots> <weapons> <label>` — the label is the
      // rest of the line (it holds spaces: "Melee weapons").
      const parts = rest.split(/\s+/);
      const label = parts.slice(3).join(' ');
      pendingDump.slotInfos.push({
        number: toNumber(parts[0]),
        slots: toNumber(parts[1]),
        weapons: toNumber(parts[2]),
        label,
        text: resolveBuyLabel(label),
      });
      break;
    }
    case 'tab': {
      if (!pendingDump) pendingDump = newDump();
      // `tab <index> <label> <active>` — the label holds spaces ("Loadout
      // A"), so the active flag is the LAST token and the label is
      // everything between the index and it.
      const parts = rest.split(/\s+/);
      const index = toNumber(parts[0]);
      let labelParts = parts.slice(1);
      let active = false;
      const last = labelParts[labelParts.length - 1];
      if (last === '0' || last === '1') {
        active = last === '1';
        labelParts = labelParts.slice(0, -1);
      }
      pendingDump.tabs.push({ index, label: labelParts.join(' '), active });
      break;
    }
    case 'short': {
      if (!pendingDump) pendingDump = newDump();
      // `short <key> <amount>` — how much more money the row needs.
      const parts = rest.split(/\s+/);
      pendingDump.shortfalls[toNumber(parts[0])] = toNumber(parts[1]);
      break;
    }
    case 'owned': {
      if (!pendingDump) pendingDump = newDump();
      // `owned <key> <flag>` — the row is already in the loadout.
      const parts = rest.split(/\s+/);
      pendingDump.owned[toNumber(parts[0])] = parts[1] === undefined ? true : toBool(parts[1]);
      break;
    }
    case 'sum': {
      if (!pendingDump) pendingDump = newDump();
      // `sum <total> <remaining_after>` — the port's pending-purchase
      // total and the money that would be left after it.
      const parts = rest.split(/\s+/);
      pendingDump.hasPurchaseSummary = true;
      pendingDump.pendingTotal = toNumber(parts[0]);
      pendingDump.remainingAfterPurchase = toNumber(parts[1]);
      break;
    }
    case 'end': {
      commitDump();
      break;
    }
    default:
      // A record this frontend does not know: ignore it rather than
      // guess. The port may grow one.
      break;
  }
}

/** Publish the assembled set as the current state. */
function commitDump(): void {
  const dump = pendingDump;
  pendingDump = null;
  if (!dump) return;
  const raw = dump.raw;
  buyMenuState.available = true;
  buyMenuState.unsupported = false;
  buyMenuState.bridgeMissing = false;
  buyMenuState.open = toBool(raw.open);
  buyMenuState.hidden = toBool(raw.hidden);
  buyMenuState.page = toNumber(raw.page);
  buyMenuState.budget = toNumber(raw.budget);
  buyMenuState.total = toNumber(raw.total);
  buyMenuState.slots = toNumber(raw.slots);
  buyMenuState.slotLimit = slotLimitFrom(raw);
  // How many of the five weapon slots hold something — the port's own
  // count (`slots_in_use`). The classic flow does not report it, and
  // then the panel counts the slots itself.
  buyMenuState.slotsInUse = toNumber(raw.slots_in_use);
  buyMenuState.ammoSpend = toNumber(raw.ammo_spend ?? raw.ammo);
  buyMenuState.newConfig = toBool(raw.new);
  buyMenuState.category = toNumber(raw.cat ?? raw.category);
  buyMenuState.pending = toNumber(raw.pending, -1);
  buyMenuState.attachments = toNumber(raw.att ?? raw.attachments);
  lastPageTitleRaw = dump.pageTitle;
  buyMenuState.pageTitle = resolveBuyLabel(dump.pageTitle);
  buyMenuState.pageName = buyPageName(dump.pageTitle, buyMenuState.pageTitle);
  buyMenuState.rows = dump.rows;
  buyMenuState.entries = dump.entries;
  buyMenuState.mode = raw.mode === 'modern' ? 'modern' : 'classic';
  buyMenuState.screen = parseScreen(raw.screen);
  buyMenuState.slot = toNumber(raw.slot);
  buyMenuState.tab = toNumber(raw.tab);
  // The modern flow names its screens itself; the classic flow does
  // not, and then the page's title is the screen's title.
  buyMenuState.screenTitle = raw.title
    ? resolveBuyLabel(raw.title)
    : buyMenuState.pageTitle;
  buyMenuState.slotInfos = dump.slotInfos;
  buyMenuState.tabs = dump.tabs;
  buyMenuState.shortfalls = dump.shortfalls;
  buyMenuState.owned = dump.owned;
  buyMenuState.pendingTotal = dump.pendingTotal;
  buyMenuState.remainingAfterPurchase = dump.remainingAfterPurchase;
  buyMenuState.hasPurchaseSummary = dump.hasPurchaseSummary;
  buyMenuState.raw = raw;
  buyMenuState.updatedAt = Date.now();
}

/**
 * Feed the port's records in from outside the engine's stdout.
 *
 * This is the SAME handler the live bridge uses: the stdout reader
 * calls `onEngineLine` with every line the engine prints, and so does
 * this. The dev harness (services/buy-menu.mock.ts) feeds it the
 * port's own record format, so the harness exercises the real parser
 * rather than a parallel fake of it.
 */
export function feedBuyMenuRecord(line: string): void {
  onEngineLine(line);
}

/** Feed a set of records in, in order. */
export function feedBuyMenuRecords(lines: string[]): void {
  for (const line of lines) onEngineLine(line);
}

/**
 * The modern flow's screen.
 *
 * The port names it; a state that does not (the classic flow) is the
 * loadout screen, which is the one the classic menu's own page is a
 * part of.
 */
function parseScreen(raw: string | undefined): BuyMenuScreen {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'browse' || value === 'attach' || value === 'loadout') return value;
  return 'loadout';
}

/**
 * The size of the slot pool, if the port reported one.
 *
 * The port's state record carries the slots USED, not the limit, and
 * the limit belongs to the port (a ruleset can change it), so the
 * panel does not invent one: it shows the limit only when the port
 * says what it is.
 */
function slotLimitFrom(raw: Record<string, string>): number {
  for (const name of ['slot_limit', 'slots_limit', 'max_slots', 'slot_total']) {
    const value = Number(raw[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

/**
 * Run a key on the port's buy menu.
 *
 * This is the ONLY way the panel changes anything: every action in the
 * game's buy menu is a key on some page, and `ts_buy_key` runs the same
 * `handle_key` the canvas menu runs.
 *
 * `page` is the page the key acts on. The port draws the columns of the
 * page it is on, and a row of a parent column answers on that column's
 * own page -- the canvas's mouse picks the column the click was in. So a
 * click sends the row's page with its key, and the port runs the key
 * there. Without a page the key runs on the port's current page, which
 * is what the digit keys do.
 */
export function sendBuyKey(key: number, page?: number): void {
  // The modern flow's remove keys run through 16, and its list rows
  // run through the design's letter band: a list's rows are keyed
  // 1-9 and then 11, 12, ..., and the keycap the panel draws for them
  // is the row's place in the list (A for the tenth row). The band
  // ends at "Z", which is key 36. The classic flow still uses only
  // its own keys; widening the guard does not change what the classic
  // menu does with them.
  if (!Number.isInteger(key) || key < 1 || key > 36) return;
  // The engine's command pool does not exist until its first frame, and
  // a command sent before that makes the engine raise a fatal error.
  if (!XashLoader.isEngineUp()) return;
  const where = page === undefined ? '' : ` on page ${page}`;
  logDebug(`[buy] key ${key}${where}`);
  XashLoader.exec(page === undefined ? `ts_buy_key ${key}` : `ts_buy_key ${key} ${page}`);
}

/**
 * Watchdog for a bridge that never answers.
 *
 * The port answers `ts_buy_state` with its state. A client build that
 * does not carry the port's commands answers "Unknown command" (caught
 * by the stdout reader) or says nothing at all. Either way the panel
 * has no state to show, so the panel says THAT instead of sitting empty.
 */
let bridgeWatchdog: number | null = null;

function armBridgeWatchdog(): void {
  if (bridgeWatchdog !== null) window.clearTimeout(bridgeWatchdog);
  bridgeWatchdog = window.setTimeout(() => {
    bridgeWatchdog = null;
    if (buyMenuState.available) return;
    buyMenuState.bridgeMissing = true;
    logDebug('[buy] no state — this client build has no buy-menu bridge');
  }, 8000);
}

/** Ask the port to print its state. The frontend listens, not polls. */
export function requestBuyState(): void {
  if (!XashLoader.isEngineUp()) return;
  XashLoader.exec('ts_buy_state');
  armBridgeWatchdog();
}

/**
 * Hide (or show) the canvas buy menu.
 *
 * The hidden flag suppresses the canvas menu's drawing and the engine's
 * own key and mouse paths; the menu's state machine keeps running, so
 * the DOM still has a state to render.
 */
export function setBuyMenuHidden(hidden: boolean): void {
  if (!XashLoader.isEngineUp()) return;
  XashLoader.exec(`ts_buy_hide ${hidden ? 1 : 0}`);
}

/**
 * Ask the port for a flow.
 *
 * `ts_buy_mode classic|modern` is the port's own switch between the
 * game's own canvas menu and the modern loadout flow. The classic is
 * the port's DEFAULT, so the browser asks for the modern one and
 * never assumes it: the port answers with its state, and the state
 * line's `mode=` is what the frontend draws from.
 */
export function sendBuyMenuMode(mode: BuyMenuMode): void {
  if (!XashLoader.isEngineUp()) return;
  logDebug(`[buy] mode ${mode}`);
  XashLoader.exec(`ts_buy_mode ${mode}`);
}

/**
 * Put the buy menu into the mode the player chose.
 *
 * Called when the player changes the setting, and once at session start
 * (see the engine-up hook at the bottom of this file). The command is
 * idempotent, so the retries below are safe: the port may not have
 * registered its commands yet on the very first frame.
 *
 * The hidden flag is cleared and never set: the modern flow draws no
 * canvas of its own accord, and in the classic flow the canvas menu
 * IS the buy menu — a flag left on would leave the player with no
 * menu at all.
 */
export function applyBuyMenuMode(mode: BuyMenuMode): void {
  sendBuyMenuMode(mode);
  setBuyMenuHidden(false);
  // The client library registers its commands while it initialises. If
  // the first attempt was too early, the engine answered "Unknown
  // command" and the flag was never set — so try again, a few times.
  //
  // Every retry re-reads the stored preference, so a player who
  // switched menus in the meantime is not overruled by a stale retry.
  for (const delayMs of [1000, 3000, 7000]) {
    window.setTimeout(() => {
      sendBuyMenuMode(storedBuyMenuMode());
      setBuyMenuHidden(false);
    }, delayMs);
  }
}

/** The player's stored preference. */
export function storedBuyMenuMode(): BuyMenuMode {
  try {
    const store = useXashStore();
    return store.tsConfig?.buyMenu === 'modern' ? 'modern' : 'classic';
  } catch (_) {
    return 'classic';
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

let stopListening: (() => void) | null = null;

/**
 * Start listening for the port's state.
 *
 * The engine's stdout is already bridged to an `xash:stdout` window
 * event (see services/live-state.ts), so this only has to match the
 * `TSBUY ` records out of it.
 */
export function startBuyMenuBridge(): () => void {
  if (stopListening) return stopListening;
  const onOut = (e: Event) => {
    const detail = (e as CustomEvent<{ line?: string }>).detail;
    if (detail?.line) onEngineLine(detail.line);
  };
  window.addEventListener('xash:stdout', onOut);
  // The engine's own complaints ("Unknown command: ts_buy_hide") do
  // not always land on stdout, and that answer is how the frontend
  // learns that this build has no bridge. So stderr is watched too,
  // exactly as live-state.ts watches it.
  window.addEventListener('xash:stderr', onOut);
  stopListening = () => {
    window.removeEventListener('xash:stdout', onOut);
    window.removeEventListener('xash:stderr', onOut);
    stopListening = null;
  };
  return stopListening;
}

export function stopBuyMenuBridge(): void {
  if (stopListening) stopListening();
}

/**
 * The session start.
 *
 * The hidden flag has to be in place BEFORE the player dies: the canvas
 * menu opens by itself when the player becomes an observer, and the
 * switch decides which menu that is. So it is applied once, when the
 * engine comes up — not when the panel opens.
 */
XashLoader.onEngineUp(() => {
  // The listener has to be up before the first state is asked for: the
  // answer arrives on stdout and nobody else is looking.
  startBuyMenuBridge();
  applyBuyMenuMode(storedBuyMenuMode());
  requestBuyState();
});
