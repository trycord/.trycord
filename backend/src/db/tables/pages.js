// The reusable blocks a page is written from.
//
// A page body is content an administrator writes, and so is a reusable block:
// the difference is that a block can be inserted into more than one page, and
// a shared one belongs to the instance rather than to its author.
//
// Kept apart from ./instance because this table is not a setting of the
// deployment. It has an author, a scope and a lifecycle, and it is read by
// the page editor rather than by the server that serves the pages.

module.exports = (engine) => [

  // scope is PERSONAL or SHARED. A shared block is visible to every
  // administrator of the instance; a personal block is visible only to the
  // administrator who wrote it. The scope is fixed when the block is created,
  // so what is in the instance-wide library only ever changes through a
  // create or a delete, both of which are audited.
  `CREATE TABLE IF NOT EXISTS page_blocks (
      id          VARCHAR(64) PRIMARY KEY,
      name        VARCHAR(128) NOT NULL,
      body        TEXT NOT NULL,
      author_id   VARCHAR(64) NOT NULL,
      scope       VARCHAR(16) NOT NULL DEFAULT 'PERSONAL',
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,
];
