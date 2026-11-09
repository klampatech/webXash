<!--
  THE CHARACTER PICKER.

  One component, used by BOTH menus that offer a character: the ESC
  options overlay (mid-match) and the pre-join identity modal (before
  the first connect). They used to carry their own copy of the markup,
  and they drifted — the same roster in two places, two styles, two
  chances to disagree about which characters exist.

  The roster itself lives in the service (`TS_MODELS`), so this
  component only has to render what the service says and report the
  choice. It does NOT decide what a character is called: the click
  carries the model's own spelling, which is the spelling the engine
  resolves (see `player-identity.ts` — the case is part of the path).

  THE COLOUR IS THE CALLER'S.

  The two menus are different surfaces: the options overlay wears the
  game's amber because it opens INSIDE the match, and the identity
  modal wears the shell's phosphor green because it opens on the
  landing page. So the colours here are CSS variables with no opinion
  of their own, and each caller sets the ones it wants. The defaults
  are the shell's green, which is the surface this component was
  written for.
-->
<template>
  <div class="picker" role="group" :aria-label="label">
    <button
      v-for="m in models"
      :key="m"
      class="picker__char"
      type="button"
      :class="{ 'picker__char--on': selected === m }"
      :aria-pressed="selected === m"
      :title="`Play as ${m}`"
      @click="emit('select', m)"
    >
      <!--
        The portrait is the character's own art, on transparent pixels:
        the game's painted portrait for the seven it draws, and a
        uniform render of the model for the nine it does not. Every one
        of them is the same 256x256 square, so the grid reads as one
        roster rather than two kinds of picture.

        The path is `/models/<name>.png`, and the NAME IS VERBATIM —
        `Bodysaver.png` is capitalised because the file is, and a
        request for `bodysaver.png` is a 404.
      -->
      <img
        class="picker__img"
        :src="`/models/${m}.png`"
        :alt="`${m} character portrait`"
        width="76"
        height="76"
        loading="lazy"
        decoding="async"
      />
      <span class="picker__name">{{ m }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { TS_MODELS, canonicalModel } from '/@/services/player-identity';

const props = withDefaults(
  defineProps<{
    /** The model's name, in whatever spelling the caller has it. */
    model?: string;
    /** The group's accessible name. */
    label?: string;
  }>(),
  { model: '', label: 'Character model' },
);

const emit = defineEmits<{ (e: 'select', model: string): void }>();

const models = TS_MODELS;

/**
 * Which tile is lit.
 *
 * The comparison is on the CANONICAL spelling, not the raw one: the
 * engine reports whatever the server sent, and a saved identity may
 * have been written by a build that spelled the character differently.
 * Without this, a player whose model is "bodysaver" would see no tile
 * lit at all and no way to tell which character they are playing.
 */
const selected = computed(() => canonicalModel(props.model) ?? '');
</script>

<style scoped lang="scss">
.picker {
  /*
   * THE COLOURS ARE THE CALLER'S.

   * `--picker-*` so a caller can set them on the component and nothing
   * else has to change. The DEFAULTS live in the `var()` fallbacks
   * rather than in declarations here, and that is deliberate: a
   * declaration on `.picker` would have the same specificity as the
   * caller's override, so which one won would come down to the order
   * the two stylesheets happened to be injected in. A fallback is only
   * used when the variable is not defined at all, so the caller's
   * value always wins.
   *
   * The defaults are the shell's phosphor green, which is the surface
   * the pre-join identity modal is on; the in-game options overlay
   * overrides them with the game's amber.
   */
  display: grid;
  /*
   * FOUR COLUMNS.

   * There are sixteen characters, and four by four is the only shape
   * that is a rectangle. Auto-fill would give five on a wide panel and
   * leave a ragged last row of one; a wrapped flex row is worse. The
   * grid is four columns wide and the tiles are square, so the whole
   * roster is one block the eye can take in at a glance.
   */
  grid-template-columns: repeat(4, minmax(0, 1fr));
  /* The grid's spacing is the CALLER's, like the colours and the tile
     size: the options overlay draws the roster in the design's own
     8px gutter, and the identity modal keeps the 0.4rem it has. */
  gap: var(--picker-gap, 0.4rem);
  /* The rows keep their own height. A roster that is taller than its
     content would otherwise stretch the rows and pull the last two
     apart — the grid reads as one block only when every gutter is
     the same. */
  align-content: start;

  @media (max-width: 24rem) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  &__char {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: var(--picker-tile-pad, 0.25rem 0.2rem);
    background: var(--picker-surface, rgba(0, 255, 65, 0.06));
    border: 1px solid var(--picker-edge, rgba(0, 255, 65, 0.28));
    color: var(--picker-ink, var(--ts-ink-muted));
    font-family: var(--picker-font, var(--ts-font-mono));
    font-size: var(--picker-name-size, 0.68rem);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;

    &:hover {
      border-color: var(--picker-accent, var(--ts-lime));
      color: var(--picker-ink, var(--ts-ink));
    }

    &:focus-visible {
      outline: none;
      border-color: var(--picker-on-edge, var(--ts-signal));
      box-shadow: 0 0 0 1px var(--picker-on-edge, var(--ts-signal));
    }

    &--on {
      background: var(--picker-on-surface, rgba(0, 255, 65, 0.16));
      border-color: var(--picker-on-edge, var(--ts-signal));
      color: var(--picker-on-ink, var(--ts-ink-bright));
    }
  }

  /*
   * The portrait itself.

   * `object-fit: contain` with a SQUARE source, so the portrait fills
   * the box exactly — every character is the same size on screen, and
   * the tile is the same shape for all of them.
   *
   * The width is a PERCENTAGE with a cap, so the portrait takes the
   * cell it is given and never grows past the cap: the cell is a
   * fraction of the panel, and a fixed width would leave the portrait
   * floating in a wide cell on a wide panel and clipped on a narrow
   * one. `aspect-ratio` keeps it square without a second measurement.
   *
   * `image-rendering: auto`, not `pixelated`: the portraits are 256px
   * and the box is about 76px, so the nearest-neighbour downscale threw
   * detail away. It was `pixelated` when the picture was a 164x200
   * painted portrait in a 72px box, and the scale has changed since.
   */
  &__img {
    display: block;
    width: 100%;
    /*
     * The tile SIZE is the CALLER's.
     *
     * The options overlay draws its roster in the design's own 68px
     * frames; the pre-join identity modal keeps the 76px it has
     * always used. The portrait is the same 256x256 file in both
     * places, so only the frame changes — and a caller's value always
     * wins, because this is a fallback and not a declaration.
     *
     * (`--picker-tile` is the tile's BACKGROUND colour, which is a
     * different thing; the size is `--picker-tile-size`.)
     */
    max-width: var(--picker-tile-size, 76px);
    aspect-ratio: 1 / 1;
    height: auto;
    object-fit: contain;
    image-rendering: auto;
    background: var(--picker-tile, rgba(0, 0, 0, 0.35));
    border-radius: 4px;

    /*
     * The old blacksteam theme puts a 2px grey-teal frame on EVERY
     * img in the app (`img { border: solid 2px #7b8484 }`). It is not
     * part of any of these palettes, so the portrait takes the tile's
     * own edge instead — or nothing at all.
     */
    border: none;
  }

  &__name {
    line-height: 1;
    /*
     * The names are up to eleven characters ("SpeziClaus"), and the
     * tile is narrow. They stay on ONE line and shrink rather than
     * wrap: a wrapped name makes the rows uneven, and an uneven grid
     * is the thing this component exists to avoid.
     */
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
