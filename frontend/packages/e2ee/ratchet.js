// The Double Ratchet, as published by Signal.
//
// The design this follows is https://signal.org/docs/specifications/doubleratchet/.
// Each direction has a chain of message keys that advances with every
// message; the chain key is destroyed as it advances, so a message key that
// has been used cannot be recovered from the state that follows it. That is
// the forward secrecy: compromising the device today does not reveal what
// was said yesterday.
//
// A change of direction is a Diffie-Hellman ratchet step, which is what gives
// post-compromise security: once a fresh key exchange has happened, a later
// compromise of the long-lived keys does not decrypt the traffic that followed
// it.
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
//
// The state this keeps is the server's state, field for field, because the
// two halves exchange it: the client seals it and the server stores it, and a
// state the server cannot read is only useful if it is the state the server
// would have produced.

import { b64, concatBytes, unb64, u32be, utf8 } from './bytes.js';
import {
  ecdh,
  encrypt as aesEncrypt,
  decrypt as aesDecrypt,
  generateKeyPair,
  hkdf,
  randomBytes,
  GCM_IV_BYTES,
  KEY_BYTES,
} from './primitives.js';
import {
  MAX_SKIPPED_KEYS,
  MAX_STALE_CHAIN_KEYS,
  PROTOCOL_VERSION,
  RATCHET_CHAIN_INFO,
  RATCHET_HEADER_INFO,
  RATCHET_ROOT_INFO,
  RATCHET_ROOT_SEED_INFO,
  RATCHET_STATE_INFO,
  ZERO_SALT,
} from './protocol.js';
import { associatedData, protocolError, validate } from './envelope.js';

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
export function emptyState() {
  return {
    v: PROTOCOL_VERSION,
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
export async function deriveRootStep(rootKey, dhOutput) {
  const out = await hkdf(dhOutput, rootKey, RATCHET_ROOT_INFO, 64);
  return { rootKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) };
}

/** The chain step: the message key and the next chain key. */
export async function deriveChain(chainKey) {
  const out = await hkdf(chainKey, ZERO_SALT, RATCHET_CHAIN_INFO, 64);
  return { messageKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) };
}

/** The key the header is encrypted under. Separate from the payload key. */
export async function deriveHeaderKey(messageKey) {
  return hkdf(messageKey, ZERO_SALT, RATCHET_HEADER_INFO, 32);
}

/**
 * The initiator's ratchet state, after X3DH.
 *
 * The responder's signed prekey is the peer's first ratchet key, so the
 * first sending chain is derived from it and the first receiving chain is
 * derived later, when the responder's own ratchet key arrives.
 */
