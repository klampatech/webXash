<template>
  <section class="ts-servers">
    <header class="ts-servers__head">
      <h2 class="ts-stamp">Server Browser</h2>
      <button
        class="ts-servers__refresh"
        :class="{ 'is-spinning': refreshing }"
        :disabled="refreshing"
        aria-label="Refresh server list"
        @click="refresh"
      >
        <span aria-hidden="true">⟳</span> Refresh
      </button>
    </header>

    <!-- Distinguish "no servers" from "could not ask" — they are
         different facts and collapsing them hides a broken endpoint. -->
    <p v-if="error" class="ts-servers__empty ts-servers__empty--error">
      {{ error }}
    </p>

    <p v-else-if="loading" class="ts-servers__empty">
      Scanning for servers…
    </p>

    <p v-else-if="!servers.length" class="ts-servers__empty">
      No servers answered.
      <span class="ts-servers__hint">
        Start one with <code>tools/port/tsp-rs/scripts/start-ts-server.sh</code>
      </span>
    </p>

    <ul v-else class="ts-servers__list" role="list">
      <li v-for="server in servers" :key="server.id" class="ts-panel ts-rule ts-server">
        <div class="ts-server__main">
          <h3 class="ts-server__name">{{ server.name }}</h3>
          <div class="ts-server__meta">
            <span class="ts-server__tag">{{ server.map }}</span>
            <span class="ts-server__tag">{{ server.mode }}</span>
          </div>
        </div>

        <!--
          The count, split.

          A2S reports `players` as humans PLUS bots, so "18 / 32" on the
          old row read as 18 players when it was really 16 bots and two
          people. The registry knows the real human count, so show both.
        -->
        <div class="ts-server__counts">
          <div class="ts-server__count">
            <span class="ts-server__count-value ts-server__count-value--humans">{{
              humansOf(server)
            }}</span>
            <span class="ts-server__count-label">human{{ humansOf(server) === 1 ? '' : 's' }}</span>
          </div>
          <div class="ts-server__count">
            <span class="ts-server__count-value ts-server__count-value--bots">{{
              botsOf(server)
            }}</span>
            <span class="ts-server__count-label">bots</span>
          </div>
          <div class="ts-server__count">
            <span class="ts-server__count-value ts-server__count-value--max">{{
              server.maxPlayers
            }}</span>
            <span class="ts-server__count-label">slots</span>
          </div>
        </div>

        <div class="ts-server__right">
          <span v-if="server.tickrate" class="ts-server__tick">
            {{ server.tickrate }}<i>tick</i>
          </span>
          <span class="ts-server__health" :class="healthClass(server)">
            {{ healthLabel(server) }}
          </span>
        </div>

        <button class="ts-server__join" @click="$emit('join', server)">
          Join
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { fetchServerList } from '/@/services/ts-server-list.ts';
import type { TsServer } from '/@/services/ts-server-list.ts';

const emit = defineEmits<{
  (e: 'join', server: TsServer): void;
  (e: 'servers', servers: TsServer[]): void;
}>();

