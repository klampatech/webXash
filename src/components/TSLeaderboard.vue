<script setup lang="ts">
/**
 * The global leaderboard.
 *
 * WHAT IT SHOWS
 * -------------
 * Three numbers per player, across the WHOLE fleet:
 *
 *   kills      the total kills the engine logged
 *   time seen  how long the registry observed the player online
 *   MVPs       the number of maps on which the player had the most kills
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * The registry's /api/leaderboard, which folds the game servers' kill
 * logs into a running board. The kill log is the engine's own record:
 *
 *   10/27/2026 - 15:53:37: "KYLE<12><STEAM_0:1:1><12>" killed "Bot Cypher 2507<2609><ID_BOT><2609>" with "m4a1"
 *
 * Bots are excluded — the <ID_BOT> authid is how they are told from a
 * person, and the fleet runs fifteen bots by default.
 *
 * THE TWO LABELS THAT ARE NOT OBVIOUS
 * -----------------------------------
 * "Time seen" is a LOWER BOUND, not a play time. The port has no
 * connected-time counter, so the registry can only measure the time it
 * happened to observe a player: a player who joins and leaves between
 * two polls contributes nothing. It is labelled "time seen" rather
 * than "time played" because a number that means something else under
 * a heading is a lie in a column heading.
 *
 * "MVPs" is DEFINED here, because TS 3.0 has no such concept: there
 * is no per-round winner, no best-player award, and no scoreboard
 * column for it. The rule is the deathmatch meaning of an MVP — the
 * most kills on a map — with the map as the window.
 */
import { ref, computed, onMounted } from 'vue';

interface LeaderboardPlayer {
  name: string;
  kills: number;
  mvps: number;
  timeSeen: number;
}

interface LeaderboardResponse {
  players: LeaderboardPlayer[];
  source?: string;
  timeSeenNote?: string;
  updatedAt?: number;
}

const ENDPOINT = 'api/leaderboard';

const players = ref<LeaderboardPlayer[]>([]);
const loading = ref(true);
const failed = ref(false);
const note = ref('');

/** The column the table is sorted by. */
type SortKey = 'kills' | 'timeSeen' | 'mvps';
const sortKey = ref<SortKey>('kills');
/** The direction. Kills lead by default, so descending. */
const sortDesc = ref(true);

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'kills', label: 'Kills' },
  { key: 'timeSeen', label: 'Time seen' },
  { key: 'mvps', label: 'MVPs' },
];

/** The rows, sorted. */
const rows = computed(() => {
  const sorted = [...players.value].sort((a, b) => {
    const delta = (b[sortKey.value] ?? 0) - (a[sortKey.value] ?? 0);
    // Ties break on the name, so the order does not shuffle between
    // two renders of the same data.
    return delta !== 0 ? delta : a.name.localeCompare(b.name);
  });
  return sortDesc.value ? sorted : sorted.reverse();
});

/** The minutes-and-seconds form for a time in seconds. */
function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function formatNumber(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}

/**
 * Sort by a column, toggling the direction when the same column is
 * chosen again.
 */
function sortBy(key: SortKey) {
  if (sortKey.value === key) {
    sortDesc.value = !sortDesc.value;
    return;
  }
  sortKey.value = key;
  // The first click on a new column sorts it biggest-first, which is
  // what a leaderboard is for.
  sortDesc.value = true;
}

/** The aria-sort value for a column header. */
function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none';
  return sortDesc.value ? 'descending' : 'ascending';
}

