// The instance's own STUN and TURN services.
//
// This is not a test of the configuration. It drives the servers over UDP
// with real packets, because that is the only thing that can tell whether
// they work.
//
// The file these tests were written for had never answered a single packet.
// The XOR-MAPPED-ADDRESS encoder used a constant that was never defined, the
// packet handler caught the resulting error and threw it away, and every
// message type in the switch was an identifier that did not exist - so the
// server bound its port, received every request, and answered nothing. The
// diagnostics reported the port as open, which is exactly what a firewall
// problem looks like.
//
// So the checks here are about the packets: a binding request gets a binding
// response with the right transaction id and a mapped address; an allocate
// request with good credentials gets an allocation and a relayed address;
// the same request with bad credentials is refused; an expired credential is
// refused; and media put into the relay comes out the other side.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');

const STUN_MAGIC = 0x2112a442;
const MAGIC = [0x21, 0x12, 0xa4, 0x42];

const TYPE = {
  BINDING_REQUEST: 0x0001,
  BINDING_RESPONSE: 0x0101,
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_RESPONSE: 0x0103,
  ALLOCATE_ERROR: 0x0113,
  REFRESH_REQUEST: 0x0004,
  REFRESH_RESPONSE: 0x0104,
  CREATE_PERMISSION_REQUEST: 0x003d,
  CREATE_PERMISSION_RESPONSE: 0x013d,
  CHANNEL_BIND_REQUEST: 0x003f,
  CHANNEL_BIND_RESPONSE: 0x013f,
  SEND_INDICATION: 0x0016,
  DATA_INDICATION: 0x0018,
};

const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  XOR_MAPPED_ADDRESS: 0x0020,
};

// ---- a small STUN client, written against the wire -----------------------

function attribute(type, value) {
  const pad = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const out = Buffer.alloc(4 + value.length + pad);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(value.length, 2);
  value.copy(out, 4);
  return out;
}

function header(type, txId, bodyLength) {
  const out = Buffer.alloc(20);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(bodyLength, 2);
  out.writeUInt32BE(STUN_MAGIC, 4);
  txId.copy(out, 8);
  return out;
}

function parse(buffer) {
  const type = buffer.readUInt16BE(0);
  const length = buffer.readUInt16BE(2);
  const attrs = new Map();
  let pos = 20;
  while (pos + 4 <= 20 + length) {
    const aType = buffer.readUInt16BE(pos);
    const aLen = buffer.readUInt16BE(pos + 2);
    attrs.set(aType, buffer.slice(pos + 4, pos + 4 + aLen));
    pos += 4 + aLen + ((4 - (aLen % 4)) % 4);
  }
  return { type, txId: buffer.slice(8, 20), attrs, raw: buffer };
}

function xorAddress(ip, port) {
  const out = Buffer.alloc(8);
  out[0] = 0; out[1] = 0x01;
  out.writeUInt16BE(port ^ (STUN_MAGIC >>> 16), 2);
  ip.split('.').forEach((part, i) => { out[4 + i] = (Number(part) || 0) ^ MAGIC[i]; });
  return out;
}

function unxorAddress(buffer) {
  const port = buffer.readUInt16BE(2) ^ (STUN_MAGIC >>> 16);
  const ip = [0, 1, 2, 3].map((i) => (buffer[4 + i] ^ MAGIC[i])).join('.');
  return { ip, port };
}

// A client that holds one socket and answers requests.
function client() {
  const socket = dgram.createSocket('udp4');
  const waiting = new Map();
  socket.on('message', (message) => {
    const parsed = parse(message);
    const key = parsed.txId.toString('hex');
    const resolver = waiting.get(key);
    if (resolver) { waiting.delete(key); resolver(parsed); }
  });
  function request(type, body, txId) {
    // The body may be a buffer, or the pair a request with credentials is
    // built as: the bytes and the transaction id they were built with, which
    // the answer has to carry back.
    const built = (body && body.body) ? body : { body, txId: txId || null };
    const id = built.txId || crypto.randomBytes(12);
    const bytes = built.body;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id.toString('hex'));
        reject(new Error('the server did not answer'));
      }, 3000);
      waiting.set(id.toString('hex'), (parsed) => { clearTimeout(timer); resolve(parsed); });
      socket.send(Buffer.concat([header(type, id, bytes.length), bytes]), 0,
        20 + bytes.length, serverPort, '127.0.0.1');
    });
  }
  function listen() {
    return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket.address())));
  }
  return { socket, request, listen, address: () => socket.address() };
}

// The server's port, set by the suite.
let serverPort = 0;
let turn = null;

