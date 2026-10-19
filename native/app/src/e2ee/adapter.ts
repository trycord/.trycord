/**
 * The end-to-end encryption adapter.
 *
 * The client's job is to know how to open an envelope and how to write one.
 * The cryptography belongs to a library and to the device's own key store,
 * and it is not written yet.
 *
 * So this file defines the seam and nothing more. The adapter below is
 * explicitly unimplemented: every call says so and refuses. It does not
 * pretend to encrypt, because a client that claims to protect a message and
 * quietly sends it in the clear is worse than one that admits it cannot.
 *
 * The server's protocol is in `backend/src/services/e2ee/`, and its
 * envelope is the one in ./envelope.ts. What has to be wired to this
 * adapter:
 *
 *   1. A crypto library that provides X25519 and Ed25519, HKDF-SHA256 and
 *      AES-256-GCM - the primitives the server's `primitives.js` uses - and
 *      a random source. Nothing in the client is implemented without them.
 *   2. The X3DH handshake (`x3dh.js` on the server): fetch a peer's prekey
 *      bundle from `GET /api/e2ee/prekeys/:deviceId`, derive the shared
 *      secret with the four labels the server uses, and open a session with
 *      `POST /api/e2ee/sessions`.
 *   3. The Double Ratchet (`ratchet.js` on the server): the root step, the
 *      chain step and the header step, with the exact labels from
 *      `protocol.js`, and the skipped-key store the server caps at a
 *      thousand entries.
 *   4. The associated data. The server's `envelope.associatedData` is a
 *      length-prefixed canonical byte string over the context, the version,
 *      the session, the conversation, the sender, the receiver, the counter
 *      as four big-endian bytes, and the ratchet key. The client's bytes
 *      must match the server's exactly, or every tag will fail.
 *   5. A device key store, holding the account's identity key, its identity
 *      DH key, its signed prekey, its one-time prekeys and the ratchet
 *      states, in the platform keystore (see ../storage/secureStore.ts).
 *   6. The message pipeline: a body that is an envelope goes to decrypt()
 *      and is rendered as text; a body that is not an envelope is rendered
 *      as text, and the difference is recorded. A message is never sent
 *      without an envelope when the conversation is encrypted, and never
 *      sent as plaintext pretending to be encrypted.
 *   7. The realtime events. The server emits `e2ee:device`, `e2ee:key-change`
 *      and `e2ee:safety-number`; a client that ignores `e2ee:key-change`
 *      keeps sending with a key the conversation has moved on from.
 */

import {
  E2eeEnvelope,
  E2eeScope,
  E2eeUnsupportedError,
  readE2eeEnvelope,
} from './envelope';

export interface E2eeAdapter {
  /** The envelope format version this adapter writes. */
  readonly protocolVersion: number;
  /** False when the adapter cannot open anything. */
  readonly supported: boolean;
  /** Whether a conversation is end-to-end encrypted. */
  isEncrypted(scope: E2eeScope): boolean;
  /** Seals a message. */
  encrypt(plaintext: string, scope: E2eeScope): Promise<E2eeEnvelope>;
  /** Opens a message. */
  decrypt(envelope: E2eeEnvelope): Promise<string>;
}

/**
 * The adapter that is wired in until the cryptography is written.
 *
 * It refuses every call with a message that says what is missing. Nothing
 * here encrypts, and nothing here pretends to.
 */
export function createUnimplementedE2eeAdapter(): E2eeAdapter {
  const refuse = (what: string): never => {
    throw new E2eeUnsupportedError(
      `End-to-end encryption is not implemented in this build: ${what}. ` +
        'The server protocol in backend/src/services/e2ee/ has to be wired to ' +
        'this adapter before a message can be sealed or opened.',
    );
  };

  return {
    protocolVersion: 0,
    supported: false,
    isEncrypted(): boolean {
      return false;
    },
    async encrypt(): Promise<E2eeEnvelope> {
      return refuse('sealing a message');
    },
    async decrypt(): Promise<string> {
      return refuse('opening a message');
    },
  };
}

/**
 * Reads an envelope that has arrived on the wire and hands it to the adapter.
 *
 * A message body that is not an envelope is not an error - it is an ordinary
 * message - so the caller gets null and renders the body as text.
 */
export async function openEnvelope(
  adapter: E2eeAdapter,
  body: unknown,
  scope: E2eeScope,
): Promise<string | null> {
  if (!adapter.supported) return null;
  if (!body || typeof body !== 'object') return null;
  let envelope: E2eeEnvelope;
  try {
    envelope = readE2eeEnvelope(body);
  } catch {
    return null;
  }
  if (!adapter.isEncrypted(scope)) return null;
  return adapter.decrypt(envelope);
}
