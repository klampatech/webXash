// buy-menu.mock.ts — the dev harness's fixture.
//
// The mock data is printed in the PORT'S OWN record format and fed
// through the real parser (`feedBuyMenuRecords`, the same handler the
// engine's stdout uses), so the harness exercises the parser and the
// panel rather than a parallel fake of them.
//
// The prices and the slot counts are the game's own — they come from
// the port's weapon table (crates/ts30/data/weapons.toml): a Glock-18
// is $850 and 10 slots, a Katana is $2,900 and 10 slots, the M60E3 is
// $8,000 and 70 slots. The budget is $30,000 and the slot pool is 81.
//
// THE RAIL: SEVEN ENTRIES, AND TWO DIFFERENT NUMBERS
// ---------------------------------------------------
// The rail is the browse aid and it has SEVEN entries: the melee
// weapons, the pistols, the SMGs, the rifles, the shotguns, the akimbo
// weapons and the player's accessory. The port keys them 1..7.
//
// The loadout screen's cards are the game's own HUD slots — five of
// them, plus the accessory — and those are a DIFFERENT set of numbers.
// The rail's key 5 is the shotguns and the HUD slot 5 is the akimbo
// weapons; the shotguns and the rifles share the HUD slot 4. So the
// fixture keeps the two apart: RAIL below is what the browser sees on
// the browse screen, and the loadout's cards keep their own labels.
//
// THE LIST'S KEY NUMBERING
// ------------------------
// A weapon list's rows are keyed 1–9 and then 11, 12, … — the key 10
// is the game's own back key and stays reserved — and the number the
// port prints for a row is the row's PLACE in the list, not its key:
// the tenth weapon wears the design's "A" and is keyed 11. The
// fixture prints the port's own records, so it prints both the same
// way.
//
// THE CLASSIC WEAPON SLOT
// -----------------------
// The slot a weapon belongs to is `WeaponInfo.hud[0]` — the HUD grid
// column, 1-based:
//
//   1  melee, grenades and swords   (M61 Grenade, Katana, the knives)
//   2  the pistols
//   3  the SMGs
//   4  the rifles and shotguns       (and the Barrett and the M60E3)
//   5  the akimbo weapons            (and the Golden Colts)
//
// The design mockup puts the M60E3 in slot 5 and the Golden Colts in
// the pistol list. Both are the mockup's mistake and neither is
// encoded here: the M60E3 is slot 4 and the Golden Colts are slot 5.
//
// THE ONE PLACE THE NUMBERS ARE THE MOCKUP'S
// ------------------------------------------
// The low-budget scenario shows the mockup's frame 4 — $1,950 left of
// $30,000 and 78 of the 81 slots in use. The real 81-slot pool cannot
// be spent down that fast (the M60E3 alone is 70 slots), so that one
// scenario borrows the design's numbers to show the amber state, and
// says so in its own records.

import {
  feedBuyMenuRecords,
  seedBuyTitles,
  type BuyMenuScreen,
} from './buy-menu.ts';

/** The states the harness can show. */
export type MockState =
  | 'default'
  | 'focused'
  | 'owned'
  | 'poor'
  | 'selected'
  | 'empty'
  | 'low'
  | 'tabs'
  | 'smgs'
  | 'rifles'
  | 'shotguns'
  | 'special';

export interface MockOptions {
  /** Which of the three screens to show. */
  screen?: BuyMenuScreen;
  /** Which row state to show. */
  state?: MockState;
}

/** One weapon: what it costs and how much of the pool it takes. */
interface MockWeapon {
  name: string;
  cost: number;
  slots: number;
  /**
   * The attachment labels the entry record carries.
   *
   * The port prints the game's own title keys here (`#HUD_Silencer`),
   * the same keys the OPTIONS rows use — so the browser resolves them
   * exactly as it resolves every other label.
   */
  attachments?: string[];
}

/** One slot of the loadout. */
interface MockSlot {
  number: number;
  label: string;
  weapons: MockWeapon[];
}

/** The budget the port works to. */
const BUDGET = 30000;

/** The size of the slot pool. */
const SLOT_LIMIT = 81;

// ---------------------------------------------------------------------------
// The rail: the weapon categories the player browses by
// ---------------------------------------------------------------------------

/**
 * The rail's seven entries.
 *
 * The port's keys (1..7) and the port's labels, verbatim. These are
 * NOT the HUD slots: the rail's key 4 is the rifles alone and the HUD
 * slot 4 holds the rifles AND the shotguns.
 */
