/**
 * Secure credential storage.
 *
 * The rules the store holds to: a key becomes a service name the platform
 * accepts, two different keys never share one entry, and a value that is not
 * there reads as nothing rather than as an error.
 */

import {createSecureStore, keychainServiceName, KeychainLike} from '../secureStore';

function fakeKeychain(): KeychainLike & {entries: Map<string, string>} {
  const entries = new Map<string, string>();
  return {
    entries,
    async setGenericPassword(_username, password, options) {
      entries.set(options.service, password);
      return {service: options.service, storage: 'keychain'};
    },
    async getGenericPassword(options) {
      const found = entries.get(options.service);
      if (found === undefined) return false;
      return {username: 'trycord', password: found};
    },
    async resetGenericPassword(options) {
      entries.delete(options.service);
      return true;
    },
  };
}

describe('the secure store', () => {
  it('writes a value and gives it back', async () => {
    const store = createSecureStore(fakeKeychain());

    await store.set('trycord.session.https://one.example', 'token-one');

    await expect(
      store.get('trycord.session.https://one.example'),
    ).resolves.toBe('token-one');
  });

  it('answers nothing for a value that is not there', async () => {
    const store = createSecureStore(fakeKeychain());

    await expect(store.get('trycord.session.https://one.example')).resolves.toBeNull();
  });

  it('forgets a value', async () => {
    const store = createSecureStore(fakeKeychain());
    await store.set('key', 'value');

    await store.remove('key');

    await expect(store.get('key')).resolves.toBeNull();
  });

  it('keeps two keys apart', async () => {
    const store = createSecureStore(fakeKeychain());

    await store.set('trycord.session.https://one.example', 'one');
    await store.set('trycord.session.https://two.example', 'two');

    await expect(
      store.get('trycord.session.https://one.example'),
    ).resolves.toBe('one');
    await expect(
      store.get('trycord.session.https://two.example'),
    ).resolves.toBe('two');
  });

  it('writes a service name the platform accepts', () => {
    const name = keychainServiceName('trycord.session.https://one.example');

    expect(name.startsWith('dev.trycord.')).toBe(true);
    expect(/^[A-Za-z0-9._-]+$/.test(name)).toBe(true);
  });

  it('writes a different service name for every key', () => {
    const one = keychainServiceName('trycord.session.https://one.example');
    const two = keychainServiceName('trycord.session.https://two.example');

    expect(one).not.toBe(two);
  });
});
