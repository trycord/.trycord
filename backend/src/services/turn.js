// In-house STUN/TURN server (RFC 5389 + RFC 5766).
//
// Operated entirely by the Trycord instance. No external STUN/TURN service is
// required. Provides:
//   - STUN Binding request/response — client discovers its reflexive address
//   - TURN Allocate — allocate a relay port for media relay
//   - TURN Refresh — keep an allocation alive
//   - TURN CreatePermission — authorize a peer to send via relay
//   - TURN ChannelBind — bind a channel number to a peer for compact framing
//   - TURN Send/Data indication — relay media bytes peer-to-peer via our relay
//
// Media is relayed byte-for-byte. DTLS-SRTP is handled by the browser clients;
// this process only moves packets.
//
// Configuration via environment:
//   TRYCORD_TURN_HOST     listen host (default 0.0.0.0)
//   TRYCORD_TURN_PORT     listen port (default 3478)
//   TRYCORD_TURN_REALM    realm for long-term credentials (default trycord-turn)
//   TRYCORD_TURN_STUNKEY  the shared secret the credentials are minted under
//                         (TRYCORD_TURN_SECRET is the older name for it)
//   TRYCORD_TURN_RELAY_MIN / TRYCORD_TURN_RELAY_MAX   the ports a relayed call may use
//
// The credentials: username = <expiry>:<name>, password = MD5(username :
// realm : stunkey). Coturn's derivation, so a host with the stunkey can mint
// credentials of its own and this relay accepts them.
//
// HTTP API (mounted by routes/voice.js under /api/turn):
//   GET /api/turn/credentials   issue short-term credentials for a username
//   GET /api/turn/status        daemon status
//
// Standalone: node src/services/turn.js

const crypto = require('crypto');
const dgram = require('dgram');

// ---- Protocol constants --------------------------------------------------

const STUN_MAGIC = 0x2112A442;

// The magic cookie as its four bytes, for the XOR encoding.
//
// RFC 5389 section 15.2: the port is XORed with the top 16 bits of the magic
// cookie and each octet of the address with the corresponding octet of the
// cookie. The cookie 0x2112A442 is the bytes 21 12 A4 42 in that order.
//
// This constant was used by the XOR-MAPPED-ADDRESS and XOR-PEER-ADDRESS
// encoders and never defined, so every binding request threw a ReferenceError
// inside the packet handler - and the handler swallowed it. The server bound
// the port, received the request, and answered nothing: a STUN server that
// listened and was silent, which is worse than one that was not there,
// because the port was open and the diagnostics said the relay was running.
const MAGIC = [0x21, 0x12, 0xa4, 0x42];

const STYPE = {
  BINDING_REQUEST:   0x0001,
  BINDING_RESPONSE:  0x0101,
  ALLOCATE_REQUEST:  0x0003,
  ALLOCATE_RESPONSE: 0x0103,
  ALLOCATE_ERROR:    0x0113,
  REFRESH_REQUEST:   0x0004,
  REFRESH_RESPONSE:  0x0104,
  CREATE_PERM_REQUEST:  0x003d,
  CREATE_PERM_RESPONSE:   0x013d,
  CHANNEL_BIND_REQUEST: 0x003f,
  CHANNEL_BIND_RESPONSE:  0x013f,
  SEND_INDICATION:   0x0016,
  DATA_INDICATION:   0x0018,
};

const ATTR = {
  MAPPED_ADDRESS:     0x0001,
  USERNAME:           0x0006,
  MESSAGE_INTEGRITY:  0x0008,
  ERROR_CODE:         0x0009,
  CHANNEL_NUMBER:     0x000c,
  LIFETIME:           0x000d,
  XOR_PEER_ADDRESS:   0x0012,
  DATA:               0x0013,
  REALM:              0x0014,
  NONCE:              0x0015,
  XOR_RELAYED_ADDRESS:0x0016,
  XOR_MAPPED_ADDRESS: 0x0020,
};

// ---- STUN codec ----------------------------------------------------------

