// End-to-end encryption: device identity, prekeys, sessions, conversation
// keys, attachment keys and key backups.
//
// These tables hold the server's half of the E2EE protocol and nothing else.
// The rule that shapes all of them: the server stores public keys, opaque
// ciphertext and counters, and never a private key in the clear.
//
//   e2ee_devices        a device's identity, its published prekey, and its
//                       private material sealed under a key only the account
//                       holder can derive
//   e2ee_prekeys        the one-time and last-resort prekeys a device
//                       publishes, each consumed exactly once
//   e2ee_sessions       a pairwise session: the ratchet state, sealed, and
//                       the counters in the clear so a replay can be refused
//   e2ee_group_sessions a conversation's key epoch
//   e2ee_group_keys     the conversation key, sealed to one device each
//   e2ee_attachments    an encrypted attachment and its sealed key material
//   e2ee_backups        a user's encrypted key backup
//
// The engine suffix is the only signal this module gets about the dialect,
// and it is enough: MySQL gets the suffix, SQLite gets an empty string.
// The standalone indexes are emitted for SQLite only, because SQLite and
// MySQL disagree about whether CREATE INDEX may be repeated - and a
// statement that fails on the second boot stops the instance from starting.
// On MySQL the foreign keys supply those indexes, and the portable UNIQUE
// constraints below do the rest.

const isMysql = (engine) => String(engine || '').indexOf('InnoDB') !== -1;

