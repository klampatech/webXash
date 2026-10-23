/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL the chunked game archive is served from.
   *
   * Defaults to './' (same origin), which is correct for local dev. In
   * production the archive lives on R2 behind its own domain, so the build
   * sets this to that origin and the part URLs resolve there.
   */
  readonly VITE_ASSET_BASE?: string;

  /**
   * `host:port` of the WebSocket↔UDP bridge.
   *
   * Defaults to the page's own host, which is correct in production
   * because the bridge is behind the same reverse proxy as the page — it
   * has to be, for mixed-content and cross-origin-isolation reasons. Dev
   * overrides it, because the Vite dev server and the bridge are on
   * different ports.
   */
  readonly VITE_BRIDGE_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
