// The Double Ratchet, as published by Signal.
//
// The design this follows is https://signal.org/docs/specifications/doubleratchet/.
// Each direction has a chain of message keys that advances with every
// message; the chain key is destroyed as it advances, so a message key that
// has been used cannot be recovered from the state that follows it. That is
// the forward secrecy: compromising the device today does not reveal what
// was said yesterday.
//
// A change of direction is a Diffie-Hellman ratchet step, which is what
// gives post-compromise security: once a fresh key exchange has happened,
// a later compromise of the long-lived keys does not decrypt the traffic
// that followed it.
//
// The chain step and the root step are HKDF-SHA256 rather than the
// HMAC-based key derivation of the original document, and the labels say so:
//
//   (MK, CK') = HKDF-SHA256(CK,  salt = 32 zero bytes,
//                           info = "trycord-double-ratchet-v1|chain", 64)
//   (RK, CK)  = HKDF-SHA256(DH,  salt = RK,
//                           info = "trycord-double-ratchet-v1|root",  64)
//
// The message key is used for exactly one message, so the AEAD nonce it is
// used with never repeats under the same key: the nonce is drawn at random
// per message and the key is single-use, and a (key, nonce) pair cannot
// repeat because the key cannot. The header is encrypted under a separate
// key derived from the message key, so the header and the payload never
// share a key either.

'use strict';

const primitives = require('./primitives');
const protocol = require('./protocol');
const envelopeModule = require('./envelope');

const HEADER_BYTES = 8;

/**
 * The ratchet state.
 *
 *   rk       the root key
 *   cks/ckr  the sending and receiving chain keys
 *   dhs      our sending ratchet key pair
 *   dhr      the peer's latest sending ratchet public key
 *   cksPeer  the peer ratchet key the current sending chain was made against
 *   n/nr     messages sent and received in the current chain
 *   ctr      messages sent in this session - the counter in the envelope
 *   peerCtr  the highest counter received from the peer
 *   skipped  message keys kept for messages that arrived out of order
 */
function emptyState() {
  return {
    v: protocol.PROTOCOL_VERSION,
    rk: null,
    cks: null,
    ckr: null,
    dhs: null,
    dhr: null,
    cksPeer: null,
    n: 0,
    nr: 0,
    ctr: 0,
    peerCtr: 0,
    pn: 0,
    skipped: {},
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/** The root step: a new root key and a chain key from one DH output. */
function deriveRootStep(rootKey, dhOutput) {
  const out = primitives.hkdf(dhOutput, rootKey, protocol.RATCHET_ROOT_INFO, 64);
  return { rootKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) };
}

/** The chain step: the message key and the next chain key. */
function deriveChain(chainKey) {
  const out = primitives.hkdf(chainKey, protocol.ZERO_SALT, protocol.RATCHET_CHAIN_INFO, 64);
  return { messageKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) };
}

/** The key the header is encrypted under. Separate from the payload key. */
function deriveHeaderKey(messageKey) {
  return primitives.hkdf(messageKey, protocol.ZERO_SALT, protocol.RATCHET_HEADER_INFO, 32);
}

/**
 * The initiator's ratchet state, after X3DH.
 *
 * The responder's signed prekey is the peer's first ratchet key, so the
 * first sending chain is derived from it and the first receiving chain is
 * derived later, when the responder's own ratchet key arrives.
 */
function initiatorState(secret, peerSignedPreKey) {
  const peerSpk = primitives.unb64(peerSignedPreKey);
  const ratchet = primitives.generateKeyPair('x25519');
  const rootKey = primitives.hkdf(secret, protocol.ZERO_SALT, protocol.RATCHET_ROOT_SEED_INFO, 32);
  const step = deriveRootStep(
    rootKey,
    primitives.ecdh(primitives.importPrivate('x25519', ratchet.privateKey, ratchet.publicKey),
      primitives.importPublic('x25519', peerSpk))
  );
  const state = emptyState();
  state.rk = primitives.b64(step.rootKey);
  state.cks = primitives.b64(step.chainKey);
  state.dhs = { pub: primitives.b64(ratchet.publicKey), priv: primitives.b64(ratchet.privateKey) };
  state.dhr = primitives.b64(peerSpk);
  state.cksPeer = state.dhr;
  return state;
}

