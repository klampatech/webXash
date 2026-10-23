/**
 * Cache headers for the large game assets under /hl/.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vite's dev server sends `cache-control: no-cache` for everything under
 * `public/`. That is correct for application code during development and
 * exactly wrong for tsmod.zip: a 494MB immutable-ish blob that every
 * visitor should download once and then reuse from their own disk.
 *
 * With `no-cache` in force the browser is told to revalidate on every
 * single load, so the archive was re-fetched every time. The manual Cache
 * API wrapper that used to sit in front of it could not fix that either:
 * `cache.put` refuses any single response over roughly 100-300MB, and
 * tsmod.zip is one 494MB entry. Measured on the same origin:
 *
 *     single 492MB entry   FAILED  UnknownError: 'put' on 'Cache'
 *     single 100MB entry   OK
 *     496MB as 62 x 8MB    OK
 *
 * So the manual cache never stored anything, and the net result was a
 * cold 494MB download on every visit. Handing the job to the HTTP cache
 * is what it is designed for, and it needs one header to be allowed to.
 *
 * WHY `max-age=0, must-revalidate` AND NOT `immutable`
 * --------------------------------------------------
 * The URL is stable (tsmod.zip is gitignored, so the path never changes)
 * but the CONTENT changes whenever the archive is rebuilt. `immutable`
 * would let a browser keep a stale copy indefinitely after one fetch, and
 * there is no cache-bust in the URL to save it.
 *
 * `max-age=0, must-revalidate` means the browser still revalidates on
 * every load, but revalidation is a conditional request: the server
 * answers `304 Not Modified` against the ETag for a few hundred bytes.
 * Unchanged means effectively free; changed means a correct re-download.
 * A content-hashed filename would allow `immutable` later, but that is a
 * deploy-pipeline change and not worth pre-solving here.
 *
 * PROD EQUIVALENT (nginx)
 * -----------------------
 *   location /hl/ {
 *     add_header Cache-Control "public, max-age=0, must-revalidate" always;
 *     add_header Accept-Ranges "bytes" always;   # resumable downloads
 *   }
 *
 * nginx already sends ETag and Last-Modified, and already supports range
 * requests, so this is the whole of the server-side change.
 */

/**
 * Paths that hold large, rarely-changing game content.
 *
 * Two tiers, because the archive is now chunked:
 *
 *   /hl/ts/<version>/part-NNN.bin   content-addressed, IMMUTABLE
 *   /hl/ts/manifest.json             the pointer that moves, revalidated
 *
 * Splitting on the version directory is what makes `immutable` safe here:
 * the directory name IS the archive's SHA-256, so a URL can never change
 * meaning. The manifest must not be immutable, because it is exactly the
 * thing that changes to point at a new archive.
 */
const ASSET_PATH_RE = /^\/hl\//;
const VERSIONED_PART_RE = /^\/hl\/ts\/[^/]+\/.+\.bin$/;

export function gameAssetCacheHeadersPlugin() {
  return {
    name: 'ts-game-asset-cache-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (VERSIONED_PART_RE.test(url)) {
          // Content-addressed: this URL can never mean anything else.
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Accept-Ranges', 'bytes');
        } else if (ASSET_PATH_RE.test(url)) {
          // Everything else under /hl/, including the manifest pointer.
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
          res.setHeader('Accept-Ranges', 'bytes');
        }
        next();
      });
    },
  };
}

export default gameAssetCacheHeadersPlugin;