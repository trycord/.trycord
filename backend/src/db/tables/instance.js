// This deployment, rather than any one community's data.
//
// The public pages an editor can change, the announcements the operator posts,
// and the devices this instance may reach a reader on. Kept apart because
// these are the tables an instance operator reasons about, and none of them
// are reachable from a community id.

module.exports = (engine) => [

  // The devices a reader has asked this instance to reach them on.
  //
  // A device belongs to one account on one instance. The token is the handle
  // the push transport uses; it is the device's own secret and is not
  // readable by anybody else, so the row is keyed by it rather than by an id
  // the client has to remember separately.
  //
  // The instance origin is stored with it because a reader may be signed in to
  // more than one instance from one device, and a token issued by one of them
  // must never be offered to another.
  `CREATE TABLE IF NOT EXISTS push_devices (
      id          VARCHAR(64) PRIMARY KEY,
      user_id     VARCHAR(64) NOT NULL,
      token       VARCHAR(255) NOT NULL,
      platform    VARCHAR(16) NOT NULL,
      instance_origin VARCHAR(255),
      created_at  VARCHAR(64) NOT NULL,
      last_seen_at VARCHAR(64),
      UNIQUE (user_id, token),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS pages (
      id          VARCHAR(64) PRIMARY KEY,
      route       VARCHAR(64) NOT NULL UNIQUE,
      title       VARCHAR(128) NOT NULL,
      description VARCHAR(255),
      status      VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
      draft_body  TEXT,
      draft_author VARCHAR(64),
      draft_at    VARCHAR(64),
      published_body TEXT,
      published_author VARCHAR(64),
      published_at VARCHAR(64),
      legal       INTEGER NOT NULL DEFAULT 0,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (draft_author) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (published_author) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS page_revisions (
      id          VARCHAR(64) PRIMARY KEY,
      page_id     VARCHAR(64) NOT NULL,
      revision    INTEGER NOT NULL,
      body        TEXT NOT NULL,
      title       VARCHAR(128) NOT NULL,
      state       VARCHAR(16) NOT NULL,
      author_id   VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      UNIQUE (page_id, revision),
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS announcements (
      id          VARCHAR(64) PRIMARY KEY,
      body        TEXT NOT NULL,
      level       VARCHAR(16) NOT NULL DEFAULT 'info',
      link_label  VARCHAR(64),
      link_href   VARCHAR(512),
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  VARCHAR(64) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64),
      expires_at  VARCHAR(64),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // Durable background jobs. A job is claimed by exactly one worker, runs to
  // completion or failure, and is retried with backoff until it succeeds or
  // exhausts its attempts - so a restart or a crashed worker never silently
  // loses durable work, and two workers never process the same job.
  `CREATE TABLE IF NOT EXISTS jobs (
      id          VARCHAR(64) PRIMARY KEY,
      kind        VARCHAR(64) NOT NULL,
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

  // A localisation pack: a set of translations for one locale.
  //
  // A pack is untrusted content. It says what the interface says; it cannot
  // say what a control does. Every string it carries was checked against the
  // source catalogue before it was stored, and the check is repeated on
  // install so a pack that was edited on disk is refused the same way.
  //
  // The locale and version are recorded, so an instance can say which
  // version of a pack it is running.
  //
  // A pack with a server_id belongs to a community and overrides the
  // instance's pack for that community. A pack without one is the instance's
  // own.
  `CREATE TABLE IF NOT EXISTS localisation_packs (
      id             VARCHAR(64) PRIMARY KEY,
      locale         VARCHAR(32) NOT NULL,
      version        VARCHAR(32) NOT NULL,
      format_version INTEGER NOT NULL DEFAULT 1,
      name           VARCHAR(128) NOT NULL,
      description    VARCHAR(255),
      strings        TEXT NOT NULL,
      author         VARCHAR(128),
      reviewer       VARCHAR(128),
      review_state   VARCHAR(16) NOT NULL DEFAULT 'pending',
      reviewer_id    VARCHAR(64),
      server_id      VARCHAR(64),
      source_hash    VARCHAR(128) NOT NULL,
      installed_by   VARCHAR(64),
      created_at     VARCHAR(64) NOT NULL,
      updated_at     VARCHAR(64),
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (installed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  // A theme package: tokens, a schema version and a compatibility
  // declaration. Values, never code.
  `CREATE TABLE IF NOT EXISTS theme_packages (
      id             VARCHAR(64) PRIMARY KEY,
      name           VARCHAR(128) NOT NULL,
      version        VARCHAR(32) NOT NULL,
      schema_version INTEGER NOT NULL,
      tokens         TEXT NOT NULL,
      compatibility  TEXT NOT NULL,
      scope          VARCHAR(16) NOT NULL DEFAULT 'instance',
      server_id      VARCHAR(64),
      state          VARCHAR(16) NOT NULL DEFAULT 'active',
      installed_by   VARCHAR(64),
      created_at     VARCHAR(64) NOT NULL,
      FOREIGN KEY (installed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  // Which theme is in force, and what was in force before it.
  //
  // A rollback reads this backwards: the activation before the current one is
  // the last theme known to have worked.
  `CREATE TABLE IF NOT EXISTS theme_activations (
      id           VARCHAR(64) PRIMARY KEY,
      scope        VARCHAR(16) NOT NULL,
      server_id    VARCHAR(64),
      theme_id     VARCHAR(64) NOT NULL,
      reason       VARCHAR(16) NOT NULL,
      activated_at VARCHAR(64) NOT NULL,
      activated_by VARCHAR(64),
      FOREIGN KEY (theme_id) REFERENCES theme_packages(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  // The operational incident timeline.
  //
  // Every row is something an operator wrote. The status page shows these
  // rows and nothing else: an instance with no incidents says it has none
  // rather than inventing an all-clear.
  `CREATE TABLE IF NOT EXISTS incidents (
      id            VARCHAR(64) PRIMARY KEY,
      kind          VARCHAR(16) NOT NULL DEFAULT 'incident',
      status        VARCHAR(16) NOT NULL DEFAULT 'investigating',
      title         VARCHAR(128) NOT NULL,
      summary       TEXT NOT NULL,
      body          TEXT,
      started_at    VARCHAR(64) NOT NULL,
      scheduled_for VARCHAR(64),
      resolved_at   VARCHAR(64),
      created_by    VARCHAR(64) NOT NULL,
      created_at    VARCHAR(64) NOT NULL,
      updated_at    VARCHAR(64),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // Which media provider carries each live voice session.
  //
  // A call does not change provider halfway through: the session it started
  // on is the session it finishes on. This row is what says so, and it is what
  // lets a room that is already running keep its provider while the instance
  // is configured to use another one.
  //
  // The row is per participant rather than per channel, because the two are
  // not the same length of time: the last person to leave ends the call, and
  // the next join starts a new one on whichever provider is then in force.
  `CREATE TABLE IF NOT EXISTS voice_provider_sessions (
      id          VARCHAR(64) PRIMARY KEY,
      channel_id  VARCHAR(64) NOT NULL,
      user_id     VARCHAR(64) NOT NULL,
      provider    VARCHAR(32) NOT NULL,
      joined_at   VARCHAR(64) NOT NULL,
      left_at     VARCHAR(64),
      UNIQUE (channel_id, user_id)
    )${engine}`,
];