onMounted(async () => {
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as LeaderboardResponse;
    players.value = Array.isArray(body.players) ? body.players : [];
    note.value = body.timeSeenNote ?? '';
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="ts-lb">
    <div class="ts-lb__head">
      <h3 class="ts-lb__title">Leaderboard</h3>
      <span v-if="note" class="ts-lb__note">{{ note }}</span>
    </div>

    <p v-if="loading" class="ts-lb__empty">Reading the scoreboard…</p>

    <p v-else-if="failed" class="ts-lb__empty">
      The scoreboard could not be reached. The registry may be restarting.
    </p>

    <p v-else-if="!rows.length" class="ts-lb__empty">
      No one has scored yet. The board fills as the servers play.
    </p>

    <div v-else class="ts-lb__scroll">
      <table class="ts-lb__table">
        <thead>
          <tr>
            <th scope="col" class="ts-lb__rank">#</th>
            <th scope="col" class="ts-lb__name">Player</th>
            <th
              v-for="col in COLUMNS"
              :key="col.key"
              scope="col"
              class="ts-lb__num"
              :aria-sort="ariaSort(col.key)"
            >
              <button
                type="button"
                class="ts-lb__sort"
                @click="sortBy(col.key)"
              >
                {{ col.label }}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(player, i) in rows"
            :key="player.name"
            class="ts-lb__row"
            :class="{ 'ts-lb__row--first': i === 0 }"
          >
            <td class="ts-lb__rank">{{ i + 1 }}</td>
            <td class="ts-lb__name">{{ player.name }}</td>
            <td class="ts-lb__num">{{ formatNumber(player.kills) }}</td>
            <td class="ts-lb__num">{{ formatTime(player.timeSeen) }}</td>
            <td class="ts-lb__num ts-lb__num--accent">
              {{ formatNumber(player.mvps) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!loading && !failed && rows.length" class="ts-lb__foot">
      Across every server in the fleet. MVPs count the maps on which a
      player had the most kills.
    </p>
  </div>
</template>

<style scoped lang="scss">
/*
 * The leaderboard's own visual language, which the site already has:
 * the terminal palette (--ts-void, --ts-panel, --ts-edge, --ts-signal,
 * --ts-lime, --ts-ink-muted) and the same three fonts the rest of the
 * site uses. So the table reads as part of the site rather than as
 * something pasted in.
 */
.ts-lb {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.ts-lb__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.ts-lb__title {
  font-family: var(--ts-font-display);
  font-size: 1.5rem;
  font-weight: 400;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ts-lime);
  margin: 0;
}

.ts-lb__note {
  font-family: var(--ts-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ts-ink-muted);
}

.ts-lb__empty {
  font-family: var(--ts-font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  color: var(--ts-ink-muted);
  margin: 0;
  padding: 2rem 0;
  text-align: center;
}

.ts-lb__scroll {
  overflow-x: auto;
}

/* The table. */
.ts-lb__table {
  width: 100%;
  min-width: 30rem;
  border-collapse: collapse;
}

.ts-lb__table th {
  padding: 0.75rem 1rem;
  font-family: var(--ts-font-mono);
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ts-ink-muted);
  text-align: right;
  border-bottom: 2px solid var(--ts-signal);
  white-space: nowrap;
}

.ts-lb__table td {
  padding: 0.85rem 1rem;
  background: var(--ts-panel);
  border-bottom: 1px solid var(--ts-edge);
  text-align: right;
  font-family: var(--ts-font-mono);
  font-size: 0.85rem;
  color: var(--ts-ink);
}

.ts-lb__rank {
  text-align: left;
  width: 3.5rem;
  font-family: var(--ts-font-display);
  font-size: 1.2rem;
}

.ts-lb__name {
  text-align: left;
  font-family: var(--ts-font-body);
  font-weight: 700;
  color: var(--ts-lime);
}

/* The leading row: the site's accent rule, and the phosphor numbers. */
.ts-lb__row--first td {
  border-bottom-color: var(--ts-signal);
}

.ts-lb__row--first .ts-lb__rank,
.ts-lb__row--first .ts-lb__name {
  color: var(--ts-signal);
}

.ts-lb__num--accent {
  color: var(--ts-signal);
}

/* The sort buttons. */
.ts-lb__sort {
  all: unset;
  cursor: pointer;
  display: inline-block;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
}

.ts-lb__sort:hover,
.ts-lb__table th[aria-sort='descending'] .ts-lb__sort,
.ts-lb__table th[aria-sort='ascending'] .ts-lb__sort {
  color: var(--ts-lime);
}

.ts-lb__sort:focus-visible {
  outline: 3px solid var(--ts-lime);
  outline-offset: 3px;
}

.ts-lb__foot {
  font-family: var(--ts-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  color: var(--ts-ink-muted);
  margin: 0;
}
</style>
