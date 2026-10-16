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
];
