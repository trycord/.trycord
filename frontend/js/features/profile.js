// A person's profile.
//
// One page for a reader, a friend, a stranger - or nobody. What can be acted on
// is decided by the relation the backend answers with, so the buttons never
// offer something the account policy removes. A profile is also where the
// community-aware facts (the member pages) link back to.

import { el, replaceChildren } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State, nameOf } from '../../packages/store.js';
import { navigate, path } from '../../packages/nav.js';
import { avatar, bannerNode, serverMark } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold, facts } from '../ui/page.js';
import { errorToast, confirmDialog, toast } from '../ui/overlays.js';
import { personSheet } from '../ui/person.js';
import { presenceLabel } from '../ui/members.js';
import { roleNames, roleChips as roleChipList } from '../../packages/roles.js';
import { displayNameOf, usernameOf } from '../../packages/identity.js';

const relationText = (p) => {
  switch (p.relation) {
    case 'self': return 'This is you.';
    case 'friend': return 'The two of you are friends.';
    case 'pending-in': return 'They asked to be friends with you.';
    case 'pending-out': return 'You asked to be friends, and the request is open.';
    default: return 'Not connected yet.';
  }
};

// A friend request is named by its own id, never by the person on the other
// side. The old button passed the profile id to a route that reads a request
// id; the two are different rows, so withdrawing somebody else's request was
// refused and the button looked broken.
function requestIdFor(profile, page) {
  const entries = [].concat(
    (page && page.outgoing) || [],
    (State.friendRequests && State.friendRequests.outgoing) || []
  );
  const match = entries.find((entry) => {
    const target = entry.user || entry.to || entry.receiver || {};
    return String(target.id || entry.userId || entry.user_id) === String(profile.id);
  });
  return match ? match.id : null;
}

function actionFor(profile, refresh) {
  const me = State.user && State.user.id;
  const self = String(profile.id) === String(me);
  const actions = [];

  if (!self) {
    if (profile.relation === 'none') {
      actions.push(el('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        onClick: async () => {
          try {
            await Api.sendFriendRequest(profile.id);
            toast('Request sent to ' + (nameOf(profile) || profile.username));
            refresh();
          } catch (e) { errorToast(e); }
        },
      }, icon('user-plus', { size: 14 }), 'Add friend'));
    } else if (profile.relation === 'pending-out') {
      actions.push(el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: async () => {
          try {
            let page = null;
            let requestId = requestIdFor(profile, null);
            if (!requestId) {
              page = await Api.friendRequests();
              requestId = requestIdFor(profile, page);
            }
            if (!requestId) {
              toast('That request is already gone.');
              refresh();
              return;
            }
            await Api.cancelFriendRequest(requestId);
            toast('Request withdrawn');
            refresh();
          } catch (e) { errorToast(e); }
        },
      }, 'Withdraw request'));
    } else if (profile.relation === 'friend') {
      actions.push(el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Remove ' + (nameOf(profile) || profile.username) + ' as a friend',
        onClick: async () => {
          const yes = await confirmDialog({
            title: 'Remove this friend?',
            body: 'They will stay reachable until you do, and they are not told why.',
            confirmLabel: 'Remove',
            danger: true,
          });
          if (!yes) return;
          try {
            await Api.removeFriend(profile.id);
            refresh();
          } catch (e) { errorToast(e); }
        },
      }, 'Remove friend'));
    }

    // Writing to somebody is what a reader who has come to a profile
    // usually wants, so it is the action that stands out.
    actions.push(el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      onClick: async () => {
        try {
          const dm = await Api.createDm(profile.id);
          navigate('/dms/' + (dm.id || dm.conversationId));
        } catch (e) { errorToast(e); }
      },
    }, icon('message', { size: 14 }), 'Message'));

    actions.push(profile.blockedByViewer
      ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: async () => {
          try {
            await Api.unblockUser(profile.id);
            toast('Unblocked');
            refresh();
          } catch (e) { errorToast(e); }
        },
      }, 'Unblock')
      : el('button', {
        class: 'btn btn--danger btn--sm', type: 'button',
        onClick: async () => {
          const yes = await confirmDialog({
            title: 'Block this person?',
            body: 'They stop being able to message you or open conversations with you. It is reversible.',
            confirmLabel: 'Block',
            danger: true,
          });
          if (!yes) return;
          try {
            await Api.blockUser(profile.id);
            toast('Blocked');
            refresh();
          } catch (e) { errorToast(e); }
        },
      }, 'Block'));
    // Reporting and the rest of the person actions live in one menu, so the
    // profile does not become a wall of destructive buttons.
    actions.push(el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      'aria-label': 'More actions for ' + (nameOf(profile) || profile.username),
      onClick: (event) => personSheet(event.currentTarget, profile),
    }, icon('more', { size: 15 }), 'More'));
  }

  if (self) {
    actions.push(el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      onClick: () => navigate('/settings'),
    }, icon('settings', { size: 14 }), 'Edit profile'));
  }

  return actions;
}

