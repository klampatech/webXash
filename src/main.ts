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

// The browser chord gate. Chromium reserves Ctrl+W (close tab) and a few
// neighbours — the keydown never reaches the page, so the browser tries
// to close the tab and the app's own unload guard turns that into a
// "Leave site?" dialog while the player is only trying to crouch. The
// gate swallows those chords during a match. Installed at import time for
// the same reason as the escape gate above: it has to be listening
// before the launch click asks for fullscreen, because that request is
// what the keyboard lock hangs off.
import { installBrowserChordGate } from './services/browser-chord-gate';
installBrowserChordGate();

// The fullscreen watchdog: a canvas resize can lose the WebGL context,
// and a lost context renders black. It only acts when the context is
// actually lost, so it cannot make a working resize worse.
import { installFullscreenWatchdog } from './services/fullscreen';
installFullscreenWatchdog();

// The brand guard. The engine overwrites document.title from its own window
// title once it boots, so the tab would revert to the game's title the
// moment you entered a match. This takes it back and keeps it — see
// services/brand.ts for why an observer and not a one-shot write.
import { claimDocumentTitle } from './services/brand';
claimDocumentTitle();

const app = createApp(App);
const pinia = createPinia();

pinia.use(piniaPluginPersistedstate);
app.use(pinia);

app.mount('#app');