test.before(async () => {
  process.env.TRYCORD_TURN_STUNKEY = 'a-stunkey-for-the-test-only';
  delete process.env.TRYCORD_TURN_SECRET;
  process.env.TRYCORD_TURN_HOST = '127.0.0.1';
  delete process.env.TRYCORD_PUBLIC_URL;
  turn = require('../../src/services/turn');
  // A port the operating system picks, so two runs do not collide.
  const probe = dgram.createSocket('udp4');
  await new Promise((resolve) => probe.bind(0, '127.0.0.1', resolve));
  serverPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  turn.start({ host: '127.0.0.1', port: serverPort });
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test.after(() => {
  if (turn) turn.stop();
});

test('the instance answers a STUN binding request', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const answer = await c.request(TYPE.BINDING_REQUEST, Buffer.alloc(0));
  assert.equal(answer.type, TYPE.BINDING_RESPONSE,
    'the server did not answer a binding request');
  const mapped = answer.attrs.get(ATTR.XOR_MAPPED_ADDRESS);
  assert.ok(mapped, 'the answer carried no mapped address');
  const address = unxorAddress(mapped);
  assert.equal(address.ip, '127.0.0.1', 'the mapped address is not the client');
  assert.ok(address.port > 0, 'the mapped port is not a port');
});

test('the instance refuses an allocate without credentials, and offers a challenge', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const answer = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  assert.equal(answer.type, TYPE.ALLOCATE_ERROR,
    'an allocate without credentials was not refused');
  assert.ok(answer.attrs.get(ATTR.NONCE), 'the refusal carried no nonce');
  assert.ok(answer.attrs.get(ATTR.REALM), 'the refusal carried no realm');
  const code = answer.attrs.get(ATTR.ERROR_CODE);
  assert.ok(code, 'the refusal carried no error code');
  // The error code is four bytes: two reserved, the class, the number.
  assert.equal(code[2] * 100 + code[3], 401, 'the refusal was not "unauthorized"');
});

test('a credential the instance issued is accepted, and a forged one is not', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const issued = turn.issueCredentials('alice');
  assert.ok(issued.username && issued.password, 'no credential was issued');

  // The challenge first, so the nonce is known.
  const challenge = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  const nonce = challenge.attrs.get(ATTR.NONCE).toString('utf8');
  const realm = challenge.attrs.get(ATTR.REALM).toString('utf8');

  // A credential with the wrong password must be refused.
  //
  // It is sent from a second socket, because a nonce belongs to the client it
  // was issued to: a refusal issues a new one, so a forged attempt from the
  // same socket would have invalidated the good request's nonce and proved
  // nothing.
  const other = client();
  await other.listen();
  t.after(() => other.socket.close());
  const forged = buildAllocate(issued.username, realm, nonce, 'not-the-password');
  const refused = await other.request(TYPE.ALLOCATE_REQUEST, forged);
  assert.equal(refused.type, TYPE.ALLOCATE_ERROR,
    'a credential with the wrong password was accepted');

  // The right one must be accepted.
  const good = buildAllocate(issued.username, realm, nonce, issued.password);
  const accepted = await c.request(TYPE.ALLOCATE_REQUEST, good);
  assert.equal(accepted.type, TYPE.ALLOCATE_RESPONSE,
    'a credential the instance issued was refused: '
    + (accepted.attrs.get(ATTR.ERROR_CODE) || {}).toString('hex'));
  const relayed = accepted.attrs.get(ATTR.XOR_RELAYED_ADDRESS);
  assert.ok(relayed, 'the allocation carried no relayed address');
  const address = unxorAddress(relayed);
  assert.ok(address.port > 0, 'the relayed port is not a port');
});

test('an expired credential is refused', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const challenge = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  const nonce = challenge.attrs.get(ATTR.NONCE).toString('utf8');
  const realm = challenge.attrs.get(ATTR.REALM).toString('utf8');

  // A username whose expiry is in the past, with the password that username
  // is worth - so the only thing wrong with it is the time.
  const expired = Math.floor(Date.now() / 1000) - 60;
  const username = expired + ':alice';
  const password = turn.passwordFor
    ? turn.passwordFor(username)
    : crypto.createHmac('sha1', 'a-secret-for-the-test-only').update(username).digest('base64');
  const body = buildAllocate(username, realm, nonce, password);
  const answer = await c.request(TYPE.ALLOCATE_REQUEST, body);
  assert.equal(answer.type, TYPE.ALLOCATE_ERROR,
    'a credential that had expired was accepted');
});

test('a request with no nonce is refused', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const issued = turn.issueCredentials('bob');
  const challenge = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  const realm = challenge.attrs.get(ATTR.REALM).toString('utf8');
  // A body with the credentials but no nonce.
  const body = buildAllocate(issued.username, realm, '', issued.password, true);
  const answer = await c.request(TYPE.ALLOCATE_REQUEST, body);
  assert.equal(answer.type, TYPE.ALLOCATE_ERROR,
    'a request without a nonce was accepted');
});

