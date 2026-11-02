<template>
  <!--
    THE MODERN BUY PANEL — the redesign.

    A view over the port's buy-menu state and an input device for it,
    like the panel it replaces. The numbers (the budget, the prices,
    the slot counts) are the port's — it prints them — and every
    action is a key on the port's own state machine. The browser
    computes nothing about the loadout: it draws what the port says
    and sends keys.

    Three screens, one at a time (the design's second principle):

      loadout  the five slot cards, the loadout tabs, the rail
      browse   a slot rail, the slot's weapons, the live loadout
      attach   the chosen weapon, its attachments, the summary

    @keydown.stop / @keyup.stop — the keyboard must not reach the
    GAME. The engine registers its key listener on `window` in the
    bubble phase, so a digit typed in the DOM still runs `slot1` in
    the game. `stopPropagation()` (not `preventDefault()`) is the
    right tool: it stops the event before it reaches `window`, and the
    key's own default action still happens. `preventDefault()` would
    stop the character from being typed at all.
  -->
  <div
    ref="root"
    class="bm"
    tabindex="-1"
    role="dialog"
    aria-label="Buy menu"
    @keydown.stop="onKeydown"
    @keyup.stop
    @keypress.stop
  >
    <div class="bm__frame">
      <!-- ============ the header: the screen, the budget ============ -->
      <header class="bm__head" :class="{ 'bm__head--loadout': screen === 'loadout' }">
        <div class="bm__head-text">
          <h1 class="bm__title">{{ title }}</h1>
          <p class="bm__crumb">{{ crumb }}</p>
        </div>
        <div class="bm__budget">
          <p class="bm__budget-line">
            <b class="bm__money" :class="{ 'bm__money--low': lowBudget }">{{ money(remaining) }}</b>
            left of {{ money(budget) }}
            <span class="bm__dot">·</span>
            {{ slotsInUse }} of {{ WEAPON_SLOTS }} slots in use
            <span class="bm__dot">·</span>
            {{ poolText }}
          </p>
          <div class="bm__bar" role="img" :aria-label="barLabel">
            <i
              class="bm__bar-fill"
              :class="{ 'bm__bar-fill--low': lowBudget }"
              :style="{ width: barPercent + '%' }"
            />
          </div>
        </div>
      </header>

      <!-- ============ the body: one screen at a time ============ -->
      <div class="bm__body">
        <!-- No state yet: the port's commands only exist in a client
             build that carries them. -->
        <div v-if="!state.available" class="bm__notice">
          <p v-if="state.unsupported">
            This client build has no buy-menu bridge, so the panel has nothing to read. The
            game's own menu is being used instead.
          </p>
          <p v-else>Waiting for the game's buy menu…</p>
        </div>

        <!--
          The port's CLASSIC pages — the interim rendering, for a port
          that has not grown the modern flow yet (Phase B). The
          redesign's screens need the slot records the modern flow
          prints, so until it does, the panel draws the page as it
          is: the port's rows, in the port's order.
        -->
        <section v-else-if="!modern" class="bm__list-wrap">
          <ul class="bm__list">
            <li v-for="(row, i) in rows" :key="i" class="bm__list-row">
              <hr v-if="row.separator" class="bm__sep" />
              <button
                v-else
                class="bm__row"
                :class="rowClass(row)"
                type="button"
                :disabled="!row.key || row.dim"
                @click="activate(row)"
              >
                <span class="bm__key">{{ badge(row) }}</span>
                <span class="bm__row-label">{{ row.text }}</span>
                <span class="bm__row-price">{{ row.price ? money(row.price) : '' }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- ============ 1. the loadout ============ -->
        <section v-else-if="screen === 'loadout'" class="bm__split">
          <div class="bm__col bm__col--main">
            <!-- The loadout tabs are the config save slots. The port
                 prints them all; three are visible and the rest are
                 one click away. -->
            <div class="bm__tabrow">
              <button
                v-for="tab in visibleTabs"
                :key="tab.index"
                class="bm__tab"
                :class="{ 'bm__tab--on': tab.active }"
                type="button"
                @click="pickTab(tab)"
              >
                {{ tab.label }}
              </button>
              <button
                v-if="hiddenTabs.length"
                class="bm__tab bm__tab--more"
                type="button"
                @click="moreOpen = !moreOpen"
              >
                More
              </button>
              <span class="bm__autosave">Saves automatically</span>
            </div>

            <div v-if="moreOpen && hiddenTabs.length" class="bm__tabrow bm__tabrow--more">
              <button
                v-for="tab in hiddenTabs"
                :key="tab.index"
                class="bm__tab"
                :class="{ 'bm__tab--on': tab.active }"
                type="button"
                @click="pickTab(tab)"
              >
                {{ tab.label }}
              </button>
            </div>

            <div class="bm__cards">
              <article
                v-for="slot in weaponSlots"
                :key="slot.number"
                class="bm__card bm__card--slot"
                :class="{ 'bm__card--empty': !slot.weapons }"
              >
                <div class="bm__card-head">
                  <span class="bm__key">{{ slot.number }}</span>
                  <span class="bm__card-label">{{ slot.text }}</span>
                  <span v-if="!slot.weapons" class="bm__card-empty">Empty</span>
                  <button class="bm__ghost bm__ghost--sm" type="button" @click="openSlot(slot)">
                    + Add {{ slotNoun(slot) }}
                  </button>
                </div>
                <div v-if="slot.weapons" class="bm__items">
                  <button
                    v-for="entry in weaponsIn(slot)"
                    :key="entry.index"
                    class="bm__item"
                    type="button"
                    :aria-label="`Remove ${entry.name}`"
                    @click="removeEntry(entry)"
                  >
                    <span class="bm__item-name">{{ entry.name }}</span>
                    <span v-if="entry.attachments.length" class="bm__item-attachments">
                      <span v-for="attachment in entry.attachments" :key="attachment" class="bm__chip">
                        {{ attachment }}
                      </span>
                    </span>
                    <span class="bm__item-price">{{ money(entry.cost) }}</span>
                  </button>
                </div>
              </article>
            </div>
          </div>

          <!-- the rail: the accessory, and the two actions -->
          <aside class="bm__col bm__col--rail">
            <p class="bm__label">Also</p>
            <button
              v-if="accessory"
              class="bm__row bm__row--accessory"
              type="button"
              @click="openSlot(accessory)"
            >
              <span class="bm__key">{{ accessory.number }}</span>
              <span class="bm__row-label">{{ accessory.text }}</span>
            </button>
            <div class="bm__rail-actions">
              <button
                v-for="row in actionRows"
                :key="row.key"
                class="bm__ghost bm__ghost--flex"
                type="button"
                @click="activate(row)"
              >
                <span class="bm__key">{{ badge(row) }}</span>
                <span class="bm__action-label">{{ row.text }}</span>
              </button>
            </div>
            <p class="bm__hint">
              Press a slot number to browse it. A slot can hold several weapons while budget
              lasts. Click a weapon to remove it.
            </p>
          </aside>
        </section>

        <!-- ============ 2. browse a slot ============ -->
        <section v-else-if="screen === 'browse'" class="bm__split bm__split--browse">
          <!-- the slot rail: switch slots without going back -->
          <aside class="bm__col bm__col--slots">
            <p class="bm__label">Slots</p>
            <button
              v-for="slot in railSlots"
              :key="slot.number"
              class="bm__tab bm__tab--rail"
              :class="{ 'bm__tab--on': slot.number === state.slot }"
              type="button"
              @click="openSlot(slot)"
            >
              <b class="bm__rail-num">{{ slot.number }}</b>{{ slot.text }}
            </button>
            <p class="bm__hint">Switch slots without going back. No stacked menus.</p>
          </aside>

          <!-- the weapons, in two columns, keyed 1–9 then A -->
          <div class="bm__col bm__col--grid">
            <div class="bm__grid" :style="gridStyle">
              <button
                v-for="row in gridRows"
                :key="row.key"
                class="bm__row"
                :class="rowClass(row)"
                :style="rowStyle(row)"
                type="button"
                @click="activate(row)"
              >
                <span class="bm__key" :class="{ 'bm__key--dim': row.unaffordable }">{{ badge(row) }}</span>
                <span class="bm__row-label" :class="{ 'bm__row-label--x': row.unaffordable }">
                  {{ row.text }}
                </span>
                <span class="bm__row-price">
                  <span :class="{ 'bm__row-price--x': row.unaffordable }">{{
                    money(row.price)
                  }}</span>
                  <span v-if="isOwned(row)" class="bm__row-tag">· Owned</span>
                  <span v-if="shortfall(row)" class="bm__row-short">
                    Need {{ money(shortfall(row)!) }} more
                  </span>
                </span>
              </button>
            </div>
          </div>

          <!-- the live loadout, while buying -->
          <aside class="bm__col bm__col--loadout">
            <p class="bm__label">{{ activeTabLabel }}</p>
            <template v-for="slot in weaponSlots" :key="slot.number">
              <div
                class="bm__card bm__card--slim"
                :class="{
                  'bm__card--empty': !slot.weapons,
                  'bm__card--on': slot.number === state.slot,
                }"
              >
                <span class="bm__num">{{ slot.number }}</span>
                <span class="bm__row-label">
                  {{ slot.weapons ? namesIn(slot) : 'Empty' }}
                </span>
              </div>
              <!--
                The slot being bought into gets a dashed card of its
                own, right under it: the design says where the next
                weapon is going.
              -->
              <div
                v-if="slot.number === state.slot && slot.weapons"
                class="bm__card bm__card--slim bm__card--empty"
              >
                <span class="bm__num"></span>
                <span class="bm__muted">Adding a {{ slotNoun(slot) }}</span>
              </div>
            </template>
          </aside>
        </section>

        <!-- ============ 3. attachments ============ -->
        <section v-else class="bm__split">
          <div class="bm__col bm__col--main">
            <div class="bm__card bm__card--gun bm__card--on">
              <div class="bm__stack">
                <span class="bm__gun-name">{{ gunName }}</span>
                <span class="bm__hint">{{ gunNote }}</span>
              </div>
              <span class="bm__gun-price">{{ money(gunPrice) }}</span>
            </div>

            <p class="bm__label bm__label--spaced">Attachments (optional)</p>
            <button
              v-for="row in attachmentRows"
              :key="row.key"
              class="bm__row"
              :class="rowClass(row)"
              type="button"
              @click="activate(row)"
            >
              <span class="bm__key">{{ badge(row) }}</span>
              <span class="bm__row-label">{{ row.text }}</span>
              <span class="bm__row-price">
                {{ money(row.price) }}<template v-if="row.selected"> · Selected</template>
              </span>
            </button>
            <p class="bm__hint">
              Press a number again to unselect. Nothing is bought until you add the gun.
            </p>
          </div>

          <!-- the summary: what the gun and its attachments cost -->
          <aside class="bm__col bm__col--summary">
            <p class="bm__label">Summary</p>
            <div class="bm__card bm__card--stack">
              <div class="bm__sum-row">
                <span>{{ gunName }}</span>
                <span class="bm__muted">{{ money(gunPrice) }}</span>
              </div>
              <div v-for="row in selectedAttachments" :key="row.key" class="bm__sum-row">
                <span>{{ row.text }}</span>
                <span class="bm__muted">{{ money(row.price) }}</span>
              </div>
              <div class="bm__sum-row bm__sum-row--total">
                <b>Total</b>
                <b>{{ money(purchaseTotal) }}</b>
              </div>
            </div>
            <p v-if="hasPurchaseSummary" class="bm__hint">
              After adding: {{ money(remainingAfter) }} left
            </p>
          </aside>
        </section>
      </div>

      <!-- ============ the footer ============ -->
      <footer class="bm__foot">
        <!--
          The Clear confirmation.

          Clear empties the loadout and refunds it, and a mis-click
          loses a loadout — so it asks. Random does not: it can only
          replace what is there with something that fits the budget.
        -->
        <template v-if="confirming">
          <span class="bm__confirm-text">
            Clear this loadout? Everything in it is refunded.
          </span>
          <div class="bm__foot-actions">
            <button class="bm__ghost" type="button" @click="cancelConfirm()">Cancel</button>
            <button class="bm__go" type="button" @click="commitConfirm()">Enter · Clear</button>
          </div>
        </template>
        <template v-else>
          <span class="bm__hint">{{ footHint }}</span>
          <div class="bm__foot-actions">
            <button
              v-if="screen === 'loadout'"
              class="bm__ghost"
              type="button"
              @click="emit('close')"
            >
              <span class="bm__key bm__key--inline">B</span>Close
            </button>
            <button v-else class="bm__ghost" type="button" @click="back()">
              <span class="bm__key bm__key--inline">0</span>{{ backLabel }}
            </button>
            <button v-if="screen === 'loadout'" class="bm__go" type="button" @click="primary()">
              Enter · Deploy with {{ activeTabLabel }}
            </button>
            <button v-if="screen === 'attach'" class="bm__go" type="button" @click="primary()">
              Enter · Add to loadout · {{ money(purchaseTotal) }}
            </button>
          </div>
        </template>
      </footer>

      <!-- the toast: why an unaffordable row cannot be bought -->
      <div v-if="toastText" class="bm__toast" role="status">{{ toastText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  BUY_REMOVE_PAGE,
  buyMenuState,
  sendBuyKey,
  type BuyEntry,
  type BuyRow,
  type BuySlotInfo,
  type BuyTabInfo,
} from '/@/services/buy-menu.ts'

const props = defineProps<{
  /**
   * Where the panel's keys go.
   *
   * In the game they go to the port (`sendBuyKey`). The dev harness
   * passes its own, so the tester can see the keys the panel sends
   * without a game session.
   */
  sendKey?: (key: number, page?: number) => void
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** The port's state. The panel is a view of this and an input device for it. */
const state = buyMenuState

/** The five classic weapon slots. */
const WEAPON_SLOTS = 5

/** The key that goes back (the canvas's own "go back" row). */
const BACK_KEY = 10

/**
 * The key that commits the attachment screen.
 *
 * The attachments are keyed 1..5 on that screen, so the commit is
 * key 6 — the same key the game's own options page buys with.
 */
const COMMIT_KEY = 6

/** How many tabs the strip shows before the rest go behind "More". */
const VISIBLE_TABS = 3

// ---------------------------------------------------------------------------
// The port's data
// ---------------------------------------------------------------------------

/** The port is in the modern flow (the port grows it in Phase B). */
const modern = computed(() => state.mode === 'modern')

/**
 * Which screen the panel is drawing.
 *
 * Until the port grows the modern flow the panel draws the port's
 * classic page as a list of rows — the old panel's job, in the new
 * frame — so the menu keeps working in the meantime.
 */
const screen = computed(() => (modern.value ? state.screen : 'browse'))

const rows = computed(() => state.rows)
const slotInfos = computed(() => state.slotInfos)
const tabs = computed(() => state.tabs)

/** The five weapon slots. */
const weaponSlots = computed(() =>
  slotInfos.value.filter((s) => s.number >= 1 && s.number <= WEAPON_SLOTS),
)

/** The player accessory — slot 6, which is not one of the five. */
const accessory = computed(() => slotInfos.value.find((s) => s.number === 6))

/** The rail on the browse screen: the five slots and the accessory. */
const railSlots = computed(() => slotInfos.value.slice().sort((a, b) => a.number - b.number))

/** The slot numbers the port knows about. */
const slotNumbers = computed(() => new Set(slotInfos.value.map((s) => s.number)))

/**
 * The rows that belong to a slot.
 *
 * The port prints the rail's rows dimmed, because they answer on the
 * rail's own page — the same way a parent column's row answers on the
 * parent's page in the classic menu.
 */
const slotRows = computed(
  () => rows.value.filter((r) => r.dim && slotNumbers.value.has(r.key)),
)

/**
 * The screen's own rows: the things on this screen that can be
 * pressed.
 *
 * A dimmed row is the port's parent column — it answers on its own
 * page, so it is not this screen's row. A row that takes no key (the
 * attachment screen's chosen gun) is not pressable either.
 */
const ownRows = computed(() => rows.value.filter((r) => !r.dim && r.key !== 0))

/**
 * The loadout screen's rail: the two actions (Random and Clear).
 *
 * The accessory is drawn from the port's slot record (it is slot 6),
 * so the row that carries it is not drawn twice.
 */
const actionRows = computed(() =>
  ownRows.value.filter((r) => r.key !== (accessory.value?.number ?? 6)),
)

/** The browse screen's weapon list. */
const gridRows = computed(() => ownRows.value.filter((r) => r.key !== 0))

/**
 * The weapon grid's shape.
 *
 * Two columns, filled down the first and then down the second, so
 * the keys read down the columns: 1-5 on the left, 6-A on the right.
 *
 * The rows are placed by hand (see `placement`), because a row
 * that carries a shortfall needs a band of its own across the whole
 * list — the price and the amount missing do not fit on one line in
 * a 214px column.
 */
const gridStyle = computed(() => ({
  gridTemplateColumns: '1fr 1fr',
  gridTemplateRows: `repeat(${placement.value.bands}, auto)`,
}))

/**
 * Where every row of the browse list goes.
 *
 * The mockup's list is two columns, filled down the first and then
 * down the second, so the keys read down the columns: 1-5 on the
 * left, 6-A on the right. A row that cannot be afforded carries the
 * amount missing, and that has to sit on the price's line — the
 * mockup draws it that way in its row-states frame.
 *
 * "Katana", "$2,900" and "Need $950 more" do not fit on one line in
 * a 214px column, so such a row takes a band of its own across the
 * whole list, exactly as the mockup draws it. The rest of the list
 * keeps the mockup's two columns, and the keys keep their order:
 * the wide row stays where it falls in the sequence.
 */
const placement = computed(() => {
  const list = gridRows.value
  const spots: Record<number, { band: number; column: string }> = {}
  let band = 1
  let i = 0
  while (i < list.length) {
    // The run of ordinary rows before the next wide one.
    const start = i
    while (i < list.length && shortfall(list[i]) === undefined) i += 1
    const run = list.slice(start, i)
    const tall = Math.max(1, Math.ceil(run.length / 2))
    run.forEach((row, j) => {
      spots[row.key] = {
        band: band + (j % tall),
        column: j < tall ? '1' : '2',
      }
    })
    band += tall
    if (i < list.length) {
      // The row that cannot be afforded: a band of its own.
      spots[list[i].key] = { band, column: '1 / -1' }
      i += 1
      band += 1
    }
  }
  return { bands: Math.max(1, band - 1), spots }
})

/** Where one row of the browse list sits in the grid. */
function rowStyle(row: BuyRow): Record<string, string> {
  const spot = placement.value.spots[row.key]
  if (!spot) return {}
  return { gridRow: String(spot.band), gridColumn: spot.column }
}

/** The attachment screen's chosen weapon: the row that takes no key. */
const gunRow = computed(() => rows.value.find((r) => r.key === 0))

/** The attachment screen's toggles. */
const attachmentRows = computed(() => rows.value.filter((r) => r.key >= 1 && r.key <= 5))

/** The attachment screen's commit. */
const commitRow = computed(() => rows.value.find((r) => r.key === COMMIT_KEY))

/** The attachments that are on. */
const selectedAttachments = computed(() => attachmentRows.value.filter((r) => r.selected))

// ---------------------------------------------------------------------------
// The money and the slots — all of it the port's
// ---------------------------------------------------------------------------

const budget = computed(() => state.budget)

/** What the config costs, the ammo included — the canvas's own total. */
const spent = computed(() => state.total + state.ammoSpend)

/** What is left of the budget. */
const remaining = computed(() => budget.value - spent.value)

/** The budget bar: the share of the budget that is spent. */
const barPercent = computed(() => {
  if (!budget.value) return 0
  return Math.max(0, Math.min(100, (spent.value / budget.value) * 100))
})

/**
 * The budget is low.
 *
 * Under about a tenth of the budget left, the bar and the figure turn
 * amber. Informational only — the port decides what can be bought.
 */
const lowBudget = computed(() => budget.value > 0 && remaining.value / budget.value < 0.1)

/**
 * How many of the five weapon slots hold something.
 *
 * The port counts them (`slots_in_use`), and the port's count is the
 * one that is shown. The browser's own count is the fallback for a
 * state that does not carry one (the classic flow).
 */
const slotsInUse = computed(
  () =>
    state.slotsInUse ||
    weaponSlots.value.filter((s) => s.weapons > 0 || s.slots > 0).length,
)

/** The slot pool: how much of it the loadout takes, and how big it is. */
const poolText = computed(() =>
  state.slotLimit ? `${state.slots}/${state.slotLimit} slots` : `${state.slots} slots`,
)

const barLabel = computed(() => `${money(spent.value)} spent of ${money(budget.value)}`)

// ---------------------------------------------------------------------------
// The loadout, grouped by the slot the port says it is in
// ---------------------------------------------------------------------------

/**
 * The loadout's weapons, in the slot they are in.
 *
 * The modern entry record carries the entry's classic weapon slot, so
 * that is exactly what places it. The browser does not derive a slot
 * from the weapon or from the order of the records.
 *
 * The old four-field entry record has no slot. That is the classic
 * flow's shape, and it keeps the counting fallback below so the
 * classic menu does not change.
 */
const loadoutBySlot = computed(() => {
  const out = new Map<number, BuyEntry[]>()
  const slots = weaponSlots.value
  for (const slot of slots) out.set(slot.number, [])

  const entriesWithSlots = state.entries.filter(
    (entry) => entry.slot >= 1 && entry.slot <= WEAPON_SLOTS,
  )
  if (entriesWithSlots.length) {
    for (const entry of entriesWithSlots) {
      out.get(entry.slot)?.push(entry)
    }
    return out
  }

  // The classic record shape only. Count the entries into the slots
  // in the order the classic port printed them.
  let i = 0
  for (const slot of slots) {
    out.set(slot.number, state.entries.slice(i, i + slot.weapons))
    i += slot.weapons
  }
  // Anything the counts did not cover — a port that prints the entries
  // in another order — goes into the last slot rather than vanishing
  // from the panel.
  if (i < state.entries.length) {
    const last = slots[slots.length - 1]
    if (last) {
      out.set(last.number, [...(out.get(last.number) ?? []), ...state.entries.slice(i)])
    }
  }
  return out
})

function weaponsIn(slot: BuySlotInfo): BuyEntry[] {
  return loadoutBySlot.value.get(slot.number) ?? []
}

function namesIn(slot: BuySlotInfo): string {
  return weaponsIn(slot)
    .map((e) => e.name)
    .join(', ')
}

/**
 * The word the design uses for a slot's kind of weapon.
 *
 * "+ Add pistol" reads better than "+ Add", and the design's mockups
 * use a word per slot (melee, pistol, SMG, gun, item). The port
 * prints the slot's LABEL, which the game's own titles can rename,
 * so this is a lookup with a fallback rather than a table of truth:
 * a label the lookup does not know gets the neutral word, and the
 * button still says what it does.
 */
const SLOT_NOUNS: Array<[RegExp, string]> = [
  [/melee|grenade|sword|knife/i, 'melee'],
  [/pistol|handgun/i, 'pistol'],
  [/smg|submachine/i, 'SMG'],
  [/rifle|shotgun/i, 'gun'],
  [/special/i, 'item'],
]

function slotNoun(slot: BuySlotInfo): string {
  for (const [pattern, noun] of SLOT_NOUNS) {
    if (pattern.test(slot.text) || pattern.test(slot.label)) return noun
  }
  return 'weapon'
}

// ---------------------------------------------------------------------------
// The screens' headings
// ---------------------------------------------------------------------------

/** The slot the port is browsing. */
const currentSlot = computed(() => slotInfos.value.find((s) => s.number === state.slot))

/** The live loadout tab. */
const activeTab = computed(() => tabs.value.find((t) => t.active) ?? tabs.value[state.tab])

const activeTabLabel = computed(() => activeTab.value?.label ?? 'Loadout')

const visibleTabs = computed(() => tabs.value.slice(0, VISIBLE_TABS))
const hiddenTabs = computed(() => tabs.value.slice(VISIBLE_TABS))
const moreOpen = ref(false)

const gunName = computed(() => gunRow.value?.text ?? '')
const gunPrice = computed(() => gunRow.value?.price ?? 0)

/**
 * What the gun is added to, and next to what.
 *
 * The port's own loadout: the slot's weapons are the ones the port
 * says are in it.
 */
const gunNote = computed(() => {
  const slot = currentSlot.value
  if (!slot) return ''
  const pending = gunName.value.trim().toLowerCase()
  // The gun being added is not one of the slot's OTHER weapons.
  const others = weaponsIn(slot)
    .filter((entry) => entry.name.trim().toLowerCase() !== pending)
    .map((entry) => entry.name)
  const where = `Slot ${slot.number} (${slot.text})`
  return others.length ? `Added to ${where}, next to ${others.join(', ')}` : `Added to ${where}`
})

const title = computed(() => {
  if (!modern.value) return state.pageName || 'BUY MENU'
  if (state.screenTitle) return state.screenTitle
  if (screen.value === 'attach') return gunName.value.toUpperCase()
  if (screen.value === 'browse') return (currentSlot.value?.text ?? '').toUpperCase()
  return 'BUY MENU'
})

const crumb = computed(() => {
  if (!modern.value) return state.pageName || ''
  if (screen.value === 'loadout') return 'Slots match the in-game weapon slots'
  const slot = currentSlot.value
  const bits: string[] = []
  bits.push(slot ? `Slot ${slot.number} · Buy` : 'Buy')
  if (slot) bits.push(slot.text)
  if (screen.value === 'attach' && gunName.value) bits.push(gunName.value)
  return bits.join(' › ')
})

const footHint = computed(() => {
  if (!modern.value) return 'Click a row, or press its number · B closes the panel'
  if (screen.value === 'loadout') return 'Closing keeps your loadout. Nothing to confirm.'
  if (screen.value === 'browse')
    return 'Add as many as your budget allows. Pick a gun to choose attachments first.'
  return 'The game buys attachments first and the gun second. The menu hides that order.'
})

const backLabel = computed(() =>
  screen.value === 'attach'
    ? `Back to ${currentSlot.value?.text ?? 'the list'}`
    : 'Back to loadout',
)

// ---------------------------------------------------------------------------
// The attachment screen's total
// ---------------------------------------------------------------------------

/**
 * What the gun and its attachments cost.
 *
 * `TSBUY sum` is the port's number. The old commit row's price is the
 * fallback for a port that has not grown the sum record yet. The
 * browser does not add the gun and its attachments up itself.
 */
const purchaseTotal = computed(() => {
  if (state.hasPurchaseSummary) return state.pendingTotal
  return commitRow.value?.price ?? 0
})

/** What is left of the budget after the purchase — the port's number. */
const remainingAfter = computed(() => state.remainingAfterPurchase)
const hasPurchaseSummary = computed(() => state.hasPurchaseSummary)

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/**
 * The number the row is drawn with.
 *
 * The port reports it: the key's own prefix ("1".."9", "0" for key
 * 10, "A" for key 11), or a number of its own — the browse list's
 * rows carry the design's keycaps ("1".."9", then A, B, C).
 *
 * A row that carries no number of its own falls back to its key, in
 * the design's keycap alphabet.
 */
function badge(row: BuyRow): string {
  if (row.number) return row.number
  return keyBadge(row.key)
}

/**
 * The keycap a key draws.
 *
 * The design's alphabet: 1–9, then "0" for the game's own back key,
 * then the letters — "A" for the tenth row, "B" for the eleventh, and
 * so on.
 *
 * The port's browse rows skip the key 10, because it is the game's
 * own back key and stays reserved, so the tenth weapon of a long list
 * is the port's key 11 and wears the design's "A". The port prints
 * that badge itself, so this is the fallback for a row that carries
 * no number of its own.
 */
function keyBadge(key: number): string {
  if (key >= 1 && key <= 9) return String(key)
  if (key === 10) return '0'
  if (key >= 11 && key <= 36) return String.fromCharCode(65 + (key - 11))
  return ''
}

/** The row is already in the loadout. */
function isOwned(row: BuyRow): boolean {
  return state.owned[row.key] === true
}

/** How much more money the row needs — the port's number. */
function shortfall(row: BuyRow): number | undefined {
  const short = state.shortfalls[row.key]
  return typeof short === 'number' && short > 0 ? short : undefined
}

/** The row's state, as the design draws it. */
function rowClass(row: BuyRow): string[] {
  const classes: string[] = []
  if (row.selected) classes.push('bm__row--on')
  if (row.dim) classes.push('bm__row--dim')
  if (row.unaffordable) classes.push('bm__row--x')
  if (isOwned(row)) classes.push('bm__row--owned')
  // A row that cannot be afforded carries the amount missing, too.
  if (shortfall(row) !== undefined) classes.push('bm__row--wide')
  return classes
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

// ---------------------------------------------------------------------------
// The write path: keys, and only keys
// ---------------------------------------------------------------------------

function send(key: number, page?: number): void {
  if (props.sendKey) props.sendKey(key, page)
  else sendBuyKey(key, page)
}

/**
 * Press a row.
 *
 * A row carries its own key AND the page that key acts on, and the
 * click sends both: the port runs the same `handle_key` the canvas
 * menu runs.
 *
 * A row the player cannot afford buys nothing and says why — the
 * amount is the port's, from its `short` record.
 */
function activate(row: BuyRow): void {
  if (!row.key || row.dim) return
  /*
    The modern flow explains the refusal here: the row says what it
    would cost and how much more money it needs, and nothing is
    bought. The classic flow is the port's own menu, which refuses
    the key itself — so the key still goes.
  */
  if (modern.value && row.unaffordable) {
    toast(shortMessage(row))
    return
  }
  // Clear asks first (the design's rule): it empties the loadout and
  // refunds it, so a mis-click loses a loadout.
  if (modern.value && isClearRow(row)) {
    confirming.value = true
    return
  }
  confirming.value = false
  send(row.key, row.page)
}

/**
 * The row that clears the loadout.
 *
 * The port prints the row and its label; the label is the game's own
 * text, and the design's keycap for it is "X". So the row is found
 * by what it says ("Clear", "Reset") or by the keycap the port drew
 * for it — never by a hardcoded key number, which would be the
 * browser's own idea of the port's pages.
 */
function isClearRow(row: BuyRow): boolean {
  if (/clear|reset|wipe/i.test(row.text)) return true
  return badge(row).toLowerCase() === 'x'
}

/** The Clear confirmation is up. */
const confirming = ref(false)

function cancelConfirm(): void {
  confirming.value = false
}

/** Yes: send the Clear row's key, which is the port's own. */
function commitConfirm(): void {
  const row = ownRows.value.find((r) => isClearRow(r))
  confirming.value = false
  if (row) send(row.key, row.page)
}

/** Open a slot: the port's own page answers, or its current one. */
function openSlot(slot: BuySlotInfo): void {
  const row = slotRows.value.find((r) => r.key === slot.number)
  if (row) {
    send(row.key, row.page)
    return
  }
  send(slot.number)
}

/**
 * Remove a weapon from the loadout.
 *
 * The entry record carries the key that removes it, and the port's
 * remove page is where that key acts. The browser still sends only a
 * key; it never edits a loadout itself.
 */
function removeEntry(entry: BuyEntry): void {
  if (!entry.removeKey) return
  send(entry.removeKey, BUY_REMOVE_PAGE)
}

/** Switch the live loadout tab — the port's config save slot. */
function pickTab(tab: BuyTabInfo): void {
  const row = rows.value.find((r) => r.text.toLowerCase() === tab.label.toLowerCase())
  if (row) {
    send(row.key, row.page)
    return
  }
  send(tab.index + 1)
}

/** Go back: the port's own "go back" key. */
function back(): void {
  send(BACK_KEY)
}

/**
 * The screen's primary action.
 *
 * Loadout: deploy. With apply-on-purchase the loadout is already
 * live, so deploying is the port's close action.
 *
 * Browse: confirm the focused row.
 *
 * Attach: add the gun and its attachments.
 */
function primary(): void {
  if (confirming.value) {
    commitConfirm()
    return
  }
  if (screen.value === 'attach') {
    const row = commitRow.value
    if (row) send(row.key, row.page)
    else send(COMMIT_KEY, attachmentRows.value[0]?.page)
    return
  }
  if (screen.value === 'browse') {
    const focused = rows.value.find((r) => r.selected && r.key)
    if (focused) activate(focused)
    return
  }
  send(BACK_KEY)
}

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

/**
 * The row a typed key names, if there is one.
 *
 * Only the screen's OWN rows: the rail's rows are dimmed, and they
 * draw the same badges as the weapon list (slot 2's rail row and the
 * second weapon both draw "2"), so a typed "2" must not answer on
 * the rail.
 */
function rowForBadge(ch: string): BuyRow | undefined {
  return ownRows.value.find((r) => badge(r).toLowerCase() === ch)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  // The HUD owns B and Escape: they open and close the panel.
  if (key === 'b' || key === 'escape') return
  if (key === 'enter') {
    // The browser's own "activate the focused button" would fire a
    // click on top of this. `preventDefault()` here stops THAT — it is
    // not what keeps the key from the game (that is `@keydown.stop`).
    e.preventDefault()
    primary()
    return
  }
  const row = rowForBadge(key)
  if (row) {
    activate(row)
    return
  }
  if (key >= '0' && key <= '9') {
    const n = key === '0' ? BACK_KEY : Number(key)
    const slot = slotRows.value.find((r) => r.key === n)
    if (slot) send(slot.key, slot.page)
    else send(n)
  }
}

/**
 * The belt to the panel's `@keydown.stop`.
 *
 * The engine's key listener is on `window` in the bubble phase, and
 * the panel's own handler only runs while the panel has the focus.
 * This one is registered in the capture phase on `window`, so it runs
 * before the engine's, and it stops the keys the panel owns from ever
 * reaching the game.
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (root.value && root.value.contains(e.target as Node)) return
  const key = e.key.toLowerCase()
  if (key === 'b' || key === 'escape') return
  e.stopImmediatePropagation()
  onKeydown(e)
}

// ---------------------------------------------------------------------------
// The toast
// ---------------------------------------------------------------------------

const toastText = ref('')
let toastTimer: number | null = null

function toast(text: string): void {
  toastText.value = text
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastText.value = ''
    toastTimer = null
  }, 5000)
}

function shortMessage(row: BuyRow): string {
  const short = shortfall(row)
  if (short) return `Not enough money. ${row.text} needs ${money(short)} more.`
  return `Not enough money. ${row.text} is out of reach.`
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const root = ref<HTMLElement | null>(null)

function focusPanel(): void {
  root.value?.focus({ preventScroll: true })
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, { capture: true })
  focusPanel()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, { capture: true })
  if (toastTimer !== null) window.clearTimeout(toastTimer)
})

// The panel takes the focus when it opens, so the keys it owns reach
// it and stop there.
watch(
  () => state.open,
  (open) => {
    if (open) focusPanel()
  },
)
</script>

<style scoped>
/*
  THE LOOK

  The design's own tokens (the mockup's §9): the same gold-on-dark
  family the game's menu already has, one shade rounder and flatter.
  Barlow Condensed for the headings, Inter for the UI, and the system
  fonts if they cannot be loaded — the mockup's own instruction is to
  keep the layout and swap the fonts.
*/
.bm {
  --bg: #14110d;
  --card: #1f1a13;
  --card-2: #262016;
  --focus: #2a2216;
  --border: #33291d;
  --border-soft: #4a3d2b;
  --text: #f2e9d8;
  --muted: #b3a68e;
  --accent: #f2b84b;
  --cant: #ff8a73;
  --cant-border: #5a2a22;
  --cant-bg: #2a1713;
  --low: #ffb35a;
  --bar-bg: #2a241b;

  position: absolute;
  inset: 0;
  z-index: 1001;
  display: flex;
  align-items: center;
  justify-content: center;
  /*
    The layer's padding is a variable so the dev harness can drop it
    and get the mockup's own frame size (960 x 620, padding
    included) for a side-by-side comparison.
  */
  padding: var(--bm-pad, 24px);
  /* The layer takes no clicks; the frame inside it does. */
  pointer-events: none;
  font-family: Inter, 'Helvetica Neue', system-ui, -apple-system, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

/*
  The panel brings its own box sizing.

  The app's reset (assets/base.css) sets it globally, but the panel is
  also mounted by the dev harness, on a page that has no reset — and
  a panel that is 56px wider than its frame is a panel that overflows
  it.
*/
.bm,
.bm *,
.bm *::before,
.bm *::after {
  box-sizing: border-box;
}

.bm:focus {
  outline: none;
}

.bm__frame {
  pointer-events: auto;
  position: relative;
  width: var(--bm-w, min(960px, 96vw));
  height: var(--bm-h, min(620px, 92vh));
  display: flex;
  flex-direction: column;
  gap: 18px;
  /*
    The border is inside the frame's box, so 27px of padding puts the
    content 28px from the outside edge — the mockup's geometry.
  */
  padding: 27px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.75);
}

/* ---- the header ---- */
.bm__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.bm__title {
  margin: 0;
  font-family: 'Barlow Condensed', 'Oswald', 'Arial Narrow', sans-serif;
  font-weight: 700;
  font-size: 30px;
  letter-spacing: 0.12em;
  color: var(--accent);
  text-transform: uppercase;
}

/*
  The loadout's title is 40px in the mockup. Its height is part of the
  frame's layout: with the 30px title the five slot cards do not fit
  above the pinned footer.
*/
.bm__head--loadout .bm__title {
  margin: 4px 0 12px;
  font-size: 40px;
  line-height: 1.125;
}

.bm__crumb {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.bm__head--loadout .bm__crumb {
  line-height: 1.6;
}

.bm__budget {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.bm__budget-line {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}

.bm__money {
  color: var(--text);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.bm__money--low {
  color: var(--low);
}

.bm__dot {
  padding: 0 4px;
}

.bm__bar {
  width: 260px;
  height: 6px;
  background: var(--bar-bg);
  border-radius: 3px;
  overflow: hidden;
}

.bm__bar-fill {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.15s linear;
}

.bm__bar-fill--low {
  background: var(--low);
}

/* ---- the body ---- */
.bm__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.bm__split {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  gap: 12px;
}

.bm__col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  min-width: 0;
}

.bm__col--main {
  flex: 1;
  min-width: 0;
}

.bm__col--rail {
  width: 250px;
  flex: none;
}

.bm__col--slots {
  width: 210px;
  flex: none;
}

.bm__col--summary {
  width: 300px;
  flex: none;
}

.bm__col--loadout {
  width: 230px;
  flex: none;
}

.bm__col--grid {
  flex: 1;
  min-width: 0;
}

/* ---- the labels ---- */
.bm__label {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.bm__label--spaced {
  margin-top: 6px;
}

.bm__hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.bm__muted {
  color: var(--muted);
  font-weight: 400;
}

/* ---- the tabs ---- */
.bm__tabrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.bm__tabrow--more {
  flex-wrap: wrap;
}

.bm__tab {
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.bm__tab:hover {
  color: var(--text);
  border-color: var(--border-soft);
}

.bm__tab--on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}

.bm__tab--on:hover {
  color: var(--bg);
}

.bm__tab--more {
  padding: 0 12px;
}

.bm__tab--rail {
  text-align: left;
  width: 100%;
}

.bm__rail-num {
  margin-right: 10px;
}

.bm__autosave {
  margin-left: auto;
  color: var(--muted);
  font-size: 13px;
}

/* ---- the cards ---- */
.bm__cards {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bm__card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 10px 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.bm__card--slot {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 8px 10px;
  /*
    The mockup's first two cards shrink to make room for all five.
    Their extra rows are clipped by the next card, while the three
    empty cards stay one line tall.
  */
  flex: 0 1 auto;
}

.bm__card--slim {
  min-height: 40px;
  padding: 8px 10px;
  flex: none;
}

.bm__card--stack {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.bm__card--gun {
  flex: none;
}

.bm__card--on {
  border-color: var(--accent);
}

.bm__card--empty {
  border-style: dashed;
}

.bm__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bm__card-label {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.bm__card-head .bm__ghost {
  margin-left: auto;
}

.bm__card-empty {
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
}

.bm__items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bm__item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  padding: 0 14px;
  background: var(--card-2);
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.bm__item:hover {
  border-color: var(--border-soft);
}

.bm__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.bm__item-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 600;
}

.bm__item-price {
  margin-left: auto;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.bm__item-attachments {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bm__chip {
  padding: 3px 10px;
  border-radius: 12px;
  background: var(--border);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.bm__num {
  width: 24px;
  color: var(--muted);
  font-size: 12px;
}

.bm__stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.bm__gun-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 16px;
  font-weight: 600;
}

.bm__gun-price {
  margin-left: auto;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

/* ---- the rows ---- */
.bm__row {
  /* A grid, so the name and the price block keep their own columns. */
  display: grid;
  grid-template-columns: auto minmax(min-content, 1fr) minmax(0, 0.9fr);
  align-items: center;
  column-gap: 12px;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 0 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.bm__row:hover {
  border-color: var(--border-soft);
}

/*
  A row that cannot be afforded carries the amount missing as well as
  the price, and the two sit on one line: the mockup draws them that
  way ("$2,900  Need $950 more"). Such a row is a band of its own
  across the whole list, so the price can have the room it needs
  instead of a share of the row.
*/
.bm__row--wide {
  grid-template-columns: auto minmax(min-content, 1fr) minmax(0, auto);
}

.bm__row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.bm__row--on {
  border-color: var(--accent);
  background: var(--focus);
}

.bm__row--owned {
  background: var(--card-2);
}

.bm__row--dim {
  opacity: 0.7;
}

.bm__row--x {
  border-color: var(--cant-border);
}

/*
  The label takes the space that is left and wraps in it.

  A weapon name is not something to cut: "SOCOM-MK23" and
  "SOCOM-M…" are not the same row to a player, and the design's own
  mockups wrap the name rather than truncating it. The row grows a
  line instead.

  The floor is min-content, so the name keeps at least one whole
  word. Without it the name is the only thing in the row that can
  give way, and a long price next to it squeezes "Katana" into a
  column of single letters.
*/
.bm__row-label {
  min-width: min-content;
  overflow-wrap: break-word;
}

.bm__row--accessory {
  grid-template-columns: auto minmax(0, 1fr);
}

.bm__row-label--x,
.bm__row-price--x {
  color: var(--cant);
  text-decoration: line-through;
}

/*
  The price and its state share the price line. The shortfall belongs
  to the price, never to the weapon's name. A narrow browse row may
  wrap the price block, but it stays in the price column.
*/
.bm__row-price {
  min-width: 0;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: flex-end;
  column-gap: 6px;
  row-gap: 1px;
  color: var(--muted);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/*
  The tag after the price: "· Owned", "· Need $950 more".

  It is the row's state, so it takes the row's colour — but it is NOT
  struck through: only the price is, and the reason the row is out of
  reach has to stay readable.
*/
.bm__row-tag {
  color: var(--muted);
}

/* The shortfall is on the price line, in the cannot-afford colour. */
.bm__row-short {
  color: var(--cant);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  min-width: 0;
  text-align: right;
}

.bm__row-tag--x {
  color: var(--cant);
}

/* the keycap */
.bm__key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: var(--border);
  color: var(--accent);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
}

.bm__key--inline {
  margin-right: 8px;
}

.bm__key--dim {
  opacity: 0.55;
}

/* ---- the grid ---- */
.bm__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  /*
    The rows are placed by hand (the panel knows which row cannot be
    afforded, and that row needs a band of its own), so the grid's
    own flow does not decide anything.
  */
  grid-auto-flow: row;
  gap: 8px;
  align-content: start;
  overflow-y: auto;
  padding-right: 4px;
}

/* ---- the summary ---- */
.bm__sum-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
}

.bm__sum-row--total {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

/* ---- the buttons ---- */
.bm__ghost {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.bm__ghost:hover {
  border-color: var(--accent);
}

.bm__ghost--sm {
  min-height: 32px;
  padding: 0 12px;
  font-size: 13px;
}

.bm__ghost--flex {
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.bm__action-label {
  line-height: 1.2;
}

.bm__col--rail > .bm__hint {
  font-size: 13px;
  line-height: 1.6;
}

.bm__rail-actions {
  display: flex;
  gap: 8px;
}

.bm__go {
  min-height: 48px;
  padding: 0 28px;
  background: var(--accent);
  border: 0;
  border-radius: 8px;
  color: var(--bg);
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.bm__go:hover {
  filter: brightness(1.06);
}

/* ---- the footer ---- */
.bm__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex: none;
}

/* the hint gives way first: the buttons are the way out of here */
.bm__foot > .bm__hint {
  flex: 1 1 auto;
  min-width: 0;
}

.bm__foot-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}

.bm__confirm-text {
  color: var(--text);
  font-size: 14px;
}

/* ---- the toast ---- */
.bm__toast {
  position: absolute;
  left: 50%;
  bottom: 92px;
  transform: translateX(-50%);
  padding: 10px 16px;
  background: var(--cant-bg);
  border: 1px solid var(--cant-border);
  border-radius: 10px;
  color: var(--cant);
  font-size: 13px;
  white-space: nowrap;
}

/* ---- the notice ---- */
.bm__notice {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

/* ---- the port's classic page (the interim rendering) ---- */
.bm__list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.bm__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bm__list-row {
  margin: 0;
}

.bm__sep {
  border: none;
  border-top: 1px solid var(--border);
  margin: 6px 0;
}

.bm__row:disabled {
  cursor: default;
  opacity: 0.7;
}

/* The panel scrolls inside a short frame. */
.bm__cards,
.bm__grid {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
</style>
