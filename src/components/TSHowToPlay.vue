<template>
  <section class="ts-about">
    <h2 class="ts-stamp ts-about__head">How It Works</h2>

    <div class="ts-about__grid">
      <article
        v-for="item in items"
        :key="item.title"
        class="ts-panel ts-about__card"
      >
        <div class="ts-about__num" aria-hidden="true">{{ item.step }}</div>
        <h3 class="ts-about__title">{{ item.title }}</h3>
        <!--
          Bullets, not paragraphs. A paragraph of four sentences asks a
          reader to hold it all in their head; a list of four points lets
          them take one at a time, and the highlighted words carry the
          part that is worth remembering.
        -->
        <ul class="ts-about__points">
          <li v-for="(point, pi) in item.points" :key="pi" class="ts-about__point">
            <template v-for="(seg, si) in segments(point)" :key="si">
              <b v-if="seg.hi" class="ts-about__hl">{{ seg.text }}</b>
              <template v-else>{{ seg.text }}</template>
            </template>
          </li>
        </ul>
      </article>
    </div>

    <div class="ts-about__controls">
      <h3 class="ts-about__controls-head">Controls</h3>
      <ul class="ts-about__keys">
        <li v-for="key in controls" :key="key.action">
          <kbd v-for="(k, i) in key.keys" :key="i">{{ k }}</kbd>
          <span>{{ key.action }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * The three cards map to the three-layer architecture documented in the
 * repo README: the Rust port (rules), the bridge (transport), and the
 * command bridge (input). Kept in that order because that is the order
 * the player experiences it — not because the docs are ordered that way.
 */

/** A piece of text, split into highlighted and plain segments. */
type Segment = { text: string; hi: boolean };

/**
 * Split a bullet on `**…**` into highlighted and plain segments.
 *
 * The markers stay in the source so the copy is still readable and
 * still editable as plain text — no markup in a string literal.
 */
function segments(text: string): Segment[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((part) => part.length)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**')
        ? { text: part.slice(2, -2), hi: true }
        : { text: part, hi: false },
    );
}

const items = [
  {
    step: '01',
    title: 'Real game code, not a remake',
    points: [
      'A **Rust reimplementation** of The Specialists’ rules, compiled to **WebAssembly**.',
      'The engine loads it like any other **game DLL** — the same shape as a native one.',
      'The **same build** also runs headless as the **dedicated server**.',
      'So what you play against is the **real ruleset**, not a JavaScript approximation.',
    ],
  },
  {
    step: '02',
    title: 'A browser can’t speak UDP. So we added a bridge.',
    points: [
      'Browsers **cannot emit UDP**, and GoldSrc servers speak it natively.',
      'A small **WebSocket↔UDP proxy** sits in the middle and forwards packets **byte-for-byte**.',
      'Game traffic is ordinary UDP once it leaves the bridge.',
    ],
  },
  {
    step: '03',
    title: 'Your keys go straight to the game',
    points: [
      'The engine **binds them itself** — W to move, X for third person, Y to chat.',
      '**Nothing is translated** on the way in.',
      'We only open The Specialists’ **anti-script gate**, so a real keypress counts as a real keypress.',
    ],
  },
];

const controls = [
  { keys: ['W', 'A', 'S', 'D'], action: 'Move' },
  { keys: ['Space'], action: 'Jump' },
  { keys: ['Ctrl'], action: 'Duck' },
  { keys: ['LMB'], action: 'Fire — and spawn, when observing' },
  { keys: ['1', '…', '0'], action: 'Weapon slots' },
  { keys: ['R'], action: 'Reload' },
  { keys: ['X'], action: 'Third person — while alive' },
  { keys: ['Y'], action: 'Chat' },
  { keys: ['Tab'], action: 'Scoreboard (hold)' },
  { keys: ['Esc'], action: 'Release the mouse, then open options' },
];
</script>

<style scoped lang="scss">
.ts-about {
  &__head {
    margin: 0 0 0.9rem;
    font-size: 1.05rem;
    color: var(--ts-lime);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.7rem;
  }

  &__card {
    padding: 1.05rem 1.1rem 1.15rem;
  }

  &__num {
    font-family: var(--ts-font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.2em;
    color: var(--ts-signal);
  }

  &__title {
    margin: 0.4rem 0 0.7rem;
    font-family: var(--ts-font-display);
    font-size: 1.02rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--ts-ink-bright);
  }

  /* ---- the bullets ---- */
  &__points {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__point {
    position: relative;
    padding-left: 0.95rem;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--ts-ink);
  }

  /* The same ▸ the boot screen uses for its active step. One marker
     language across the product. */
  &__point::before {
    content: '▸';
    position: absolute;
    left: 0;
    top: 0.06rem;
    font-size: 0.68rem;
    line-height: 1.7;
    color: var(--ts-signal);
  }

  /* The word worth remembering. Phosphor, because phosphor is the
     colour of "this is the operative fact" in this shell. */
  &__hl {
    color: var(--ts-signal);
    font-weight: 700;
  }

  &__controls {
    margin-top: 1.2rem;
  }

  &__controls-head {
    margin: 0 0 0.6rem;
    font-family: var(--ts-font-display);
    font-size: 0.92rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ts-lime);
  }

  &__keys {
    display: grid;
    /* Two tracks, not auto-fit: at the 775px panel width auto-fit packs
       three columns and orphans rows, which reads as ragged rather than
       as a list. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.4rem 1.6rem;
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      font-size: 0.8rem;
      color: var(--ts-ink);
      /* keep each row intact when the label wraps */
      flex-wrap: nowrap;
      white-space: nowrap;
    }

    span {
      color: var(--ts-ink-muted);
    }
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

@media (max-width: 560px) {
  .ts-about__keys {
    grid-template-columns: minmax(0, 1fr);
  }
}