const RAIL: Array<{ key: number; label: string }> = [
  { key: 1, label: 'Melee weapons' },
  { key: 2, label: 'Pistols' },
  { key: 3, label: 'SMGs' },
  { key: 4, label: 'Rifles' },
  { key: 5, label: 'Shotguns' },
  { key: 6, label: 'Special' },
  { key: 7, label: 'Player Accessory' },
];

// ---------------------------------------------------------------------------
// The game's own weapon table, by the rail's entry
// ---------------------------------------------------------------------------

/**
 * Rail 1 — the melee weapons.
 *
 * The order is the port's own: the HUD grid column, then the id. The
 * M61 Grenade is in the first column, so it is the first row — which is
 * how the port lists it, and the grenade is reachable because of it.
 */
const MELEE: MockWeapon[] = [
  { name: 'M61 Grenade', cost: 1000, slots: 7 },
  { name: 'Katana', cost: 2900, slots: 10 },
  { name: 'Combat Knife', cost: 100, slots: 1 },
  { name: 'Seal Knife', cost: 100, slots: 1 },
];

/**
 * Rail 2 — the pistols.
 *
 * The order is the port's own (the HUD grid column, then the id), which
 * puts the Beretta 92F last — it is in the ninth column of the grid.
 * The Golden Colts are NOT here: they are an akimbo weapon and they
 * live in the rail's Special entry.
 */
const PISTOLS: MockWeapon[] = [
  { name: 'Glock-18', cost: 850, slots: 10 },
  { name: 'SOCOM-MK23', cost: 700, slots: 10 },
  { name: 'Desert Eagle', cost: 1050, slots: 15 },
  { name: 'Five-seveN', cost: 1250, slots: 10 },
  { name: 'Glock-20C', cost: 1300, slots: 10 },
  { name: 'Ruger-MK1', cost: 1500, slots: 5 },
  { name: 'Raging Bull', cost: 2100, slots: 15 },
  { name: 'Contender G2', cost: 1500, slots: 15 },
  { name: 'Beretta 92F', cost: 900, slots: 10 },
];

/** Rail 3 — the SMGs. */
const SMGS: MockWeapon[] = [
  { name: 'Mini-Uzi', cost: 1300, slots: 20 },
  { name: 'MP5SD', cost: 2500, slots: 25 },
  { name: 'MP5K', cost: 1500, slots: 20 },
  { name: 'Skorpion', cost: 1100, slots: 15 },
  { name: 'MP7-PDW', cost: 2800, slots: 25 },
  { name: 'UMP', cost: 2300, slots: 30 },
];

/**
 * Rail 4 — the rifles.
 *
 * The port splits the HUD slot 4 by the game's own weapon kind, so
 * this list holds the rifles and the sniper rifle (the Barrett) and
 * NOT the shotguns — they are the rail's own entry. The USAS-12 is
 * here because the game's own `GetWeaponType` calls it a rifle.
 */
const RIFLES: MockWeapon[] = [
  { name: 'M4A1', cost: 4500, slots: 40 },
  { name: 'AK47', cost: 3000, slots: 40 },
  { name: 'STEYR-AUG', cost: 5000, slots: 30 },
  { name: 'Barrett M82A1', cost: 9000, slots: 70 },
  { name: 'M16A4', cost: 2500, slots: 40 },
  { name: 'M60E3', cost: 8000, slots: 70 },
  { name: 'USAS-12', cost: 5100, slots: 40 },
];

/**
 * Rail 5 — the shotguns.
 *
 * The rest of the HUD slot 4. The Sawed-Off is here because the game's
 * own `GetWeaponType` calls it a shotgun (the weapon table's `kind`
 * says pistol).
 */
const SHOTGUNS: MockWeapon[] = [
  { name: 'Benelli M3', cost: 3000, slots: 40 },
  { name: 'SPAS-12', cost: 2100, slots: 30 },
  { name: 'Mossberg 500', cost: 2500, slots: 40 },
  { name: 'Sawed-off', cost: 1900, slots: 20 },
];

