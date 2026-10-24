import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';

import './assets/main.css';
// Global, NOT inside a scoped component block: the theme defines its
// tokens on :root, and a scoped style block rewrites every selector in it
// to :root[data-v-xxx], which matches nothing — the tokens then resolve
// to empty and every var() fallback silently renders as transparent.
import './assets/ts-theme.css';

// The escape gate has to be listening BEFORE the WASM engine boots and
// registers its own keydown listener on `window`. Import-time is the only
// place guaranteed to be early enough — the canvas mounts later, and by
// then the engine may already own the key.
import { installEscapeGate } from './services/escape-gate';
installEscapeGate();

// The fullscreen watchdog: a canvas resize can lose the WebGL context,
// and a lost context renders black. It only acts when the context is
// actually lost, so it cannot make a working resize worse.
import { installFullscreenWatchdog } from './services/fullscreen';
installFullscreenWatchdog();

const app = createApp(App);
const pinia = createPinia();

pinia.use(piniaPluginPersistedstate);
app.use(pinia);

app.mount('#app');
