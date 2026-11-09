// dev-options.ts — the dev harness's entry point.
//
// It mounts the real options overlay with a mocked engine and a mocked
// readout, so the redesign can be iterated on in a browser without a
// game session:
//
//     npm run dev
//     https://localhost:5174/dev-options.html
//
// The page is DEV ONLY. It is not one of the production build's
// inputs, so it never ships — see vite.config.ts (the build's input
// is index.html alone).
//
// The harness's own pieces:
//
//   services/perf-collect.ts     the report, built from a mock fixture
//   components/XashOptionsOverlay.vue   the panel itself — the real one

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import DevOptionsHarness from '/@/dev-options.vue';
import XashLoader from '/@/services/xash-loader';
import { openOverlay } from '/@/services/escape-gate';

/**
 * THE ENGINE'S ANSWERS, MOCKED.
 *
 * The overlay reads the engine's cvars with `Cmd_ExecuteString`, and the
 * engine answers on stdout — which the page forwards as an
 * `xash:stdout` window event. So the mock is the engine's own format:
 *
 *     "fov" is "0" ( "90" )
 *
 * `fov` is the interesting one: it holds 0 while its default is 90,
 * and the slider is supposed to show the 90 and say that it is the
 * default.
 */
const CVARS: Record<string, [string, string]> = {
  sensitivity: ['1.7', '2'],
  fov: ['0', '90'],
  volume: ['0.05', '1'],
  name: ['Specialist', 'Specialist'],
  model: ['Bodysaver', 'Bodysaver'],
};

XashLoader.exec = ((cmd: string): boolean => {
  const hit = CVARS[cmd];
  if (hit) {
    window.dispatchEvent(
      new CustomEvent('xash:stdout', {
        detail: { line: `"${cmd}" is "${hit[0]}" ( "${hit[1]}" )` },
      }),
    );
  }
  return true;
}) as typeof XashLoader.exec;

const app = createApp(DevOptionsHarness);

// The store is a dependency of the services the panel pulls in. It is
// installed here too, so a service that reaches for it does not throw
// for want of an active pinia.
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
app.use(pinia);

app.mount('#dev-options');

// OPEN THE PANEL: the overlay is mounted by the game, and the
// harness is standing in for the game.
openOverlay();
