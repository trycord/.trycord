// Moderation, and the record of it.
//
// Four tables written together and read together: a report becomes an action, an action
// can be appealed, and all of it is audit-logged. Separating them would put the sequence
// that matters most in the place it is hardest to see.

module.exports = (engine) => [

  `CREATE TABLE IF NOT EXISTS reports (
      id         VARCHAR(64) PRIMARY KEY,
      reporter_id VARCHAR(64) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id   VARCHAR(64) NOT NULL,
      reason      VARCHAR(255) NOT NULL,
      description TEXT,
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      assigned_admin_id VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64),
      resolution  VARCHAR(16),
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS moderation_actions (
      id         VARCHAR(64) PRIMARY KEY,
      actor_id   VARCHAR(64) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id  VARCHAR(64) NOT NULL,
      action_type VARCHAR(24) NOT NULL,
      reason     TEXT NOT NULL,
      expires_at VARCHAR(64),
      report_id  VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS appeals (
      id          VARCHAR(64) PRIMARY KEY,
      user_id     VARCHAR(64) NOT NULL,
      action_id   VARCHAR(64) NOT NULL,
      reason      TEXT NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      reviewer_id VARCHAR(64),
      decision    VARCHAR(16),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (action_id) REFERENCES moderation_actions(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
      id         VARCHAR(64) PRIMARY KEY,
      actor_id   VARCHAR(64) NOT NULL,
      action     VARCHAR(64) NOT NULL,
      target_type VARCHAR(32),
      target_id  VARCHAR(64),
      reason     TEXT,
      report_id  VARCHAR(64),
      -- The community a server-scoped moderation entry belongs to. Platform
      -- entries (enforcement, bot flags) leave it NULL, which is why it is
      -- nullable rather than NOT NULL.
      server_id  VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // A moderator's note about a member.
  //
  // One note per member per community, so a moderator who writes again
  // replaces the earlier note rather than leaving a pile of them to read.
  //
  // The note belongs to the community's moderators and to nobody else: the
  // member it is about never sees it, and the server only hands it to a
  // reader who can moderate here.
  `CREATE TABLE IF NOT EXISTS member_notes (
      id         VARCHAR(64) PRIMARY KEY,
      server_id  VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      author_id  VARCHAR(64) NOT NULL,
      body       TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE (server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  // A report about activity on another instance.
  //
  // The row is the record of what was sent, and it deliberately holds a
  // reference and not a copy: the identifier of the reported thing on the
  // instance that owns it, the reason, and the reporter's account on that
  // instance. The content itself is never here, and neither is anything
  // personal about the reporter.
  //
  // Direction says which side of the exchange this row is on: 'outbound' is a
  // report this instance filed about something on another instance,
  // 'inbound' is one that arrived from another instance about something here.
  `CREATE TABLE IF NOT EXISTS cross_instance_reports (
      id                     VARCHAR(64) PRIMARY KEY,
      direction              VARCHAR(16) NOT NULL,
      origin_instance_id     VARCHAR(64) NOT NULL,
      target_instance_id     VARCHAR(64) NOT NULL,
      target_instance_origin VARCHAR(512),
      community_id           VARCHAR(64),
      channel_id             VARCHAR(64),
      content_id             VARCHAR(64) NOT NULL,
      content_type           VARCHAR(32) NOT NULL,
      reason                 VARCHAR(255) NOT NULL,
      description            TEXT,
      reporter_id            VARCHAR(64),
      reporter_origin_id     VARCHAR(64),
      status                 VARCHAR(16) NOT NULL DEFAULT 'FILED',
      -- Whether the receiving instance holds the reported thing and can
      -- therefore act on it. A report about something it has never seen is
      -- still a report; it just cannot be acted on.
      actionable             INTEGER NOT NULL DEFAULT 0,
      disclosure             TEXT,
      envelope_id            VARCHAR(64),
      delivery_error         TEXT,
      created_at             VARCHAR(64) NOT NULL,
      received_at            VARCHAR(64),
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,
];
