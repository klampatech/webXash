import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { a2sServerListPlugin } from './vite-a2s-plugin.mjs';
import { gameAssetCacheHeadersPlugin } from './vite-asset-headers.mjs';

// https://vite.dev/config/
//
// CheerpX requires `window.crossOriginIsolated` to be true, which means:
//   - The page must be served over HTTPS (or from localhost)
//   - The responses must include:
//       Cross-Origin-Embedder-Policy: credentialless  (or require-corp)
//       Cross-Origin-Opener-Policy: same-origin
//
// For Phase 1 step 1.1 (CheerpX PoC), we run Vite over HTTPS with a
// self-signed cert. The cert is generated via openssl outside this repo
// (see /home/kyle/Development/scratch/cheerpx-inspect/certs/) so it
// doesn't pollute the submodule. Browser will show a one-time cert
// warning per device; accept it and you're good.
const certDir = '/home/kyle/Development/scratch/cheerpx-inspect/certs';

export default defineConfig({
  // Served from the site root so the app lives at https://bulletballet.dev/
  // rather than https://bulletballet.dev/webXash/. Every path below that
  // mentions the base has to track this value.
  base: '/',
  plugins: [
    vue(),
    // Let the browser cache tsmod.zip. Vite's dev default is
    // `cache-control: no-cache`, which forces a 494MB re-download on
    // every visit. See vite-asset-headers.mjs for why the HTTP cache is
    // used instead of the Cache API, and for the nginx equivalent.
    gameAssetCacheHeadersPlugin(),
    // Real A2S server list for the landing page's server browser.
    // Same-origin on purpose: the page is HTTPS and ts-udp-bridge.js is
    // plain HTTP, so a fetch from the page would be blocked as mixed
    // content. A browser cannot emit UDP either, so this has to be Node.
    // Edit `targets` to change which servers are listed.
    a2sServerListPlugin({
      // `host` is where the A2S query is SENT from this machine; it is
      // also the address the server reports back, which for a local
      // server is 127.0.0.1 — unreachable from a remote browser. So
      // `publicAddress` is what the browser is told to +connect to.
      targets: [
        {
          id: 'dev',
          host: '127.0.0.1',
          port: 27015,
          publicAddress: '100.95.111.112',
        },
      ],
    }),
  ],
  resolve: {
    alias: {
      '/@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    https: fs.existsSync(`${certDir}/key.pem`) && fs.existsSync(`${certDir}/cert.pem`)
      ? {
          key: fs.readFileSync(`${certDir}/key.pem`),
          cert: fs.readFileSync(`${certDir}/cert.pem`),
        }
      : undefined,
    headers: {
      // credentialless is the dev-friendly variant of require-corp —
      // it lets cross-origin subresources load without requiring them
      // to set Cross-Origin-Resource-Policy. For production, we'd use
      // require-corp + CORP-friendly CDNs.
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    // The dev page must reach the WebSocket↔UDP bridge the same way
    // production does: on the page's own origin, at /bridge.
    //
    // WHY THIS EXISTS
    // ---------------
    // The client picks its bridge address from the launch options. In
    // production `launchOptionsFor()` names the bridge explicitly
    // (`+bridge bulletballet.dev:443`) and Caddy terminates TLS and
    // proxies /bridge to the bridge process. In dev there is no Caddy:
    // the page is served by Vite, and `launchOptionsFor()` still adds
    // `+bridge <the dev server's own host:port>` — because the dev page
    // is HTTPS too, and the condition that adds it is "the page is
    // secure", not "this is production".
    //
    // The result was a WebSocket to `wss://<dev host>:5174/bridge`,
    // where Vite has no such endpoint: the socket sat in CONNECTING
    // forever, the engine's connect packets were dropped ("ws not
    // open"), and the client showed nothing but
    // `Connecting to <ip> (retry #N)` — a dev loop that could never
    // reach a dedicated server.
    //
    // Proxying /bridge to the local bridge fixes it the same way
    // production does, and it also means the browser only ever talks to
    // its own origin (no mixed-content, no cross-origin WS).
    proxy: {
      '/bridge': {
        target: 'ws://127.0.0.1:27017',
        ws: true,
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:27017',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});