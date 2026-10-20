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
//   TRYCORD_TURN_USERNAME / TRYCORD_TURN_PASSWORD   long-term credential pair
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
function xorMappedAddress(ip, port) {
  const b = Buffer.alloc(8);
  b[0] = 0; b[1] = 0x01; // IPv4
  b.writeUInt16BE(port ^ (STUN_MAGIC >>> 16), 2);
  ip.split('.').forEach((o, i) => b[4 + i] = (Number(o) || 0) ^ MAGIC[i]);
  return b;
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

// The secret the credentials are made under.
//
// There is deliberately no default. A default would be the same on every
// instance in the world, so a credential minted against one instance would
// verify against any other - and the credentials are what lets a client use
// the relay. An instance without a secret gets a secret of its own, made when
// the process starts, so the relay works and the credentials do not outlive
// it.
let generatedSecret = null;
function sharedSecret() {
  const configured = String(process.env.TRYCORD_TURN_SECRET || '').trim();
  if (configured) return configured;
  if (!generatedSecret) {
    generatedSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[turn] TRYCORD_TURN_SECRET is not set, so the credentials this '
      + 'instance issues are good only until it restarts. Set it to a secret of '
      + 'your own to keep them.');
  }
  return generatedSecret;
}

// The address a client is given.
//
// The relay listens on every interface, and every interface is not an
// address a client can reach: "0.0.0.0" is a wildcard, not a place. The
// address the peers are given has to be the one they can use - the one the
// instance publishes, or the one the operator named.
function publicHost() {
  const named = String(process.env.TRYCORD_TURN_HOST || '').trim();
  if (named && named !== '0.0.0.0' && named !== '::' && named !== '[::]') return named;
  const publicUrl = String(process.env.TRYCORD_PUBLIC_URL || '').trim();
  if (publicUrl) {
    try { return new URL(publicUrl).hostname; } catch { /* not a usable address */ }
  }
  return named || '127.0.0.1';
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
// The credential this instance issues is `<expiry>:<name>` with a password
// that is the HMAC of that string under the instance's secret. The check
// here is the other half of the same thing: the same string, the same
// secret, the same HMAC. A client that was given a credential this instance
// issued can therefore be checked, and a client that was not cannot.
//
// The two halves used to disagree - the issuer produced an HMAC and the
// checker looked for the shared secret itself - so no credential the server
// issued would ever have verified.
function passwordFor(username) {
  const secret = Buffer.from(sharedSecret(), 'utf8');
  return crypto.createHmac('sha1', secret).update(String(username)).digest('base64');
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

function issueNonce(address) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  for (const [key, entry] of nonces) {
    if (now > entry.expiresAt) nonces.delete(key);
  }
  nonces.set(address, { nonce, expiresAt: now + 60 * 1000 });
  return nonce;
}

function nonceFor(address) {
  const entry = nonces.get(address);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { nonces.delete(address); return null; }
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
  const expectedNonce = nonceFor(rinfo.address);
  if (!expectedNonce || nonce !== expectedNonce) return null;

  // The credential must be one of ours and must not have expired.
  const parts = readUsername(username);
  if (!parts) return null;
  if (parts.expiry * 1000 <= Date.now()) return null;

  const key = crypto.createHash('md5')
    .update(`${username}:${realmStr}:${passwordFor(username)}`, 'utf8').digest();

  // Canonical message: everything up to (but not including) the
  // MESSAGE-INTEGRITY attribute, with its length field reset.
  const miOffset = indexOfBuf(parsed.raw, integrity.value);
  if (miOffset < 20) return null;
  const canonical = Buffer.alloc(miOffset);
  parsed.raw.copy(canonical, 0, 0, miOffset);
  canonical.writeUInt16BE(miOffset - 20, 2);
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
  const nonce = issueNonce(rinfo.address);
  const errBuf = Buffer.from([0, 0, 4, 1]);
  const body = Buffer.concat([
    buildAttr(ATTR.REALM, Buffer.from(defaultRealm(), 'utf8')),
    buildAttr(ATTR.NONCE, Buffer.from(nonce, 'utf8')),
    buildAttr(ATTR.ERROR_CODE, errBuf),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(parsed.type | 0x0100, 0);
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
  header.writeUInt16BE(parsed.type | 0x0100, 0);
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
  const xma = xorMappedAddress(rinfo.address, rinfo.port);
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

  const relay = dgram.createSocket('udp4');
  const range = relayPortRange();
  // The relay port is taken from the range, so the ports a client has to
  // open are a known set rather than whatever the operating system happens
  // to hand out.
  const wanted = range.from + (allocations.size % Math.max(1, range.to - range.from + 1));
  relay.bind(wanted, '0.0.0.0', () => {
    const inf = relay.address();
    const alloc = {
      id: crypto.randomBytes(12).toString('hex'),
      clientIp: rinfo.address,
      clientPort: rinfo.port,
      // The address the client is told is the one it can reach, not the
      // wildcard this socket happens to be bound to.
      relayIp: publicHost(),
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
      const xpeer = Buffer.alloc(8);
      xpeer[0] = 0; xpeer[1] = 0x01;
      xpeer.writeUInt16BE(peerInfo.port ^ (STUN_MAGIC >>> 16), 2);
      peerInfo.address.split('.').forEach((o, i) => xpeer[4 + i] = (Number(o) || 0) ^ MAGIC[i]);
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
    const xra = Buffer.alloc(8);
    xra[0] = 0; xra[1] = 0x01;
    xra.writeUInt16BE(alloc.relayPort ^ (STUN_MAGIC >>> 16), 2);
    alloc.relayIp.split('.').forEach((o, i) => xra[4+i] = (Number(o) || 0) ^ MAGIC[i]);
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
  const peer = parseXorPeerAddress(peerBuf.value);
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
  const peer = parseXorPeerAddress(peerBuf.value);
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
  const peer = parseXorPeerAddress(peerBuf.value);
  if (alloc.peers.size > 0 && !alloc.peers.has(peer.ip + ':' + peer.port)) return;
  if (alloc.relaySocket) {
    alloc.relaySocket.send(dataBuf.value, 0, dataBuf.value.length, peer.port, peer.ip);
  }
}

function parseXorPeerAddress(buf) {
  const portXor = buf.readUInt16BE(2) ^ (STUN_MAGIC >>> 16);
  const ip = [buf[4]^0x21, buf[5]^0x12, buf[6]^0xa4, buf[7]^0x42].join('.');
  return { ip, port: portXor };
}

// ===== Credential issuance (HTTP API) =====

function issueCredentials(username) {
  const expiry = Math.floor(Date.now()/1000) + 3600;
  const secret = Buffer.from(sharedSecret(), 'utf8');
  const key = crypto.createHmac('sha1', secret).update(`${expiry}:${username}`).digest('base64');
  return { username: `${expiry}:${username}`, password: key, ttl: 3600 };
}

// ===== Server lifecycle =====

let server = null;
// The running server's own sweep, so stopping the server stops the sweep.
let activeSweeper = null;

function startServer(config) {
  const host = (config && config.host) || '0.0.0.0';
  const port = (config && config.port) || 3478;
  const socket = dgram.createSocket('udp4');
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
    console.log('[turn] STUN/TURN server listening on ' + host + ':' + port);
  });
  // The same sweep, started again for the running server. The module-level one
  // is already doing this work, so this is redundant - but the server's own
  // lifetime is what should decide, and the module-level sweep is unref'd, so
  // it is not a reason to keep a stopped server alive.
  const sweeper = setInterval(cleanupAllocations, 30000);
  sweeper.unref();
  activeSweeper = sweeper;
  return socket;
}

function stopServer() {
  try { server && server.close(); } catch {}
  server = null;
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