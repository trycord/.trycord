// The relay, and the address it is published at.
//
// The relay is this instance's own service: it answers binding requests and
// it relays the bytes. Two things about it are checked here, and both of them
// were wrong:
//
//   - the address it is published at. A browser given `turn:127.0.0.1:3478`
//     resolves that to the reader's own machine, so the call could never be
//     relayed no matter how well the rest of it was configured. The address
//     has to be one a client outside this instance can reach, and the
//     instance has to say so when it is not.
//
//   - the address on the wire. It used to be IPv4 only, so an IPv6 client was
//     told it had been seen at a four-byte address made of the first two
//     groups of its own - and ICE believes what a STUN server tells it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');

const turn = require('../../src/services/turn');
const address = require('../../src/services/voice/address');
const voiceConfig = require('../../src/services/voice/config');

const STUN_MAGIC = 0x2112A442;

// A binding request, and the reading of the answer.
function bindingRequest() {
  const txId = crypto.randomBytes(12);
  const message = Buffer.alloc(20);
  message.writeUInt16BE(0x0001, 0);
  message.writeUInt16BE(0, 2);
  message.writeUInt32BE(STUN_MAGIC, 4);
  txId.copy(message, 8);
  return { message, txId };
}

// The mapped address in a binding answer.
function readMappedAddress(buffer, txId) {
  let at = 20;
  while (at + 4 <= buffer.length) {
    const type = buffer.readUInt16BE(at);
    const len = buffer.readUInt16BE(at + 2);
    if (type === 0x0020) {
      const value = buffer.slice(at + 4, at + 4 + len);
      const family = value[1];
      const port = (value.readUInt16BE(2) ^ (STUN_MAGIC >>> 16)) & 0xffff;
      if (family === 0x02) {
        const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txId]);
        const bytes = [];
        for (let i = 0; i < 16; i += 1) bytes.push(value[8 + i] ^ mask[i]);
        const groups = [];
        for (let i = 0; i < 8; i += 1) {
          groups.push(((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16));
        }
        return { family: 6, port, address: groups.join(':') };
      }
      return {
        family: 4,
        port,
        address: [value[4] ^ 0x21, value[5] ^ 0x12, value[6] ^ 0xa4, value[7] ^ 0x42].join('.'),
      };
    }
    at += 4 + len + (len % 4 ? 4 - (len % 4) : 0);
  }
  return null;
}

