// The capability catalogue.
//
// An extension or a workflow never holds a permission of its own. It asks for
// capabilities by name, the operator grants a subset of them, and every call
// either side makes is checked against what was actually granted.
//
// The list is closed on purpose. A capability that is not in this catalogue
// cannot be requested, granted or checked, so there is no way for a package to
// name a permission the instance does not understand and have it quietly
// treated as satisfied.
//
// The catalogue is the vocabulary of the permission model, not the permission
// model itself: which actions a capability unlocks is decided by the action
// catalogue in ../workflows/actions, and the check that a grant is present is
// made here.

const CAPABILITIES = [
  {
    id: 'messages.read',
    label: 'Read messages',
    risk: 'read',
    description: 'Read message history in channels the workflow can reach.',
  },
  {
    id: 'messages.write',
    label: 'Send messages',
    risk: 'write',
    description: 'Post messages and add reactions as the workflow owner.',
  },
  {
    id: 'members.read',
    label: 'Read membership',
    risk: 'read',
    description: 'Read how many members a community has.',
  },
  {
    id: 'members.write',
    label: 'Manage membership',
    risk: 'write',
    description: 'Assign and remove roles in a community.',
  },
  {
    id: 'webhooks.manage',
    label: 'Notify webhooks',
    risk: 'write',
    description: 'Deliver an event to the outgoing webhooks of a community.',
  },
  {
    id: 'admin.read',
    label: 'Read instance statistics',
    risk: 'read',
    description: 'Read counts of accounts, communities and messages.',
  },
  {
    id: 'workflows.run',
    label: 'Run other workflows',
    risk: 'write',
    description: 'Start another workflow as a child run.',
  },
  {
    id: 'storage.write',
    label: 'Write extension storage',
    risk: 'write',
    description: "Store values in the extension's own namespaced storage.",
  },
  {
    id: 'federation.read',
    label: 'Read federation status',
    risk: 'read',
    description: 'Read whether federation is enabled and how many peers are known.',
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

// The capabilities that need no grant. A workflow that only logs is not
// asking for anything, and making the operator grant a capability for it
// would only teach them to grant everything.
const ALWAYS_ALLOWED = new Set(['log']);

function isKnown(capability) {
  return ALWAYS_ALLOWED.has(capability) || BY_ID.has(capability);
}

function label(capability) {
  const entry = BY_ID.get(capability);
  return entry ? entry.label : capability;
}

// The catalogue as the API reports it.
function catalogue() {
  return CAPABILITIES.map((c) => ({
    id: c.id,
    label: c.label,
    risk: c.risk,
    description: c.description,
  }));
}

// Reduce a requested list to the capabilities this instance knows. Unknown
// names are reported rather than dropped, so an operator is never told a
// package asked for less than it did.
function partition(requested) {
  const known = [];
  const unknown = [];
  for (const raw of Array.isArray(requested) ? requested : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    if (isKnown(id)) known.push(id);
    else unknown.push(id);
  }
  return { known: [...new Set(known)], unknown: [...new Set(unknown)] };
}

/**
 * The error a refused capability produces.
 *
 * `code` is the repository's own vocabulary, so the route layer can answer
 * with the standard envelope without inventing a new one.
 */
function denied(capability, holder) {
  const e = new Error(
    (holder ? holder + ' ' : '') + 'has not been granted the capability "' + capability + '"'
  );
  e.code = 'PERMISSION_DENIED';
  e.capability = capability;
  return e;
}

/**
 * Whether a grant set covers a capability.
 *
 * The grant set is a Set of capability ids. Nothing else is consulted: an
 * extension that was never granted a capability does not get it, and a
 * capability that was revoked is not in the set, so the same check covers
 * both the install-time decision and the call-time decision.
 */
function granted(grantSet, capability) {
  if (ALWAYS_ALLOWED.has(capability)) return true;
  return !!grantSet && grantSet.has(capability);
}

/**
 * Refuse a capability the holder was not granted.
 *
 * Every call an extension or a workflow makes goes through this. That is the
 * whole enforcement mechanism, and it is checked on the call rather than on
 * the install, so revoking a grant takes effect on the next call.
 */
function assertGranted(grantSet, capability, holder) {
  if (!granted(grantSet, capability)) throw denied(capability, holder);
  return true;
}

module.exports = {
  CAPABILITIES,
  ALWAYS_ALLOWED,
  catalogue,
  isKnown,
  label,
  partition,
  granted,
  assertGranted,
  denied,
};
