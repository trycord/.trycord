// The voice schema.
//
// Rooms and participants are durable rows; the provider's session id lives on a
// participant rather than owning one, because a room outlives any single connection.
//
// This did not exist before voice was added, so there is nothing to migrate from: the
// tables are created empty, and an existing instance gains them with no data movement.

const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS voice_rooms (
     id         VARCHAR(64) PRIMARY KEY,
     channel_id VARCHAR(64) NOT NULL,
     server_id  VARCHAR(64) NOT NULL,
     created_at VARCHAR(64) NOT NULL,
     UNIQUE (channel_id)
   )`,
  `CREATE TABLE IF NOT EXISTS voice_participants (
     id         VARCHAR(64) PRIMARY KEY,
     room_id    VARCHAR(64) NOT NULL,
     channel_id VARCHAR(64) NOT NULL,
     user_id    VARCHAR(64) NOT NULL,
     session_id VARCHAR(128),
     joined_at  VARCHAR(64) NOT NULL,
     left_at    VARCHAR(64),
     muted      INTEGER NOT NULL DEFAULT 0,
     deafened   INTEGER NOT NULL DEFAULT 0,
     UNIQUE (channel_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS voice_speak_requests (
     id         VARCHAR(64) PRIMARY KEY,
     channel_id VARCHAR(64) NOT NULL,
     user_id    VARCHAR(64) NOT NULL,
     created_at VARCHAR(64) NOT NULL
   )`,
];

const INDEX_DDL = [
  'CREATE INDEX IF NOT EXISTS idx_voice_participants_room ON voice_participants(room_id)',
  'CREATE INDEX IF NOT EXISTS idx_voice_participants_live ON voice_participants(channel_id, left_at)',
  'CREATE INDEX IF NOT EXISTS idx_voice_rooms_server ON voice_rooms(server_id)',
];

module.exports = { TABLE_DDL, INDEX_DDL };
