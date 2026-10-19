// A person's profile.
//
// One page for a reader, a friend, a stranger - or nobody. What can be acted on
// is decided by the relation the backend answers with, so the buttons never
// offer something the account policy removes. A profile is also where the
// community-aware facts (the member pages) link back to.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State, nameOf } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import { avatar, bannerNode } from '../ui/primitives.js';
import { head, card, blank, fault, fold, facts } from '../ui/page.js';
import { errorToast, confirmDialog, toast } from '../ui/overlays.js';

const relationText = (p) => {
  switch (p.relation) {
    case 'self': return 'This is you.';
    case 'friend': return 'The two of you are friends.';
    case 'pending-in': return 'They asked to be friends with you.';
    case 'pending-out': return 'You asked to be friends, and the request is open.';
    default: return 'Not connected yet.';
  }
};

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
            await Api.cancelFriendRequest(profile.id);
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

    actions.push(el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
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
  const host = el('div', { class: 'fold fold--tight' },
    head({
      kicker: 'Profile',
      title: 'Profile',
      lede: 'Who is here, and what can be done about it.',
      actions: null,
    }),
    identity);

  let version = 0;
  const load = async () => {
    version += 1;
    const mine = version;
    try {
      const profile = await Api.user(userId, serverId);
      if (mine !== version || !profile) return;
      if (!profile.id) throw { code: 'NOT_FOUND', message: 'There is no one here.' };

      const actions = el('div', { class: 'pagehead-actions' }, actionFor(profile, load));
      const banner = profile.bannerUrl ? bannerNode(profile.bannerUrl, 'profile-banner') : null;
      const name = nameOf(profile) || profile.username;
      const roles = profile.membership && profile.membership.roles
        ? (profile.membership.roles || []).map((r) => r.name) : [];
      identity.replaceChildren(
        banner,
        el('div', { class: 'profile-main' },
          avatar(profile, { size: 'lg', rounded: true, presence: profile.presence || 'offline' }),
          el('div', { class: 'profile-nameblock' },
            el('p', { class: 'pagehead-kicker' }, '@' + profile.username),
            el('p', { class: 'profile-name' }, name),
            profile.statusText ? el('p', { class: 'profile-status' }, profile.statusText) : null,
            el('p', { class: 'profile-relation' }, relationText(profile)),
            roles.length ? el('p', { class: 'profile-roles' }, roles.join(' · ')) : null,
            actions)),
        el('div', { class: 'fold fold--tight' },
          card({
            label: 'Facts',
            glyph: 'info',
            body: facts([
              { value: profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—', label: 'Joined' },
            ]),
          }),
          profile.bio ? card({
            label: 'About', glyph: 'file',
            body: el('p', { class: 'lede' }, profile.bio),
          }) : null,
          profile.membership && profile.membership.joinedAt ? card({
            label: 'In this community', glyph: 'users',
            body: el('div', { class: 'lede' }, 'Sitting in this community since '
              + new Date(profile.membership.joinedAt).toLocaleDateString() + '.'),
          }) : null));
    } catch (e) {
      if (mine !== version) return;
      identity.replaceChildren(fold([
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