/** Rail 6 — the akimbo weapons, and the Golden Colts. */
const SPECIAL: MockWeapon[] = [
  { name: 'Akimbo Berrettas', cost: 900, slots: 10 },
  { name: 'Akimbo MK23', cost: 700, slots: 10 },
  { name: 'Akimbo Mini-Uzi', cost: 1300, slots: 20 },
  { name: 'Golden Colts', cost: 2600, slots: 20 },
  { name: 'Akimbo Five-seveN', cost: 1250, slots: 10 },
  { name: 'Akimbo Skorpions', cost: 1100, slots: 15 },
];

/** The attachments, and what they cost. */
const ATTACHMENTS = [
  // The port's own labels: the game's title keys, the ones the
  // OPTIONS rows use.
  { key: '#HUD_Silencer', cost: 900 },
  { key: '#HUD_Lasersight', cost: 800 },
  { key: '#HUD_Flashlight', cost: 500 },
];

/**
 * The game's own titles — the entries the harness needs.
 *
 * The port prints TITLE KEYS (`#Buy_Random`, `#HUD_Silencer`), and
 * the browser resolves them through the game's own titles file, which
 * the engine holds: `services/buy-menu.ts` reads it out of the
 * engine's filesystem, and the engine resolves the very same keys.
 *
 * The harness has no engine, so it seeds the same file here — the
 * same keys, the game's own text, and the same parser — and a title
 * resolves in the harness exactly as it does in the game. This is the
 * mod's `ts/titles.txt`, verbatim.
 *
 * `Buy_ResetConfig` is the CLASSIC flow's own reset row: the classic
 * canvas menu keeps the game's title, and the harness shows the
 * modern flow only. The modern flow's clear row prints the design's
 * own word ("Clear"), which is not a title at all — the browser
 * passes a plain label through unchanged.
 */
const MOCK_TITLES = `
Buy_ResetConfig
{
Reset Config
}

Buy_Random
{
Random
}

Buy_PlayerAccessory
{
Player Accessory
}

HUD_Silencer
{
Silencer
}

HUD_Lasersight
{
Lasersight
}

HUD_Flashlight
{
Flashlight
}
`;

// Seed the titles before the first state is parsed, so the very first
// record already resolves its labels.
seedBuyTitles(MOCK_TITLES);

/**
 * The loadout of Loadout A — the mockup's example, to the dollar.
 *
 * A Combat Knife and a Katana in slot 1, and a Glock-18 with a
 * silencer and a lasersight ($2,550) next to a Desert Eagle in slot
 * 2. That is $6,600 of the $30,000 budget — the mockup's frame 1 says
 * "$23,400 left of $30,000" — and 36 of the 81 slots.
 *
 * The labels here are the CARDS' labels: the game's own HUD slots.
 * The rail's labels are the categories' (see RAIL).
 */
const LOADOUT_A: MockSlot[] = [
  {
    number: 1,
    label: 'Melee weapons',
    weapons: [
      { name: 'Combat Knife', cost: 100, slots: 1 },
      { name: 'Katana', cost: 2900, slots: 10 },
    ],
  },
  {
    number: 2,
    label: 'Pistols',
    weapons: [
      {
        name: 'Glock-18',
        cost: 2550,
        slots: 10,
        attachments: ['#HUD_Silencer', '#HUD_Lasersight'],
      },
      { name: 'Desert Eagle', cost: 1050, slots: 15 },
    ],
  },
  { number: 3, label: 'SMGs', weapons: [] },
  { number: 4, label: 'Rifles · Shotguns', weapons: [] },
  { number: 5, label: 'Special', weapons: [] },
];

/**
 * The loadout of the low-budget scenario.
 *
 * The mockup's frame 4: $1,950 left of $30,000 and 78 of the 81 slots
 * in use. The weapon set is the game's own; the slot counts are a
 * ruleset's, because the stock pool cannot be spent that fast.
 *
 * The modern flow has seven remove keys (10..16), so this synthetic
 * loadout has seven entries. It still fills all five weapon slots.
 */
const LOADOUT_LOW: MockSlot[] = [
  {
    number: 1,
    label: 'Melee weapons',
    weapons: [{ name: 'Katana', cost: 2900, slots: 10 }],
  },
  {
    number: 2,
    label: 'Pistols',
    weapons: [
      { name: 'Raging Bull', cost: 2100, slots: 10 },
      { name: 'Desert Eagle', cost: 1050, slots: 10 },
    ],
  },
  {
    number: 3,
    label: 'SMGs',
    weapons: [{ name: 'UMP', cost: 2400, slots: 20 }],
  },
  {
    number: 4,
    label: 'Rifles · Shotguns',
    weapons: [
      { name: 'Barrett M82A1', cost: 9000, slots: 13 },
      { name: 'M60E3', cost: 8000, slots: 14 },
    ],
  },
  {
    number: 5,
    label: 'Special',
    weapons: [{ name: 'Golden Colts', cost: 2600, slots: 1 }],
  },
];

