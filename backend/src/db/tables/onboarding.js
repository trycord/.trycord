// Community onboarding.
//
// A community that greets nobody is a community that loses people. The
// onboarding is what a community says to somebody who has just arrived: the
// rules, the channels worth looking at, and a few questions whose answers
// decide what the member is shown.
//
// Three tables:
//
//   community_onboarding        the configuration, one row per community
//   community_onboarding_questions  the questions, and what an answer may do
//   community_onboarding_answers   what each member answered
//
// The answers are the delicate part. An answer may **assign a role** and it
// may **reveal a channel**, and both of those are authority, so both are
// checked when the answer is recorded and not only when the question was
// written: a role that was ordinary when the question was set up may be the
// owner's role by the time somebody answers it.
//
// Nothing here can grant a privileged role. The service refuses an answer
// that would, and the refusal is about the role, not about the member who
// wrote the question.

module.exports = (engine) => [

  `CREATE TABLE IF NOT EXISTS community_onboarding (
      id              VARCHAR(64) PRIMARY KEY,
      server_id       VARCHAR(64) NOT NULL UNIQUE,
      -- Whether the onboarding is shown at all. A community with the tables
      -- but the switch off greets nobody, and that is a choice.
      enabled         INTEGER NOT NULL DEFAULT 0,
      welcome_title   TEXT,
      welcome_body    TEXT,
      -- The rules the member acknowledges, as a list of { id, text }. They
      -- are stored as written: a rule is a thing the community says, and
      -- rewriting one is the community's business.
      rules           TEXT,
      -- The channels a new member is pointed at, as a list of channel ids.
      default_channels TEXT,
      -- Whether the member has to answer the required questions before the
      -- community lets them in.
      required        INTEGER NOT NULL DEFAULT 0,
      created_at      VARCHAR(64) NOT NULL,
      updated_at      VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS community_onboarding_questions (
      id            VARCHAR(64) PRIMARY KEY,
      server_id     VARCHAR(64) NOT NULL,
      position      INTEGER NOT NULL DEFAULT 0,
      text          TEXT NOT NULL,
      -- 'single' or 'multiple': the one answer, or several.
      kind          VARCHAR(16) NOT NULL DEFAULT 'single',
      -- Whether the member has to answer it. An optional question is one
      -- they may skip, and skipping it costs nothing.
      required      INTEGER NOT NULL DEFAULT 0,
      -- The options, as a list of { id, label, roleIds, channelIds }. The
      -- role and channel lists are what the answer may do, and both are
      -- checked again when the answer is recorded.
      options       TEXT,
      created_at    VARCHAR(64) NOT NULL,
      updated_at    VARCHAR(64) NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )${engine}`,

  `CREATE TABLE IF NOT EXISTS community_onboarding_answers (
      id          VARCHAR(64) PRIMARY KEY,
      server_id   VARCHAR(64) NOT NULL,
      user_id     VARCHAR(64) NOT NULL,
      question_id VARCHAR(64) NOT NULL,
      -- The options the member chose, as a list of option ids.
      option_ids  TEXT NOT NULL,
      answered_at VARCHAR(64) NOT NULL,
      UNIQUE (user_id, question_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,
];