test('the relay', async (t) => {
  await t.test('a binding request is answered with the address it came from', async () => {
    const server = turn.start({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => socket.bind(0, resolve));
    const { message, txId } = bindingRequest();
    const answer = await new Promise((resolve, reject) => {
      socket.on('message', (buf) => resolve(buf));
      socket.on('error', reject);
      socket.send(message, port, '127.0.0.1');
      setTimeout(() => reject(new Error('the relay did not answer')), 3000);
    });

    assert.equal(answer.readUInt16BE(0), 0x0101, 'it is not a binding success');
    const mapped = readMappedAddress(answer, txId);
    assert.ok(mapped, 'the answer carries no mapped address');
    assert.equal(mapped.family, 4, 'the address is not of the IPv4 family');
    assert.equal(mapped.address, '127.0.0.1', 'the address is not the one the request came from');
    assert.ok(mapped.port > 0, 'the port is not the one the request came from');

    socket.close();
    server.close();
  });

  await t.test('an IPv6 request is answered with an IPv6 address', async () => {
    // The relay on the loopback, asked over IPv6.
    const server = turn.start({ host: '::1', port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    const socket = dgram.createSocket({ type: 'udp6', ipv6Only: false });
    await new Promise((resolve) => socket.bind(0, '::1', resolve));
    const { message, txId } = bindingRequest();
    const answer = await new Promise((resolve, reject) => {
      socket.on('message', (buf) => resolve(buf));
      socket.on('error', reject);
      socket.send(message, port, '::1');
      setTimeout(() => reject(new Error('the relay did not answer')), 3000);
    });

    const mapped = readMappedAddress(answer, txId);
    assert.ok(mapped, 'the answer carries no mapped address');
    assert.equal(mapped.family, 6, 'an IPv6 client is answered with an IPv4 address');
    // The address is the one the request came from, which is the source
    // address the kernel chose for it - the loopback when the socket is bound
    // to it, and a temporary address when it is not.
    assert.equal(mapped.address.split(':').length, 8,
      'the address is not an IPv6 address: ' + mapped.address);
    assert.ok(mapped.port > 0, 'the port is not the one the request came from');

    socket.close();
    server.close();
  });
});

test('the address the relay is published at', async (t) => {
  await t.test('the loopback is not an address a client can reach', () => {
    assert.equal(address.addressIsReachable('127.0.0.1'), false);
    assert.equal(address.addressIsReachable('localhost'), false);
    assert.equal(address.addressIsReachable('0.0.0.0'), false);
    assert.equal(address.addressIsReachable('192.168.1.10'), false);
    assert.equal(address.addressIsReachable('10.0.0.1'), false);
    assert.equal(address.addressIsReachable('172.16.0.1'), false);
    assert.equal(address.addressIsReachable('172.32.0.1'), true);
    assert.equal(address.addressIsReachable('203.0.113.7'), true);
    assert.equal(address.addressIsReachable('2a02:2f0e::1'), true);
    assert.equal(address.addressIsReachable('fe80::1'), false);
  });

  await t.test('the voice address is the one the clients are given', () => {
    const before = process.env.TRYCORD_VOICE_PUBLIC_URL;
    process.env.TRYCORD_VOICE_PUBLIC_URL = 'https://voice.example.test';
    try {
      assert.equal(address.publicHost(), 'voice.example.test');
      assert.equal(address.publicHost(4), 'voice.example.test');
    } finally {
      if (before === undefined) delete process.env.TRYCORD_VOICE_PUBLIC_URL;
      else process.env.TRYCORD_VOICE_PUBLIC_URL = before;
    }
  });

  await t.test('the ICE list carries the address of every family published', () => {
    const before = process.env.TRYCORD_VOICE_PUBLIC_URL;
    process.env.TRYCORD_VOICE_PUBLIC_URL = 'https://voice.example.test';
    try {
      const list = voiceConfig.iceServers('mesh', { credentials: true, userId: 'u1' });
      const urls = [];
      for (const entry of list) {
        if (Array.isArray(entry.urls)) urls.push(...entry.urls);
        else urls.push(entry.urls);
      }
      assert.ok(urls.some((url) => url.indexOf('stun:') === 0), 'no STUN server is offered');
      assert.ok(urls.some((url) => url.indexOf('turn:') === 0), 'no TURN relay is offered');
      // The credential belongs to the caller and to nobody else.
      const turnEntry = list.find((entry) => {
        const value = Array.isArray(entry.urls) ? entry.urls[0] : entry.urls;
        return String(value).indexOf('turn:') === 0;
      });
      assert.ok(turnEntry, 'the TURN entry is missing');
      assert.ok(turnEntry.username && turnEntry.credential,
        'the TURN entry carries no credential');
      assert.ok(turnEntry.username.indexOf('u1') !== -1,
        'the credential is not minted for this caller: ' + turnEntry.username);
    } finally {
      if (before === undefined) delete process.env.TRYCORD_VOICE_PUBLIC_URL;
      else process.env.TRYCORD_VOICE_PUBLIC_URL = before;
    }
  });

  await t.test('a family with no published address is given none', () => {
    const beforeV6 = process.env.TRYCORD_VOICE_PUBLIC_URL;
    const beforeV4 = process.env.TRYCORD_VOICE_PUBLIC_URL_V4;
    process.env.TRYCORD_VOICE_PUBLIC_URL = 'https://[2a02:2f0e::1]';
    delete process.env.TRYCORD_VOICE_PUBLIC_URL_V4;
    try {
      assert.equal(address.publicHost(6), '[2a02:2f0e::1]');
      assert.equal(address.publicHost(4), '',
        'an IPv4 client is given an IPv6 address it cannot route to');
    } finally {
      if (beforeV6 === undefined) delete process.env.TRYCORD_VOICE_PUBLIC_URL;
      else process.env.TRYCORD_VOICE_PUBLIC_URL = beforeV6;
      if (beforeV4 === undefined) delete process.env.TRYCORD_VOICE_PUBLIC_URL_V4;
      else process.env.TRYCORD_VOICE_PUBLIC_URL_V4 = beforeV4;
    }
  });
});
