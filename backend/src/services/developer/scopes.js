// The scope catalogue.
//
// One module, read by the interface, by the API and by the checker that
// refuses a request. A scope that exists in one of them and not in the others
// is a scope nobody can rely on, so the list is written down once here and
// nowhere else.
//
// A scope is a verb over a resource area: `messages:read` is "read the
// messages of a community", `webhooks:manage` is "administer the webhooks of
// a community". The catalogue is the whole vocabulary: a scope that is not in
// this list is not a scope, and a key carrying one is refused at creation
// rather than at the first use.
//
// Scopes constrain machine credentials. A user session is the account itself
// and is not scope-checked: a person is not a stranger to their own data.

const SCOPES = [
  {
    name: 'profile:read',
    group: 'account',
    description: 'Read the calling credential: what it is, what it may do and what it is limited to.',
  },
  {
    name: 'keys:read',
    group: 'credentials',
    description: 'List the API keys of the owner and read one key, its usage and its health.',
  },
  {
    name: 'keys:write',
    group: 'credentials',
    description: 'Create, rotate and revoke API keys. A credential may only create a key whose scopes are a subset of its own.',
  },
  {
    name: 'communities:read',
    group: 'communities',
    description: 'Read a community the caller belongs to.',
  },
  {
    name: 'communities:write',
    group: 'communities',
    description: 'Change the developer configuration of a community: its applications, commands, webhooks and subscriptions.',
  },
  {
    name: 'members:read',
    group: 'communities',
    description: 'List the members of a community.',
  },
  {
    name: 'bots:read',
    group: 'applications',
    description: 'List the bot applications of a community, read one, and read its health.',
  },
  {
    name: 'bots:write',
    group: 'applications',
    description: 'Create a bot application, give it its scopes, rotate its token and revoke it.',
  },
  {
    name: 'commands:read',
    group: 'applications',
    description: 'List the slash commands an application answers.',
  },
  {
    name: 'commands:write',
    group: 'applications',
    description: 'Register, change and remove the slash commands an application answers.',
  },
  {
    name: 'messages:read',
    group: 'messages',
    description: 'Read the recent messages of a channel.',
  },
  {
    name: 'messages:write',
    group: 'messages',
    description: 'Post a message as a bot application.',
  },
  {
    name: 'webhooks:read',
    group: 'webhooks',
    description: 'List the webhooks of a community and read their deliveries and their health.',
  },
  {
    name: 'webhooks:manage',
    group: 'webhooks',
    description: 'Create, rotate the secret of and remove the webhooks of a community.',
  },
  {
    name: 'events:read',
    group: 'events',
    description: 'Read the event vocabulary and the envelope the platform delivers.',
  },
  {
    name: 'events:subscribe',
    group: 'events',
    description: 'Subscribe a webhook to the events of a community, and end that subscription.',
  },
  {
    name: 'admin:read',
    group: 'instance',
    description: 'Read the developer platform diagnostics of this instance.',
  },
];

const SCOPE_NAMES = new Set(SCOPES.map((s) => s.name));

// The catalogue as the API and the interface read it: a list of groups, each
// with the scopes it contains.
function catalogue() {
  const groups = [];
  for (const scope of SCOPES) {
    let group = groups.find((g) => g.name === scope.group);
    if (!group) {
      group = { name: scope.group, scopes: [] };
      groups.push(group);
    }
    group.scopes.push({ name: scope.name, description: scope.description });
  }
  return groups;
}

function isScope(name) {
  return SCOPE_NAMES.has(String(name || ''));
}

/**
 * Validate a list of scope names.
 *
 * Unknown scopes are refused rather than ignored: a caller that asks for a
 * scope this build does not have is asking for something it cannot get, and
 * quietly dropping it would hand back a key that does less than it was told.
 *
 * @param {unknown} input
 * @returns {string[]} the accepted scopes, sorted and without duplicates
 * @throws {Error} with code VALIDATION_ERROR
 */
function normaliseScopes(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    const e = new Error('scopes must be an array of scope names');
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  const out = new Set();
  for (const raw of input) {
    const name = String(raw || '').trim();
    if (!isScope(name)) {
      const e = new Error('unknown scope: ' + (name || '(empty)'));
      e.code = 'VALIDATION_ERROR';
      throw e;
    }
    out.add(name);
  }
  return [...out].sort();
}

/**
 * Whether a granted set covers a required set.
 *
 * @param {string[]} granted
 * @param {string[]} required
 * @returns {string[]} the required scopes that are missing, empty when covered
 */
function missingScopes(granted, required) {
  const have = new Set(granted || []);
  return (required || []).filter((scope) => !have.has(scope));
}

module.exports = { SCOPES, SCOPE_NAMES, catalogue, isScope, normaliseScopes, missingScopes };
