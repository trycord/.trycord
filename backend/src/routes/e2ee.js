// /api/e2ee - device identity, prekeys, sessions, conversation keys,
// attachment keys, key backup and recovery.
//
// The shape of the API follows the rest of the instance: a bearer token, the
// { error: { code, message } } envelope, and the same rate limiter. Every
// route here is authenticated, and every route that touches one account's
// material refuses another account's.
//
// There is no endpoint in this router that accepts a plaintext message
// body. The only thing that crosses it is a sealed ratchet state, a sealed
// key, or a public key. That is deliberate: a fallback that sends in the
// clear when encryption fails is not a fallback, it is the end of the
// feature, and this router has no way to express one.

const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { singleFile } = require('../middleware/upload');
const { fail, wrap, serviceError } = require('../errors');
const e2ee = require('../services/e2ee');
const { protocolError } = require('../services/e2ee/envelope');

const router = express.Router();

// The router is mounted at its own path, so the session check belongs on
// the router rather than on every route: it is the same check for all of
// them, and one lookup instead of one per route.
router.use(auth);

// The shared limiter buckets by the router a request landed on, so every
// route here would share one budget and the tightest limit would govern
// all of them. A device publishes prekeys far more often than it is
// recovered, and those budgets are unrelated, so each route names its own
// bucket. The router-level limit is the backstop underneath them.
const limited = (bucket, max) => rateLimit({ windowMs: 60000, max, key: 'e2ee:' + bucket });

// A limit whose bucket is named by the request as well as by the route.
//
// A route that spends something the server holds - a one-time prekey, for
// instance - has to be limited by the thing being spent, or one caller can
// empty a pool that belongs to everybody.
const limitedBy = (bucket, max, nameOf) => rateLimit({
  windowMs: 60000,
  max,
  key: 'e2ee:' + bucket,
  keyBy: (req) => nameOf(req),
});
router.use(rateLimit({ windowMs: 60000, max: 300, key: 'e2ee' }));

/**
 * A handler that answers this subsystem's own errors.
 *
 * The shared mapper knows the instance-wide codes; the codes raised here
 * carry the status they mean, so they are answered before the shared
 * mapper can flatten an unknown one into a 500.
 */
const route = (handler) => wrap(async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (e) {
    if (e && e.code && e.status) return fail(res, e.code, e.message, e.status);
    return serviceError(res, e);
  }
});

/** A required string field from the body. */
function required(body, field) {
  const value = body && body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw protocolError('E2EE_VALIDATION_ERROR', field + ' is required', 400);
  }
  return value;
}

// ---- devices -------------------------------------------------------------

// GET /api/e2ee/devices - the account's devices.
router.get('/devices', limited('devices', 60), route(async (req, res) => {
  res.json({ devices: await e2ee.listDevices(req.user.id) });
}));

// POST /api/e2ee/devices - register a device.
//
// The client sends the three public keys and, if it wants recovery, the
// private material sealed under its own recovery key. The server stores the
// seal and cannot open it.
router.post('/devices', limited('devices', 20), route(async (req, res) => {
  const body = req.body || {};
  const device = await e2ee.registerDevice(req.user.id, {
    id: body.id,
    label: required(body, 'label'),
    identityKey: required(body, 'identityKey'),
    identityDhKey: required(body, 'identityDhKey'),
    signedPreKey: required(body, 'signedPreKey'),
    keyFingerprint: body.keyFingerprint || '',
    signature: body.signature,
    wrappedPrivateKey: body.wrappedPrivateKey || null,
    recoverySalt: body.recoverySalt || null,
    recoveryIterations: body.recoveryIterations || null,
  });
  res.status(201).json({ device });
}));

// GET /api/e2ee/devices/:id - one of the account's own devices.
router.get('/devices/:id', limited('devices', 60), route(async (req, res) => {
  const device = await e2ee.devices.owned(req.user.id, req.params.id);
  res.json({ device: e2ee.devices.shape(device) });
}));