export function renderProfile(ctx) {
  const userId = ctx.params.id;
  const serverId = ctx.query && ctx.query.serverId;

  const identity = el('div', { class: 'profile' });
  // The head is replaced once the profile is known: a head that says
  // "Profile" is a head that says nothing, and the name of the person is
  // the one thing the page is about.
  let headNode = head({
    kicker: 'Profile',
    title: 'Profile',
    lede: 'Who is here, and what can be done about it.',
  });
  const host = el('div', { class: 'fold fold--tight' }, headNode, identity);

  let version = 0;
  const load = async () => {
    version += 1;
    const mine = version;
    try {
      const profile = await Api.user(userId, serverId);
      if (mine !== version || !profile) return;
      if (!profile.id) throw { code: 'NOT_FOUND', message: 'There is no one here.' };

      const banner = profile.bannerUrl ? bannerNode(profile.bannerUrl, 'profile-banner') : null;
      const name = displayNameOf(profile) || profile.username;
      // The roles are drawn in the colours the community gave them, so a
      // role that is coloured is coloured everywhere it appears - here, in
      // the member list, and in the message headers.
      const roles = profile.membership && profile.membership.roles
        ? roleNames({ roles: profile.membership.roles || [] }) : [];
      const roleChips = profile.membership && profile.membership.roles
        ? roleChipList({ roles: profile.membership.roles || [] }) : null;
      const isSelf = String(profile.id) === String(State.user && State.user.id);
      const presence = profile.presence === undefined ? null : profile.presence;
      const presenceNode = el('span', {
        class: 'profile-presence member-presence',
        dataset: { presence: presence || 'offline' },
      }, presence ? presenceLabel(presence) : 'Presence hidden');

      // The head names the person, and carries what can be done about them.
      const next = head({
        kicker: 'Profile',
        title: name,
        lede: isSelf
          ? 'This is you.'
          : '@' + (usernameOf(profile) || 'someone') + ' · ' + relationText(profile),
        actions: actionFor(profile, load),
      });
      host.replaceChild(next, headNode);
      headNode = next;

      replaceChildren(identity, 
        banner,
        el('div', { class: 'profile-main' },
          avatar(profile, { size: 'lg', rounded: true, presence: profile.presence || 'offline' }),
          el('div', { class: 'profile-nameblock' },
            el('p', { class: 'pagehead-kicker' }, '@' + profile.username),
            el('p', { class: 'profile-name' }, name,
              // The mark that says a bot is a bot. A profile that does not
              // say so is a profile of somebody pretending.
              profile.isBot
                ? el('span', { class: 'botflag', title: 'This is a bot' }, 'BOT')
                : null),
            el('p', { class: 'profile-presence-line' }, presenceNode,
              presence === 'invisible' && isSelf
                ? el('span', { class: 'profile-presence-note' }, 'Only you can see this.')
                : null),
            profile.statusText ? el('p', { class: 'profile-status' }, profile.statusText) : null,
            roleChips
              ? el('p', { class: 'profile-roles' }, roleChips)
              : (roles.length ? el('p', { class: 'profile-roles' }, roles) : null))),
        el('div', { class: 'fold fold--tight' },
          card({
            label: 'Facts',
            glyph: 'info',
            body: facts([
              { value: profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—', label: 'Joined Trycord' },
              profile.membership && profile.membership.joinedAt
                ? { value: new Date(profile.membership.joinedAt).toLocaleDateString(), label: 'In this community' }
                : null,
              { value: String(profile.mutualFriendCount || 0), label: 'Mutual friends' },
            ]),
          }),
          profile.bio ? card({
            label: 'About', glyph: 'file',
            body: el('p', { class: 'lede' }, profile.bio),
          }) : null,
          // Both lists are facts about the viewer's own relationships as much
          // as the subject's. They are the bridge from a stranger's page to a
          // place the two already share.
          profile.mutualFriends && profile.mutualFriends.length
            ? card({
              label: 'Mutual friends',
              glyph: 'users',
              note: String(profile.mutualFriendCount || profile.mutualFriends.length),
              tight: true,
              body: el('div', { class: 'rowlist' },
                ...profile.mutualFriends.map((friend) => row({
                  lead: avatar(friend, { size: 'sm', rounded: true }),
                  title: nameOf(friend) || friend.username,
                  sub: '@' + (friend.username || ''),
                  href: path('/users/' + friend.id),
                  link: true,
                }))),
            })
            : null,
          profile.sharedCommunities && profile.sharedCommunities.length
            ? card({
              label: 'Communities you share',
              glyph: 'globe',
              note: String(profile.sharedCommunities.length),
              tight: true,
              body: el('div', { class: 'rowlist' },
                ...profile.sharedCommunities.map((community) => row({
                  lead: serverMark(community, { size: 'sm' }),
                  title: community.name,
                  sub: 'Community',
                  href: path('/server/' + community.id),
                  link: true,
                }))),
            })
            : null,
          // The community they are in, and what they are in it - said once,
          // and not twice.
          profile.membership && profile.membership.roles && profile.membership.roles.length
            ? card({
              label: 'In this community', glyph: 'users',
              body: el('div', { class: 'lede' },
                profile.membership.joinedAt
                  ? 'Here since ' + new Date(profile.membership.joinedAt).toLocaleDateString() + '.'
                  : 'Here.',
                roleChips ? el('p', { class: 'profile-roles' }, roleChips) : null),
            })
            : null));
    } catch (e) {
      if (mine !== version) return;
      if (e && e.code === 'PROFILE_PRIVATE') {
        // A block and a private profile answer the same way on purpose: the
        // blocked person must not learn which of the two doors closed.
        const next = head({
          kicker: 'Profile',
          title: 'Private profile',
          lede: 'This person has limited who can see their page.',
        });
        host.replaceChild(next, headNode);
        headNode = next;
        replaceChildren(identity, fold([
          blank({
            glyph: 'lock',
            title: 'This profile is private',
            text: 'You can still meet them in a community you share, or through somebody you both know.',
            action: el('a', { class: 'btn btn--default', href: path('/friends') }, 'Back to friends'),
          }),
        ]));
        return;
      }
      replaceChildren(identity, fold([
        blank({
          glyph: 'user',
          title: 'No one goes by that here',
          text: 'The number does not answer to a person. It may have left, or the link is stale.',
        }),
        fault(e, () => load()),
      ]));
    }
  };

  return {
    node: host,
    onMount: load,
    cleanup() { version += 1; },
  };
}
