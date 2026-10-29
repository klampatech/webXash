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
// The frontend never computes a loadout, never sends `tkw`/`tki`/`tka`,
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

import { reactive } from 'vue';
import XashLoader from '/@/services/xash-loader';
import { useXashStore } from '/@/stores/store.ts';
import { logDebug } from './debug-log';

/** The prefix every record the port prints carries. */
const PREFIX = 'TSBUY ';

/** The flags a row can carry. The port writes `0` for "no flags". */
const ROW_FLAGS = ['on', 'dim', 'x', 'sep'] as const;

export type BuyMenuMode = 'classic' | 'modern';

export interface BuyRow {
  /** The key this row answers to (1..11). 0 = the row takes no key. */
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
  /** The entry's name. */
  name: string;
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
    ammoSpend: 0,
    newConfig: false,
    category: 0,
    pending: -1,
    attachments: 0,
    pageTitle: '',
    pageName: '',
    rows: [],
    entries: [],
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
}

function newDump(): Dump {
  return { raw: {}, pageTitle: '', rows: [], entries: [] };
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
      const parts = rest.split(/\s+/);
      pendingDump.entries.push({
        index: toNumber(parts[0]),
        cost: toNumber(parts[1]),
        slots: toNumber(parts[2]),
        name: parts.slice(3).join(' '),
      });
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
  buyMenuState.raw = raw;
  buyMenuState.updatedAt = Date.now();
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
  if (!Number.isInteger(key) || key < 1 || key > 11) return;
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
 * Put the buy menu into the mode the player chose.
 *
 * Called when the player changes the setting, and once at session start
 * (see the engine-up hook at the bottom of this file). The flag is
 * idempotent, so the retries below are safe: the port may not have
 * registered its commands yet on the very first frame.
 */
export function applyBuyMenuMode(mode: BuyMenuMode): void {
  setBuyMenuHidden(mode === 'modern');
  // The client library registers its commands while it initialises. If
  // the first attempt was too early, the engine answered "Unknown
  // command" and the flag was never set — so try again, a few times.
  //
  // Every retry re-reads the stored preference, so a player who
  // switched menus in the meantime is not overruled by a stale retry.
  for (const delayMs of [1000, 3000, 7000]) {
    window.setTimeout(() => {
      setBuyMenuHidden(storedBuyMenuMode() === 'modern');
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
