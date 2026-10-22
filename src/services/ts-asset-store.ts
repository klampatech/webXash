/**
 * Client-side store for the split tsmod archive.
 *
 * WHY INDEXEDDB AND NOT THE HTTP CACHE
 * -------------------------------------
 * The browser HTTP cache was tried first and does not work for this
 * payload. Measured, in a real Vivaldi session, with correct headers on
 * the wire and as received by the browser:
 *
 *     Cache-Control: public, max-age=0, must-revalidate   transferSize 1048876
 *     Cache-Control: public, max-age=31536000, immutable  transferSize 1048876
 *     Cache-Control: public, max-age=600                  transferSize 1048876
 *
 * for a 1MB file, and the same at 50MB and 200MB. Nothing cached, and the
 * header was not the variable. The cause is unexplained.
 *
 * IndexedDB is used instead because its limits are documented and
 * predictable, which is what you want for a correctness-critical asset:
 *
 *     single value   133,169,152 B  (127 MiB)
 *
 * so parts are 64MB - comfortably under it, with ~2x headroom.
 * Cache Storage was rejected for a different, measured reason: `cache.put`
 * fails on a single large response (492MB UnknownError, 100MB fine).
 *
 * KEYING
 * ------
 * Parts are keyed by `<version>/<name>`, where `version` is a content
 * address from the archive's SHA-256. A rebuilt archive therefore gets new
 * keys and needs no manual cache busting - the new parts simply miss, the
 * old ones become garbage, and `pruneVersions` reclaims them.
 *
 * GOTCHA, HARD-WON
 * ----------------
 * An IndexedDB transaction auto-commits as soon as the microtask queue
 * drains. Hoisting one object store and issuing requests later throws
 * `TransactionInactiveError`. Every operation below opens its OWN
 * transaction, created in the same task as its request.
 */

const DB_NAME = 'ts-assets';
const DB_VERSION = 1;
const STORE = 'parts';

/** Raised for anything that is not "part is simply absent". */
export class PartStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PartStoreError';
    (this as { cause?: unknown }).cause = cause;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new PartStoreError('IndexedDB is unavailable in this context'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new PartStoreError('could not open IndexedDB', req.error));
    req.onblocked = () => reject(new PartStoreError('IndexedDB upgrade blocked by another tab'));
  });
}

/**
 * Run one operation inside its own transaction.
 *
 * The transaction must be created in the same task as the request, or it
 * commits before the request is made. Hence a function, not a hoisted
 * store.
 */
function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch (e) {
      reject(new PartStoreError('could not open a transaction', e as Error));
      return;
    }
    let req: IDBRequest<T>;
    try {
      req = fn(tx.objectStore(STORE));
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already gone */
      }
      reject(new PartStoreError('request could not be issued', e as Error));
      return;
    }
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () =>
      reject(new PartStoreError('transaction failed', (tx.error ?? req.error) as Error));
    tx.onabort = () =>
      reject(new PartStoreError('transaction aborted', (tx.error ?? req.error) as Error));
  });
}

/** Stable key for a part. Version-scoped, so content addressing does the busting. */
export const partKey = (version: string, name: string): string => `${version}/${name}`;

/** Is a part already stored? `false` when unavailable - never throws. */
export async function hasPart(version: string, name: string): Promise<boolean> {
  try {
    const db = await openDb();
    try {
      const key = await withStore(db, 'readonly', (s) => s.getKey(partKey(version, name)));
      return key !== undefined;
    } finally {
      db.close();
    }
  } catch {
    // Storage being unavailable is a cache miss, not a failure. The caller
    // falls back to the network, which is correct.
    return false;
  }
}

/**
 * Store one part.
 *
 * @throws {PartStoreError} if the write fails - the caller decides whether
 *   that is fatal. A failed store means a slower load, not a broken one.
 */
export async function putPart(version: string, name: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    await withStore(db, 'readwrite', (s) => s.put(data, partKey(version, name)));
  } finally {
    db.close();
  }
}

/**
 * Read a part back.
 *
 * @throws {PartStoreError} when absent - callers should check `hasPart`
 *   first, and treat a miss here as "re-fetch it".
 */
export async function getPart(version: string, name: string): Promise<ArrayBuffer> {
  const db = await openDb();
  try {
    const value = await withStore<ArrayBuffer | undefined>(
      db,
      'readonly',
      (s) => s.get(partKey(version, name)) as IDBRequest<ArrayBuffer | undefined>,
    );
    if (!value) {
      throw new PartStoreError(`part not stored: ${partKey(version, name)}`);
    }
    return value;
  } finally {
    db.close();
  }
}

/**
 * Total bytes currently held, for diagnostics.
 *
 * Reads each record's own header rather than materialising 493MB of
 * buffers just to add up their lengths: the value is an ArrayBuffer, so
 * `byteLength` is available without copying anything out of storage.
 */
export async function storedBytes(): Promise<number> {
  try {
    const db = await openDb();
    try {
      const keys = await withStore<IDBValidKey[]>(
        db,
        'readonly',
        (s) => s.getAllKeys(),
      );
      let total = 0;
      for (const key of keys) {
        const v = await withStore<ArrayBuffer | undefined>(
          db,
          'readonly',
          (s) => s.get(key) as IDBRequest<ArrayBuffer | undefined>,
        );
        total += v?.byteLength ?? 0;
      }
      return total;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Delete every part belonging to versions that are not `keepVersion`.
 *
 * Called after a successful load, so a user who picked up a new archive
 * does not carry two full copies forever.
 *
 * @returns how many keys were removed
 */
export async function pruneVersions(keepVersion: string): Promise<number> {
  try {
    const db = await openDb();
    try {
      const keys = await withStore<string[]>(db, 'readonly', (s) => s.getAllKeys() as IDBRequest<string[]>);
      const stale = keys.filter((k) => !String(k).startsWith(`${keepVersion}/`));
      if (stale.length === 0) return 0;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of stale) store.delete(k);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new PartStoreError('prune failed', tx.error as Error));
        tx.onabort = () => reject(new PartStoreError('prune aborted', tx.error as Error));
      });
      return stale.length;
    } finally {
      db.close();
    }
  } catch {
    // Failing to prune only wastes disk. Never fail a boot over it.
    return 0;
  }
}

/** Test seam: drop everything. */
export async function clearAllParts(): Promise<void> {
  const db = await openDb();
  try {
    await withStore(db, 'readwrite', (s) => s.clear());
  } finally {
    db.close();
  }
}