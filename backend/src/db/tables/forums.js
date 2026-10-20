// The tables this deployment adds on top of the shared data model: the
// instance configuration a system administrator saves, the voice rooms and
// participants that exist while a call is running, and the forum
// subscriptions a reader keeps on the topics they follow.
//
// The forum subscription is a reader's own record of a topic they follow. It
// points at a message rather than at a topic table, because a topic *is* a
// message - the forum adds a way of presenting the messages, not a second
// kind of message.
module.exports = (engine) => [

  `CREATE TABLE IF NOT EXISTS forum_subscriptions (
      id         VARCHAR(64) PRIMARY KEY,
      user_id    VARCHAR(64) NOT NULL,
      channel_id VARCHAR(64) NOT NULL,
      message_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      UNIQUE (user_id, message_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,
];
