// The developer platform's own tables.
//
// Three concerns, kept apart from the community data model because they answer
// to a different question: not "what happened in this community" but "who is
// calling the API, what may they call, and what have they called".
//
//   developer_api_keys      the credentials a third-party integration uses
//   developer_key_usage     what those credentials have spent
//   developer_subscriptions which events a credential has subscribed to
//
// A credential is stored as one row per *secret generation*. A rotation issues
// a new secret without changing the credential's identity, so the new secret
// gets a row of its own and names the row it replaced in `rotated_from`. The
// old row stays usable until the end of the overlap window and is then
// refused, which is what makes a rotation a rotation rather than an outage.
//
// The row id is also the handle inside the token, so authenticating a request
// is one indexed primary-key lookup rather than a scan of every credential.

module.exports = (engine) => [

  // One row per secret generation of one credential.
  //
  // `key_id` is the credential's public identifier: it is stable across
  // rotations, it is what a caller puts in a URL, and it is what groups the
  // generations of one credential together. The row `id` changes on every
  // rotation and never leaves the server.
  `CREATE TABLE IF NOT EXISTS developer_api_keys (
      id          VARCHAR(64) PRIMARY KEY,
      key_id      VARCHAR(64) NOT NULL,
      owner_user_id VARCHAR(64) NOT NULL,
      name        VARCHAR(64) NOT NULL,
      -- 'user' for a credential a person owns, 'bot' for the scoped
      -- credential that belongs to an application. A bot credential holds no
      -- secret of its own: the application owns the token, and the credential
      -- row carries the scopes and the limit that go with it.
      kind        VARCHAR(16) NOT NULL DEFAULT 'user',
      bot_application_id VARCHAR(64),
      -- The community the credential is bound to, or NULL for a credential
      -- that may act in any community its owner can act in.
      community_id VARCHAR(64),
      scopes      TEXT NOT NULL,
      secret_hash VARCHAR(255),
      -- 'active' while this generation is the current one, 'superseded' while
      -- the previous secret is still inside its overlap window, 'revoked'
      -- once the credential has been withdrawn.
      status      VARCHAR(16) NOT NULL DEFAULT 'active',
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 120,
      created_at  VARCHAR(64) NOT NULL,
      last_used_at VARCHAR(64),
      -- For the current generation, when the credential itself expires. For a
      -- superseded generation, when the previous secret stops working.
      expires_at  VARCHAR(64),
      revoked_at  VARCHAR(64),
      revoked_reason VARCHAR(255),
      rotated_at  VARCHAR(64),
      -- The generation this one replaced.
      rotated_from VARCHAR(64),
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (bot_application_id) REFERENCES bot_applications(id) ON DELETE CASCADE
    )${engine}`,

  // What a credential has spent, counted per minute, per route and per
  // outcome. The row id is derived from those three, so a counter is one
  // upsert rather than a read-modify-write.
  `CREATE TABLE IF NOT EXISTS developer_key_usage (
      id          VARCHAR(64) PRIMARY KEY,
      key_id      VARCHAR(64) NOT NULL,
      route       VARCHAR(128) NOT NULL,
      bucket_start VARCHAR(64) NOT NULL,
      requests    INTEGER NOT NULL DEFAULT 0,
      succeeded   INTEGER NOT NULL DEFAULT 0,
      client_errors INTEGER NOT NULL DEFAULT 0,
      server_errors INTEGER NOT NULL DEFAULT 0
    )${engine}`,

  // A credential's event subscriptions: which events of a community are
  // delivered to which webhook, and which credential asked for it.
  //
  // `key_id` is the credential that asked for the subscription, and
  // `owner_user_id` the account it acts for. A subscription made by a signed-in
  // person has no credential, so the first is null and the second is not.
  `CREATE TABLE IF NOT EXISTS developer_subscriptions (
      id          VARCHAR(64) PRIMARY KEY,
      key_id      VARCHAR(64),
      owner_user_id VARCHAR(64),
      webhook_id  VARCHAR(64) NOT NULL,
      community_id VARCHAR(64) NOT NULL,
      events      TEXT NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    )${engine}`,
];