module.exports = (engine) => {
  const ddl = [

    // A device: one browser, one phone, one desktop client.
    //
    // identity_key is the Ed25519 signing key and identity_dh_key the
    // X25519 key used in the Diffie-Hellman role. The device signs the
    // bundle it publishes, so a server that swaps one device's keys for
    // another's produces a bundle a client rejects - which is what stops the
    // server from sitting in the middle of a conversation.
    //
    // wrapped_private_key holds the private material sealed under a key
    // derived from the account holder's recovery key. The server stores it
    // and cannot open it: the recovery key never reaches the server.
    `CREATE TABLE IF NOT EXISTS e2ee_devices (
        id                   VARCHAR(64) PRIMARY KEY,
        user_id              VARCHAR(64) NOT NULL,
        label                VARCHAR(128) NOT NULL,
        identity_key         VARCHAR(64) NOT NULL,
        identity_dh_key      VARCHAR(64) NOT NULL,
        signed_pre_key       VARCHAR(64) NOT NULL,
        -- The device's signature over its own bundle. A client checks it
        -- against the identity key in the bundle before it trusts the
        -- bundle, which is what makes a bundle that the server rewrote
        -- detectable.
        signature            VARCHAR(128),
        key_fingerprint      VARCHAR(64) NOT NULL,
        wrapped_private_key  TEXT,
        recovery_salt        VARCHAR(64),
        recovery_iterations  INTEGER,
        revoked_at           VARCHAR(64),
        created_at           VARCHAR(64) NOT NULL,
        last_seen_at         VARCHAR(64) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )${engine}`,

    // The prekeys a device publishes.
    //
    // A one-time prekey is handed out once and then never again: the row is
    // marked consumed in the same transaction that hands it out, so two
    // initiators racing for the same prekey cannot both get it. The
    // last-resort prekey is consumed the same way - a device publishes a
    // fresh one as soon as the old one is used.
    `CREATE TABLE IF NOT EXISTS e2ee_prekeys (
        id                 VARCHAR(64) PRIMARY KEY,
        device_id          VARCHAR(64) NOT NULL,
        user_id            VARCHAR(64) NOT NULL,
        public_key         VARCHAR(64) NOT NULL,
        -- The signature over this prekey, bound to the device that published
        -- it and to the device's signed prekey. One signature per prekey,
        -- because the bundle handed out carries one prekey: a signature
        -- over the whole batch would not cover the one that was handed out.
        signature          VARCHAR(128),
        sealed_private_key TEXT,
        kind               VARCHAR(16) NOT NULL DEFAULT 'one-time',
        consumed_at        VARCHAR(64),
        claimed_at         VARCHAR(64),
        created_at         VARCHAR(64) NOT NULL,
        FOREIGN KEY (device_id) REFERENCES e2ee_devices(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )${engine}`,

    // A pairwise session between two devices.
    //
    // ratchet_state is the ratchet state sealed under a key derived from the
    // session secret. The server stores it and cannot read it. The counters
    // are in the clear beside it, because refusing a replayed message is the
    // server's job and it cannot do that with a sealed blob.
    `CREATE TABLE IF NOT EXISTS e2ee_sessions (
        id               VARCHAR(64) PRIMARY KEY,
        user_id          VARCHAR(64) NOT NULL,
        device_id        VARCHAR(64) NOT NULL,
        peer_device_id   VARCHAR(64) NOT NULL,
        peer_user_id     VARCHAR(64) NOT NULL,
        conversation_id  VARCHAR(128),
        ratchet_state    TEXT,
        send_counter     INTEGER NOT NULL DEFAULT 0,
        recv_counter     INTEGER NOT NULL DEFAULT 0,
        status           VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at       VARCHAR(64) NOT NULL,
        last_seen_at     VARCHAR(64) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (device_id) REFERENCES e2ee_devices(id) ON DELETE CASCADE,
        FOREIGN KEY (peer_device_id) REFERENCES e2ee_devices(id) ON DELETE CASCADE
      )${engine}`,

    // A conversation's key, and the epoch that names which key is current.
    //
    // A membership change mints a new epoch and a new key; the old rows stay
    // so a client that has not caught up can be told which epoch it is
    // missing rather than simply failing.
    `CREATE TABLE IF NOT EXISTS e2ee_group_sessions (
        id              VARCHAR(128) PRIMARY KEY,
        epoch           INTEGER NOT NULL DEFAULT 0,
        created_by      VARCHAR(64) NOT NULL,
        created_at      VARCHAR(64) NOT NULL,
        updated_at      VARCHAR(64) NOT NULL
      )${engine}`,

    // The conversation key, sealed to one device each.
    //
    // The seal is a Diffie-Hellman agreement with the device's identity key
    // and an ephemeral key the sealing device throws away afterwards, so the
    // server can neither open a seal nor re-seal one for a device it is not
    // entitled to hand it to.
    `CREATE TABLE IF NOT EXISTS e2ee_group_keys (
        conversation_id VARCHAR(128) NOT NULL,
        device_id       VARCHAR(64) NOT NULL,
        epoch           INTEGER NOT NULL,
        sealed_key      TEXT NOT NULL,
        created_at      VARCHAR(64) NOT NULL,
        PRIMARY KEY (conversation_id, device_id, epoch),
        FOREIGN KEY (device_id) REFERENCES e2ee_devices(id) ON DELETE CASCADE
      )${engine}`,

    // An encrypted attachment.
    //
    // filename and mime describe the ciphertext, not the content: the server
    // stores the bytes the client uploaded and has no idea what they are.
    `CREATE TABLE IF NOT EXISTS e2ee_attachments (
        id              VARCHAR(64) PRIMARY KEY,
        conversation_id VARCHAR(128) NOT NULL,
        uploader_id     VARCHAR(64) NOT NULL,
        filename        VARCHAR(255) NOT NULL,
        mime            VARCHAR(64) NOT NULL,
        size            INTEGER NOT NULL DEFAULT 0,
        created_at      VARCHAR(64) NOT NULL,
        FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
      )${engine}`,

    // The attachment key, sealed to one device each. The plaintext key is
    // never sent to the server; the server only ever holds a seal.
    `CREATE TABLE IF NOT EXISTS e2ee_attachment_keys (
        attachment_id VARCHAR(64) NOT NULL,
        device_id     VARCHAR(64) NOT NULL,
        sealed_key    TEXT NOT NULL,
        created_at    VARCHAR(64) NOT NULL,
        PRIMARY KEY (attachment_id, device_id),
        FOREIGN KEY (attachment_id) REFERENCES e2ee_attachments(id) ON DELETE CASCADE,
        FOREIGN KEY (device_id) REFERENCES e2ee_devices(id) ON DELETE CASCADE
      )${engine}`,

    // A user's encrypted key backup: the blob their other devices can
    // restore from, and the parameters needed to open it. The blob is opaque
    // to the server.
    `CREATE TABLE IF NOT EXISTS e2ee_backups (
        user_id    VARCHAR(64) PRIMARY KEY,
        salt       VARCHAR(64) NOT NULL,
        iterations INTEGER NOT NULL,
        iv         VARCHAR(64) NOT NULL,
        ciphertext TEXT NOT NULL,
        tag        VARCHAR(64) NOT NULL,
        created_at VARCHAR(64) NOT NULL,
        updated_at VARCHAR(64) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )${engine}`,
  ];

  if (!isMysql(engine)) {
    ddl.push(
      'CREATE INDEX IF NOT EXISTS idx_e2ee_devices_user ON e2ee_devices(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_e2ee_prekeys_device ON e2ee_prekeys(device_id, consumed_at)',
      'CREATE INDEX IF NOT EXISTS idx_e2ee_sessions_device ON e2ee_sessions(device_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_e2ee_sessions_peer ON e2ee_sessions(peer_device_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_e2ee_group_keys_conversation ON e2ee_group_keys(conversation_id, epoch)',
      'CREATE INDEX IF NOT EXISTS idx_e2ee_attachments_conversation ON e2ee_attachments(conversation_id)'
    );
  }

  return ddl;
};