/**
 * The responder's ratchet state, after X3DH.
 *
 * The responder's signed prekey is its sending ratchet key until it ratchets,
 * and the initiator's ratchet public key - which arrives in the first
 * message - is the peer ratchet key from the start.
 */
function responderState(secret, ownSignedPreKeyPair, peerRatchetPublicKey) {
  const rootKey = primitives.hkdf(secret, protocol.ZERO_SALT, protocol.RATCHET_ROOT_SEED_INFO, 32);
  const step = deriveRootStep(
    rootKey,
    primitives.ecdh(
      primitives.importPrivate('x25519', ownSignedPreKeyPair.privateKey, ownSignedPreKeyPair.publicKey),
      primitives.importPublic('x25519', peerRatchetPublicKey)
    )
  );
  const state = emptyState();
  state.rk = primitives.b64(step.rootKey);
  state.ckr = primitives.b64(step.chainKey);
  state.dhs = {
    pub: primitives.b64(ownSignedPreKeyPair.publicKey),
    priv: primitives.b64(ownSignedPreKeyPair.privateKey),
  };
  state.dhr = primitives.b64(peerRatchetPublicKey);
  return state;
}

/** The key a skipped message is filed under. */
function skippedId(chainId, position) {
  return chainId + ':' + position;
}

/** File a message key, keeping the store inside its bound. */
function storeSkipped(state, chainId, position, messageKey) {
  state.skipped[skippedId(chainId, position)] = primitives.b64(messageKey);
  const ids = Object.keys(state.skipped);
  if (ids.length > protocol.MAX_SKIPPED_KEYS) {
    for (const id of ids.slice(0, ids.length - protocol.MAX_SKIPPED_KEYS)) {
      delete state.skipped[id];
    }
  }
}

/**
 * Find a filed message key that opens this message's header.
 *
 * This is how a message that arrives late is read: the key was derived and
 * filed when a later message in the same chain came through first.
 */
function matchSkipped(state, chainId, env, aad) {
  const prefix = chainId + ':';
  for (const id of Object.keys(state.skipped)) {
    if (!id.startsWith(prefix)) continue;
    let header;
    try {
      header = primitives.decrypt(
        deriveHeaderKey(primitives.unb64(state.skipped[id])),
        primitives.unb64(env.hiv),
        primitives.unb64(env.hct),
        primitives.unb64(env.htag),
        aad
      );
    } catch {
      continue;
    }
    if (header.length !== HEADER_BYTES) continue;
    const position = header.readUInt32BE(0);
    if (skippedId(chainId, position) !== id) continue;
    return { id, messageKey: primitives.unb64(state.skipped[id]) };
  }
  return null;
}

/**
 * File the remaining keys of the chain the peer has just left behind.
 *
 * The peer says how long that chain was in the header of the message that
 * follows it. The keys we never received are derived from the chain key we
 * held and filed, so a message from that chain arriving late is still
 * readable.
 */
function storeStaleChain(state, stale, peerChainLength) {
  if (!stale.chainId || !stale.chainKey) return;
  const remaining = Math.min(peerChainLength - stale.from, protocol.MAX_STALE_CHAIN_KEYS);
  let chainKey = primitives.unb64(stale.chainKey);
  for (let i = 0; i < remaining; i++) {
    const step = deriveChain(chainKey);
    chainKey = step.chainKey;
    storeSkipped(state, stale.chainId, stale.from + i, step.messageKey);
  }
}

/**
 * Encrypt a message.
 *
 * @param {object} state   the ratchet state
 * @param {Buffer} plaintext
 * @param {object} context { sid, cid, from, to, init }  init is the key
 *        agreement of a session's first message, and is absent afterwards
 * @returns {{envelope: object, state: object}} the envelope and the state to keep
 */
