// dev-buy.ts — the dev harness's entry point.
//
// It mounts the buy panel with mock data, so the redesign can be
// iterated on in a browser without a game session:
//
//     npm run dev
//     https://localhost:5174/dev-buy.html
//
// The page is DEV ONLY. It is not one of the production build's
// inputs, so it never ships — see vite.config.ts (the build's input
// is index.html alone).
//
// The harness's own pieces:
//
//   services/buy-menu.mock.ts  the fixture, in the port's record format
//   dev-buy.vue                 the toolbar and the stage
//   components/TSBuyMenuPanel.vue   the panel itself — the real one

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import DevBuyHarness from '/@/dev-buy.vue';

const app = createApp(DevBuyHarness);

// The store is a dependency of the services the panel pulls in. It is
// installed here too, so a service that reaches for it does not throw
// for want of an active pinia.
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
app.use(pinia);

app.mount('#dev-buy');
