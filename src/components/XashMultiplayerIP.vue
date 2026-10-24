<template>
  <div class="window no-resize multiplayer-config" name="Multiplayer">
    <div class="multiplayer-config__row multiplayer-config__enable">
      <label class="multiplayer-config__checkbox">
        <input
          id="multiplayer-enable"
          v-model="enabled"
          type="checkbox"
        />
        <span>Enable multiplayer (WebRTC + signaling server)</span>
      </label>
    </div>

    <template v-if="enabled">
      <div class="multiplayer-config__row">
        <label for="multiplayer-role">Mode</label>
        <select id="multiplayer-role" v-model="role">
          <option value="host">Host</option>
          <option value="guest">Join</option>
        </select>
      </div>
      <div class="multiplayer-config__row">
        <label for="multiplayer-server">Signaling server</label>
        <input
          id="multiplayer-server"
          v-model="server"
          type="text"
          placeholder="100.95.111.112:27016"
        />
      </div>
      <div class="multiplayer-config__row" v-if="role === 'guest'">
        <label for="multiplayer-room">Room ID</label>
        <input id="multiplayer-room" v-model="room" type="text" placeholder="default" />
      </div>
    </template>

    <div class="multiplayer-config__row multiplayer-config__hint">
      <InfoIcon @click="openHelp" />
      <span v-if="enabled">
        Host opens a room; both parties use the same signaling server &amp; room ID.
      </span>
      <span v-else>
        Disabled by default. Tick the box to enable WebRTC peer-to-peer multiplayer.
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import InfoIcon from './InfoIcon.vue';

// Multiplayer config kept in component-local state (not the store)
// because it's a per-launch setting, not persistent across sessions.
// On launch, the values are passed through window.__multiplayerConfig
// and read by XashLoader.

const DEFAULT_SERVER = '100.95.111.112:27016';

const enabled = ref(false);
const role = ref<'host' | 'guest'>('host');
const server = ref(DEFAULT_SERVER);
const room = ref('default');

const persist = () => {
  // Only persist a config object when multiplayer is enabled —
  // leaving it undefined tells XashLoader to use single-player.
  if (enabled.value) {
    (window as any).__multiplayerConfig = {
      role: role.value,
      server: server.value,
      room: room.value,
    };
  } else {
    delete (window as any).__multiplayerConfig;
  }
};

watch([enabled, role, server, room], persist, { immediate: true });

const openHelp = () => {
  window.open(
    'https://github.com/klampatech/webXash/blob/main/MULTIPLAYER.md',
    '_blank',
  );
};
</script>

<style scoped lang="scss">
.multiplayer-config {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  &__row {
    display: flex;
    align-items: center;
    gap: 0.5rem;

    label {
      flex: 0 0 auto;
      min-width: 110px;
      font-size: 0.85rem;
    }

    select,
    input {
      flex: 1;
    }
  }

  &__hint {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.6);
  }

  &__enable {
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding-bottom: 0.5rem;
    margin-bottom: 0.25rem;
  }

  &__checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    width: 100%;
  }
}
</style>