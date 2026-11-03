<template>
  <section class="ts-faq">
    <h2 class="ts-stamp ts-faq__head">FAQ</h2>

    <!--
      THE CONTROLS COME FIRST.

      This panel used to lead with the architecture — three cards
      explaining the Rust port, the WebSocket↔UDP bridge and the key
      path. That is the wrong order for a player. They want to know
      which key does what; the architecture is a "how" answer to a
      "what" question. The technical explanation is not lost — it is
      the last line of this panel, as a link to the repository.

      EVERY KEY BELOW IS THE GAME'S OWN. Each row is a bind in the
      game's own `ts/config.cfg`, which the engine loads at boot (it
      opens with `unbindall`), so this list and the running game
      cannot drift apart. `LMB`/`RMB`/`MMB` are the engine's
      MOUSE1/MOUSE2/MOUSE3.
    -->
    <div class="ts-faq__controls">
      <h3 class="ts-faq__controls-head">Controls</h3>

      <section v-for="group in groups" :key="group.title" class="ts-faq__group">
        <h4 class="ts-faq__group-title">{{ group.title }}</h4>
        <ul class="ts-faq__keys">
          <li v-for="row in group.rows" :key="row.action">
            <span class="ts-faq__caps">
              <kbd v-for="(k, i) in row.keys" :key="i">{{ k }}</kbd>
            </span>
            <span class="ts-faq__action">{{ row.action }}</span>
          </li>
        </ul>
      </section>
    </div>

    <div class="ts-faq__links">
      <p class="ts-faq__line">
        The mechanics in depth — stunts, slots and weight, weapons, powerups —
        are in
        <a href="https://www.tsmod.net/faq/" target="_blank" rel="noreferrer noopener">the original TS FAQ</a>.
      </p>
      <p class="ts-faq__line">
        <a
          class="ts-faq__tech"
          href="https://github.com/klampatech/specialists-browser#the-four-things-that-make-it-work"
          target="_blank"
          rel="noreferrer noopener"
        >
          Technical explanation available on GitHub
        </a>
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * A row of the controls list: the keys, then what they do.
 *
 * `keys` is an array because several actions have more than one key —
 * the stunt is on `Q` and on the middle mouse button, and the
 * superjump is duck-then-jump.
 */
type Row = { keys: string[]; action: string };

/** A named group of rows: movement, weapons, and so on. */
type Group = { title: string; rows: Row[] };

/**
 * The controls, grouped by what the player is doing rather than by
 * which letter of the alphabet the key happens to be.
 *
 * The grouping is the point. A flat list of twenty rows is a wall; four
 * short lists are four things a player can hold in their head at once.
 *
 * The labels are the game's own vocabulary, not ours: a "fire mode" is
 * what TS calls it, a "stunt" is a dive or a wall flip, and a "powerup"
 * is the slow motion and the superjump.
 *
 * WHERE THE LABELS COME FROM, for the ones that are not obvious:
 *
 *   F  firemode   cycles the gun's fire mode — Semi-auto, Burst,
 *                 Pump-action, Free Semi, Free Full (`firemode_name` in
 *                 the port's client).
 *   G  useitems   the gun's ATTACHMENTS — laser, flashlight, both, off
 *                 (`CTSGun::SwitchItems`, `shared/src/weapons/gun.rs`).
 *                 Not "an item": the command name is a leftover.
 *   Z  usepowerup the powerup — slow motion, superjump and the rest.
 *                 E reaches the same powerup, but needs a double tap
 *                 (`cl_usepowerup 1`); Z is one press.
 *   Q  +alt1      the stunt. The port says so in its own words
 *                 (`client-ext-api.rs`: "TS's `+alt1`, the stunt"), and
 *                 MOUSE3 is the same command.
 *   Shift         a 30% walk, not a run: `cl_movespeedkey` is 0.3.
 *   H  impulse 201  the spray (`impulse_commands`, server side).
 */
