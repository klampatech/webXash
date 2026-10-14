import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
  base: '/webXash/',
  plugins: [vue()],
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
  },
});