/**
 * The loadout of the "poor" scenario — the melee list with a shortfall.
 *
 * The mockup's frame 4: the Katana out of reach, the Seal Knife
 * already owned and the Combat Knife focused.
 *
 * The slot 1 entry is the Seal Knife rather than the low scenario's
 * Katana, because the Katana is the row that must be OUT of reach: a
 * row the loadout holds is owned, and an owned row is never out of
 * reach (the port's own rule — buying it would take it off the
 * loadout, and that costs nothing).
 */
const LOADOUT_POOR: MockSlot[] = LOADOUT_LOW.map((slot) =>
  slot.number === 1
    ? { ...slot, weapons: [{ name: 'Seal Knife', cost: 100, slots: 1 }] }
    : slot,
);

/** The port's pages, as the port numbers them. */
const PAGE = {
  MAIN: 0,
  CATEGORY: 1,
  WEAPONS: 2,
  OPTIONS: 3,
  LOAD: 7,
};

/**
 * The number the port prints for a row keyed in the game's alphabet.
 *
 * The port's own key prefix: "1".."9", "0" for the key ten and "A"
 * for the key eleven. The attachments screen's rows are keyed 1–4, so
 * they carry their own key as their number.
 */
function keyPrefix(key: number): string {
  if (key >= 1 && key <= 9) return String(key);
  if (key === 10) return '0';
  if (key === 11) return 'A';
  return '-';
}

/**
 * The key a list's row takes.
 *
 * The port's own rule: a list's rows are keyed 1–9 and then 11, 12,
 * …, because the key 10 is the game's own back key and stays
 * reserved. The tenth weapon of a long list is therefore key 11.
 */
function browseKey(index: number): number {
  return index < 9 ? index + 1 : index + 2;
}

/**
 * The keycap the panel draws for a list's row.
 *
 * The port's own badge: the row's PLACE in the list and not its key.
 * The design's browse list is keyed 1–9 and then A (the tenth row),
 * and the letters carry on after it — so a slot with a dozen weapons
 * reads 1…9, A, B, C.
 */
function browseBadge(index: number): string {
  if (index <= 8) return String(index + 1);
  if (index <= 34) return String.fromCharCode(65 + (index - 9));
  // Past the alphabet the key is the badge, so the row is still identifiable.
  return String(browseKey(index));
}

/**
 * The state record.
 *
 * `key=value` pairs, separated by spaces — so a value cannot hold a
 * space. The screen's TITLE therefore comes from the page record
 * (`TSBUY page <id> <title>`), which takes the rest of the line.
 */
function stateRecord(fields: Record<string, string | number>): string {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  return `TSBUY state ${parts.join(' ')}`;
}

/** The slot records: the port's slots and what is in them. */
function slotRecords(slots: MockSlot[]): string[] {
  const out: string[] = [];
  for (const slot of slots) {
    const used = slot.weapons.reduce((n, w) => n + w.slots, 0);
    out.push(`TSBUY slot ${slot.number} ${used} ${slot.weapons.length} ${slot.label}`);
  }
  // The player accessory is slot 6 for the port's purposes, and it is
  // not one of the five weapon slots.
  out.push('TSBUY slot 6 0 0 Player Accessory');
  return out;
}

/**
 * How many of the five weapon slots hold something.
 *
 * The port's own count (`slots_in_use`): the weapon slots that hold
 * at least one weapon, counted the way the port counts them. The
 * player accessory (slot 6) is not one of the five.
 */
function slotsInUse(slots: MockSlot[]): number {
  return slots.filter((slot) => slot.number <= 5 && slot.weapons.length > 0).length;
}

/**
 * The config's entries.
 *
 * The modern entry record carries the attachment labels, the
 * weapon's classic slot, and the key that removes it. The classic
 * four-field shape is still parsed by the browser for the classic
 * flow, but this harness exercises the modern shape.
 *
 *   entry <index> <cost> <slots> <attachments> <slot> <remove_key> <name>
 *
 * The attachment field is a comma-separated list of the port's own
 * labels: the game's title keys, the same ones the OPTIONS rows use
 * (`#HUD_Silencer,#HUD_Lasersight`). The browser resolves them the
 * way it resolves every other label.
 */
