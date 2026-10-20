// The device store.
//
// Where the private keys live. The store is per-origin: IndexedDB is bound to
// the origin that opened it, and localStorage is bound to the origin it
// belongs to, so a script on another origin cannot read either. That is the
// property the whole design rests on, and the fallback chain is what keeps
// the client working in a browser that has neither.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as e from '../../packages/e2ee/index.js';

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    get length() { return values.size; },
    key: (index) => Array.from(values.keys())[index] || null,
  };
}

test('the device store', async (t) => {
  await t.test('the memory store keeps what it is given', async () => {
    const store = e.memoryStore();
    assert.equal(store.backend, 'memory');
    assert.equal(await store.get('nothing'), null);
    await store.set('device', '{"id":"d1"}');
    assert.equal(await store.get('device'), '{"id":"d1"}');
    assert.deepEqual(await store.keys(), ['device']);
    await store.remove('device');
    assert.equal(await store.get('device'), null);
  });

  await t.test('the localStorage store keeps what it is given', async () => {
    const area = fakeStorage();
    const store = e.localStorageStore(area);
    assert.equal(store.backend, 'localstorage');
    await store.set('device', '{"id":"d1"}');
    assert.equal(area.getItem('trycord.e2ee.device'), '{"id":"d1"}');
    assert.equal(await store.get('device'), '{"id":"d1"}');
    assert.deepEqual(await store.keys(), ['device']);
    await store.set('session:a', '{"id":"s1"}');
    assert.deepEqual((await store.keys()).sort(), ['device', 'session:a']);
    await store.clear();
    assert.deepEqual(await store.keys(), []);
  });

  await t.test('the store that is opened is the best one available', async () => {
    // This browser has no IndexedDB, so the store falls back.
    const store = await e.openStore({ namespace: 'test' });
    assert.ok(['indexeddb', 'localstorage', 'memory'].indexOf(store.backend) !== -1);
    assert.notEqual(store.backend, 'indexeddb', 'there is no IndexedDB here');
  });

  await t.test('a store can be asked for by name', async () => {
    const memory = await e.openStore({ backend: 'memory' });
    assert.equal(memory.backend, 'memory');
    const local = await e.openStore({ backend: 'localstorage', storage: fakeStorage() });
    assert.equal(local.backend, 'localstorage');
  });

  await t.test('a record is kept as text, and read back as an object', async () => {
    const store = e.memoryStore();
    await e.writeRecord(store, 'device', { id: 'd1', keys: { ik: { privateKey: 'x' } } });
    const raw = await store.get('device');
    assert.equal(typeof raw, 'string', 'the record is text, so every store holds the same thing');
    const read = await e.readRecord(store, 'device');
    assert.equal(read.id, 'd1');
    assert.equal(read.keys.ik.privateKey, 'x');
    assert.equal(await e.readRecord(store, 'nothing'), null);
    await e.removeRecord(store, 'device');
    assert.equal(await e.readRecord(store, 'device'), null);
  });

  await t.test('a record that is not text is not a record', async () => {
    const store = e.memoryStore();
    await store.set('device', 'not json at all');
    assert.equal(await e.readRecord(store, 'device'), null);
  });
});
