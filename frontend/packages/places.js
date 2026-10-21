// The places a person is.
//
// Two kinds of them, and they are kept apart:
//
//   - the communities of this instance, which live here;
//   - the communities that live on another instance, which this instance
//     knows about and may follow.
//
// They are listed in sections of their own because they are different
// things. A community of this instance is here: it has a member list, it has
// roles, its owner may change its settings. A community on another instance
// is a reference: it grants no role and no permission here, and the instance
// it lives on stays the only authority over it.
//
// The desk and the phone draw their own controls, but they agree on the
// rules below, so a community is the same community in both.

/** The address of a federated community. */
export function federatedRoute(community) {
  if (!community) return '';
  return '/federated/' + encodeURIComponent(community.originInstanceId || '')
    + '/' + encodeURIComponent(community.originCommunityId || '');
}

/** The name of a federated community. */
export function federatedName(community) {
  if (!community) return 'A community on another instance';
  return community.name || 'A community on another instance';
}

/**
 * Where a federated community lives.
 *
 * "General" on another instance is not the same "General", so the reader is
 * always told which instance it is on.
 */
export function federatedOrigin(community) {
  const name = community && community.originName;
  if (name) return 'on ' + name;
  return 'on another instance';
}

/** Whether this reader follows a federated community. */
export function federatedIsJoined(community) {
  return !!(community && community.relationship === 'joined');
}

/**
 * The communities of another instance this reader follows, and the ones this
 * instance has merely heard of.
 */
export function partitionFederated(list) {
  const joined = [];
  const discovered = [];
  for (const community of list || []) {
    if (federatedIsJoined(community)) joined.push(community);
    else discovered.push(community);
  }
  return { joined, discovered };
}