// DELETE /api/e2ee/devices/:id - revoke a device.
//
// Its prekeys are deleted, its sessions are marked dead, and the other
// devices of the account are told, because they have to rekey whatever they
// shared with it.
router.delete('/devices/:id', limited('devices', 20), route(async (req, res) => {
  res.json({ device: await e2ee.revokeDevice(req.user.id, req.params.id) });
}));

// ---- prekeys -------------------------------------------------------------

// POST /api/e2ee/prekeys - publish a bundle.
//
// The bundle and every one-time prekey in it must be signed by the
// device's identity key. A bundle that does not verify is refused, because
// a client that trusted it would be trusting material nobody signed.
router.post('/prekeys', limited('prekeys', 60), route(async (req, res) => {
  const body = req.body || {};
  res.json(await e2ee.publishPrekeys(req.user.id, required(body, 'deviceId'), {
    identityKey: required(body, 'identityKey'),
    identityDhKey: required(body, 'identityDhKey'),
    signedPreKey: required(body, 'signedPreKey'),
    signature: body.signature,
    oneTimePreKeys: Array.isArray(body.oneTimePreKeys) ? body.oneTimePreKeys : [],
    lastResortPreKey: body.lastResortPreKey || null,
  }));
}));

// GET /api/e2ee/prekeys/:deviceId - take a peer's bundle.
//
// The response carries a signature over the bundle and over the one-time
// prekey in it. The client checks both before it uses anything, which is
// what stops the server from passing off a bundle of its own making.
//
// Every fetch consumes a one-time prekey, so a caller that fetches in a loop
// empties a device's pool and forces it onto the reusable fallback - which is
// a downgrade of the protection the prekeys exist to provide. The bucket is
// therefore keyed by the device being fetched as well as by the caller: one
// reader cannot spend another's pool, and one reader cannot spend a device's
// pool in a burst.
router.get('/prekeys/:deviceId',
  limited('prekeys', 120),
  limitedBy('prekey-device', 10, (req) => req.params.deviceId),
  route(async (req, res) => {
    res.json({ bundle: await e2ee.fetchPrekeyBundle(req.params.deviceId) });
  }));

// POST /api/e2ee/prekeys/claim - claim the one-time prekey a session used.
//
// The responder claims the prekey the initiator used, so one prekey cannot
// start two sessions. The claim is refused when the prekey has already been
// claimed.
router.post('/prekeys/claim', limited('prekeys', 60), route(async (req, res) => {
  const body = req.body || {};
  const claimed = await e2ee.claimPrekey(req.user.id, required(body, 'deviceId'), body.prekeyId);
  res.json({ prekey: claimed });
}));

// POST /api/e2ee/prekeys/release - give back a prekey that was taken but
// not used.
//
// An initiator that takes a bundle and does not use its one-time prekey
// has still consumed it. Releasing it puts it back into circulation.
router.post('/prekeys/release', limited('prekeys', 60), route(async (req, res) => {
  const body = req.body || {};
  res.json(await e2ee.releasePrekeys(req.user.id, required(body, 'deviceId')));
}));

// ---- sessions ------------------------------------------------------------

// POST /api/e2ee/sessions - record a session the client has established.
router.post('/sessions', limited('sessions', 60), route(async (req, res) => {
  const body = req.body || {};
  const session = await e2ee.createSession(req.user.id, {
    id: body.id,
    deviceId: required(body, 'deviceId'),
    peerDeviceId: required(body, 'peerDeviceId'),
    peerUserId: body.peerUserId || '',
    conversationId: body.conversationId || null,
    ratchetState: body.ratchetState || null,
    sendCounter: body.sendCounter,
    recvCounter: body.recvCounter,
  });
  res.status(201).json({ session });
}));

