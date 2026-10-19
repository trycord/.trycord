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
];
