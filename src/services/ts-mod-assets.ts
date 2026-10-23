// Fetch the TS mod archive for the engine's virtual filesystem.
//
// WHY THIS IS CHUNKED
// -------------------
// tsmod.zip is 516,960,756 bytes. Every storage layer between here and the
// browser has a per-object ceiling that it exceeds:
//
//   Cache Storage (cache.put)   492MB entry -> UnknownError; 100MB fine
//   IndexedDB single value      133,169,152 B -> "value too large"
//   Cloudflare CDN cache-file   512 MB       -> passed through uncached
//
// So it is shipped as 64MB parts plus a content-addressed manifest, which
// sits under all three. See docs/ASSET-DELIVERY.md for the measurements.
//
// WHAT THE HTTP CACHE IS NOT DOING
// --------------------------------
// An earlier version wrapped this in a Cache Storage entry and appeared to
// work; it never did. `cache.put` failed on every write, the code logged
// and carried on, and the archive re-downloaded every visit. An attempt to
// hand the job to the browser's own HTTP cache also failed to produce a
// hit for 1MB, 50MB or 200MB under any cache-control variant tried, with
// correct headers both on the wire and as received by the browser. That is
// unexplained, so this relies on IndexedDB, whose limits are documented and
// predictable, rather than on behaviour we cannot reproduce.
//
// Note: `Response.status` CANNOT tell you whether a response came from
// cache - a cached response is exposed as a reconstructed 200. Use
// performance.getEntriesByName(url).transferSize (0 means cached) or the
// Network panel's transferred-bytes column.

import { getPart, hasPart, pruneVersions, putPart } from '/@/services/ts-asset-store.ts';
import { logDebug } from '/@/services/debug-log.ts';

/** One part as described by the manifest. */
export interface TsPart {
  name: string;
  bytes: number;
  sha256: string;
}

/** Manifest written by tools/assets/split-tsmod.mjs. */
export interface TsManifest {
  schema: number;
  /** Content address of the whole archive; also the version prefix. */
  version: string;
  size: number;
  partSize: number;
  /** Path segments the versioned parts live under, relative to the manifest. */
  prefix: string;
  parts: TsPart[];
}

export class AssetFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AssetFetchError';
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Where the parts live.
 *
 * Defaults to the same origin, which is correct for local dev and for a
 * single-box deploy. In production the payload sits on R2 behind a custom
 * domain, so the build sets VITE_ASSET_BASE and part URLs resolve there.
 *
 * Part URLs themselves are relative in the manifest and get resolved
 * against wherever the manifest was fetched from - see fetchManifest -
 * so the manifest never needs re-splitting when the host changes.
 */
const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE ?? './').replace(/\/+$/, '') + '/';
const MANIFEST_URL = `${ASSET_BASE}hl/ts/manifest.json`;

/**
 * Progress detail. Two honest signals rather than one synthetic one:
 * how many parts are accounted for, and how many bytes.
 */
export interface AssetProgress {
  percent: number;
  partsDone: number;
  partsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** How many parts so far came from local storage rather than the network. */
  partsFromCache: number;
}

async function fetchManifest(
  bypassCache: boolean,
): Promise<{ manifest: TsManifest; baseUrl: string }> {
  let res: Response;
  try {
    res = await fetch(MANIFEST_URL, {
      cache: bypassCache ? 'no-store' : 'default',
    });
  } catch (e) {
    // Same self-heal as fetchPart: a CDN variant cached without the CORS
    // header fails opaquely, and a changed cache key gets a fresh copy from
    // the origin. The manifest is the entry point, so failing here fails
    // everything.
    try {
      res = await fetch(bustCacheKey(MANIFEST_URL));
      logDebug('[assets] manifest fetch failed, retried with a cache-busting key');
    } catch {
      throw new AssetFetchError(
        `could not reach ${MANIFEST_URL}. Has the archive been split?\n` +
          '  Run:  node tools/assets/split-tsmod.mjs',
        e,
      );
    }
  }
  if (res.status === 404) {
    throw new AssetFetchError(
      `${MANIFEST_URL} returned 404. The archive has not been split yet.\n` +
        '  Run:  node tools/assets/split-tsmod.mjs',
    );
  }
  if (!res.ok) {
    throw new AssetFetchError(`manifest fetch failed (HTTP ${res.status})`);
  }
  const m = (await res.json()) as TsManifest;
  if (!m?.version || !Array.isArray(m.parts) || m.parts.length === 0) {
    throw new AssetFetchError('manifest is missing version/parts');
  }
  // Part URLs are resolved against THIS file, not the document. The
  // manifest's `prefix` is written relative to itself, so resolving it
  // against location.href sent requests to /<version>/... instead
  // of /hl/ts/<version>/... and Vite answered every one with
  // index.html - 1107 bytes where 67108864 were expected.
  // Strip any cache-buster before deriving the base URL for part
  // resolution, so the parts resolve against the manifest's directory and
  // not against a query string.
  const manifestUrl = new URL(res.url);
  manifestUrl.search = '';
  return { manifest: m, baseUrl: new URL('.', manifestUrl.href).href };
}

