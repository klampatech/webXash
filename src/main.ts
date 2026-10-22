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

const app = createApp(App);
const pinia = createPinia();

pinia.use(piniaPluginPersistedstate);
app.use(pinia);

app.mount('#app');
