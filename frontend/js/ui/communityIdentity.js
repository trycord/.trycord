// The identity of a community.
//
// A reader is in a community, not in a channel: the channel is where the
// conversation is, and the community is the place it happens. So the
// community says who it is - its mark, its name, and what it is for - and
// the saying lives here, so every surface says it the same way.
//
// The description is the community's own words, so it is shown when it has
// them and left out when it does not. A header that always has a line under
// the name is a header with an empty line in it half the time.

import { el } from '../../packages/dom.js';
import { serverMark } from './primitives.js';

/**
 * The identity of a community.
 *
 * @param {object} server    the community
 * @param {object} [options] { href, compact }
 * @returns {HTMLElement}
 */
export function communityIdentity(server, options) {
  const opts = options || {};
  const community = server || {};
  const name = community.name || 'This community';

  const mark = serverMark(community, { size: opts.compact ? 'sm' : 'md' });

  const words = el('span', { class: 'community-identity__words' },
    el('span', { class: 'community-identity__name' }, name),
    community.description
      ? el('span', { class: 'community-identity__about' }, community.description)
      : null);

  const body = el('span', { class: 'community-identity' },
    el('span', { class: 'community-identity__mark' }, mark),
    words);

  if (opts.href) {
    return el('a', {
      class: 'community-identity community-identity--link',
      href: opts.href,
      'aria-label': name,
    }, body);
  }
  return body;
}

export default { communityIdentity };
