/**
 * Ordinary local storage.
 *
 * This is where anything that is not a secret lives: the chosen instance, the
 * list of known instances, the draft index, the small settings the app keeps
 * on the device. The session token is not here; it is in the keystore.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * An in-memory store, for the unit tests and for the moment before the
 * platform storage is ready.
 */
export function createMemoryStore(seed: Record<string, string> = {}): KeyValueStore {
  const values: Record<string, string> = {...seed};
  return {
    async get(key: string): Promise<string | null> {
      return Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : null;
    },
    async set(key: string, value: string): Promise<void> {
      values[key] = value;
    },
    async remove(key: string): Promise<void> {
      delete values[key];
    },
  };
}
