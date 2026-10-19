<template>
  <div class="window no-resize multiplayer-config" name="Multiplayer">
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
    <div class="multiplayer-config__row multiplayer-config__hint">
      <InfoIcon @click="openHelp" />
      <span>
        Host opens a room; both parties use the same signaling server &amp; room ID.
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

const role = ref<'host' | 'guest'>('host');
const server = ref(DEFAULT_SERVER);
const room = ref('default');

const persist = () => {
  (window as any).__multiplayerConfig = {
    role: role.value,
    server: server.value,
    room: room.value,
  };
};

watch([role, server, room], persist, { immediate: true });

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
}
</style>