function parseStun(buf) {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const len  = buf.readUInt16BE(2);
  const magic = buf.readUInt32BE(4);
  if (magic !== STUN_MAGIC) return null;
  if (buf.length < 20 + len) return null;
  const txId = Buffer.from(buf.slice(8, 20));
  const attrs = new Map();
  let pos = 20;
  const end = 20 + len;
  while (pos + 4 <= end) {
    const aType = buf.readUInt16BE(pos);
    const aLen  = buf.readUInt16BE(pos + 2);
    if (aLen > end - pos - 4) break;
    const v = buf.slice(pos + 4, pos + 4 + aLen);
    attrs.set(aType, { type: aType, length: aLen, value: v });
    pos += 4 + aLen;
    if (aLen % 4 !== 0) pos += 4 - (aLen % 4);
  }
  // The bytes are kept: the message-integrity check is over the packet as it
  // arrived, not over the attributes that were read out of it.
  return { type, length: len, txId, attrs, raw: buf };
}

// The address of a peer, in the form the protocol asks for.
//
// The port is the same for both families: it is the port with the high
// sixteen bits of the magic cookie XORed into it.
//
// The address is the one the client already has, with the magic cookie (and,
// for IPv6, the transaction id as well) XORed into it - so that the address
// on the wire is not the address of the peer in the clear.
//
// The family is in the first byte: 1 for IPv4 and 2 for IPv6. An IPv6
// address is sixteen bytes, and it is the transaction id that makes the XOR
// different from the IPv4 one - which is why the transaction id is needed
// here and not only in the header.
function xorAddress(address, port, transactionId) {
  const isV6 = String(address || '').indexOf(':') !== -1;
  const raw = isV6 ? ipv6Bytes(address) : ipv4Bytes(address);
  const mask = isV6
    ? Buffer.concat([Buffer.from(MAGIC), Buffer.from(transactionId || [])])
    : Buffer.from(MAGIC);
  const value = Buffer.alloc(isV6 ? 20 : 8);
  value[0] = 0;
  value[1] = isV6 ? 0x02 : 0x01;
  value.writeUInt16BE((port & 0xffff) ^ (STUN_MAGIC >>> 16), 2);
  for (let i = 0; i < raw.length; i += 1) value[4 + i] = raw[i] ^ mask[i];
  return value;
}

// The address the other way: the peer's address and port, read out of the
// value the protocol carries.
function parseXorAddress(buf, transactionId) {
  if (!buf || buf.length < 8) return null;
  const family = buf[1];
  const port = (buf.readUInt16BE(2) ^ (STUN_MAGIC >>> 16)) & 0xffff;
  if (family === 0x02) {
    if (buf.length < 20) return null;
    const mask = Buffer.concat([Buffer.from(MAGIC), Buffer.from(transactionId || [])]);
    const bytes = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = buf[4 + i] ^ mask[i];
    return { ip: ipv6Text(bytes), port, family: 6 };
  }
  const bytes = [buf[4] ^ 0x21, buf[5] ^ 0x12, buf[6] ^ 0xa4, buf[7] ^ 0x42];
  return { ip: bytes.join('.'), port, family: 4 };
}

// The four bytes of an IPv4 address.
function ipv4Bytes(address) {
  return Buffer.from(String(address || '0.0.0.0').split('.').map((part) => (Number(part) || 0) & 0xff));
}

// The sixteen bytes of an IPv6 address.
//
// The address is written in the usual eight groups of hexadecimal, and a
// "::" stands for the run of zero groups it replaces - so the address is
// expanded first and the groups are read out of it.
function ipv6Bytes(address) {
  const text = String(address || '').trim().replace(/^\[|\]$/g, '');
  let head = text;
  let tail = '';
  const gap = text.indexOf('::');
  if (gap !== -1) {
    head = text.slice(0, gap);
    tail = text.slice(gap + 2);
  }
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = headGroups.concat(new Array(Math.max(0, missing)).fill('0')).concat(tailGroups);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    const part = parseInt(groups[i] || '0', 16);
    out.writeUInt16BE(Number.isFinite(part) ? part : 0, i * 2);
  }
  return out;
}

// The text of sixteen bytes of an IPv6 address.
function ipv6Text(bytes) {
  const groups = [];
  for (let i = 0; i < 8; i += 1) groups.push(bytes.readUInt16BE(i * 2).toString(16));
  return groups.join(':');
}

