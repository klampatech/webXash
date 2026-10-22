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

    <p v-if="!servers.length && !loading" class="ts-servers__empty">
      No servers responded.
      <span class="ts-servers__hint">
        Start one with <code>tools/port/tsp-rs/scripts/start-ts-server.sh</code>
      </span>
    </p>

    <p v-if="loading" class="ts-servers__empty">Scanning…</p>

    <ul v-else class="ts-servers__list" role="list">
      <li v-for="server in servers" :key="server.id" class="ts-panel ts-reticle ts-server">
        <div class="ts-server__main">
          <h3 class="ts-server__name">{{ server.name }}</h3>
          <div class="ts-server__meta">
            <span class="ts-server__tag">{{ server.map }}</span>
            <span class="ts-server__tag">{{ server.mode }}</span>
          </div>
        </div>

        <div class="ts-server__right">
          <!-- A2S_PLAYERCOUNT / A2S_MAXPLAYERS, or "—" until wired. -->
          <div class="ts-server__count" :title="`${server.players} of ${server.maxPlayers} players`">
            <span class="ts-server__count-now">{{ server.players }}</span>
            <span class="ts-server__count-slash">/</span>
            <span class="ts-server__count-max">{{ server.maxPlayers }}</span>
          </div>
          <div class="ts-server__count-label">players</div>
        </div>

        <button class="ts-server__join" @click="$emit('join', server)">
          Join
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { fetchServerList } from '/@/services/ts-server-list.ts';
import type { TsServer } from '/@/services/ts-server-list.ts';

defineEmits<{ (e: 'join', server: TsServer): void }>();

const servers = ref<TsServer[]>([]);
const loading = ref(true);
const refreshing = ref(false);

async function refresh() {
  refreshing.value = true;
  servers.value = await fetchServerList();
  refreshing.value = false;
  loading.value = false;
}

onMounted(refresh);
</script>

<style scoped lang="scss">
.ts-servers {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.9rem;
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
    color: var(--ts-ink-dim);
    text-align: center;
  }

  &__hint {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.74rem;
    color: var(--ts-ink-faint);

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
  grid-template-columns: 1fr auto auto;
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

  &__right {
    text-align: right;
  }

  &__count {
    font-family: var(--ts-font-mono);
    line-height: 1;

    &-now {
      font-size: 1.5rem;
      color: var(--ts-lime);
    }

    &-slash {
      margin: 0 0.1rem;
      color: var(--ts-ink-faint);
    }

    &-max {
      font-size: 0.95rem;
      color: var(--ts-ink-dim);
    }
  }

  &__count-label {
    margin-top: 0.2rem;
    font-family: var(--ts-font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ts-ink-faint);
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

@keyframes ts-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>