const groups: Group[] = [
  {
    title: 'Movement',
    rows: [
      { keys: ['W', 'A', 'S', 'D'], action: 'Move' },
      { keys: ['Space'], action: 'Jump — double-tap to flip or wall-climb' },
      { keys: ['Ctrl'], action: 'Crouch — double-tap to roll' },
      { keys: ['Ctrl', 'Space'], action: 'Superjump — crouch, then jump' },
      { keys: ['Q', 'MMB'], action: 'Stunt — dive, wall flip, roll' },
      { keys: ['Shift'], action: 'Walk — slow, for precision' },
    ],
  },
  {
    title: 'Weapons',
    rows: [
      { keys: ['LMB'], action: 'Fire' },
      { keys: ['RMB'], action: 'Alt fire — grenade roll, stock hit' },
      { keys: ['F'], action: 'Fire mode — semi, burst, pump, free' },
      { keys: ['R'], action: 'Reload' },
      { keys: ['1', '…', '0'], action: 'Weapon slots' },
      { keys: ['Wheel'], action: 'Cycle weapons' },
      { keys: ['T'], action: 'Drop weapon' },
      { keys: ['G'], action: 'Attachments — laser, flashlight, both, off' },
    ],
  },
  {
    title: 'Buy & use',
    rows: [
      { keys: ['B'], action: 'Buy menu — while you wait to respawn' },
      { keys: ['E'], action: 'Use — pick up a dropped gun' },
      { keys: ['Z'], action: 'Use powerup — slow motion, superjump' },
    ],
  },
  {
    title: 'Interface',
    rows: [
      { keys: ['Tab'], action: 'Scoreboard (hold)' },
      { keys: ['Y'], action: 'Chat' },
      { keys: ['X'], action: 'Third person' },
      { keys: ['H'], action: 'Spray' },
      { keys: ['Esc'], action: 'Release the mouse, then open options' },
    ],
  },
];
</script>

<style scoped lang="scss">
.ts-faq {
  &__head {
    margin: 0 0 0.9rem;
    font-size: 1.05rem;
    color: var(--ts-lime);
  }

  /* The groups sit in a responsive grid: two side by side on a wide
     panel, one on a narrow one. The key list inside a group is a
     single column, because a group is narrow and a two-column list
     inside it orphans rows. */
  &__controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
    gap: 1.1rem 1.9rem;
  }

  &__controls-head {
    grid-column: 1 / -1;
    margin: 0 0 0.15rem;
    font-family: var(--ts-font-display);
    font-size: 0.92rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ts-lime);
  }

  &__group-title {
    margin: 0 0 0.5rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--ts-edge);
    font-family: var(--ts-font-mono);
    font-size: 0.66rem;
    font-weight: 400;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ts-signal);
  }

  /* A grid, not a flex list, so the actions of one group line up in a
     column: the key track is as wide as the widest row in THAT group
     and no wider. */
  &__keys {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.4rem 0.7rem;
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      display: contents;
    }
  }

  &__caps {
    display: inline-flex;
    align-items: center;
    gap: 0.22rem;
  }

  &__action {
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--ts-ink-muted);
  }

  &__links {
    margin-top: 1.4rem;
    padding-top: 1rem;
    border-top: 1px solid var(--ts-edge);
  }

  &__line {
    margin: 0 0 0.45rem;
    font-size: 0.8rem;
    line-height: 1.55;
    color: var(--ts-ink-muted);

    &:last-child {
      margin-bottom: 0;
    }

    a {
      color: var(--ts-signal);
      text-decoration: none;
      transition: color var(--ts-sweep) var(--ts-ease);

      &:hover {
        color: var(--ts-signal-hot);
        text-decoration: underline;
      }
    }
  }

  /* The technical explanation is a footnote, not a call to action, so
     it carries the same ▸ the bullets used to. */
  &__tech::before {
    content: '▸';
    margin-right: 0.45rem;
    font-size: 0.68rem;
    line-height: 1.7;
    color: var(--ts-signal);
  }
}

kbd {
  display: inline-block;
  min-width: 1.55rem;
  padding: 0.14rem 0.4rem;
  font-family: var(--ts-font-mono);
  font-size: 0.7rem;
  text-align: center;
  color: var(--ts-lime);
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--ts-edge);
  box-shadow: 0 1px 0 var(--ts-ink-faint);
}
</style>
