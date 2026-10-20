// The end-to-end encryption client.
//
// Trycord E2EE, version 1 ("TCE2E-v1"). The server's half of the protocol is
// in backend/src/services/e2ee/; this is the browser's half, and the two are
// the same protocol: the same labels, the same byte encodings, the same
// key schedule.
//
// What is here:
//
//   protocol.js    the version, the derivation labels, the bounds
//   primitives.js  X25519, Ed25519, HKDF-SHA256, AES-256-GCM, SHA-2
//   envelope.js    the wire format and its validation
//   x3dh.js        the initiator's and the responder's halves
//   ratchet.js     the Double Ratchet and the sealed state
//   sealing.js     sealing a symmetric key to a device
//   deviceKeys.js  a device's key material and the recovery wrap
//   prekeys.js     the bytes a device signs
//   store.js       where the private keys live
//   device.js      this browser's device
//   sessions.js    one session per peer device
//   group.js       the conversation key
//   attachments.js encrypted files
//   recovery.js    the key backup and the recovery flow
//   message.js     reading a message that may be encrypted
//   send.js        what the composer does with a message
//   api.js         the /api/e2ee routes
//   client.js      the client that ties them together

export {
  PROTOCOL_VERSION,
  X3DH_INFO,
  RATCHET_INFO,
  RATCHET_ROOT_SEED_INFO,
  RATCHET_ROOT_INFO,
  RATCHET_CHAIN_INFO,
  RATCHET_HEADER_INFO,
  GROUP_SEAL_INFO,
  RATCHET_STATE_INFO,
  RECOVERY_WRAP_INFO,
  ATTACHMENT_SEAL_INFO,
  PREKEY_SIGNATURE_CONTEXT,
  SESSION_INIT_SIGNATURE_CONTEXT,
  RECOVERY_PROOF_CONTEXT,
  ENVELOPE_AAD_CONTEXT,
  MAX_SKIPPED_KEYS,
  MAX_STALE_CHAIN_KEYS,
  RECOVERY_PBKDF2_ITERATIONS,
  RECOVERY_SALT_BYTES,
  ZERO_SALT,
  canonical,
} from './protocol.js';

export {
  KEY_BYTES,
  SIGNATURE_BYTES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  SALT_BYTES,
  generateKeyPair,
  ecdh,
  hkdf,
  sha256,
  sha512,
  pbkdf2,
  encrypt as aesEncrypt,
  decrypt as aesDecrypt,
  sign,
  verify,
} from './primitives.js';

export {
  b64,
  unb64,
  utf8,
  fromUtf8,
  hex,
  randomBytes,
  concatBytes,
  equalBytes,
} from './bytes.js';

export {
  protocolError,
  associatedData,
  agreementBytes,
  counterBytes,
  initSignatureBytes,
  validate,
  REQUIRED_FIELDS,
} from './envelope.js';

export { deriveSecret, initiate, respond } from './x3dh.js';

export {
  emptyState,
  deriveRootStep,
  deriveChain,
  deriveHeaderKey,
  initiatorState,
  responderState,
  encrypt as ratchetEncrypt,
  decrypt as ratchetDecrypt,
  sealState,
  openState,
} from './ratchet.js';

export { seal, open } from './sealing.js';

export {
  KEY_NAMES,
  generateKeySet,
  publicKeySet,
  privateKeySet,
  restoreKeySet,
  fingerprint,
  generateRecoveryKey,
  deriveWrappingKey,
  sealPrivateMaterial,
  openPrivateMaterial,
  sealPrivateBytes,
  openPrivateBytes,
} from './deviceKeys.js';

export {
  bundleSignatureBytes,
  prekeySignatureBytes,
  signatureVerifies,
} from './prekeys.js';

export {
  openStore,
  memoryStore,
  localStorageStore,
  indexedDbStore,
  readRecord,
  writeRecord,
  removeRecord,
  STORE_PREFIX,
  DB_NAME,
  DB_STORE,
} from './store.js';

export {
  Device,
  loadDevice,
  saveDevice,
  createDevice,
  ensureSealedPrivateKey,
  newId,
  DEVICE_RECORD,
  PREKEY_BATCH,
  PREKEY_LOW_WATER,
} from './device.js';

export { SessionManager, verifyBundle, SESSION_INDEX, PEER_KEYS } from './sessions.js';

export { sealAad, sealForDevice, openForDevice, newConversationKey, publishKey, keyForDevice } from './group.js';

export {
  sealAad as attachmentSealAad,
  sealForDevice as sealAttachmentForDevice,
  openForDevice as openAttachmentForDevice,
  encryptFile,
  decryptFile,
  upload,
  keyForDevice as attachmentKeyForDevice,
} from './attachments.js';

export {
  proofBytes,
  sealBackup,
  openBackup,
  backupMaterial,
  deviceFromBackup,
  recover,
} from './recovery.js';

export { readMessage, envelopeFor, REASONS } from './message.js';

export {
  decide,
  needsWarning,
  ENCRYPTED,
  NOT_ENCRYPTED,
  MIXED,
  KEY_CHANGED,
  WARNINGS,
} from './send.js';

export { createE2eeApi } from './api.js';

export { E2eeClient } from './client.js';
