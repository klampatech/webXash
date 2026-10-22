// Fetch the (large) tsmod.zip for the engine's virtual filesystem.
//
// WHY THERE IS NO Cache API HERE ANYMORE
// ---------------------------------------
// This used to wrap the download in `caches.open('xash-zips-v1')` to
// store it for reuse. That never worked: `cache.put` refuses a single
// response above roughly 100-300MB, and tsmod.zip is one 494MB entry.
// Measured against this same origin:
//
//     single 492MB entry   FAILED  UnknownError: 'put' on 'Cache'
//     single 100MB entry   OK
//     496MB as 62 x 8MB    OK
//
// It was not a quota problem (storage estimate reported 496MB used of
// 10736MB available) and not an artifact of an ephemeral browser
// profile. The write threw, this module logged `cache write failed` and
// returned the buffer anyway, and nothing was ever stored — so the
// archive re-downloaded on every visit while appearing to have a cache.
// `TSMOD_CACHE_VERSION` never had anything to bust.
//
// The browser's own HTTP cache has no such per-entry ceiling and is what
// this workload actually wants: one large, unchanging static file. It
// needs permission from the server, which now comes from
// `vite-asset-headers.mjs` — `public, max-age=0, must-revalidate`.
// Unchanged content then costs one 304 revalidation; changed content
// re-downloads correctly. Neither case needs anything from us.
//
// WHAT THIS STILL OWNS
// --------------------
// Progress reporting. A 494MB download with no progress bar is
// indistinguishable from a hang, so the body is streamed and reported as
// bytes land rather than handed to `response.arrayBuffer()` in one go.

/**
 * @param progressCallback  receives 0-100 as bytes arrive.
 * @param opts.bypassCache  force a genuinely cold download by telling the
 *   HTTP cache to be skipped for this one request (`cache: 'no-store'`).
 *   Wired to `?nocache=1` so the cold path is a repeatable experiment
 *   rather than a DevTools excursion — necessary because a locally-served
 *   archive re-downloads fast enough to look like a cache hit.
 */
const getZip = async (
  zipName: string,
  zipPath: string,
  progressCallback: (progress: number) => any,
  opts?: { bypassCache?: boolean },
): Promise<ArrayBuffer> => {
  const url = './' + zipPath + zipName;

  const response = await fetch(url, {
    // `no-store` is the platform primitive for "do not use or update the
    // cache for this request" — the honest expression of the intent the
    // old Cache API eviction dance was approximating.
    cache: opts?.bypassCache ? 'no-store' : 'default',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }

  const total = parseInt(response.headers.get('content-length') || '0', 10);
  const reader = response.body?.getReader();

  if (!reader || !response.body) {
    // No ReadableStream — fall back to a plain read.
    const buffer = await response.arrayBuffer();
    progressCallback(100);
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      progressCallback(Math.round((received / total) * 100));
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  progressCallback(100);
  return merged.buffer;
};

export { getZip };