function entryRecords(slots: MockSlot[]): string[] {
  const out: string[] = [];
  let index = 0;
  for (const slot of slots) {
    for (const weapon of slot.weapons) {
      const attachments = weapon.attachments?.join(',') ?? '';
      const removeKey = 10 + index;
      out.push(
        `TSBUY entry ${index} ${weapon.cost} ${weapon.slots} ${attachments} ${slot.number} ${removeKey} ${weapon.name}`,
      );
      index += 1;
    }
  }
  return out;
}

/** The loadout tabs — the config save slots. */
function tabRecords(count: number, active: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`TSBUY tab ${i} Loadout ${String.fromCharCode(65 + i)} ${i === active ? 1 : 0}`);
  }
  return out;
}

/**
 * The rail's rows.
 *
 * The port prints them dimmed, because they answer on the rail's own
 * page — the same way a parent column's row answers on the parent's
 * page in the classic menu.
 *
 * Their keys are the RAIL's keys (1..7), which are not the HUD slots:
 * the rail's key 5 is the shotguns and the HUD slot 5 is the akimbo
 * weapons. The port prints the rail's rows before the tabs' (both are
 * dimmed and both use the same keys), so a browser that finds the
 * rail's rows by their key finds the rail and not a tab.
 */
function railRows(): string[] {
  return RAIL.map(
    (entry) => `TSBUY row ${entry.key} 0 dim ${PAGE.CATEGORY} ${entry.key} ${entry.label}`,
  );
}

/** The loadout screen's rows: the accessory, random and clear. */
function actionRows(): string[] {
  return [
    `TSBUY row 6 0 0 ${PAGE.MAIN} 6 #Buy_PlayerAccessory`,
    `TSBUY row 7 0 0 ${PAGE.MAIN} R #Buy_Random`,
    // The port's MAIN page's own reset row is key EIGHT now, so that every
    // card's own digit opens its card (the card 4 digit used to wipe the
    // loadout instead). The panel draws the keycap the design asked for
    // ("X"), which is what the row's number field carries.
    //
    // The LABEL is the design's own word: the port prints "Clear" and
    // the browser passes a plain label through unchanged, so the row
    // says what the design says. The classic flow's canvas row keeps
    // the game's own "#Buy_ResetConfig" — the classic menu must not
    // change.
    `TSBUY row 8 0 0 ${PAGE.MAIN} X Clear`,
  ];
}

/**
 * The rows of a weapon list.
 *
 * The port's own numbering: the rows are keyed 1–9 and then 11, 12,
 * … — the key 10 is the game's own back key and stays reserved — and
 * the number the port prints is the row's PLACE in the list, so the
 * tenth weapon wears the design's "A".
 *
 * The flags are keyed by the port's key. The first nine rows keep the
 * keys they always had (1–9), so a flag on one of them is the same
 * flag as before.
 */