function buildAttr(aType, valueBuf) {
  const pad = valueBuf.length % 4 === 0 ? 0 : 4 - (valueBuf.length % 4);
  const b = Buffer.alloc(4 + valueBuf.length + pad);
  b.writeUInt16BE(aType, 0);
  b.writeUInt16BE(valueBuf.length, 2);
  valueBuf.copy(b, 4);
  return b;
}

function buildHeader(type, txId, bodyLen) {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(bodyLen, 2);
  b.writeUInt32BE(STUN_MAGIC, 4);
  txId.copy(b, 8);
  return b;
}

// XOR-mapped address encoding (RFC 5389 §15.2).
// The address a client was seen at.
//
// The same encoding as the other addresses, and for the same reason: the
// address is not written on the wire in the clear. An IPv6 address is XORed
// with the magic cookie and the transaction id, as the protocol asks.
//
// It used to be IPv4 only, so an IPv6 client was told it had been seen at a
// four-byte address that was made of the first two groups of its own - and
// ICE, which believes what a STUN server tells it, believed it.
function xorMappedAddress(ip, port, transactionId) {
  return xorAddress(ip, port, transactionId);
}

function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest();
}
function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest(); }

// Long-term credential key: MD5(username:realm:password)
function longTermKey(username, realm, password) {
  return md5(`${username}:${realm}:${password}`);
}

function indexOfBuf(haystack, needle) {
  if (needle.length === 0) return 0;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

// ---- Configuration ------------------------------------------------------

function cfg() {
  return {
    // The relay is a service of this instance and it is meant to be reached
    // from outside it, so it listens on every interface unless the operator
    // names one. A browser given the loopback resolves that to the reader's
    // own machine, and a call can never be relayed through it.
    host:   process.env.TRYCORD_TURN_HOST   || '0.0.0.0',
    port:   Number(process.env.TRYCORD_TURN_PORT) || 3478,
    realm:  process.env.TRYCORD_TURN_REALM   || 'trycord-turn',
    secret: sharedSecret(),
  };
}

// ===== Allocation store =====

const allocations = new Map(); // key: "clientIp:clientPort"

function newAllocation(clientIp, clientPort) {
  const relay = dgram.createSocket('udp4');
  return {
    id: crypto.randomBytes(12).toString('hex'),
    clientIp,
    clientPort,
    relaySocket: relay,
    relayIp: null,
    relayPort: null,
    ready: false,
    lifetime: 600,
    expiresAt: Date.now() + 600000,
    peers: new Set(),
    channels: new Map(),
  };
}

function cleanupAllocations() {
  const now = Date.now();
  for (const [key, alloc] of allocations.entries()) {
    if (now > alloc.expiresAt) {
      try { alloc.relaySocket.close(); } catch {}
      allocations.delete(key);
    }
  }
}

// The sweep that expires stale allocations.
//
// Two things about it are deliberate. It is unref'd, so requiring this module
// - which the voice route does, on every boot - does not by itself keep a
// process alive: the server's own socket is what holds the standalone TURN
// process open, and nothing should hold it open after it has been stopped. And
// the handle is kept, so stopServer() can clear it; an interval that cannot be
// cleared is a leak that only shows up as a process that will not exit.
const allocationSweeper = setInterval(cleanupAllocations, 30000);
allocationSweeper.unref();

// ===== Auth =====

// The secret the credentials are made under - the "stunkey", as Coturn
// calls it. Anything that has to reach the relay needs to know it.
//
// There is deliberately no default. A default would be the same on every
// instance in the world, so a credential minted against one instance would
// verify against any other - and the credentials are what lets a client use
// the relay. An instance without a secret gets a secret of its own, made when
// the process starts, so the relay works and the credentials do not outlive
// it.
let generatedSecret = null;
function sharedSecret() {
  const configured = String(
    process.env.TRYCORD_TURN_STUNKEY || process.env.TRYCORD_TURN_SECRET || ''
  ).trim();
  if (configured) return configured;

  // The environment comes first, as it does for every secret. A key an
  // administrator saved is the instance's own.
  const saved = savedStunkey();
  if (saved) return saved;

  if (!generatedSecret) {
    generatedSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[turn] TRYCORD_TURN_STUNKEY is not set, so the credentials this '
      + 'instance issues are good only until it restarts. Set it to a secret of '
      + 'your own to keep them.');
  }
  return generatedSecret;
}

