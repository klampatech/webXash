// Cache API storage for the (large) tsmod.zip download.
// First call: fetches from /webXash/hl/<zipName> with progress, stores
// the response in a Cache, returns ArrayBuffer.
// Subsequent calls: instant return from the Cache.
//
// Bumping TSMOD_CACHE_VERSION forces a fresh download — bump it when
// tsmod.zip is regenerated with new content (we gitignore the zip, so
// the URL doesn't change but the bytes do).
const TSMOD_CACHE_NAME = 'xash-zips-v1';
const TSMOD_CACHE_VERSION = '1';

const getZip = async (
  zipName: string,
  zipPath: string,
  progressCallback: (progress: number) => any,
): Promise<ArrayBuffer> => {
  const url = './' + zipPath + zipName;

  // Cache hit — instant return. Skip progress (it's <1ms).
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(TSMOD_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        progressCallback(100);
        return await cached.arrayBuffer();
      }
    } catch (err) {
      // Cache API can throw in private modes or restricted contexts.
      // Fall through to fetch.
      console.warn('[zip-helpers] cache read failed:', err);
    }
  }

  // Cache miss — fetch with streaming progress.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }

  const total = parseInt(response.headers.get('content-length') || '0', 10);
  const reader = response.body?.getReader();
  let arrayBuffer: ArrayBuffer;

  if (!reader || !response.body) {
    // No ReadableStream — fall back to plain arrayBuffer().
    arrayBuffer = await response.arrayBuffer();
    progressCallback(100);
  } else {
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
    // Concat chunks into one ArrayBuffer.
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    arrayBuffer = merged.buffer;
    progressCallback(100);
  }

  // Store in cache for next time.
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(TSMOD_CACHE_NAME);
      await cache.put(
        url,
        new Response(arrayBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        }),
      );
    } catch (err) {
      // Quota exceeded or other issue — log but don't fail the
      // current download.
      console.warn('[zip-helpers] cache write failed:', err);
    }
  }

  return arrayBuffer;
};

// Expose version so XashSettings can show it / bust on demand.
export { getZip, TSMOD_CACHE_NAME, TSMOD_CACHE_VERSION };