function weaponRows(weapons: MockWeapon[], flags: Record<number, string> = {}): string[] {
  return weapons.map((weapon, i) => {
    const key = browseKey(i);
    const number = browseBadge(i);
    const flag = flags[key] ?? '0';
    return `TSBUY row ${key} ${weapon.cost} ${flag} ${PAGE.WEAPONS} ${number} ${weapon.name}`;
  });
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

export interface MockScenario {
  /** Which screen the scenario shows. */
  screen: BuyMenuScreen;
  /** Which row state the scenario shows. */
  state: MockState;
  /** What the scenario is, for the harness's buttons. */
  label: string;
  /** The port's records, in the port's own format. */
  records: string[];
}

/** The loadout screen — the mockup's frame 1. */
function loadoutScenario(state: MockState): MockScenario {
  const slots = state === 'empty' ? LOADOUT_A.map((s) => ({ ...s, weapons: [] })) : LOADOUT_A;
  const low = state === 'low';
  const loadout = low ? LOADOUT_LOW : slots;
  const total = loadout.reduce((n, slot) => n + slot.weapons.reduce((m, w) => m + w.cost, 0), 0);
  const used = loadout.reduce((n, slot) => n + slot.weapons.reduce((m, w) => m + w.slots, 0), 0);
  const records = [
    stateRecord({
      open: 1,
      hidden: 0,
      page: PAGE.MAIN,
      budget: BUDGET,
      total: low ? 28050 : total,
      slots: low ? 78 : used,
      ammo_spend: 0,
      new: 0,
      cat: 0,
      pending: -1,
      att: 0,
      mode: 'modern',
      screen: 'loadout',
      slot: 0,
      tab: 0,
      slots_in_use: slotsInUse(loadout),
      slot_limit: SLOT_LIMIT,
    }),
    `TSBUY page ${PAGE.MAIN} BUY MENU`,
    ...slotRecords(loadout),
    ...tabRecords(state === 'tabs' ? 9 : 3, 0),
    ...actionRows(),
    ...entryRecords(loadout),
    'TSBUY end',
  ];
  return { screen: 'loadout', state, label: labelFor(state), records };
}

/** The browse screen — the mockup's frame 2. */
function browseScenario(state: MockState): MockScenario {
  const rifles = state === 'rifles';
  const shotguns = state === 'shotguns';
  const special = state === 'special';
  const smgs = state === 'smgs';
  const poor = state === 'poor';

  // The rail's entry the player is browsing: its key is the RAIL's key,
  // not the HUD slot, and the page's title is the entry's own name.
  const weapons = rifles
    ? RIFLES
    : shotguns
      ? SHOTGUNS
      : special
        ? SPECIAL
        : smgs
          ? SMGS
          : poor
            ? MELEE
            : PISTOLS;
  const railKey = rifles ? 4 : shotguns ? 5 : special ? 6 : smgs ? 3 : poor ? 1 : 2;
  const label = rifles
    ? 'Rifles'
    : shotguns
      ? 'Shotguns'
      : special
        ? 'Special'
        : smgs
          ? 'SMGs'
          : poor
            ? 'Melee weapons'
            : 'Pistols';

  // The low-budget scenarios are the ones with an unaffordable row.
  const low = poor || rifles;
  const loadout = poor ? LOADOUT_POOR : low ? LOADOUT_LOW : LOADOUT_A;
  const total = loadout.reduce((n, s) => n + s.weapons.reduce((m, w) => m + w.cost, 0), 0);
  const used = loadout.reduce((n, s) => n + s.weapons.reduce((m, w) => m + w.slots, 0), 0);

  const owned: number[] = [];
  const short: Array<[number, number]> = [];
  let rows: string[];

  if (poor) {
    // The mockup's frame 4: the melee list with the Katana out of
    // reach, the Seal Knife already owned and the Combat Knife
    // focused. The Katana carries the `x` flag — the port's own way
    // of saying the row cannot be bought — so the row is red, struck
    // through and its keycap dimmed.
    //
    // The rows are the port's own order: the M61 Grenade (1), the
    // Katana (2), the Combat Knife (3) and the Seal Knife (4).
    rows = weaponRows(weapons, { 3: 'on' });
    owned.push(4);
    short.push([2, 950]);
  } else if (rifles) {
    // The low budget again, this time in the rifles: the USAS-12 needs
    // $3,150 more. The rows the loadout holds — the Barrett and the
    // M60E3 — are the owned ones, because an owned row is never out of
    // reach (the port's own rule).
    rows = weaponRows(weapons, { 7: 'x' });
    owned.push(4, 6);
    short.push([7, 3150]);
  } else if (state === 'owned') {
    rows = weaponRows(weapons);
    owned.push(3);
  } else if (state === 'focused') {
    rows = weaponRows(weapons, { 1: 'on' });
  } else {
    rows = weaponRows(weapons);
  }

  const records = [
    stateRecord({
      open: 1,
      hidden: 0,
      page: PAGE.WEAPONS,
      budget: BUDGET,
      total: low ? 28050 : total,
      slots: low ? 78 : used,
      ammo_spend: 0,
      new: 0,
      cat: 0,
      pending: -1,
      att: 0,
      mode: 'modern',
      screen: 'browse',
      slot: railKey,
      tab: 0,
      slots_in_use: slotsInUse(loadout),
      slot_limit: SLOT_LIMIT,
    }),
    `TSBUY page ${PAGE.WEAPONS} ${label.toUpperCase()}`,
    ...slotRecords(loadout),
    ...tabRecords(3, 0),
    ...railRows(),
    ...rows,
    ...owned.map((key) => `TSBUY owned ${key} 1`),
    ...short.map(([key, amount]) => `TSBUY short ${key} ${amount}`),
    ...entryRecords(loadout),
    'TSBUY end',
  ];
  return { screen: 'browse', state, label: labelFor(state), records };
}

/** The attachment screen — the mockup's frame 3. */
function attachScenario(state: MockState): MockScenario {
  const selected = state === 'selected';
  const attachments = ATTACHMENTS.map((attachment, i) => {
    const key = i + 1;
    const on = selected && key <= 2 ? 'on' : '0';
    return `TSBUY row ${key} ${attachment.cost} ${on} ${PAGE.OPTIONS} ${keyPrefix(key)} ${attachment.key}`;
  });
  const gunCost = 850;
  const bundle = selected ? gunCost + ATTACHMENTS[0].cost + ATTACHMENTS[1].cost : gunCost;
  const records = [
    stateRecord({
      open: 1,
      hidden: 0,
      page: PAGE.OPTIONS,
      budget: BUDGET,
      total: 6600,
      slots: 36,
      ammo_spend: 0,
      new: 0,
      cat: 0,
      pending: 1,
      att: selected ? 3 : 0,
      mode: 'modern',
      screen: 'attach',
      slot: 2,
      tab: 0,
      slots_in_use: slotsInUse(LOADOUT_A),
      slot_limit: SLOT_LIMIT,
    }),
    `TSBUY page ${PAGE.OPTIONS} GLOCK-18`,
    ...slotRecords(LOADOUT_A),
    ...tabRecords(3, 0),
    `TSBUY row 0 ${gunCost} 0 ${PAGE.OPTIONS} - Glock-18`,
    ...attachments,
    `TSBUY row 6 ${bundle} 0 ${PAGE.OPTIONS} 6 Add to loadout`,
    `TSBUY sum ${bundle} ${BUDGET - 6600 - bundle}`,
    ...entryRecords(LOADOUT_A),
    'TSBUY end',
  ];
  return { screen: 'attach', state, label: labelFor(state), records };
}

/** What a state is called, for the harness's buttons. */
function labelFor(state: MockState): string {
  switch (state) {
    case 'default':
      return 'default';
    case 'focused':
      return 'a focused row';
    case 'owned':
      return 'an owned row';
    case 'poor':
      return "can't afford + shortfall";
    case 'selected':
      return 'selected attachments';
    case 'empty':
      return 'empty slots';
    case 'low':
      return 'low budget';
    case 'tabs':
      return 'all nine tabs';
    case 'smgs':
      return 'SMGs (rail 3)';
    case 'rifles':
      return 'rifles (rail 4)';
    case 'shotguns':
      return 'shotguns (rail 5)';
    case 'special':
      return 'special (rail 6)';
  }
}

/**
 * The scenarios the harness can show.
 *
 * Every screen, every row state: an affordable row, a focused row, an
 * owned row, an unaffordable row with a shortfall, a selected
 * attachment, an empty slot and a low budget.
 */
export const MOCK_SCENARIOS: MockScenario[] = [
  loadoutScenario('default'),
  loadoutScenario('empty'),
  loadoutScenario('low'),
  loadoutScenario('tabs'),
  browseScenario('default'),
  browseScenario('focused'),
  browseScenario('owned'),
  browseScenario('poor'),
  browseScenario('smgs'),
  browseScenario('rifles'),
  browseScenario('shotguns'),
  browseScenario('special'),
  attachScenario('default'),
  attachScenario('selected'),
];

/** The scenarios of one screen, in the order the harness lists them. */
export function mockScenarios(screen?: BuyMenuScreen): MockScenario[] {
  if (!screen) return MOCK_SCENARIOS;
  return MOCK_SCENARIOS.filter((s) => s.screen === screen);
}

/**
 * The port's records for a screen and a state.
 *
 * The default is the loadout screen with the mockup's example loadout
 * in it.
 */
export function mockBuyMenuRecords(opts: MockOptions = {}): string[] {
  const screen = opts.screen ?? 'loadout';
  const state = opts.state ?? 'default';
  const found =
    MOCK_SCENARIOS.find((s) => s.screen === screen && s.state === state) ??
    MOCK_SCENARIOS.find((s) => s.screen === screen) ??
    MOCK_SCENARIOS[0];
  return found.records;
}

/**
 * Push the records into the live parser.
 *
 * The SAME handler the engine's stdout uses, so the harness runs the
 * real parser and the real panel.
 */
export function applyMockBuyMenuRecords(opts: MockOptions = {}): void {
  feedBuyMenuRecords(mockBuyMenuRecords(opts));
}
