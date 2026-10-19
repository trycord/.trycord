// The collaboration workspace: spaces, collaborative documents, boards, events
// and polls.
//
// Every table here is scoped to a community (server_id) and reuses the
// community's own identity, membership and permission model. Nothing in this
// file grants access to anything: a row is only ever readable by a member of
// the community it belongs to, and the checks that decide that live in
// services/permissions.js and services/workspace/access.js.
//
// The collaborative documents follow the shape of the instance page editor
// (pages.js + pageContent.js): a body is an array of typed blocks, never raw
// HTML, and the revision history is append-only - a save appends a revision and
// a restore appends another one rather than rewriting what came before. The
// revision table below is the community-scoped counterpart of page_revisions:
// the instance pages table is keyed by a unique route and carries no community
// or space, so a community document cannot be a row in it.

module.exports = (engine) => [

  // ---- spaces ----------------------------------------------------------
  //
  // A space is a navigation and configuration object: a named group of
  // channels, documents, a board and resource links. It is not a second
  // container for the community's data - it holds references, and the things it
  // references keep their own access rules.
  `CREATE TABLE IF NOT EXISTS spaces (
      id              VARCHAR(64) PRIMARY KEY,
      server_id       VARCHAR(64) NOT NULL,
      name            VARCHAR(64) NOT NULL,
      description     TEXT,
      -- A public space is visible to every member of the community. A private
      -- one is visible only to the members holding the role named by
      -- required_role_id (and to the owner). A private space with no role is
      -- visible to the owner alone.
      is_private      INTEGER NOT NULL DEFAULT 0,
      required_role_id VARCHAR(64),
      position        INTEGER NOT NULL DEFAULT 0,
      created_by      VARCHAR(64) NOT NULL,
      created_at      VARCHAR(64) NOT NULL,
      updated_at      VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (required_role_id) REFERENCES roles(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  // The references a space holds. kind says what the reference points at:
  // channel, document, board or resource. A voice room is a channel of type
  // 'voice', so it is a 'channel' here rather than a kind of its own.
  `CREATE TABLE IF NOT EXISTS space_items (
      id         VARCHAR(64) PRIMARY KEY,
      space_id   VARCHAR(64) NOT NULL,
      kind       VARCHAR(16) NOT NULL,
      -- The id of the thing referenced. NULL for a resource, which is a link
      -- rather than a row in this community.
      target_id  VARCHAR(64),
      title      VARCHAR(255),
      url        VARCHAR(512),
      position   INTEGER NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  // ---- collaborative documents -----------------------------------------
  //
  // body holds the same structured blocks the page editor stores: a JSON array
  // of typed blocks (heading, paragraph, list, note, link, rule). The
  // renderer in pageContent.js is the only thing that turns them into
  // markup, so a document can never carry raw HTML.
  `CREATE TABLE IF NOT EXISTS documents (
      id         VARCHAR(64) PRIMARY KEY,
      server_id  VARCHAR(64) NOT NULL,
      space_id   VARCHAR(64),
      title      VARCHAR(128) NOT NULL,
      body       TEXT NOT NULL,
      -- The revision the current body belongs to. A save carries the revision
      -- the editor loaded; a mismatch is a conflict, not an overwrite.
      revision   INTEGER NOT NULL DEFAULT 1,
      author_id  VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE SET NULL,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )${engine}`,

  // Append-only. A save appends a revision, a restore appends a revision that
  // carries the restored body. Nothing is ever updated or deleted here, so the
  // history of what was written, by whom and in what order survives.
  `CREATE TABLE IF NOT EXISTS document_revisions (
      id          VARCHAR(64) PRIMARY KEY,
      document_id VARCHAR(64) NOT NULL,
      revision    INTEGER NOT NULL,
      title       VARCHAR(128) NOT NULL,
      body        TEXT NOT NULL,
      author_id   VARCHAR(64),
      created_at  VARCHAR(64) NOT NULL,
      UNIQUE (document_id, revision),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  // A comment anchored to a block of the document. block_id is the id the
  // editor gives a block; it is optional, because a comment about the
  // document as a whole is a normal thing to want.
  `CREATE TABLE IF NOT EXISTS document_comments (
      id          VARCHAR(64) PRIMARY KEY,
      document_id VARCHAR(64) NOT NULL,
      server_id   VARCHAR(64) NOT NULL,
      author_id   VARCHAR(64) NOT NULL,
      block_id    VARCHAR(64),
      body        TEXT NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64),
      resolved_by VARCHAR(64),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    )${engine}`,

  // Links out of a document: another document in this community, or a URL the
  // member opens themselves. A URL is stored and handed back; it is never
  // fetched, embedded or proxied by the server.
  `CREATE TABLE IF NOT EXISTS document_links (
      id          VARCHAR(64) PRIMARY KEY,
      document_id VARCHAR(64) NOT NULL,
      server_id   VARCHAR(64) NOT NULL,
      kind        VARCHAR(16) NOT NULL,
      target_id   VARCHAR(64),
      url         VARCHAR(512),
      label       VARCHAR(255),
      created_by  VARCHAR(64) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  // The in-house search index for documents, the same shape as
  // message_search_words: one row per distinct word, lowercased, with the
  // community copied alongside so the query can scope to it and the permission
  // check cannot be left out of a later rewrite.
  `CREATE TABLE IF NOT EXISTS document_search_words (
      document_id VARCHAR(64) NOT NULL,
      word       VARCHAR(64) NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (document_id, word)
    )${engine}`,

  // ---- boards ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS boards (
      id          VARCHAR(64) PRIMARY KEY,
      server_id   VARCHAR(64) NOT NULL,
      space_id    VARCHAR(64),
      name        VARCHAR(64) NOT NULL,
      description TEXT,
      created_by  VARCHAR(64) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      updated_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  // A status lane on a board. Cards live in a column.
  `CREATE TABLE IF NOT EXISTS board_columns (
      id         VARCHAR(64) PRIMARY KEY,
      board_id   VARCHAR(64) NOT NULL,
      name       VARCHAR(64) NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    )${engine}`,

  // A card: the unit of work on a board.
  //
  // due_at is a UTC instant and due_timezone is the timezone the author wrote
  // the date in, so the same moment is shown to everyone in their own local
  // time rather than being re-interpreted.
  //
  // version is the optimistic concurrency guard: an update states the version
  // it was written against, and the write only lands when that is still the
  // current version. Two people editing the same card therefore produce one
  // edit and one conflict, never one edit that silently loses the other.
  `CREATE TABLE IF NOT EXISTS cards (
      id                VARCHAR(64) PRIMARY KEY,
      board_id          VARCHAR(64) NOT NULL,
      server_id         VARCHAR(64) NOT NULL,
      column_id         VARCHAR(64) NOT NULL,
      title             VARCHAR(255) NOT NULL,
      body              TEXT,
      assignee_id       VARCHAR(64),
      due_at            VARCHAR(64),
      due_timezone      VARCHAR(64),
      priority          VARCHAR(16) NOT NULL DEFAULT 'normal',
      status            VARCHAR(16) NOT NULL DEFAULT 'open',
      position          INTEGER NOT NULL DEFAULT 0,
      version           INTEGER NOT NULL DEFAULT 1,
      -- Set when the card was made from a message. The link back to it is
      -- what makes the conversion reversible in the reader's mind: the task
      -- says where it came from.
      source_message_id VARCHAR(64),
      source_channel_id VARCHAR(64),
      created_by        VARCHAR(64) NOT NULL,
      created_at        VARCHAR(64) NOT NULL,
      updated_at        VARCHAR(64) NOT NULL,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
      FOREIGN KEY (column_id) REFERENCES board_columns(id) ON DELETE CASCADE,
      FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS card_labels (
      card_id VARCHAR(64) NOT NULL,
      label   VARCHAR(64) NOT NULL,
      PRIMARY KEY (card_id, label),
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    )${engine}`,

  // What a card points at: a channel, a document, a discussion, an event or
  // the message it was made from. A discussion is a thread - a message with
  // replies - so its target is the id of the thread's root message, read
  // through the existing thread model. There is no second discussion table.
  `CREATE TABLE IF NOT EXISTS card_links (
      id         VARCHAR(64) PRIMARY KEY,
      card_id    VARCHAR(64) NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      kind       VARCHAR(16) NOT NULL,
      target_id  VARCHAR(64),
      created_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  // Every change to a card, in order: who, what changed, from what, to what,
  // and when. Append-only, like a message log.
  `CREATE TABLE IF NOT EXISTS card_activity (
      id         VARCHAR(64) PRIMARY KEY,
      card_id    VARCHAR(64) NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      actor_id   VARCHAR(64) NOT NULL,
      field      VARCHAR(64),
      from_value TEXT,
      to_value   TEXT,
      created_at VARCHAR(64) NOT NULL,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id)
    )${engine}`,

  // A named grouping of cards with a date of its own.
  `CREATE TABLE IF NOT EXISTS milestones (
      id          VARCHAR(64) PRIMARY KEY,
      board_id    VARCHAR(64) NOT NULL,
      server_id   VARCHAR(64) NOT NULL,
      name        VARCHAR(128) NOT NULL,
      description TEXT,
      due_at      VARCHAR(64),
      due_timezone VARCHAR(64),
      created_by  VARCHAR(64) NOT NULL,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS card_milestones (
      card_id      VARCHAR(64) NOT NULL,
      milestone_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (card_id, milestone_id),
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
      FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE CASCADE
    )${engine}`,

  // ---- events ----------------------------------------------------------
  //
  // starts_at and ends_at are UTC instants; timezone is the IANA name the
  // author wrote them in, kept so the event can be rendered the way it was
  // meant. location_url is a link the member opens themselves - the server
  // never fetches or proxies it. voice_channel_id is a reservation of a voice
  // room in this community.
  `CREATE TABLE IF NOT EXISTS events (
      id                    VARCHAR(64) PRIMARY KEY,
      server_id             VARCHAR(64) NOT NULL,
      space_id              VARCHAR(64),
      title                 VARCHAR(255) NOT NULL,
      description           TEXT,
      starts_at             VARCHAR(64) NOT NULL,
      ends_at               VARCHAR(64) NOT NULL,
      timezone              VARCHAR(64) NOT NULL,
      location_url          VARCHAR(512),
      voice_channel_id      VARCHAR(64),
      capacity              INTEGER,
      -- 'members' lets every member of the community see who is attending.
      -- 'organisers' limits the attendance list to the event's creator and
      -- the people who manage the community's structure.
      attendance_visibility VARCHAR(16) NOT NULL DEFAULT 'members',
      reminder_at           VARCHAR(64),
      reminder_job_id       VARCHAR(64),
      created_by            VARCHAR(64) NOT NULL,
      created_at            VARCHAR(64) NOT NULL,
      updated_at            VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE SET NULL,
      FOREIGN KEY (voice_channel_id) REFERENCES channels(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS event_rsvps (
      id         VARCHAR(64) PRIMARY KEY,
      event_id   VARCHAR(64) NOT NULL,
      server_id  VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      status     VARCHAR(16) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE (event_id, user_id),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // ---- polls -----------------------------------------------------------
  //
  // A poll is attached to a channel, to a message, or to neither.
  //
  // scoring is 'plurality' (one choice per voter, or several when
  // allows_multiple is set) or 'ranked' (an ordered ballot, scored by
  // position - a Borda count).
  //
  // eligibility is 'members' (every member may vote) or 'role' (only the
  // members holding required_role_id may).
  `CREATE TABLE IF NOT EXISTS polls (
      id              VARCHAR(64) PRIMARY KEY,
      server_id       VARCHAR(64) NOT NULL,
      channel_id      VARCHAR(64),
      message_id      VARCHAR(64),
      question        VARCHAR(500) NOT NULL,
      scoring         VARCHAR(16) NOT NULL DEFAULT 'plurality',
      allows_multiple INTEGER NOT NULL DEFAULT 0,
      max_choices     INTEGER NOT NULL DEFAULT 1,
      is_anonymous    INTEGER NOT NULL DEFAULT 0,
      eligibility     VARCHAR(16) NOT NULL DEFAULT 'members',
      required_role_id VARCHAR(64),
      -- The number of votes the result needs before it stands. NULL means no
      -- quorum.
      quorum          INTEGER,
      opens_at        VARCHAR(64),
      closes_at       VARCHAR(64),
      status          VARCHAR(16) NOT NULL DEFAULT 'open',
      created_by      VARCHAR(64) NOT NULL,
      created_at      VARCHAR(64) NOT NULL,
      closed_at       VARCHAR(64),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (required_role_id) REFERENCES roles(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS poll_options (
      id       VARCHAR(64) PRIMARY KEY,
      poll_id  VARCHAR(64) NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      label    VARCHAR(255) NOT NULL,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    )${engine}`,

  // The choices a voter has made. One row per chosen option, so a
  // multiple-choice vote is several rows for one voter. Replacing a vote
  // deletes the voter's rows for the poll and writes the new ones, which is
  // what makes a repeated request idempotent instead of additive.
  `CREATE TABLE IF NOT EXISTS poll_votes (
      id         VARCHAR(64) PRIMARY KEY,
      poll_id    VARCHAR(64) NOT NULL,
      option_id  VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      UNIQUE (poll_id, user_id, option_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // A ranked ballot: the same option ranked twice is refused by the unique
  // key, and rank 1 is the voter's first preference.
  `CREATE TABLE IF NOT EXISTS poll_ballots (
      id         VARCHAR(64) PRIMARY KEY,
      poll_id    VARCHAR(64) NOT NULL,
      option_id  VARCHAR(64) NOT NULL,
      user_id    VARCHAR(64) NOT NULL,
      \`rank\`      INTEGER NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      UNIQUE (poll_id, user_id, option_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // The result as it stood when the poll closed. Append-only: a later recount
  // computes a fresh tally and leaves this history alone.
  `CREATE TABLE IF NOT EXISTS poll_results (
      id          VARCHAR(64) PRIMARY KEY,
      poll_id     VARCHAR(64) NOT NULL,
      server_id   VARCHAR(64) NOT NULL,
      scoring     VARCHAR(16) NOT NULL,
      payload     TEXT NOT NULL,
      recorded_at VARCHAR(64) NOT NULL,
      recorded_by VARCHAR(64) NOT NULL,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    )${engine}`,
];