function encrypt(state, plaintext, context) {
  const work = cloneState(state);

  // A sending chain derived against an older peer ratchet key is stale: the
  // peer has moved on, and a chain that both sides can still derive must be
  // replaced by one that both sides can still derive.
  if (!work.cks || work.cksPeer !== work.dhr) {
    if (!work.dhr) {
      throw envelopeModule.protocolError('E2EE_CRYPTO_ERROR', 'the peer ratchet key is not known yet', 400);
    }
    const fresh = primitives.generateKeyPair('x25519');
    const step = deriveRootStep(
      primitives.unb64(work.rk),
      primitives.ecdh(
        primitives.importPrivate('x25519', fresh.privateKey, fresh.publicKey),
        primitives.importPublic('x25519', primitives.unb64(work.dhr))
      )
    );
    work.rk = primitives.b64(step.rootKey);
    work.cks = primitives.b64(step.chainKey);
    work.dhs = { pub: primitives.b64(fresh.publicKey), priv: primitives.b64(fresh.privateKey) };
    work.cksPeer = work.dhr;
    // The length of the chain just finished, which the peer needs in order
    // to know which of its own late messages we can still read.
    work.pn = work.n;
    work.n = 0;
  }

  const step = deriveChain(primitives.unb64(work.cks));
  work.cks = primitives.b64(step.chainKey);
  work.n += 1;
  work.ctr += 1;

  const envelope = {
    v: protocol.PROTOCOL_VERSION,
    sid: context.sid,
    cid: context.cid,
    from: context.from,
    to: context.to,
    ctr: work.ctr,
    dh: work.dhs.pub,
  };
  // The key agreement of a session's first message travels with the
  // envelope and is covered by the associated data, so it cannot be
  // swapped for another device's.
  if (context.init) envelope.init = context.init;
  const aad = envelopeModule.associatedData(envelope);

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(work.n - 1, 0);
  header.writeUInt32BE(work.pn, 4);
  const headerIv = primitives.randomBytes(primitives.GCM_IV_BYTES);
  const sealedHeader = primitives.encrypt(deriveHeaderKey(step.messageKey), headerIv, header, aad);

  // A fresh nonce for every message, under a message key that is used once.
  const iv = primitives.randomBytes(primitives.GCM_IV_BYTES);
  const sealed = primitives.encrypt(step.messageKey, iv, plaintext, aad);

  envelope.iv = primitives.b64(sealed.iv);
  envelope.ct = primitives.b64(sealed.ciphertext);
  envelope.tag = primitives.b64(sealed.tag);
  envelope.hiv = primitives.b64(sealedHeader.iv);
  envelope.hct = primitives.b64(sealedHeader.ciphertext);
  envelope.htag = primitives.b64(sealedHeader.tag);

  return { envelope, state: work };
}

/**
 * Decrypt a message.
 *
 * @param {object} state   the ratchet state
 * @param {object} envelope
 * @param {object} context { sid, cid, to }
 * @returns {{plaintext: Buffer, state: object}}
 */
