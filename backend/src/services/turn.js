// Self-hosted STUN binding responder (RFC 5389), owned by Trycord.
//
// Reports the client's reflexive public address as seen by this server.
// Lightweight, no authentication required for plain STUN binding (binding
// requests carry no credentials per RFC 5389 short-term flow; the server is
// expected to be on a trusted path or rate-limited).
//
// This is the in-house STUN baseline. Operators run it (or bind it inside the
// Trycord backend) where they control network endpoints. It makes no external
// network calls and requires no third-party service.
//
// TURN relay (RFC 5766) is a separate larger scope. For self-hosted relay the
// operator is expected to install Coturn (or deploy the upcoming Trycord TURN
// daemon) and configure VOICE_VIDEO_TURN_URL to point at it. The Trycord side
// requires STUN/TURN URLs via settings; no public STUN fallbacks exist.
const dgram = require('dgram');

const STUN_MAGIC = 0x2112a442;
const STUN_BIND_REQUEST = 0x0001;
const STUN_BIND_RESPONSE = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

function parseStunPacket(buf) {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const magic = buf.readUInt32BE(4);
  if (magic !== STUN_MAGIC) return null;
  if (buf.length < 20 + len) return null;
  return { type, length: len, txId: buf.slice(8, 20) };
}

function xorMappedAddressValue(ip, port) {
  const buf = Buffer.alloc(8);
  buf[0] = 0;
  buf[1] = 0x01; // IPv4 family
  const xoredPort = port ^ (STUN_MAGIC >>> 16);
  buf.writeUInt16BE(xoredPort, 2);
  const magicBytes = [0x21, 0x12, 0xA4, 0x42];
  ip.split('.').map(Number).forEach((byte, i) => { buf[4 + i] = byte ^ magicBytes[i]; });
  return buf;
}

function buildStunResponse(txId, clientIp, clientPort) {
  const xma = xorMappedAddressValue(clientIp, clientPort);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(STUN_BIND_RESPONSE, 0);
  header.writeUInt16BE(xma.length + 4, 2);
  header.writeUInt32BE(STUN_MAGIC, 4);
  txId.copy(header, 8);

  const attrBuf = Buffer.alloc(4 + xma.length);
  attrBuf.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
  attrBuf.writeUInt16BE(xma.length, 2);
  xma.copy(attrBuf, 4);

  return Buffer.concat([header, attrBuf]);
}

let server = null;
function start(config) {
  const host = (config && config.host) || '0.0.0.0';
  const port = (config && config.port) || 3478;
  server = dgram.createSocket('udp4');
  server.on('message', (buf, rinfo) => {
    const msg = parseStunPacket(buf);
    if (!msg) return;
    if (msg.type !== STUN_BIND_REQUEST) return;
    const reply = buildStunResponse(msg.txId, rinfo.address, rinfo.port);
    server.send(reply, rinfo.port, rinfo.address);
  });
  server.on('error', (err) => {
    process.stderr.write('[turn-stun] error: ' + String(err && err.message || err) + '\\n');
  });
  server.on('listening', () => {
    process.stdout.write('[turn-stun] STUN binding responder listening on ' + host + ':' + port + '\\n');
  });
  server.bind(port, host);
}

function stop() {
  try { server && server.close(); } catch (_) {}
  server = null;
}

if (require.main === module) {
  const port = process.env.TRYCORD_STUN_PORT ? Number(process.env.TRYCORD_STUN_PORT) : 3478;
  const host = process.env.TRYCORD_STUN_HOST || '0.0.0.0';
  start({ port, host });
}

module.exports = { STUN_MAGIC, parseStunPacket, buildStunResponse, start, stop };