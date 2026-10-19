/**
 * Secure credential storage.
 *
 * The session token is the one secret this client holds, and it is held in the
 * platform keystore: the iOS Keychain through react-native-keychain, and on
 * Android the Keystore-backed encrypted preferences behind the same library.
 * It is never written to AsyncStorage, never written to a file, and never put
 * in a URL.
 *
 * The interface is separated from the implementation so the unit tests can
 * exercise the storage rules without a device, and so the choice of keystore
 * is one line in one file.
 */

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The part of react-native-keychain this client uses. */
export interface KeychainLike {
  setGenericPassword(
    username: string,
    password: string,
    options: {service: string},
  ): Promise<unknown>;
  getGenericPassword(
    options: {service: string},
  ): Promise<false | {username: string; password: string}>;
  resetGenericPassword(options: {service: string}): Promise<boolean>;
}

/**
 * The prefix of every service name this client writes. A Keychain service is
 * a namespace, not a secret, but keeping the app's entries under one prefix
 * makes them findable and makes it obvious that they are ours.
 */
export const KEYCHAIN_SERVICE_PREFIX = 'dev.trycord.';

/**
 * Turns a storage key into a Keychain service name.
 *
 * A service name may only contain letters, digits, dot, dash and underscore,
 * and the keys here are instance origins - which contain a colon and a slash.
 * The readable part is kept and a hash of the whole key is appended, so two
 * instances never share one entry and the name stays short.
 */
export function keychainServiceName(key: string): string {
  const readable = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  return `${KEYCHAIN_SERVICE_PREFIX}${readable}.${fnv1a(key)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = hash ^ text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The store used in production. It writes into the platform keystore and
 * nowhere else.
 */
export function createSecureStore(keychain: KeychainLike): SecureStore {
  return {
    async get(key: string): Promise<string | null> {
      const found = await keychain.getGenericPassword({
        service: keychainServiceName(key),
      });
      if (!found || typeof found.password !== 'string' || !found.password) {
        return null;
      }
      return found.password;
    },

    async set(key: string, value: string): Promise<void> {
      await keychain.setGenericPassword('trycord', value, {
        service: keychainServiceName(key),
      });
    },

    async remove(key: string): Promise<void> {
      await keychain.resetGenericPassword({
        service: keychainServiceName(key),
      });
    },
  };
}
