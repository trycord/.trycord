// Moderation, and the record of it.
//
// A case is the durable centre: a report opens one, an enforcement action
// attaches to one, its evidence and notes live under it, and an appeal can
// challenge it. The case identifier is what every surface uses to tell the
// same story, whether it is a platform investigation or a community one.

module.exports = (engine) => [

  // The case itself. `scope` says who owns it: platform Trust & Safety or a
  // community. A community case always carries server_id, and every read of
  // a community case is scoped by it - a case identifier is never authority
  // to read another community's investigation.
  `CREATE TABLE IF NOT EXISTS moderation_cases (
      id          VARCHAR(64) PRIMARY KEY,
      scope       VARCHAR(16) NOT NULL,
      server_id   VARCHAR(64),
      subject_type VARCHAR(32) NOT NULL,
      subject_id  VARCHAR(64),
      title       VARCHAR(255) NOT NULL,
      category    VARCHAR(32),
      severity    VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
      priority    VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      assignee_id VARCHAR(64),
      reporter_id VARCHAR(64),
      report_id   VARCHAR(64),
      action_id   VARCHAR(64),
      summary     TEXT,
      resolution  TEXT,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      closed_at   VARCHAR(64),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS reports (
      id         VARCHAR(64) PRIMARY KEY,
      case_id    VARCHAR(64),
      reporter_id VARCHAR(64) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id   VARCHAR(64) NOT NULL,
      server_id   VARCHAR(64),
      reason      VARCHAR(255) NOT NULL,
      category    VARCHAR(32) NOT NULL DEFAULT 'OTHER',
      severity    VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
      priority    VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
      description TEXT,
      target_snapshot TEXT,
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      assigned_admin_id VARCHAR(64),
      resolution  VARCHAR(16),
      resolution_note TEXT,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64),
      last_activity_at VARCHAR(64),
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE SET NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS moderation_actions (
      id         VARCHAR(64) PRIMARY KEY,
      case_id    VARCHAR(64),
      server_id  VARCHAR(64),
      actor_id   VARCHAR(64) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id  VARCHAR(64) NOT NULL,
      action_type VARCHAR(32) NOT NULL,
      reason     TEXT NOT NULL,
      expires_at VARCHAR(64),
      status     VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      report_id  VARCHAR(64),
      metadata   TEXT,
      lifted_at  VARCHAR(64),
      lifted_by  VARCHAR(64),
      updated_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE SET NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL,
      FOREIGN KEY (lifted_by) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS appeals (
      id          VARCHAR(64) PRIMARY KEY,
      case_id     VARCHAR(64),
      server_id   VARCHAR(64),
      user_id     VARCHAR(64) NOT NULL,
      action_id   VARCHAR(64) NOT NULL,
      reason      TEXT NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      decision    VARCHAR(16),
      decision_note TEXT,
      reviewer_id VARCHAR(64),
      reviewed_at VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE SET NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (action_id) REFERENCES moderation_actions(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  // The case timeline. One row per transition, assignment, note or linked
  // action, so the interface can show the sequence rather than a status.
  `CREATE TABLE IF NOT EXISTS case_events (
      id         VARCHAR(64) PRIMARY KEY,
      case_id    VARCHAR(64) NOT NULL,
      actor_id   VARCHAR(64),
      kind       VARCHAR(32) NOT NULL,
      note       TEXT,
      metadata   TEXT,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS case_notes (
      id         VARCHAR(64) PRIMARY KEY,
      case_id    VARCHAR(64) NOT NULL,
      author_id  VARCHAR(64) NOT NULL,
      body       TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // Evidence is a snapshot, not a pointer that can be edited or deleted to
  // change the case. `content` is the preserved text/metadata; the reference
  // lets an authorised reader open the original if it still exists.
  `CREATE TABLE IF NOT EXISTS case_evidence (
      id         VARCHAR(64) PRIMARY KEY,
      case_id    VARCHAR(64) NOT NULL,
      kind       VARCHAR(32) NOT NULL,
      reference_id VARCHAR(64),
      content    TEXT,
      metadata   TEXT,
      created_by VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  // Feature-level restrictions are separate from account enforcement: a
  // member can keep their account and still be unable to create communities,
  // send messages, speak in voice or open new DMs.
  `CREATE TABLE IF NOT EXISTS user_restrictions (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      kind       VARCHAR(32) NOT NULL,
      reason     TEXT NOT NULL,
      actor_id   VARCHAR(64) NOT NULL,
      case_id    VARCHAR(64),
      expires_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      lifted_at  VARCHAR(64),
      lifted_by  VARCHAR(64),
      lift_reason TEXT,
      expired_at VARCHAR(64),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (case_id) REFERENCES moderation_cases(id) ON DELETE SET NULL,
      FOREIGN KEY (lifted_by) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  // Platform-only notes about an account. Unlike a case note these stay with
  // the person, so repeat-offender context is visible before the next report
  // becomes a case.
  `CREATE TABLE IF NOT EXISTS admin_user_notes (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      author_id  VARCHAR(64) NOT NULL,
      body       TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // Append-only audit trail. The hash chain makes a removed or edited row
  // detectable: each entry commits to the one before it and to its own
  // content. The verification endpoint walks the chain.
  `CREATE TABLE IF NOT EXISTS audit_logs (
      id         VARCHAR(64) PRIMARY KEY,
      actor_id   VARCHAR(64) NOT NULL,
      action     VARCHAR(64) NOT NULL,
      target_type VARCHAR(32),
      target_id  VARCHAR(64),
      reason     TEXT,
      report_id  VARCHAR(64),
      case_id    VARCHAR(64),
      server_id  VARCHAR(64),
      metadata   TEXT,
      previous_hash VARCHAR(64),
      entry_hash VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // A moderator's note about a member. Kept for the existing community note
  // surface; case notes are the investigation-level record.
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

  // A report about activity on another instance. The row records what was
  // sent and deliberately holds a reference, not a copy of the content.
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
      actionable             INTEGER NOT NULL DEFAULT 0,
      disclosure             TEXT,
      envelope_id            VARCHAR(64),
      delivery_error         TEXT,
      created_at             VARCHAR(64) NOT NULL,
      received_at            VARCHAR(64),
      FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,
];