// The key the instance saved, or nothing.
//
// The settings are read lazily and quietly: a process that has not connected
// to the database has no saved key, and a key it cannot read is no reason to
// refuse to work.
function savedStunkey() {
  try {
    const settings = require('./settings');
    const value = settings.secretValue('voice.mesh.stunkey');
    return value ? String(value).trim() : '';
  } catch (e) {
    return '';
  }
}

// The address a client is given.
//
// The relay listens on every interface, and every interface is not an
// address a client can reach: "0.0.0.0" is a wildcard, not a place. The
// address the peers are given has to be the one they can use - the one the
// instance publishes, or the one the operator named.
// The address the relay is published at.
//
// It is the shared one, so the relay and the ICE configuration a client is
// given cannot disagree about it.
function publicHost(family) {
  return require('./voice/address').publicHost(family);
}

// The range the relay ports are taken from.
//
// A relay port is a real port on this host, and a range keeps the ports a
// client has to open known. The range is the listen port and the next
// hundred, unless the operator says otherwise.
function relayPortRange() {
  const from = Number(process.env.TRYCORD_TURN_RELAY_MIN || 0);
  const to = Number(process.env.TRYCORD_TURN_RELAY_MAX || 0);
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from) {
    return { from, to };
  }
  const base = Number(process.env.TRYCORD_TURN_PORT || 3478) || 3478;
  return { from: base + 1, to: base + 100 };
}

function defaultRealm() {
  return process.env.TRYCORD_TURN_REALM || 'trycord-turn';
}

function longTermKey(username, realm, password) {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

// The password a username is worth, right now.
//
// The derivation is Coturn's static-auth-secret one, which is the one everybody
// else implements:
//
//   password = MD5(username : realm : stunkey)
//
// The result is 32 characters of hex, and the client is given the username
// and the password and nothing else. A host that has the stunkey can mint its
// own credential for its own expiry, which is what makes the relay usable by
// something other than this instance's own API.
//
// The check on the other side is the other half of the same thing: the same
// username, the same realm, the same stunkey, and then the long-term key the
// standard builds from them.
function passwordFor(username, realm) {
  return crypto.createHash('md5')
    .update(`${username}:${realm || defaultRealm()}:${sharedSecret()}`, 'utf8')
    .digest('hex');
}

// The name and the expiry inside a username, or null when it is not one of
// ours.
function readUsername(username) {
  const text = String(username || '');
  const cut = text.indexOf(':');
  if (cut <= 0) return null;
  const expiry = Number(text.slice(0, cut));
  if (!Number.isFinite(expiry)) return null;
  return { expiry, name: text.slice(cut + 1) };
}

// The nonces this server has issued, per client address.
//
// A challenge is only good for the client it was sent to, and only for a
// short while. The nonce is what proves the client is in a conversation with
// this server rather than replaying a request it captured earlier.
const nonces = new Map();

// The key a nonce is filed under.
//
// The address *and the port*: a nonce is a conversation with one client, and
// two clients behind one address - two browsers behind one router, two
// sockets in one process - are two conversations. Keyed by the address alone,
// the second client's challenge replaced the first client's nonce, and the
// first client was then refused for a nonce it had been given correctly.
function clientKey(rinfo) {
  return rinfo.address + ':' + rinfo.port;
}

function issueNonce(key) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  for (const [existing, entry] of nonces) {
    if (now > entry.expiresAt) nonces.delete(existing);
  }
  nonces.set(key, { nonce, expiresAt: now + 60 * 1000 });
  return nonce;
}

function nonceFor(key) {
  const entry = nonces.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { nonces.delete(key); return null; }
  return entry.nonce;
}