/**
 * Fetch one part.
 *
 * A dev server or SPA host answers an unknown path with index.html and a
 * 200, so a status check alone is not enough - check the declared length
 * and say so clearly when the response is not a part at all.
 *
 * NETWORK ERRORS GET ONE RETRY WITH A CACHE-BUSTING QUERY STRING.
 *
 * Once a CORS policy exists on the asset origin, the origin sends
 * `vary: Origin`, so a CDN caches one variant of each object per origin. A
 * variant that was cached *before* the policy was applied comes back
 * without `Access-Control-Allow-Origin`, and a cross-origin fetch of it
 * fails with an opaque TypeError - no status, no body, no explanation. The
 * bytes are right there on the origin; only the cached copy is wrong.
 *
 * Adding a query string changes the cache key, so the retry is served
 * fresh from origin with correct headers. That makes the client self-heal
 * against a poisoned edge variant instead of failing forever, which matters
 * because the failure is indistinguishable from "the network is down" and
 * nobody is watching a CDN's cache.
 *
 * Only network failures are retried. A 404 or a 403 will not be fixed by
 * changing the cache key, and retrying those just delays the real error.
 */
/**
 * Add a cache-busting query string to a URL.
 *
 * The value only has to be unique per attempt; it exists to change the CDN
 * cache key so the request misses the cached copy and is served fresh from
 * the origin.
 */
function bustCacheKey(url: string): string {
  const u = new URL(url);
  u.searchParams.set('cb', Date.now().toString(36));
  return u.href;
}

async function fetchPart(url: string, expectedBytes: number): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const busted = bustCacheKey(url);
    try {
      res = await fetch(busted);
    } catch {
      // Throw the ORIGINAL error: a cache-busted retry failing too means the
      // origin itself is unreachable, and the first error is the honest one.
      throw new AssetFetchError(
        `part fetch failed for ${url}: ${(err as Error)?.message || err}`,
      );
    }
    logDebug(
      '[assets] part fetch failed, retried with a cache-busting key:',
      busted,
    );
  }
  if (!res.ok) {
    throw new AssetFetchError(`part fetch failed (HTTP ${res.status}): ${url}`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== expectedBytes) {
    const looksLikeHtml =
      buf.byteLength < 4096 &&
      new TextDecoder().decode(buf.slice(0, 64)).trimStart().startsWith('<');
    throw new AssetFetchError(
      looksLikeHtml
        ? `part URL returned an HTML page, not the part: ${url}\n` +
            '  Expected ' + expectedBytes + ' bytes. The server is falling back to a\n' +
            '  document for unknown paths - check the manifest prefix resolves\n' +
            '  against the manifest URL.'
        : `part ${url} is ${buf.byteLength} bytes, manifest declares ${expectedBytes}`,
    );
  }
  return buf;
}

/**
 * Get the whole archive, fetching only the parts not already stored.
 *
 * Order of operations:
 *   1. read the manifest (tiny, always revalidated)
 *   2. for each part: IndexedDB hit -> reuse; miss -> fetch and store
 *   3. concatenate in manifest order
 *   4. prune parts belonging to other versions
 *
 * @param onProgress  receives 0-100 plus the underlying counters
 * @param opts.bypassCache  ignore stored parts and re-download everything.
 *   Wired to `?nocache=1` so the cold path is repeatable - necessary
 *   because a locally-served archive re-downloads fast enough to look
 *   like a cache hit.
 */
export async function getTsmodArchive(
  onProgress?: (p: AssetProgress) => void,
  opts?: { bypassCache?: boolean },
): Promise<ArrayBuffer> {
  const bypass = !!opts?.bypassCache;
  const { manifest, baseUrl } = await fetchManifest(bypass);
  const { version, parts, size } = manifest;
  // Resolve part URLs against the manifest's own location.
  const partUrl = (name: string) => new URL(`${manifest.prefix}${name}`, baseUrl).href;

  // Assemble INTO a single preallocated buffer, one part at a time.
  //
  // The obvious version - collect all 8 chunks in an array, then build a
  // merged copy - holds 493MB of chunks AND 493MB of merged buffer at
  // once, ~986MB, immediately before the unzip allocates another 885MB of
  // decompressed output. Measured cost of that: the download phase failed
  // to complete inside 245s, from a baseline of ~2s.
  //
  // Writing each part straight into the destination and releasing it
  // afterwards holds 493MB + one 64MB part instead, and works identically
  // on a warm load (each part is read out of IndexedDB into its slot).
  const merged = new Uint8Array(size);
  let bytesDone = 0;
  let partsDone = 0;
  let fromCache = 0;

  const report = () => {
    onProgress?.({
      percent: Math.min(100, Math.round((bytesDone / size) * 100)),
      partsDone,
      partsTotal: parts.length,
      bytesDone,
      bytesTotal: size,
      partsFromCache: fromCache,
    });
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const url = partUrl(part.name);
    let buf: ArrayBuffer | null = null;

    if (!bypass && (await hasPart(version, part.name))) {
      try {
        buf = await getPart(version, part.name);
      } catch {
        // Treated as a miss below. A corrupt entry must not be fatal.
        buf = null;
      }
    }

    if (buf && buf.byteLength !== part.bytes) {
      // Stored copy is the wrong size - refetch rather than hand the
      // engine a corrupt archive.
      buf = null;
    }
    if (buf) fromCache++;

    if (!buf) {
      buf = await fetchPart(url, part.bytes);
      // A failed store costs bandwidth next time, not correctness now.
      try {
        await putPart(version, part.name, buf);
      } catch (e) {
        console.warn('[ts-assets] could not store part', part.name, e);
      }
    }

    merged.set(new Uint8Array(buf), bytesDone);
    bytesDone += buf.byteLength;
    partsDone++;
    report();
    // Drop the reference so this part can be collected before the next
    // one is allocated.
    buf = null;
  }

  if (bytesDone !== size) {
    throw new AssetFetchError(
      `reassembled ${bytesDone} bytes, manifest declares ${size}`,
    );
  }

  // Reclaim older archive versions now that the new one is complete.
  void pruneVersions(version);

  report();
  return merged.buffer;
}