// GET /api/e2ee/sessions?deviceId= - the sessions of one of the account's
// devices.
router.get('/sessions', limited('sessions', 60), route(async (req, res) => {
  const deviceId = required(req.query, 'deviceId');
  res.json({ sessions: await e2ee.listSessions(req.user.id, deviceId) });
}));

// GET /api/e2ee/sessions/:id - the session and its sealed ratchet state.
router.get('/sessions/:id', limited('sessions', 120), route(async (req, res) => {
  res.json({ session: await e2ee.getSession(req.user.id, req.params.id) });
}));

// PATCH /api/e2ee/sessions/:id - store the ratchet state after a message.
//
// The send counter has to move forward. A push that does not is refused:
// it is a replay, or a state the client has already replaced.
router.patch('/sessions/:id', limited('sessions', 240), route(async (req, res) => {
  const body = req.body || {};
  const session = await e2ee.updateSession(req.user.id, req.params.id, {
    ratchetState: body.ratchetState,
    sendCounter: body.sendCounter,
    recvCounter: body.recvCounter,
  });
  res.json({ session });
}));

// DELETE /api/e2ee/sessions/:id - end a session.
router.delete('/sessions/:id', limited('sessions', 60), route(async (req, res) => {
  res.json({ session: await e2ee.closeSession(req.user.id, req.params.id) });
}));

// ---- conversations -------------------------------------------------------

// POST /api/e2ee/conversations/:conversationId/key - publish or rekey the
// conversation key.
//
// The key is sealed to each member device by the client. The server records
// the seals and the epoch, and refuses a seal for a device that is not in
// the conversation.
router.post('/conversations/:conversationId/key', limited('conversations', 60), route(async (req, res) => {
  const body = req.body || {};
  const result = await e2ee.publishConversationKey(req.user.id, {
    conversationId: req.params.conversationId,
    deviceId: required(body, 'deviceId'),
    epoch: body.epoch,
    sealedKeys: Array.isArray(body.sealedKeys) ? body.sealedKeys : [],
  });
  res.status(201).json(result);
}));

// GET /api/e2ee/conversations/:conversationId/key?deviceId= - the sealed
// key for one of the caller's own devices.
router.get('/conversations/:conversationId/key', limited('conversations', 120), route(async (req, res) => {
  const deviceId = required(req.query, 'deviceId');
  res.json(await e2ee.conversationKey(req.user.id, req.params.conversationId, deviceId));
}));

// GET /api/e2ee/conversations/:conversationId/state - what is actually
// true about this conversation's encryption.
//
// The state is computed from the keys the member devices hold. A
// conversation is reported as encrypted only when every live member device
// holds the current key.
router.get('/conversations/:conversationId/state', limited('conversations', 120), route(async (req, res) => {
  res.json(await e2ee.conversationState(req.user.id, req.params.conversationId));
}));

// ---- attachments ---------------------------------------------------------

// POST /api/e2ee/attachments - record an encrypted attachment.
//
// The server never receives the attachment key: it receives the key
// sealed to each member device, and a record of the ciphertext the client
// uploaded.
router.post('/attachments', limited('attachments', 60), route(async (req, res) => {
  const body = req.body || {};
  const attachment = await e2ee.registerAttachment(req.user.id, {
    id: body.id,
    conversationId: required(body, 'conversationId'),
    filename: body.filename || 'attachment',
    mime: body.mime || 'application/octet-stream',
    size: body.size,
    sealedKeys: Array.isArray(body.sealedKeys) ? body.sealedKeys : [],
  });
  res.status(201).json({ attachment });
}));

// GET /api/e2ee/attachments/:attachmentId - the attachment, with the seals
// belonging to the caller's own devices.
router.get('/attachments/:attachmentId', limited('attachments', 120), route(async (req, res) => {
  res.json({ attachment: await e2ee.attachment(req.user.id, req.params.attachmentId) });
}));

// ---- backup and recovery ------------------------------------------------

