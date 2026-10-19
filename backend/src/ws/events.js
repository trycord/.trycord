// The realtime event vocabulary.
//
// Every event the gateway can emit has a name here, and nowhere else. The name is
// what travels over the socket and what a client matches on, so two spellings of
// one event are not a style difference: one of them is not delivered.
//
// This is the list that was scattered as string literals across eight files. A
// new event is a line here and a case in whichever handler answers it, rather
// than a literal typed at each call site where a typo fails silently - the sender
// and the receiver each believe they sent and heard the right thing.

const EVENTS = {
  MESSAGE: 'message',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_EMBEDS: 'message_embeds',
  MESSAGE_REACTION: 'message_reaction',
  MESSAGE_PINNED: 'message_pinned',
  MESSAGE_UNPINNED: 'message_unpinned',

  DM_MESSAGE: 'dm:message',
  DM_MESSAGE_UPDATED: 'dm:message_updated',
  DM_MESSAGE_DELETED: 'dm:message_deleted',
  DM_MESSAGE_EMBEDS: 'dm:message_embeds',
  DM_READ: 'dm:read',
  DM_TYPING: 'dm:typing',

  PRESENCE: 'presence',
  NOTIFICATION: 'notification',
};

// Account-scoped events: the server telling one client that its own state
// changed somewhere else. Separate from EVENTS because they answer to different
// handlers and carry no channel or conversation, but they are part of the same
// vocabulary and the same check.
const SESSION_EVENTS = {
  PROFILE: 'profile',
  PRIVACY: 'privacy',
  WELLBEING: 'wellbeing',
  NOTIFICATION_PREFS: 'notification-prefs',
  BLOCKS: 'blocks',
  FRIEND: 'friend',
  TWOFACTOR: 'twofactor',
  SESSION_REVOKED: 'session-revoked',
};

// End-to-end encryption events.
//
// A device came or went, a key was published, or the safety number a reader
// compares with their peer's changed. They are account-scoped rather than
// channel-scoped, so they live with the other account events.
const E2EE_EVENTS = {
  DEVICE: 'e2ee:device',
  KEY_CHANGE: 'e2ee:key-change',
  SAFETY_NUMBER: 'e2ee:safety-number',
};

// Federation events.
//
// Something arrived from an instance this account follows: a message that was
// relayed, or a reaction on one. The payload says which instance it came from
// and that it is relayed, so a client never shows a relayed message as if it
// were written here.
const CONTINUUM_EVENTS = {
  RELAY_MESSAGE: 'continuum:relay-message',
  RELAY_REACTION: 'continuum:relay-reaction',
};

// Every event name, for the checks that need to know the whole vocabulary.
const ALL = [
  ...Object.values(EVENTS),
  ...Object.values(SESSION_EVENTS),
  ...Object.values(E2EE_EVENTS),
  ...Object.values(CONTINUUM_EVENTS),
];

module.exports = { EVENTS, SESSION_EVENTS, E2EE_EVENTS, CONTINUUM_EVENTS, ALL };