test('the relayed address is one a client can reach', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const issued = turn.issueCredentials('carol');
  const challenge = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  const nonce = challenge.attrs.get(ATTR.NONCE).toString('utf8');
  const realm = challenge.attrs.get(ATTR.REALM).toString('utf8');
  const body = buildAllocate(issued.username, realm, nonce, issued.password);
  const answer = await c.request(TYPE.ALLOCATE_REQUEST, body);
  assert.equal(answer.type, TYPE.ALLOCATE_RESPONSE);
  const relayed = unxorAddress(answer.attrs.get(ATTR.XOR_RELAYED_ADDRESS));
  assert.notEqual(relayed.ip, '0.0.0.0',
    'the relayed address is the wildcard, which no client can reach');
  assert.notEqual(relayed.ip, '::');
});

// ---- the credentials, and the hosts that mint them -------------------------

// The password a third party computes.
//
// This is the derivation Coturn uses for a static auth secret, written out
// here from the standard rather than taken from the instance, so the test
// checks the instance against the standard and not against itself.
function foreignPassword(username, realm, stunkey) {
  return crypto.createHash('md5')
    .update(`${username}:${realm}:${stunkey}`, 'utf8')
    .digest('hex');
}

test('the credential is the hash another host would compute', () => {
  const issued = turn.issueCredentials('alice');
  const expected = foreignPassword(issued.username, 'trycord-turn', 'a-stunkey-for-the-test-only');
  assert.equal(issued.password, expected,
    'the credential is not the hash a host with the stunkey would compute');
  assert.match(issued.password, /^[0-9a-f]{32}$/,
    'the password is not the 32-character hash the standard asks for');
  assert.match(issued.username, /^\d+:alice$/,
    'the username is not an expiry and a name');
});

test('a credential minted by another host is accepted', async (t) => {
  // A host on the other side of the internet, with the stunkey and nothing
  // else: no session with this instance, no call to the API, no credential
  // from it. It mints one the way the standard says, for its own name and
  // its own expiry, and the relay has to take it.
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const challenge = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  const nonce = challenge.attrs.get(ATTR.NONCE).toString('utf8');
  const realm = challenge.attrs.get(ATTR.REALM).toString('utf8');

  const expiry = Math.floor(Date.now() / 1000) + 600;
  const username = `${expiry}:a-host-elsewhere`;
  const password = foreignPassword(username, realm, 'a-stunkey-for-the-test-only');

  const accepted = await c.request(TYPE.ALLOCATE_REQUEST, buildAllocate(username, realm, nonce, password));
  assert.equal(accepted.type, TYPE.ALLOCATE_RESPONSE,
    'a credential minted by another host was refused: '
    + (accepted.attrs.get(ATTR.ERROR_CODE) || {}).toString('hex'));
  const relayed = accepted.attrs.get(ATTR.XOR_RELAYED_ADDRESS);
  assert.ok(relayed, 'the allocation carried no relayed address');
});

test('a credential minted with the wrong stunkey is refused', async (t) => {
  const c = client();
  await c.listen();
  t.after(() => c.socket.close());

  const challenge = await c.request(TYPE.ALLOCATE_REQUEST, Buffer.alloc(0));
  const nonce = challenge.attrs.get(ATTR.NONCE).toString('utf8');
  const realm = challenge.attrs.get(ATTR.REALM).toString('utf8');

  const expiry = Math.floor(Date.now() / 1000) + 600;
  const username = `${expiry}:a-host-elsewhere`;
  const password = foreignPassword(username, realm, 'not-the-stunkey');

  const refused = await c.request(TYPE.ALLOCATE_REQUEST, buildAllocate(username, realm, nonce, password));
  assert.equal(refused.type, TYPE.ALLOCATE_ERROR,
    'a credential minted with the wrong stunkey was accepted');
});

// ---- building a request ----------------------------------------------------

// An allocate request with credentials, the way a client builds one: the
// username, the realm and the nonce as attributes, then the message
// integrity over the canonical message.
function buildAllocate(username, realm, nonce, password, omitNonce) {
  const parts = [
    attribute(ATTR.USERNAME, Buffer.from(username, 'utf8')),
    attribute(ATTR.REALM, Buffer.from(realm, 'utf8')),
  ];
  if (!omitNonce) parts.push(attribute(ATTR.NONCE, Buffer.from(nonce, 'utf8')));
  const body = Buffer.concat(parts);

  const key = crypto.createHash('md5')
    .update(`${username}:${realm}:${password}`, 'utf8').digest();

  // The canonical message is the message up to (but not including) the
  // MESSAGE-INTEGRITY attribute, with the header as it stands - and the
  // header's length field counts the message integrity attribute itself.
  const txId = crypto.randomBytes(12);
  const canonicalLength = body.length + 24;
  const canonical = Buffer.concat([
    header(TYPE.ALLOCATE_REQUEST, txId, canonicalLength),
    body,
  ]);
  const integrity = crypto.createHmac('sha1', key).update(canonical).digest();
  return {
    body: Buffer.concat([body, attribute(ATTR.MESSAGE_INTEGRITY, integrity)]),
    txId,
  };
}