// POST /api/e2ee/backup - store the account's encrypted key backup.
//
// The blob is encrypted by the client under a key derived from the
// recovery key. The server keeps it and the parameters needed to describe
// it, and nothing else.
router.post('/backup', limited('backup', 10), route(async (req, res) => {
  const body = req.body || {};
  res.json(await e2ee.saveBackup(req.user.id, {
    salt: required(body, 'salt'),
    iterations: body.iterations,
    iv: required(body, 'iv'),
    ciphertext: required(body, 'ciphertext'),
    tag: required(body, 'tag'),
  }));
}));

// GET /api/e2ee/backup - the account's encrypted key backup.
router.get('/backup', limited('backup', 60), route(async (req, res) => {
  const backup = await e2ee.fetchBackup(req.user.id);
  if (!backup) return fail(res, 'NOT_FOUND', 'no key backup has been stored', 404);
  res.json({ backup });
}));

// POST /api/e2ee/recovery - recover a device from the one that was lost.
//
// The proof is a signature by the lost device's identity key over a
// statement that names the account and the new device. The server checks
// it against public data. The recovery key and both private keys stay on
// the client's machine throughout.
router.post('/recovery', limited('recovery', 10), route(async (req, res) => {
  const body = req.body || {};
  const device = body.device || {};
  const result = await e2ee.recoverDevice(req.user.id, {
    sourceDeviceId: required(body, 'sourceDeviceId'),
    recoveryProof: required(body, 'recoveryProof'),
    device: {
      id: device.id,
      label: device.label,
      identityKey: device.identityKey,
      identityDhKey: device.identityDhKey,
      signedPreKey: device.signedPreKey,
      keyFingerprint: device.keyFingerprint,
      signature: device.signature,
      wrappedPrivateKey: device.wrappedPrivateKey || null,
      recoverySalt: device.recoverySalt || null,
      recoveryIterations: device.recoveryIterations || null,
    },
  });
  res.status(201).json(result);
}));

// ---- safety numbers ------------------------------------------------------

// GET /api/e2ee/safety-number?userId= - the fingerprint of a peer's
// identity keys.
//
// Two people who read the same number over a channel they trust are
// talking to the same keys. The number changes when a device is added or
// revoked, which is when it is worth looking again.
router.get('/safety-number', limited('safety-number', 60), route(async (req, res) => {
  const peerUserId = required(req.query, 'userId');
  res.json(await e2ee.safetyNumber(req.user.id, peerUserId));
}));

// POST /api/e2ee/attachments/upload - the ciphertext of an attachment.
//
// The client encrypts the file with a random key, seals that key to each
// member device, and uploads the ciphertext. The server stores the
// ciphertext and the seals, and holds no key it can open - the attachment
// record carries the name the client sent, and the name is metadata, so the
// real one belongs inside the encrypted message.
//
// The client chooses the attachment's id, because the key has to be sealed to
// it before the file is uploaded, and the id is what the seal names.
router.post('/attachments/upload', auth.requireVerified, limited('attachments', 30), singleFile,
  route(async (req, res) => {
    const body = req.body || {};
    if (!req.file || !req.file.buffer) {
      throw protocolError('E2EE_VALIDATION_ERROR',
        'send the file as a multipart field named "file"', 400);
    }
    const attachment = await e2ee.storeEncryptedAttachment(req.user.id, {
      id: body.id,
      conversationId: required(body, 'conversationId'),
      filename: body.filename || 'attachment',
      mime: body.mime || 'application/octet-stream',
      buffer: req.file.buffer,
      sealedKeys: sealedKeysFrom(body.sealedKeys),
    });
    res.status(201).json({ attachment });
  }));

// The seals, which arrive as a JSON string in a multipart field.
function sealedKeysFrom(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw protocolError('E2EE_VALIDATION_ERROR',
      'sealedKeys is not a list of seals', 400);
  }
}

module.exports = router;
