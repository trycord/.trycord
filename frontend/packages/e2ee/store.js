// The device store: where the private keys live.
//
// The private halves of a device's key set never leave this store. The store
// is per-origin - IndexedDB is bound to the origin that created it, and a
// script on another origin cannot read it - which is the property the whole
// design rests on. When IndexedDB is not there, localStorage is used, which
// is also per-origin, and when neither is there the store is in memory and
// the device says so rather than pretending.
//
// The store holds JSON text rather than live objects, so the same record can
// be written to IndexedDB, to localStorage and to a test's memory store
// without being reshaped on the way.

/** The prefix every key of the store carries. */
export const STORE_PREFIX = 'trycord.e2ee.';

/** The name of the IndexedDB database. */
export const DB_NAME = 'trycord-e2ee';

/** The object store inside it. */
export const DB_STORE = 'records';

/**
 * A store kept in memory.
 *
 * Used when the browser has neither IndexedDB nor localStorage - private
 * browsing in some engines - and by the tests. Nothing survives a reload,
 * which is why the device is registered again when it is used again.
 */
export function memoryStore() {
  const values = new Map();
  return {
    backend: 'memory',
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, String(value));
    },
    async remove(key) {
      values.delete(key);
    },
    async keys() {
      return Array.from(values.keys());
    },
    async clear() {
      values.clear();
    },
  };
}

/**
 * A store kept in localStorage.
 *
 * The fallback for a browser without IndexedDB. It is per-origin as well,
 * so the private keys are no more readable from another origin than they
 * would be in IndexedDB - only a script on this origin can read them, and a
 * script on this origin can read IndexedDB too.
 */
export function localStorageStore(storage) {
  const area = storage || (globalThis.localStorage);
  if (!area) throw new Error('localStorage is not available');
  const prefix = STORE_PREFIX;
  return {
    backend: 'localstorage',
    async get(key) {
      return area.getItem(prefix + key);
    },
    async set(key, value) {
      area.setItem(prefix + key, String(value));
    },
    async remove(key) {
      area.removeItem(prefix + key);
    },
    async keys() {
      const out = [];
      for (let i = 0; i < area.length; i += 1) {
        const key = area.key(i);
        if (key && key.startsWith(prefix)) out.push(key.slice(prefix.length));
      }
      return out;
    },
    async clear() {
      for (const key of await this.keys()) area.removeItem(prefix + key);
    },
  };
}

/**
 * A store kept in IndexedDB.
 *
 * One database, one object store, and the key is the record's name. The
 * values are the same JSON text the other backends hold.
 */
export async function indexedDbStore(namespace) {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available');
  const db = await new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME + (namespace ? '-' + namespace : ''), 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB would not open'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });

  const run = (mode, action) => new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, mode);
    const store = transaction.objectStore(DB_STORE);
    let result;
    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB refused the write'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB aborted the write'));
  });

  return {
    backend: 'indexeddb',
    async get(key) {
      const request = await run('readonly', (store) => store.get(key));
      return request === undefined ? null : request;
    },
    async set(key, value) {
      await run('readwrite', (store) => store.put(String(value), key));
    },
    async remove(key) {
      await run('readwrite', (store) => store.delete(key));
    },
    async keys() {
      const request = await run('readonly', (store) => store.getAllKeys());
      return Array.isArray(request) ? request : [];
    },
    async clear() {
      await run('readwrite', (store) => store.clear());
    },
  };
}

/**
 * The store to use.
 *
 * IndexedDB when the browser has it, localStorage when it does not, and
 * memory when it has neither. The choice is reported in `backend`, so the
 * settings page can say where the keys are.
 *
 * @param {object} options { backend, namespace, storage }
 */
export async function openStore(options = {}) {
  const wanted = options.backend || 'auto';
  const namespace = options.namespace || '';
  if (wanted === 'memory') return memoryStore();
  if (wanted === 'localstorage') return localStorageStore(options.storage);
  if (wanted === 'indexeddb') return indexedDbStore(namespace);
  try {
    return await indexedDbStore(namespace);
  } catch {
    try {
      return localStorageStore(options.storage);
    } catch {
      return memoryStore();
    }
  }
}

/** Read a record. Returns null when it is not there. */
export async function readRecord(store, key) {
  const raw = await store.get(key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a record. */
export async function writeRecord(store, key, value) {
  await store.set(key, JSON.stringify(value));
}

/** Remove a record. */
export async function removeRecord(store, key) {
  await store.remove(key);
}
