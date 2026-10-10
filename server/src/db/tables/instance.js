// This deployment, rather than any one community's data.
//
// The public pages an editor can change, and the announcements the operator posts. Kept
// apart because these are the tables an instance operator reasons about, and none of
// them are reachable from a community id.

module.exports = (engine) => [

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
];
