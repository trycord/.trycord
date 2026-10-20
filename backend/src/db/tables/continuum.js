// Community Continuum: real federation with compatible Trycord instances.
//
// These tables track remote instances we exchange events with, the durable
// outbox of events awaiting delivery, the delivery attempt log, and the
// inbox of received events used for idempotency and replay protection.
//
// Continuum is opt-in: when the continuum.enabled feature flag is off, none
// of this data is read or written and a local-only instance stays fully
// functional.

module.exports = (engine) => [

  // Remote instances we federate with. One row per logical instance, keyed
  // by its stable instance id (not its origin, which can change).
  `CREATE TABLE IF NOT EXISTS continuum_instances (
      id          VARCHAR(64) PRIMARY KEY,
      name        VARCHAR(128) NOT NULL,
      origin      VARCHAR(512) NOT NULL UNIQUE,
      public_key  VARCHAR(512) NOT NULL,
      trust_status VARCHAR(16) NOT NULL DEFAULT 'pending',
      last_seen   VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL
    )${engine}`,

  // Outbox: federation events awaiting delivery to remote instances. Each row
  // is a signed event that one or more remote instances should receive.
  `CREATE TABLE IF NOT EXISTS continuum_events (
      id          VARCHAR(64) PRIMARY KEY,
      kind        VARCHAR(64) NOT NULL,
      actor_id    VARCHAR(64),
      target_id   VARCHAR(64),
      payload     TEXT NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      backoff_ms  INTEGER NOT NULL DEFAULT 1000,
      run_after   VARCHAR(64) NOT NULL,
      error       TEXT,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL
    )${engine}`,

  // Delivery log: one row per attempt to deliver an event to an instance.
  // Provides the failure diagnostics and retry history the operator can see
  // in the administration interface.
  `CREATE TABLE IF NOT EXISTS continuum_deliveries (
      id          VARCHAR(64) PRIMARY KEY,
      event_id    VARCHAR(64) NOT NULL,
      instance_id VARCHAR(64) NOT NULL,
      status      VARCHAR(16) NOT NULL,
      attempted_at VARCHAR(64) NOT NULL,
      error       TEXT,
      FOREIGN KEY (event_id) REFERENCES continuum_events(id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES continuum_instances(id) ON DELETE CASCADE
    )${engine}`,

  // Inbox: received events, used for deduplication and replay protection.
  // An event we have already processed is never processed again, even if it
  // arrives from multiple paths or is replayed after a network failure.
  `CREATE TABLE IF NOT EXISTS continuum_inbox (
      event_id    VARCHAR(64) PRIMARY KEY,
      instance_id VARCHAR(64) NOT NULL,
      kind        VARCHAR(64) NOT NULL,
      payload     TEXT NOT NULL,
      received_at VARCHAR(64) NOT NULL,
      processed   INTEGER NOT NULL DEFAULT 0
    )${engine}`,

  // This instance's own signing identity. Generate-once, persist-forever: a
  // federation relationship cannot survive an operator restart if the key pair
  // is regenerated, because remote instances verify our signatures against the
  // public key they recorded when they added us. One row, id = 1.
  `CREATE TABLE IF NOT EXISTS continuum_keys (
      id INTEGER PRIMARY KEY,
      private_key TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL
    )`,

  // The publication ledger: what this instance has already federated, and the
  // state it was in when it was published.
  //
  // The relay publishes from the instance's own state rather than from a hook
  // in every write path, so it needs to know what it has already sent. One row
  // per local source row (a community, a channel, a message, a reaction),
  // keyed by the kind and the local id.
  //
  //   fingerprint - a hash of the state that was published. A different hash
  //                 means the row changed and the change has to be relayed.
  //   state       - 'live' (published), 'withheld' (decided not to federate:
  //                 a private community, a channel the members cannot post in)
  //                 or 'deleted' (the local row is gone and the deletion was
  //                 relayed).
  //
  // A withheld row is withheld for good: what was not federable when it was
  // written is never federated later, when the rule that stopped it has been
  // changed.
  `CREATE TABLE IF NOT EXISTS continuum_publications (
      source_kind   VARCHAR(32) NOT NULL,
      source_id     VARCHAR(160) NOT NULL,
      fingerprint   VARCHAR(128) NOT NULL,
      -- What the publication needs later: where the thing was, who wrote it,
      -- and the ids a deletion event has to carry once the row is gone.
      context       TEXT,
      state         VARCHAR(16) NOT NULL DEFAULT 'live',
      last_kind     VARCHAR(64),
      last_event_id VARCHAR(64),
      published_at  VARCHAR(64) NOT NULL,
      updated_at    VARCHAR(64) NOT NULL,
      PRIMARY KEY (source_kind, source_id)
    )${engine}`,

  // The change feed's cursors. The feed reconciles the local tables against
  // the ledger, and these say where the last pass stopped so the next one
  // picks up where it left off instead of starting over every time.
  `CREATE TABLE IF NOT EXISTS continuum_feed_state (
      name       VARCHAR(64) PRIMARY KEY,
      \`cursor\`  VARCHAR(160) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    )${engine}`,

  // Per-actor sequence counters.
  //
  //   'out:<actor id>'                  - the sequence this instance has handed
  //                                       out for one local actor.
  //   'in:<origin instance>:<actor id>' - the highest sequence this instance
  //                                       has accepted from one remote actor.
  //
  // The inbound half is the replay floor: an event whose sequence is not
  // newer than the highest already accepted for that (origin, actor) is
  // refused as stale.
  `CREATE TABLE IF NOT EXISTS continuum_sequences (
      scope      VARCHAR(160) PRIMARY KEY,
      last_seq   INTEGER NOT NULL DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL
    )${engine}`,

  // The remote communities this instance knows about. One row per community
  // on another instance, keyed by the instance it lives on and its id there.
  //
  // A remote community is a reference, never a copy: it is not a row in
  // `servers`, it grants no role and no permission here, and the instance it
  // lives on stays the only authority over it.
  `CREATE TABLE IF NOT EXISTS continuum_communities (
      id                  VARCHAR(64) PRIMARY KEY,
      origin_instance_id  VARCHAR(64) NOT NULL,
      origin_community_id VARCHAR(64) NOT NULL,
      name                VARCHAR(255) NOT NULL,
      description         TEXT,
      icon_url            VARCHAR(512),
      -- The channels the origin exposes, as JSON: one entry per channel with
      -- its origin id, name, type, topic and whether the members may post.
      channels            TEXT NOT NULL,
      state               VARCHAR(16) NOT NULL DEFAULT 'discovered',
      synced_at           VARCHAR(64) NOT NULL,
      created_at          VARCHAR(64) NOT NULL,
      updated_at          VARCHAR(64) NOT NULL,
      UNIQUE (origin_instance_id, origin_community_id)
    )${engine}`,

  // Which local account follows which remote community. The local side of a
  // federated membership: it says that a person here joined a community that
  // lives on another instance, and it carries no authority over it.
  `CREATE TABLE IF NOT EXISTS continuum_memberships (
      id                  VARCHAR(64) PRIMARY KEY,
      user_id             VARCHAR(64) NOT NULL,
      origin_instance_id  VARCHAR(64) NOT NULL,
      origin_community_id VARCHAR(64) NOT NULL,
      state               VARCHAR(16) NOT NULL DEFAULT 'joined',
      created_at          VARCHAR(64) NOT NULL,
      updated_at          VARCHAR(64) NOT NULL,
      UNIQUE (user_id, origin_instance_id, origin_community_id)
    )${engine}`,

  // The relay store: a message that arrived from another instance.
  //
  // Keyed by (origin instance, origin id) so a remote id can never collide
  // with a local one, and so the same message arriving twice lands on the
  // same row. It is not a local message: it keeps the origin's timestamp, the
  // origin's author and the origin's ids, and it is presented as relayed.
  `CREATE TABLE IF NOT EXISTS continuum_relay_messages (
      id                  VARCHAR(64) PRIMARY KEY,
      origin_instance_id  VARCHAR(64) NOT NULL,
      origin_message_id   VARCHAR(64) NOT NULL,
      origin_community_id VARCHAR(64) NOT NULL,
      origin_channel_id   VARCHAR(64) NOT NULL,
      author_origin_id    VARCHAR(64) NOT NULL,
      author_username     VARCHAR(128),
      author_display_name VARCHAR(128),
      content             TEXT,
      -- The origin's own timestamps, kept as they were there.
      created_at          VARCHAR(64) NOT NULL,
      edited_at           VARCHAR(64),
      deleted_at          VARCHAR(64),
      thread_root_id      VARCHAR(64),
      event_id            VARCHAR(64),
      relayed_at          VARCHAR(64) NOT NULL,
      UNIQUE (origin_instance_id, origin_message_id)
    )${engine}`,

  // A reaction that arrived from another instance, keyed the same way.
  `CREATE TABLE IF NOT EXISTS continuum_relay_reactions (
      id                  VARCHAR(64) PRIMARY KEY,
      origin_instance_id  VARCHAR(64) NOT NULL,
      origin_message_id   VARCHAR(64) NOT NULL,
      origin_user_id      VARCHAR(64) NOT NULL,
      username            VARCHAR(128),
      display_name        VARCHAR(128),
      emoji               VARCHAR(32) NOT NULL,
      created_at          VARCHAR(64) NOT NULL,
      relayed_at          VARCHAR(64) NOT NULL,
      UNIQUE (origin_instance_id, origin_message_id, origin_user_id, emoji)
    )${engine}`,

  // A message written here for a community that lives on another instance.
  //
  // This is the return direction. A member of a federated community writes on
  // this instance, and the message travels to the instance that owns the
  // community. It is not a local message - the community is not here - so it
  // has a table of its own and a lifecycle of its own:
  //
  //   pending  - written here; the owner has not answered yet
  //   accepted - the owner took it
  //   refused  - the owner would not take it, and said why
  //   deleted  - it was taken back, here or at the owner
  //
  // The community and the channel keep the ids they have on the instance that
  // owns them (origin_community_id, origin_channel_id); the message keeps the
  // id it has here, which is this row's id.
  `CREATE TABLE IF NOT EXISTS continuum_relay_outgoing (
      id                     VARCHAR(64) PRIMARY KEY,
      origin_instance_id     VARCHAR(64) NOT NULL,
      origin_community_id    VARCHAR(64) NOT NULL,
      origin_channel_id      VARCHAR(64) NOT NULL,
      author_id              VARCHAR(64) NOT NULL,
      username               VARCHAR(128),
      display_name           VARCHAR(128),
      content                TEXT,
      created_at             VARCHAR(64) NOT NULL,
      edited_at              VARCHAR(64),
      deleted_at             VARCHAR(64),
      -- The thread root, and the instance that holds it: a reply can hang
      -- from a message the owner wrote and from one another member wrote
      -- here, and the two are not on the same instance.
      thread_root_id         VARCHAR(64),
      thread_root_instance_id VARCHAR(64),
      state                  VARCHAR(16) NOT NULL DEFAULT 'pending',
      reason                 TEXT,
      event_id               VARCHAR(64),
      decided_at             VARCHAR(64),
      updated_at             VARCHAR(64) NOT NULL
    )${engine}`,

  // A member of one of this instance's communities who lives on another
  // instance. The origin decides what such a member may do; this row is the
  // origin's record of them, and it grants nothing here.
  //
  // The state is what the owner has decided about them: 'joined' (a member),
  // 'left' (they left, or the owner removed them), 'muted' (a member whose
  // writing the owner does not accept) and 'removed' (taken out of the
  // community).
  `CREATE TABLE IF NOT EXISTS continuum_relay_memberships (
      id                  VARCHAR(64) PRIMARY KEY,
      origin_instance_id  VARCHAR(64) NOT NULL,
      origin_community_id VARCHAR(64) NOT NULL,
      origin_user_id      VARCHAR(64) NOT NULL,
      username            VARCHAR(128),
      display_name        VARCHAR(128),
      state               VARCHAR(16) NOT NULL DEFAULT 'joined',
      joined_at           VARCHAR(64),
      updated_at          VARCHAR(64) NOT NULL,
      UNIQUE (origin_instance_id, origin_community_id, origin_user_id)
    )${engine}`,
];
