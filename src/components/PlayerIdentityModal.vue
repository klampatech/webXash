<template>
  <div v-if="open" class="ident" role="dialog" aria-label="Choose your player">
    <div class="ident__panel">
      <header class="ident__head">
        <h2 class="ident__title">Before you join</h2>
        <button
          v-if="dismissible"
          class="ident__close"
          type="button"
          aria-label="Close"
          @click="close"
        >
          ✕
        </button>
      </header>

      <p class="ident__lede">
        Pick the name you play under and the character you spawn as. You
        can change both mid-match with <kbd>Esc</kbd>.
      </p>

      <label class="ident__row">
        <span class="ident__label">Name</span>
        <input
          ref="nameInput"
          v-model="name"
          class="ident__input"
          type="text"
          maxlength="24"
          spellcheck="false"
          autocomplete="off"
          @keyup.enter="commit"
        />
      </label>

      <!--
        THE CHARACTER PICKER.

        The portraits are the character's own art: the game's painted
        portrait for the seven characters it draws, and a uniform render
        of the model for the nine it does not. The component is shared
        with the ESC options overlay, so the two menus cannot disagree
        about which characters exist.

        The choice is NOT applied on the click. This modal is a form:
        the model is set when the player commits with "Join as ...", and
        it rides out on the launch arguments, so the server learns it
        with the connect. Clicking a portrait here chooses; it does not
        change the running game (there isn't one yet).
      -->
      <div class="ident__row ident__row--models">
        <span class="ident__label">Character</span>
        <CharacterPicker
          :model="model"
          label="Character model"
          @select="selectModel"
        />
      </div>

      <label class="ident__remember">
        <input v-model="remember" type="checkbox" />
        <span>Remember me — don't ask again</span>
      </label>

      <div class="ident__actions">
        <button
          v-if="dismissible"
          class="ident__btn"
          type="button"
          @click="close"
        >
          Cancel
        </button>
        <button class="ident__btn ident__btn--go" type="button" @click="commit">
          Join as {{ name.trim() || 'Specialist' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import CharacterPicker from '/@/components/CharacterPicker.vue';
import {
  applyModel,
  applyName,
  displayName,
  engineModel,
  loadSavedIdentity,
  refreshIdentity,
  saveIdentity,
} from '/@/services/player-identity';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** Can the player back out of it? The landing-page flow cannot. */
    dismissible?: boolean;
  }>(),
  { dismissible: false },
);

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'close'): void }>();

const name = ref('');
const model = ref('');
const remember = ref(true);
const nameInput = ref<HTMLInputElement | null>(null);

function close() {
  emit('close');
}

/**
 * Choose a character.
 *
 * The click only CHOOSES. The model is applied on commit, because the
 * commit is what sends the launch arguments — and the launch
 * arguments are what the server sees with the connect.
 */
function selectModel(m: string) {
  model.value = m;
}

async function prepare() {
  // A saved identity wins over the engine's defaults: it is the
  // player's explicit choice from last time.
  const saved = loadSavedIdentity();
  remember.value = saved.remember !== false;
  await refreshIdentity();
  name.value = saved.name || displayName.value;
  model.value = saved.model || engineModel.value;
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void prepare();
  },
  { immediate: true },
);

function commit() {
  applyName(name.value);
  if (model.value) applyModel(model.value);
  saveIdentity({ remember: remember.value });
  emit('confirm');
}
</script>

<style scoped lang="scss">
.ident {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(1, 10, 4, 0.88);
  z-index: 40;

  &__panel {
    width: min(30rem, 92vw);
    max-height: 90vh;
    overflow-y: auto;
    padding: 1.3rem 1.4rem 1.4rem;
    background: var(--ts-panel, #06150a);
    border: 1px solid rgba(0, 255, 65, 0.32);
    box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.65);
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  &__title {
    margin: 0;
    font-family: var(--ts-font-display);
    font-size: 1.25rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ts-lime);
  }

  &__close {
    background: none;
    border: 1px solid rgba(0, 255, 65, 0.32);
    color: var(--ts-ink);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.1rem 0.4rem;

    &:hover {
      border-color: var(--ts-lime);
      color: var(--ts-lime);
    }
  }

  &__lede {
    margin: 0 0 1rem;
    font-size: 0.85rem;
    line-height: 1.55;
    color: var(--ts-ink-muted);

    kbd {
      font-family: var(--ts-font-mono);
      font-size: 0.72rem;
      padding: 0.05rem 0.28rem;
      border: 1px solid var(--ts-edge);
      color: var(--ts-ink);
    }
  }

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.9rem;
    margin-bottom: 0.6rem;

    &--models {
      align-items: flex-start;
      flex-direction: column;
      gap: 0.45rem;
      margin-top: 0.9rem;
      /* The roster is as wide as the panel. */
      width: 100%;
    }
  }

  &__label {
    font-size: 0.82rem;
    color: var(--ts-ink);
  }

  &__input {
    width: 11rem;
    padding: 0.35rem 0.5rem;
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(0, 255, 65, 0.25);
    color: var(--ts-ink-bright);
    font-family: var(--ts-font-mono);
    font-size: 0.88rem;

    &:focus {
      outline: none;
      border-color: var(--ts-signal);
      box-shadow: 0 0 0 1px var(--ts-signal), 0 0 12px rgba(0, 255, 65, 0.3);
    }
  }

  /*
   * THE CHARACTER PICKER'S OWN STYLES LIVE IN THE COMPONENT.

   * The picker is shared with the ESC options overlay, and its tiles,
   * its portraits and its grid are all inside `CharacterPicker.vue`.
   * What this panel owns is the LAYOUT around it: the label above the
   * roster, and the panel's own colours, which the component reads
   * through its `--picker-*` variables.
   */
  &__remember {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    font-size: 0.8rem;
    color: var(--ts-ink-muted);
    cursor: pointer;

    input {
      accent-color: var(--ts-signal);
    }
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 1.2rem;
  }

  &__btn {
    padding: 0.45rem 0.9rem;
    background: rgba(0, 255, 65, 0.08);
    border: 1px solid rgba(0, 255, 65, 0.32);
    color: var(--ts-ink-bright);
    font-family: var(--ts-font-mono);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;

    &:hover {
      background: rgba(0, 255, 65, 0.18);
      border-color: var(--ts-lime);
    }

    &:focus-visible {
      outline: none;
      border-color: var(--ts-signal);
      box-shadow: 0 0 0 1px var(--ts-signal);
    }

    &--go {
      background: var(--ts-signal);
      border-color: var(--ts-signal);
      color: var(--ts-void);

      &:hover {
        background: var(--ts-signal-hot);
        border-color: var(--ts-signal-hot);
      }
    }
  }
}
</style>