function decrypt(state, envelopeInput, context) {
  const env = envelopeModule.validate(envelopeInput);
  if (context.sid && env.sid !== context.sid) {
    throw envelopeModule.protocolError('E2EE_VALIDATION_ERROR', 'the message belongs to another session', 400);
  }
  if (context.cid && env.cid !== context.cid) {
    throw envelopeModule.protocolError('E2EE_VALIDATION_ERROR', 'the message belongs to another conversation', 400);
  }
  if (context.to && env.to !== context.to) {
    throw envelopeModule.protocolError('E2EE_VALIDATION_ERROR', 'the message is addressed to another device', 400);
  }

  const aad = envelopeModule.associatedData(env);
  const work = cloneState(state);

  // A message from a chain we have already moved past: its key is filed.
  const late = matchSkipped(work, env.dh, env, aad);
  if (late) {
    const plaintext = primitives.decrypt(
      late.messageKey,
      primitives.unb64(env.iv),
      primitives.unb64(env.ct),
      primitives.unb64(env.tag),
      aad
    );
    delete work.skipped[late.id];
    work.peerCtr = Math.max(work.peerCtr, env.ctr);
    return { plaintext, state: work };
  }

  if (env.ctr <= work.peerCtr) {
    throw envelopeModule.protocolError(
      'E2EE_REPLAY',
      'this message has already been received, or arrives out of order',
      409
    );
  }

  // A new chain from the peer: the Diffie-Hellman ratchet step.
  let stale = null;
  if (env.dh !== work.dhr) {
    if (!work.dhs) {
      throw envelopeModule.protocolError('E2EE_CRYPTO_ERROR', 'the ratchet state has no sending key', 400);
    }
    const step = deriveRootStep(
      primitives.unb64(work.rk),
      primitives.ecdh(
        primitives.importPrivate('x25519', primitives.unb64(work.dhs.priv), primitives.unb64(work.dhs.pub)),
        primitives.importPublic('x25519', primitives.unb64(env.dh))
      )
    );
    stale = { chainId: work.dhr, chainKey: work.ckr, from: work.nr };
    work.rk = primitives.b64(step.rootKey);
    work.ckr = primitives.b64(step.chainKey);
    work.dhr = env.dh;
    work.nr = 0;
  }

  if (!work.ckr) {
    throw envelopeModule.protocolError('E2EE_CRYPTO_ERROR', 'the ratchet state has no receiving chain', 400);
  }

  // Walk the receiving chain until the header opens. Each step destroys the
  // chain key it used, and the keys that were passed over are filed so a
  // message that arrives late can still be read.
  let chainKey = primitives.unb64(work.ckr);
  const passed = [];
  for (let i = 0; i <= protocol.MAX_SKIPPED_KEYS; i++) {
    const step = deriveChain(chainKey);
    const position = work.nr + i;
    let header = null;
    try {
      header = primitives.decrypt(
        deriveHeaderKey(step.messageKey),
        primitives.unb64(env.hiv),
        primitives.unb64(env.hct),
        primitives.unb64(env.htag),
        aad
      );
    } catch {
      chainKey = step.chainKey;
      passed.push({ position, messageKey: step.messageKey });
      continue;
    }
    if (header.length !== HEADER_BYTES) {
      throw envelopeModule.protocolError('E2EE_CRYPTO_ERROR', 'the message header is malformed', 400);
    }
    if (header.readUInt32BE(0) !== position) {
      throw envelopeModule.protocolError('E2EE_CRYPTO_ERROR', 'the message header does not match the chain', 400);
    }
    for (const skipped of passed) {
      storeSkipped(work, env.dh, skipped.position, skipped.messageKey);
    }
    work.ckr = primitives.b64(step.chainKey);
    work.nr = position + 1;
    if (stale) storeStaleChain(work, stale, header.readUInt32BE(4));

    const plaintext = primitives.decrypt(
      step.messageKey,
      primitives.unb64(env.iv),
      primitives.unb64(env.ct),
      primitives.unb64(env.tag),
      aad
    );
    work.peerCtr = Math.max(work.peerCtr, env.ctr);
    return { plaintext, state: work };
  }

  throw envelopeModule.protocolError(
    'E2EE_REPLAY',
    'no message key fits this message; the gap is larger than the skipped-key store',
    409
  );
}

/**
 * Seal a ratchet state for storage.
 *
 * The server holds this blob and cannot open it: the key is derived from
 * the session secret, which the server never sees. The counters are kept in
 * the clear beside it, because the server has to be able to refuse a
 * replayed one.
 */
function sealState(state, secret) {
  const key = primitives.hkdf(secret, protocol.ZERO_SALT, protocol.RATCHET_STATE_INFO, 32);
  const iv = primitives.randomBytes(primitives.GCM_IV_BYTES);
  const sealed = primitives.encrypt(
    key,
    iv,
    Buffer.from(JSON.stringify(state), 'utf8'),
    Buffer.from(protocol.RATCHET_STATE_INFO, 'utf8')
  );
  return {
    iv: primitives.b64(sealed.iv),
    ciphertext: primitives.b64(sealed.ciphertext),
    tag: primitives.b64(sealed.tag),
  };
}

/** Open a sealed ratchet state. Throws when the secret is wrong. */
function openState(blob, secret) {
  const key = primitives.hkdf(secret, protocol.ZERO_SALT, protocol.RATCHET_STATE_INFO, 32);
  const plaintext = primitives.decrypt(
    key,
    primitives.unb64(blob.iv),
    primitives.unb64(blob.ciphertext),
    primitives.unb64(blob.tag),
    Buffer.from(protocol.RATCHET_STATE_INFO, 'utf8')
  );
  const state = JSON.parse(plaintext.toString('utf8'));
  if (!state || state.v !== protocol.PROTOCOL_VERSION) {
    throw envelopeModule.protocolError('E2EE_UNSUPPORTED_VERSION', 'the stored ratchet state is not readable', 400);
  }
  return state;
}

module.exports = {
  deriveRootStep,
  deriveChain,
  deriveHeaderKey,
  initiatorState,
  responderState,
  encrypt,
  decrypt,
  sealState,
  openState,
};
