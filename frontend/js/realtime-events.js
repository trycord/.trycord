// The realtime event vocabulary, as the client spells it.
//
// This mirrors backend/src/ws/events.js. The two must agree: a name spelled
// differently on each side is an event that is sent and never received, or
// received and never sent, and neither side reports it. check-events.js fails
// the build when they drift, so the duplication is checked rather than trusted.
//
// The client only ever *reads* these, matching what the gateway emits. Nothing
// here is sent.

export const EVENTS = {
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

// The events the gateway pushes that are not in EVENTS: local notifications
// the server sends about the session itself rather than about a message or a
// presence change. Listed separately because they answer to different
// handlers, not because they are less real.
export const SESSION_EVENTS = {
  PROFILE: 'profile',
  PRIVACY: 'privacy',
  WELLBEING: 'wellbeing',
  NOTIFICATION_PREFS: 'notification-prefs',
  BLOCKS: 'blocks',
  FRIEND: 'friend',
  TWOFACTOR: 'twofactor',
  SESSION_REVOKED: 'session-revoked',
};

export default { EVENTS, SESSION_EVENTS };
