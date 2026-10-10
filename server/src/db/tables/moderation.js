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
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,
];
