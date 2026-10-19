// The event vocabulary the workflow engine listens to.
//
// The names here are the ones the rest of the application already uses. The
// realtime gateway publishes 'message', 'message_updated' and 'dm:message';
// the outgoing webhook service publishes 'message.created', 'member.joined'
// and the rest of the domain vocabulary. Both spellings name the same thing,
// so the alias table maps the realtime spelling onto the domain one and
// there is a single set of triggers to reason about.
//
// A workflow names one of these events. An event that is not in the list is
// refused when the workflow is saved rather than waking nothing forever.

const EVENTS = [
  'message.created',
  'message.updated',
  'message.deleted',
  'message.reacted',
  'dm.message.created',
  'member.joined',
  'member.left',
  'channel.created',
  'channel.deleted',
  'role.created',
  'role.updated',
  'role.deleted',
  'command.created',
  'notification.created',
  'presence.updated',
];

// The realtime spelling, as published by the gateway, mapped onto the domain
// name above.
const ALIASES = {
  message: 'message.created',
  message_updated: 'message.updated',
  message_deleted: 'message.deleted',
  message_reaction: 'message.reacted',
  'dm:message': 'dm.message.created',
  dm_message: 'dm.message.created',
  notification: 'notification.created',
  presence: 'presence.updated',
};

const BY_NAME = new Set(EVENTS);

/**
 * The canonical name of an event, or null when the name is not one this
 * instance publishes.
 */
function normalise(name) {
  const raw = String(name || '').trim();
  if (BY_NAME.has(raw)) return raw;
  const alias = ALIASES[raw];
  return alias || null;
}

function isKnown(name) {
  return normalise(name) !== null;
}

function catalogue() {
  return EVENTS.map((name) => ({ name, aliases: Object.keys(ALIASES).filter((a) => ALIASES[a] === name) }));
}

module.exports = { EVENTS, ALIASES, normalise, isKnown, catalogue };