// Check the credentials on a request.
//
// The rules, in the order they are applied:
//   - the username, the nonce and the message-integrity must all be there;
//   - the nonce must be one this server issued to this client, and must not
//     have expired - so a captured request cannot be replayed;
//   - the username must be one of ours, and must not have expired;
//   - the message-integrity must be the HMAC-SHA1 of the canonical message
//     under the key the client's password and the realm make.
function verifyAuth(parsed, rinfo) {
  const uBuf = parsed.attrs.get(ATTR.USERNAME);
  const realmBuf = parsed.attrs.get(ATTR.REALM);
  const nonceBuf = parsed.attrs.get(ATTR.NONCE);
  const integrity = parsed.attrs.get(ATTR.MESSAGE_INTEGRITY);
  if (!uBuf || !integrity || !nonceBuf) return null;

  const username = uBuf.value.toString('utf8').replace(/\0+$/, '');
  const realmStr = realmBuf ? realmBuf.value.toString('utf8').replace(/\0+$/, '') : defaultRealm();
  const nonce = nonceBuf.value.toString('utf8').replace(/\0+$/, '');

  // The nonce this server issued, to this client.
  const expectedNonce = nonceFor(clientKey(rinfo));
  if (!expectedNonce || nonce !== expectedNonce) return null;

  // The credential must be one of ours and must not have expired.
  const parts = readUsername(username);
  if (!parts) return null;
  if (parts.expiry * 1000 <= Date.now()) return null;

  const key = crypto.createHash('md5')
    .update(`${username}:${realmStr}:${passwordFor(username, realmStr)}`, 'utf8').digest();

  // The canonical message.
  //
  // RFC 5389 section 15.4: the HMAC is over the message up to (but not
  // including) the MESSAGE-INTEGRITY attribute itself, with the header as it
  // stands. The header's length field is the whole message's length - it
  // counts the MESSAGE-INTEGRITY attribute too - so the bytes are simply the
  // first part of the packet, unchanged.
  //
  // The rule used to be different: the input ran to the *value* of the
  // attribute, so it included the attribute's own header, and the length
  // field was rewritten to exclude the attribute altogether. Every client
  // that followed the standard was refused.
  const valueOffset = indexOfBuf(parsed.raw, integrity.value);
  const headerOffset = valueOffset - 4;
  if (headerOffset < 20) return null;
  const canonical = parsed.raw.slice(0, headerOffset);
  const expected = crypto.createHmac('sha1', key).update(canonical).digest();
  if (expected.length !== integrity.value.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ integrity.value[i];
  if (diff !== 0) return null;
  return { ok: true, username, realm: realmStr, name: parts.name, expiry: parts.expiry };
}

// The 401 that asks for credentials.
//
// The error code is 401 Unauthorized: two reserved bytes, the class (4) and
// the number (1). The nonce is remembered for this client, because the
// request that follows has to carry it back.
function sendAuthChallenge(socket, parsed, rinfo) {
  const nonce = issueNonce(clientKey(rinfo));
  const errBuf = Buffer.from([0, 0, 4, 1]);
  const body = Buffer.concat([
    buildAttr(ATTR.REALM, Buffer.from(defaultRealm(), 'utf8')),
    buildAttr(ATTR.NONCE, Buffer.from(nonce, 'utf8')),
    buildAttr(ATTR.ERROR_CODE, errBuf),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(parsed.type | 0x0110, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(STUN_MAGIC, 4);
  parsed.txId.copy(header, 8);
  const out = Buffer.concat([header, body]);
  socket.send(out, 0, out.length, rinfo.port, rinfo.address);
}

function sendError(socket, parsed, txId, code, rinfo) {
  const errBuf = Buffer.alloc(4);
  errBuf[0] = 0; errBuf[1] = 0;
  errBuf[2] = Math.floor(code / 100) & 0xff;
  errBuf[3] = code % 100;
  const body = Buffer.concat([buildAttr(ATTR.ERROR_CODE, errBuf)]);
  const header = Buffer.alloc(20);
  // An error response, not a success one: the class is 11 in the top two
  // bits of the message type, which is the method with 0x0110 set.
  header.writeUInt16BE(parsed.type | 0x0110, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(STUN_MAGIC, 4);
  parsed.txId.copy(header, 8);
  const out = Buffer.concat([header, body]);
  socket.send(out, 0, out.length, rinfo.port, rinfo.address);
}

// ===== Request handlers =====

function handlePacket(socket, buf, rinfo) {
  const parsed = parseStun(buf);
  if (!parsed) return;
  switch (parsed.type) {
    case STYPE.BINDING_REQUEST:
      handleBinding(socket, parsed, rinfo);
      break;
    case STYPE.ALLOCATE_REQUEST:
      handleAllocate(socket, parsed, rinfo);
      break;
    case STYPE.REFRESH_REQUEST:
      handleRefresh(socket, parsed, rinfo);
      break;
    case STYPE.CREATE_PERMISSION_REQUEST:
      handleCreatePermission(socket, parsed, rinfo);
      break;
    case STYPE.CHANNEL_BIND_REQUEST:
      handleChannelBind(socket, parsed, rinfo);
      break;
    case STYPE.SEND_INDICATION:
      handleSendIndication(socket, parsed, rinfo);
      break;
    default:
      // Unknown method — ignore silently.
      break;
  }
}

function handleBinding(socket, parsed, rinfo) {
  const xma = xorMappedAddress(rinfo.address, rinfo.port, parsed.txId);
  const body = buildAttr(ATTR.XOR_MAPPED_ADDRESS, xma);
  const header = buildHeader(STYPE.BINDING_RESPONSE, parsed.txId, body.length);
  const out = Buffer.concat([header, body]);
  socket.send(out, 0, out.length, rinfo.port, rinfo.address);
}

function handleAllocate(socket, parsed, rinfo) {
  const auth = verifyAuth(parsed, rinfo);
  if (!auth) {
    sendAuthChallenge(socket, parsed, rinfo);
    return;
  }
  const key = rinfo.address + ':' + rinfo.port;
  const prior = allocations.get(key);
  if (prior) { try { prior.relaySocket.close(); } catch {} allocations.delete(key); }

  // The socket family follows the family of the client that asked for the
  // allocation.
  //
  // It used to be IPv4 whatever the client was, so an IPv6 client's media
  // was relayed from an IPv4 socket: the bytes went nowhere, and the call
  // that was relayed silently carried no sound.
  const family = String(rinfo.address || '').indexOf(':') !== -1 ? 'udp6' : 'udp4';
  const relay = dgram.createSocket({ type: family, ipv6Only: false });
  const range = relayPortRange();
  // The relay port is taken from the range, so the ports a client has to
  // open are a known set rather than whatever the operating system happens
  // to hand out.
  const wanted = range.from + (allocations.size % Math.max(1, range.to - range.from + 1));
  relay.bind(wanted, family === 'udp6' ? '::' : '0.0.0.0', () => {
    const inf = relay.address();
    const alloc = {
      id: crypto.randomBytes(12).toString('hex'),
      clientIp: rinfo.address,
      clientPort: rinfo.port,
      // The address the client is told is the one it can reach, not the
      // wildcard this socket happens to be bound to.
      //
      // It is the address of the client's own family: an IPv4 client cannot
      // route to an IPv6 address, so telling it one would leave it waiting
      // for a relay that could never answer.
      relayIp: publicHost(String(rinfo.address || '').indexOf(':') === -1 ? 4 : 6),
      relayPort: inf.port,
      relaySocket: relay,
      lifetime: 600,
      expiresAt: Date.now() + 600000,
      peers: new Set(),
      channels: new Map(),
    };
    allocations.set(key, alloc);

    relay.on('message', (data, peerInfo) => {
      // Forward inbound packet from remote peer to our client via DataIndication.
      if (!allocations.has(key)) return;
      if (alloc.peers.size > 0 && !alloc.peers.has(peerInfo.address + ':' + peerInfo.port)) return;
      const xpeer = xorAddress(peerInfo.address, peerInfo.port, parsed.txId);
      const body = Buffer.concat([
        buildAttr(ATTR.XOR_PEER_ADDRESS, xpeer),
        buildAttr(ATTR.DATA, data),
      ]);
      const indHeader = Buffer.alloc(20);
      indHeader.writeUInt16BE(STYPE.DATA_INDICATION, 0);
      indHeader.writeUInt16BE(body.length, 2);
      indHeader.writeUInt32BE(STUN_MAGIC, 4);
      parsed.txId.copy(indHeader, 8);
      const indOut = Buffer.concat([indHeader, body]);
      try { socket.send(indOut, 0, indOut.length, rinfo.port, rinfo.address); } catch {}
    });
    relay.on('error', () => {});

    const lifetimeBuf = Buffer.alloc(4); lifetimeBuf.writeUInt32BE(alloc.lifetime, 0);
    const xra = xorAddress(alloc.relayIp, alloc.relayPort, parsed.txId);
    const body = Buffer.concat([
      buildAttr(ATTR.LIFETIME, lifetimeBuf),
      buildAttr(ATTR.XOR_RELAYED_ADDRESS, xra),
    ]);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(STYPE.ALLOCATE_RESPONSE, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(STUN_MAGIC, 4);
    parsed.txId.copy(header, 8);
    const out = Buffer.concat([header, body]);
    socket.send(out, 0, out.length, rinfo.port, rinfo.address);
  });
  relay.on('error', () => {});
}

function handleRefresh(socket, parsed, rinfo) {
  const alloc = allocations.get(rinfo.address + ':' + rinfo.port);
  if (!alloc) { sendError(socket, parsed.txId, 437, rinfo); return; }
  alloc.expiresAt = Date.now() + alloc.lifetime * 1000;
  const lifetimeBuf = Buffer.alloc(4); lifetimeBuf.writeUInt32BE(alloc.lifetime, 0);
  const body = buildAttr(ATTR.LIFETIME, lifetimeBuf);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(STYPE.REFRESH_RESPONSE, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(STUN_MAGIC, 4);
  parsed.txId.copy(header, 8);
  const out = Buffer.concat([header, body]);
  socket.send(out, 0, out.length, rinfo.port, rinfo.address);
}

function handleCreatePermission(socket, parsed, rinfo) {
  const auth = verifyAuth(parsed, rinfo);
  if (!auth) { sendAuthChallenge(socket, parsed, rinfo); return; }
  const alloc = allocations.get(rinfo.address + ':' + rinfo.port);
  if (!alloc) { sendError(socket, parsed.txId, 437, rinfo); return; }
  const peerBuf = parsed.attrs.get(ATTR.XOR_PEER_ADDRESS);
  if (!peerBuf) { sendError(socket, parsed.txId, 400, rinfo); return; }
  const peer = parseXorPeerAddress(peerBuf.value, parsed.txId);
  if (peer) alloc.peers.add(peer.ip + ':' + peer.port);
  const out = Buffer.alloc(20);
  out.writeUInt16BE(STYPE.CREATE_PERM_RESPONSE, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt32BE(STUN_MAGIC, 4);
  parsed.txId.copy(out, 8);
  socket.send(out, 0, out.length, rinfo.port, rinfo.address);
}

function handleChannelBind(socket, parsed, rinfo) {
  const alloc = allocations.get(rinfo.address + ':' + rinfo.port);
  if (!alloc) { sendError(socket, parsed.txId, 437, rinfo); return; }
  const chanBuf = parsed.attrs.get(ATTR.CHANNEL_NUMBER);
  const peerBuf = parsed.attrs.get(ATTR.XOR_PEER_ADDRESS);
  if (!chanBuf || !peerBuf) { sendError(socket, parsed.txId, 400, rinfo); return; }
  const channelNum = chanBuf.value.readUInt16BE(0);
  const peer = parseXorPeerAddress(peerBuf.value, parsed.txId);
  if (peer) alloc.channels.set(channelNum, peer.ip + ':' + peer.port);
  const out = Buffer.alloc(20);
  out.writeUInt16BE(STYPE.CHANNEL_BIND_RESPONSE, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt32BE(STUN_MAGIC, 4);
  parsed.txId.copy(out, 8);
  socket.send(out, 0, out.length, rinfo.port, rinfo.address);
}

function handleSendIndication(socket, parsed, rinfo) {
  const alloc = allocations.get(rinfo.address + ':' + rinfo.port);
  if (!alloc) return;
  const peerBuf = parsed.attrs.get(ATTR.XOR_PEER_ADDRESS);
  const dataBuf = parsed.attrs.get(ATTR.DATA);
  if (!peerBuf || !dataBuf) return;
  const peer = parseXorPeerAddress(peerBuf.value, parsed.txId);
  if (alloc.peers.size > 0 && !alloc.peers.has(peer.ip + ':' + peer.port)) return;
  if (alloc.relaySocket) {
    alloc.relaySocket.send(dataBuf.value, 0, dataBuf.value.length, peer.port, peer.ip);
  }
}

function parseXorPeerAddress(buf, transactionId) {
  const parsedAddress = parseXorAddress(buf, transactionId);
  if (!parsedAddress) return null;
  return { ip: parsedAddress.ip, port: parsedAddress.port };
}

// ===== Credential issuance (HTTP API) =====

// The credential this instance issues.
//
// The username is the expiry and the name, separated by a colon, which is the
// form Coturn uses and the form every TURN client understands. The password
// is the 32-character hash of the username, the realm and the stunkey, so a
// host that knows the stunkey can mint a credential of its own for as long as
// it likes - which is what "reachable from other hosts" means.
//
// The lifetime is an hour unless somebody asks for another. It is in the
// username, so the relay can refuse a credential that has run out without
// having to keep a list of the ones it handed out.
function issueCredentials(username, ttlSeconds) {
  const ttl = Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
    ? Math.floor(Number(ttlSeconds))
    : 3600;
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const name = `${expiry}:${username}`;
  return { username: name, password: passwordFor(name, defaultRealm()), ttl };
}

// ===== Server lifecycle =====

let server = null;
// The running server's own sweep, so stopping the server stops the sweep.
let activeSweeper = null;

function startServer(config) {
  const host = (config && config.host) || '127.0.0.1';
  // A port of zero is a port: it asks the operating system for an ephemeral
  // one. It used to be read as "no port", and the service bound 3478
  // whatever it was asked for - so a caller that wanted a port of its own
  // was refused the one it had asked for.
  const asked = Number(config && config.port);
  const port = Number.isFinite(asked) && asked >= 0 ? asked : 3478;

  // The socket is kept, so that stopServer() can close it.
  //
  // It was not kept: the function returned the socket and never recorded it,
  // so stopServer() closed nothing. The service kept its port open after it
  // had been told to stop, and a process that had started it could not exit.
  // That is what a test that starts the service and stops it found.
  if (server) {
    try { server.close(); } catch { /* already closed */ }
    server = null;
  }

  // The socket family follows the address the relay listens on.
  //
  // It used to be IPv4 whatever the address was, so a relay published at an
  // IPv6 address was a relay that no IPv6 client could reach: the socket
  // was listening on the IPv4 side of the host while the clients were given
  // the IPv6 one. A wildcard binds both families, and an IPv6 literal binds
  // the IPv6 one.
  const family = host === '::' || host === '[::]' || host.indexOf(':') !== -1 ? 'udp6' : 'udp4';
  const socket = dgram.createSocket({ type: family, ipv6Only: false });
  socket.on('message', (buf, rinfo) => {
    // A packet that cannot be handled is logged, not swallowed. The silent
    // catch is what hid the missing magic-cookie bytes for as long as this
    // file existed: the server received every request, threw, and said
    // nothing, and the diagnostics - which reported the port as open - looked
    // like a network problem rather than a fault in this file.
    try {
      handlePacket(socket, buf, rinfo);
    } catch (error) {
      console.error('[turn] a packet could not be handled: '
        + ((error && error.message) || error));
    }
  });
  socket.on('error', (e) => console.error('[turn] socket error', e && e.message));
  socket.bind(port, host, () => {
    // The port the socket actually got, which is not the one that was asked
    // for when the one that was asked for was zero.
    const bound = socket.address();
    console.log('[turn] STUN/TURN server listening on '
      + (bound ? bound.address : host) + ':' + (bound ? bound.port : port));
  });
  // The same sweep, started again for the running server. The module-level one
  // is already doing this work, so this is redundant - but the server's own
  // lifetime is what should decide, and the module-level sweep is unref'd, so
  // it is not a reason to keep a stopped server alive.
  const sweeper = setInterval(cleanupAllocations, 30000);
  sweeper.unref();
  activeSweeper = sweeper;
  server = socket;
  return socket;
}

function stopServer() {
  try { server && server.close(); } catch {}
  server = null;
  // The socket that was open is closed above; the handle is cleared so a
  // second stop does not try to close it again.
  if (activeSweeper) { clearInterval(activeSweeper); activeSweeper = null; }
  for (const a of allocations.values()) try { a.relaySocket.close(); } catch {}
  allocations.clear();
}

if (require.main === module) {
  const port = Number(process.env.TRYCORD_TURN_PORT || 3478);
  const host = process.env.TRYCORD_TURN_HOST || '0.0.0.0';
  const s = startServer({ port, host });
  process.on('SIGTERM', () => { stopServer(); process.exit(0); });
  process.on('SIGINT', () => { stopServer(); process.exit(0); });
}

module.exports = { start: startServer, stop: stopServer, issueCredentials, parseStun };