export async function initiatorState(secret, peerSignedPreKey) {
  const peerSpk = unb64(peerSignedPreKey);
  const ratchet = generateKeyPair('x25519');
  const rootKey = await hkdf(secret, ZERO_SALT, RATCHET_ROOT_SEED_INFO, 32);
  const step = await deriveRootStep(rootKey, ecdh(ratchet.privateKey, peerSpk));
  const state = emptyState();
  state.rk = b64(step.rootKey);
  state.cks = b64(step.chainKey);
  state.dhs = { pub: b64(ratchet.publicKey), priv: b64(ratchet.privateKey) };
  state.dhr = b64(peerSpk);
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
export async function responderState(secret, ownSignedPreKeyPair, peerRatchetPublicKey) {
  const rootKey = await hkdf(secret, ZERO_SALT, RATCHET_ROOT_SEED_INFO, 32);
  const step = await deriveRootStep(
    rootKey,
    ecdh(ownSignedPreKeyPair.privateKey, peerRatchetPublicKey),
  );
  const state = emptyState();
  state.rk = b64(step.rootKey);
  state.ckr = b64(step.chainKey);
  state.dhs = {
    pub: b64(ownSignedPreKeyPair.publicKey),
    priv: b64(ownSignedPreKeyPair.privateKey),
  };
  state.dhr = b64(peerRatchetPublicKey);
  return state;
}

/** The key a skipped message is filed under. */
function skippedId(chainId, position) {
  return chainId + ':' + position;
}

/** File a message key, keeping the store inside its bound. */
function storeSkipped(state, chainId, position, messageKey) {
  state.skipped[skippedId(chainId, position)] = b64(messageKey);
  const ids = Object.keys(state.skipped);
  if (ids.length > MAX_SKIPPED_KEYS) {
    for (const id of ids.slice(0, ids.length - MAX_SKIPPED_KEYS)) {
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
async function matchSkipped(state, chainId, env, aad) {
  const prefix = chainId + ':';
  for (const id of Object.keys(state.skipped)) {
    if (!id.startsWith(prefix)) continue;
    let header;
    try {
      header = await aesDecrypt(
        await deriveHeaderKey(unb64(state.skipped[id])),
        unb64(env.hiv),
        unb64(env.hct),
        unb64(env.htag),
        aad,
      );
    } catch {
      continue;
    }
    if (header.length !== HEADER_BYTES) continue;
    const position = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
    if (skippedId(chainId, position) !== id) continue;
    return { id, messageKey: unb64(state.skipped[id]) };
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
async function storeStaleChain(state, stale, peerChainLength) {
  if (!stale.chainId || !stale.chainKey) return;
  const remaining = Math.min(peerChainLength - stale.from, MAX_STALE_CHAIN_KEYS);
  let chainKey = unb64(stale.chainKey);
  for (let i = 0; i < remaining; i += 1) {
    const step = await deriveChain(chainKey);
    chainKey = step.chainKey;
    storeSkipped(state, stale.chainId, stale.from + i, step.messageKey);
  }
}

/**
 * Encrypt a message.
 *
 * @param {object} state   the ratchet state
 * @param {Uint8Array} plaintext
 * @param {object} context { sid, cid, from, to, init }  init is the key
 *        agreement of a session's first message, and is absent afterwards
 * @returns {Promise<{envelope: object, state: object}>} the envelope and the state to keep
 */
export async function encrypt(state, plaintext, context) {
  const work = cloneState(state);

  // A sending chain derived against an older peer ratchet key is stale: the
  // peer has moved on, and a chain that both sides can still derive must be
  // replaced by one that both sides can still derive.
  if (!work.cks || work.cksPeer !== work.dhr) {
    if (!work.dhr) {
      throw protocolError('E2EE_CRYPTO_ERROR', 'the peer ratchet key is not known yet', 400);
    }
    const fresh = generateKeyPair('x25519');
    const step = await deriveRootStep(
      unb64(work.rk),
      ecdh(fresh.privateKey, unb64(work.dhr)),
    );
    work.rk = b64(step.rootKey);
    work.cks = b64(step.chainKey);
    work.dhs = { pub: b64(fresh.publicKey), priv: b64(fresh.privateKey) };
    work.cksPeer = work.dhr;
    // The length of the chain just finished, which the peer needs in order
    // to know which of its own late messages we can still read.
    work.pn = work.n;
    work.n = 0;
  }

  const step = await deriveChain(unb64(work.cks));
  work.cks = b64(step.chainKey);
  work.n += 1;
  work.ctr += 1;

  const envelope = {
    v: PROTOCOL_VERSION,
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
  const aad = associatedData(envelope);

  const header = concatBytes(u32be(work.n - 1), u32be(work.pn));
  const headerIv = randomBytes(GCM_IV_BYTES);
  const sealedHeader = await aesEncrypt(await deriveHeaderKey(step.messageKey), headerIv, header, aad);

  // A fresh nonce for every message, under a message key that is used once.
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await aesEncrypt(step.messageKey, iv, plaintext, aad);

  envelope.iv = b64(sealed.iv);
  envelope.ct = b64(sealed.ciphertext);
  envelope.tag = b64(sealed.tag);
  envelope.hiv = b64(sealedHeader.iv);
  envelope.hct = b64(sealedHeader.ciphertext);
  envelope.htag = b64(sealedHeader.tag);

  return { envelope, state: work };
}

/**
 * Decrypt a message.
 *
 * @param {object} state   the ratchet state
 * @param {object} envelopeInput
 * @param {object} context { sid, cid, to }
 * @returns {Promise<{plaintext: Uint8Array, state: object}>}
 */
export async function decrypt(state, envelopeInput, context) {
  const env = validate(envelopeInput);
  if (context.sid && env.sid !== context.sid) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the message belongs to another session', 400);
  }
  if (context.cid && env.cid !== context.cid) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the message belongs to another conversation', 400);
  }
  if (context.to && env.to !== context.to) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'the message is addressed to another device', 400);
  }

  const aad = associatedData(env);
  const work = cloneState(state);

  // A message from a chain we have already moved past: its key is filed.
  const late = await matchSkipped(work, env.dh, env, aad);
  if (late) {
    const plaintext = await aesDecrypt(
      late.messageKey,
      unb64(env.iv),
      unb64(env.ct),
      unb64(env.tag),
      aad,
    );
    delete work.skipped[late.id];
    work.peerCtr = Math.max(work.peerCtr, env.ctr);
    return { plaintext, state: work };
  }

  if (env.ctr <= work.peerCtr) {
    throw protocolError(
      'E2EE_REPLAY',
      'this message has already been received, or arrives out of order',
      409,
    );
  }

  // A new chain from the peer: the Diffie-Hellman ratchet step.
  let stale = null;
  if (env.dh !== work.dhr) {
    if (!work.dhs) {
      throw protocolError('E2EE_CRYPTO_ERROR', 'the ratchet state has no sending key', 400);
    }
    const step = await deriveRootStep(
      unb64(work.rk),
      ecdh(unb64(work.dhs.priv), unb64(env.dh)),
    );
    stale = { chainId: work.dhr, chainKey: work.ckr, from: work.nr };
    work.rk = b64(step.rootKey);
    work.ckr = b64(step.chainKey);
    work.dhr = env.dh;
    work.nr = 0;
  }

  if (!work.ckr) {
    throw protocolError('E2EE_CRYPTO_ERROR', 'the ratchet state has no receiving chain', 400);
  }

  // Walk the receiving chain until the header opens. Each step destroys the
  // chain key it used, and the keys that were passed over are filed so a
  // message that arrives late can still be read.
  let chainKey = unb64(work.ckr);
  const passed = [];
  for (let i = 0; i <= MAX_SKIPPED_KEYS; i += 1) {
    const step = await deriveChain(chainKey);
    const position = work.nr + i;
    let header = null;
    try {
      header = await aesDecrypt(
        await deriveHeaderKey(step.messageKey),
        unb64(env.hiv),
        unb64(env.hct),
        unb64(env.htag),
        aad,
      );
    } catch {
      chainKey = step.chainKey;
      passed.push({ position, messageKey: step.messageKey });
      continue;
    }
    if (header.length !== HEADER_BYTES) {
      throw protocolError('E2EE_CRYPTO_ERROR', 'the message header is malformed', 400);
    }
    const headerPosition = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
    if (headerPosition !== position) {
      throw protocolError('E2EE_CRYPTO_ERROR', 'the message header does not match the chain', 400);
    }
    for (const skipped of passed) {
      storeSkipped(work, env.dh, skipped.position, skipped.messageKey);
    }
    work.ckr = b64(step.chainKey);
    work.nr = position + 1;
    if (stale) await storeStaleChain(work, stale, (header[4] << 24) | (header[5] << 16) | (header[6] << 8) | header[7]);

    const plaintext = await aesDecrypt(
      step.messageKey,
      unb64(env.iv),
      unb64(env.ct),
      unb64(env.tag),
      aad,
    );
    work.peerCtr = Math.max(work.peerCtr, env.ctr);
    return { plaintext, state: work };
  }

  throw protocolError(
    'E2EE_REPLAY',
    'no message key fits this message; the gap is larger than the skipped-key store',
    409,
  );
}

/**
 * Seal a ratchet state for storage.
 *
 * The server holds this blob and cannot open it: the key is derived from the
 * session secret, which the server never sees. The counters are kept in the
 * clear beside it, because the server has to be able to refuse a replayed
 * one.
 */
export async function sealState(state, secret) {
  const key = await hkdf(secret, ZERO_SALT, RATCHET_STATE_INFO, KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = await aesEncrypt(
    key,
    iv,
    utf8(JSON.stringify(state)),
    utf8(RATCHET_STATE_INFO),
  );
  return {
    iv: b64(sealed.iv),
    ciphertext: b64(sealed.ciphertext),
    tag: b64(sealed.tag),
  };
}

/** Open a sealed ratchet state. Throws when the secret is wrong. */
export async function openState(blob, secret) {
  const key = await hkdf(secret, ZERO_SALT, RATCHET_STATE_INFO, KEY_BYTES);
  const plaintext = await aesDecrypt(
    key,
    unb64(blob.iv),
    unb64(blob.ciphertext),
    unb64(blob.tag),
    utf8(RATCHET_STATE_INFO),
  );
  const state = JSON.parse(new TextDecoder().decode(plaintext));
  if (!state || state.v !== PROTOCOL_VERSION) {
    throw protocolError('E2EE_UNSUPPORTED_VERSION', 'the stored ratchet state is not readable', 400);
  }
  return state;
}
