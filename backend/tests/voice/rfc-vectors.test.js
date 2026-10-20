// The protocol implementation, checked against the standard's own vectors.
//
// The message integrity in this file was wrong for a long time and nothing
// noticed, because the server checked the credentials with the same rule the
// test built them with. A test that agrees with the implementation proves
// only that the implementation agrees with itself.
//
// So the vectors are the ones RFC 5769 publishes, and the check is the
// standard's own: the HMAC is over the message up to (but not including) the
// MESSAGE-INTEGRITY attribute, with the header as it stands.
//
// RFC 5769 section 2.4 - a request with long-term credentials:
//
//   username  the six Japanese characters, in UTF-8
//   realm     "example.org"
//   nonce     "f//499k954d6OL34oL9FSTvy64sA"
//   password  "TheMatrIX", which is what SASLprep makes of the original
//   the HMAC  f6 70 24 65 6d d6 4a 3e 02 b8 e0 71 2e 85 c9 a2 8c a8 96 66
//
// The rule the vector proves is the one the implementation has to follow:
// the HMAC is over the first 92 bytes of the packet, and the length field in
// the header stays at 0x0060 - which counts the MESSAGE-INTEGRITY attribute
// itself, even though the HMAC does not cover it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const turn = require('../../src/services/turn');

// RFC 5769, section 2.4. The bytes are the ones the RFC publishes.
const REQUEST = Buffer.from([
  0x00, 0x01, 0x00, 0x60, 0x21, 0x12, 0xa4, 0x42,
  0x78, 0xad, 0x34, 0x33, 0xc6, 0xad, 0x72, 0xc0, 0x29, 0xda, 0x41, 0x2e,
  0x00, 0x06, 0x00, 0x12,
  0xe3, 0x83, 0x9e, 0xe3, 0x83, 0x88, 0xe3, 0x83, 0xaa, 0xe3, 0x83, 0x83, 0xe3, 0x82, 0xaf, 0xe3, 0x82, 0xb9, 0x00, 0x00,
  0x00, 0x15, 0x00, 0x1c,
  0x66, 0x2f, 0x2f, 0x34, 0x39, 0x39, 0x6b, 0x39, 0x35, 0x34, 0x64, 0x36,
  0x4f, 0x4c, 0x33, 0x34, 0x6f, 0x4c, 0x39, 0x46, 0x53, 0x54, 0x76, 0x79, 0x36, 0x34, 0x73, 0x41,
  0x00, 0x14, 0x00, 0x0b,
  0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x6f, 0x72, 0x67, 0x00,
  0x00, 0x08, 0x00, 0x14,
  0xf6, 0x70, 0x24, 0x65, 0x6d, 0xd6, 0x4a, 0x3e, 0x02, 0xb8, 0xe0, 0x71, 0x2e, 0x85, 0xc9, 0xa2, 0x8c, 0xa8, 0x96, 0x66,
]);

const USERNAME = 'マトリックス';
const REALM = 'example.org';
const PASSWORD = 'TheMatrIX';
const EXPECTED_HMAC = 'f67024656dd64a3e02b8e0712e85c9a28ca89666';

// The offset of the MESSAGE-INTEGRITY attribute's header.
const INTEGRITY_HEADER_OFFSET = 92;

test('the message integrity is the one the standard names', async (t) => {
  await t.test('the packet is the one the RFC publishes', () => {
    assert.equal(REQUEST.length, 116, 'the packet is not the length the RFC says');
    assert.equal(REQUEST.readUInt16BE(2), 0x0060, 'the length field is not the one the RFC says');
  });

  await t.test('the HMAC is over the message up to the integrity attribute', () => {
    const key = crypto.createHash('md5')
      .update(`${USERNAME}:${REALM}:${PASSWORD}`, 'utf8').digest();

    // The canonical message: the packet up to (but not including) the
    // MESSAGE-INTEGRITY attribute, with the header as it stands.
    const canonical = REQUEST.slice(0, INTEGRITY_HEADER_OFFSET);
    const hmac = crypto.createHmac('sha1', key).update(canonical).digest('hex');

    assert.equal(hmac, EXPECTED_HMAC,
      'the canonical message is not the one the standard names, so every '
      + 'credential a real client sends would be refused');
  });

  await t.test('the packet parses, and the attributes are the ones it holds', () => {
    const parsed = turn.parseStun(REQUEST);
    assert.ok(parsed, 'the packet did not parse');
    assert.equal(parsed.type, 0x0001, 'the message type is not a request');
    assert.equal(parsed.txId.toString('hex'), '78ad3433c6ad72c029da412e');
    assert.equal(parsed.attrs.get(0x0006).value.toString('utf8').replace(/\0+$/, ''), USERNAME);
    assert.equal(parsed.attrs.get(0x0014).value.toString('utf8').replace(/\0+$/, ''), REALM);
    assert.equal(parsed.attrs.get(0x0015).value.toString('utf8'), 'f//499k954d6OL34oL9FSTvy64sA');
  });

  await t.test('the integrity attribute is the one the RFC publishes', () => {
    const parsed = turn.parseStun(REQUEST);
    const integrity = parsed.attrs.get(0x0008);
    assert.ok(integrity, 'the packet carries no message integrity');
    assert.equal(integrity.value.toString('hex'), EXPECTED_HMAC);
  });
});