const servers = ref<TsServer[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');

/**
 * How often the list refreshes itself.
 *
 * The landing page's top bar shows the live map and player count, and
 * that only works if the list is polled rather than fetched once.
 */
const POLL_MS = 20_000;
let poll: ReturnType<typeof setInterval> | undefined;

/** Real humans on the server. The registry knows; A2S does not. */
function humansOf(server: TsServer): number {
  return server.humans ?? server.players ?? 0;
}

/** Bots on the server. `players` is humans PLUS bots. */
function botsOf(server: TsServer): number {
  if (typeof server.bots === 'number') return server.bots;
  return Math.max(0, (server.players ?? 0) - humansOf(server));
}

/**
 * The health chip.
 *
 * Three different facts, and they must not collapse into one: a server
 * that is not answering is not the same as one that is answering badly,
 * and neither is the same as the registry's own data being stale.
 */
function healthClass(server: TsServer): string {
  if (server.stale) return 'is-stale';
  if (server.degrading) return 'is-degrading';
  if (server.responsive === false) return 'is-dead';
  return 'is-ok';
}

function healthLabel(server: TsServer): string {
  if (server.stale) return 'Stale';
  if (server.degrading) return 'Degraded';
  if (server.responsive === false) return 'No reply';
  return 'Ok';
}

async function refresh() {
  refreshing.value = true;
  error.value = '';
  try {
    servers.value = await fetchServerList();
    emit('servers', servers.value);
  } catch (e) {
    // Never fall back to placeholder rows here. A fabricated server that
    // a visitor can click is worse than an honest empty panel.
    servers.value = [];
    error.value = e instanceof Error ? e.message : 'Server list unavailable';
  } finally {
    refreshing.value = false;
    loading.value = false;
  }
}

onMounted(async () => {
  await refresh();
  poll = setInterval(refresh, POLL_MS);
});

onUnmounted(() => {
  if (poll) clearInterval(poll);
});
</script>

<style scoped lang="scss">
.ts-servers {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.7rem;
  }

  h2 {
    margin: 0;
    font-size: 1.05rem;
    color: var(--ts-lime);
  }

  &__refresh {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.32rem 0.7rem;
    font-family: var(--ts-font-mono);
    font-size: 0.78rem;
    color: var(--ts-khaki);
    background: transparent;
    border: var(--ts-edge-thin);
    cursor: pointer;
    transition: color var(--ts-sweep) var(--ts-ease),
      border-color var(--ts-sweep) var(--ts-ease);

    span {
      display: inline-block;
      font-size: 1rem;
      line-height: 1;
    }

    &:hover:not(:disabled) {
      color: var(--ts-signal);
      border-color: var(--ts-signal);
    }

    &.is-spinning span {
      animation: ts-spin 700ms linear infinite;
    }
  }

  &__empty {
    margin: 0;
    padding: 1.1rem;
    font-family: var(--ts-font-mono);
    font-size: 0.82rem;
    color: var(--ts-ink-muted);
    text-align: center;
  }

  &__empty--error {
    color: var(--ts-error);
    border: 1px solid var(--ts-edge);
  }

  &__hint {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.74rem;
    color: var(--ts-ink-muted);

    code {
      color: var(--ts-header);
      font-size: 0.72rem;
    }
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
}

.ts-server {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 1.1rem;
  padding: 0.85rem 1.1rem;
  transition: border-color var(--ts-sweep) var(--ts-ease);

  &:hover {
    border-color: var(--ts-khaki-deep);
  }

  &__name {
    margin: 0 0 0.35rem;
    font-family: var(--ts-font-display);
    font-size: 1.02rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--ts-ink-bright);
  }

  &__meta {
    display: flex;
    gap: 0.4rem;
  }

  &__tag {
    padding: 0.1rem 0.42rem;
    font-family: var(--ts-font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ts-header);
    background: rgba(0, 0, 0, 0.32);
    border: 1px solid var(--ts-edge);
  }

  /* ---- the split count ------------------------------------------------ */
  &__counts {
    display: flex;
    gap: 1.1rem;
  }

  &__count {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 3.1rem;
  }

  &__count-value {
    font-family: var(--ts-font-mono);
    font-size: 1.3rem;
    line-height: 1.1;

    /* Humans are the thing a visitor is here for, so they get the
       phosphor; the bots are context, so they stay muted. */
    &--humans {
      color: var(--ts-signal);
    }

    &--bots {
      color: var(--ts-ink-muted);
    }

    &--max {
      color: var(--ts-khaki-dim);
    }
  }

  &__count-label {
    margin-top: 0.15rem;
    font-family: var(--ts-font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ts-ink-faint);
  }

  /* ---- tickrate + health --------------------------------------------- */
  &__right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
  }

  &__tick {
    font-family: var(--ts-font-mono);
    font-size: 0.72rem;
    color: var(--ts-header);

    i {
      font-style: normal;
      margin-left: 0.28rem;
      font-size: 0.56rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--ts-ink-faint);
    }
  }

  &__health {
    padding: 0.08rem 0.4rem;
    font-family: var(--ts-font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    border: 1px solid var(--ts-edge);

    &.is-ok {
      color: var(--ts-signal);
      border-color: rgba(0, 255, 65, 0.35);
    }

    &.is-degrading {
      color: var(--ts-warn);
      border-color: rgba(255, 196, 77, 0.4);
    }

    &.is-dead,
    &.is-stale {
      color: var(--ts-error);
      border-color: rgba(255, 92, 92, 0.4);
    }
  }

  &__join {
    padding: 0.5rem 1.35rem;
    font-family: var(--ts-font-display);
    font-size: 0.92rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ts-void);
    background: var(--ts-signal);
    border: none;
    height: auto; /* immune to any future global button height rule */
    cursor: pointer;
    transition: background var(--ts-sweep) var(--ts-ease),
      transform 120ms var(--ts-ease);

    &:hover {
      background: var(--ts-signal-hot);
    }

    &:active {
      transform: translateY(1px);
    }
  }
}

@media (max-width: 720px) {
  .ts-server {
    grid-template-columns: 1fr auto;
    row-gap: 0.8rem;

    &__main {
      grid-column: 1 / -1;
    }

    &__right {
      align-items: flex-start;
    }
  }
}

@keyframes ts-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
