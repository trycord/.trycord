// The access of a community: the members, the roles, the invites and the
// categories.
//
// The four of them are the community's own pages - community.js draws the
// list of each - and they are drawn here inside the console, so the reader
// finds them in the same place as everything else rather than having to know
// that they have addresses of their own.
//
// What the community's pages did not have is here as well: the catalogue of
// permissions, what a role may be given, the order of the roles, and the
// overrides that narrow or widen what the roles grant in one channel or one
// category. Those are the settings of the community's access, and they were
// the part of the access the server supported and the interface never showed.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { path } from '../../../packages/nav.js';
import { card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { confirmDialog } from '../../ui/overlays.js';
import {
  State, refreshServerRoles, refreshServerMembers, can, isOwner,
} from '../../../packages/store.js';
import { communityApi } from '../../../packages/communitySettings.js';
import { reporter } from './parts.js';
import { renderMembers, renderRoles, renderInvites, renderCategories } from '../community.js';

// The name of a member, however the server spells it.
function memberName(member) {
  return member.nickname || member.display_name || member.displayName
    || member.username || 'Someone';
}

// A page of the community, inside the console.
//
// The page keeps its own lifecycle; what is added here is drawn after it and
// loaded after it.
function withPage(render, addition) {
  return (ctx) => {
    const page = render(ctx);
    const extra = addition ? addition(ctx) : null;
    return {
      node: fold([page.node, extra ? extra.node : null]),
      onMount: async () => {
        if (page.onMount) await page.onMount();
        if (extra && extra.onMount) await extra.onMount();
      },
      cleanup: page.cleanup,
    };
  };
}

// A link to another section of the console.
function sectionLink(serverId, section, label) {
  return el('a', {
    class: 'btn btn--ghost btn--sm',
    href: path('/server/' + serverId + '/settings/' + section),
  }, icon('link', { size: 14 }), label);
}

// -- the permission catalogue -------------------------------------------------

// Every permission the community knows, and what it means.
//
// The text lives with the permission on the server, so the list here cannot
// drift from the rules that are enforced.
function catalogueCard(serverId) {
  const body = el('div', { class: 'rowlist' });
  return {
    node: card({
      label: 'What a role may do', glyph: 'shield',
      note: 'The permissions this community knows',
      body, flush: true,
    }),
    onMount: async () => {
      body.replaceChildren(hold('Reading the permissions'));
      try {
        const answer = await Api.rolePermissions(serverId);
        const all = (answer && answer.all) || [];
        const descriptions = (answer && answer.descriptions) || {};
        if (!all.length) {
          body.replaceChildren(blank({
            glyph: 'shield',
            title: 'No permissions',
            text: 'This community does not know any permissions.',
          }));
          return;
        }
        body.replaceChildren(...all.map((permission) => row({
          title: permission,
          sub: descriptions[permission] || '',
        })));
      } catch (error) {
        body.replaceChildren(fold([fault(error, null)]));
      }
    },
  };
}

// -- who holds a role ---------------------------------------------------------

// Giving a role to somebody, and taking it away.
function assignmentCard(serverId) {
  const body = el('div', { class: 'rowlist' });
  const status = reporter();
  const rolePick = el('select', { class: 'input', 'aria-label': 'The role to give' });
  const memberPick = el('select', { class: 'input', 'aria-label': 'The member who gets it' });
  const give = el('button', { class: 'btn btn--default btn--sm', type: 'button' }, 'Give the role');

  const roles = () => State.serverRoles.get(serverId) || [];

  const paintRoles = () => {
    rolePick.replaceChildren(...roles().map((role) => el('option', { value: role.id }, role.name)));
  };

  const load = async () => {
    body.replaceChildren(hold('Reading the roster'));
    try {
      await refreshServerRoles(serverId);
      const page = await refreshServerMembers(serverId);
      const members = (page && page.items) || [];
      paintRoles();
      memberPick.replaceChildren(
        el('option', { value: '' }, 'Choose a member'),
        ...members.map((member) => el('option', { value: member.id }, memberName(member))));
      body.replaceChildren(...members.map((member) => row({
        lead: el('span', { class: 'role-dot' }, icon('user', { size: 15 })),
        title: memberName(member),
        sub: (member.roles || []).map((role) => role.name).join(', ') || 'No roles',
        side: (member.roles || []).length
          ? el('span', { class: 'rowtools' }, ...(member.roles || []).map((role) => el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Take the role ' + role.name + ' away from ' + memberName(member),
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Take the role away?',
                body: memberName(member) + ' will no longer hold ' + role.name + '.',
                confirmLabel: 'Take it away',
                danger: true,
              });
              if (!yes) return;
              try {
                await Api.unassignRole(serverId, role.id, member.id);
                status.answered('The server answered: the role was taken away.');
                await load();
              } catch (error) {
                status.fail(error);
              }
            },
          }, 'Take away ' + role.name)))
          : null,
      })));
    } catch (error) {
      body.replaceChildren(fold([fault(error, load)]));
    }
  };

  give.addEventListener('click', async () => {
    if (!rolePick.value || !memberPick.value) {
      if (!rolePick.value) rolePick.focus(); else memberPick.focus();
      return;
    }
    try {
      await Api.assignRole(serverId, rolePick.value, memberPick.value);
      status.answered('The server answered: the role was given.');
      await load();
    } catch (error) {
      status.fail(error);
    }
  });

  return {
    node: card({
      label: 'Who holds what', glyph: 'users',
      body: fold([
        status.node,
        el('div', { class: 'rowtools' }, rolePick, memberPick, give),
        body,
      ]),
    }),
    onMount: load,
  };
}

// -- the order of the roles ----------------------------------------------------

// Which role outranks which.
//
// The server keeps the order; the community may not reorder a role it cannot
// manage, and the server refuses that. Here the order is offered and the
// answer is reported.
function orderCard(serverId) {
  const body = el('div', { class: 'rowlist' });
  const status = reporter();

  const load = async () => {
    body.replaceChildren(hold('Reading the roles'));
    try {
      if (!State.serverRoles.get(serverId)) await refreshServerRoles(serverId);
      const roles = (State.serverRoles.get(serverId) || []);
      const movable = roles.filter((role) => !role.isDefault && !role.is_default);
      if (!movable.length) {
        body.replaceChildren(blank({
          glyph: 'layers',
          title: 'No roles to order',
          text: 'The baseline role every member holds is always last.',
        }));
        return;
      }
      const paint = () => {
        body.replaceChildren(...movable.map((role, index) => row({
          lead: el('span', { class: 'role-dot' }, icon('shield', { size: 15 })),
          title: role.name,
          sub: 'Holds ' + (role.permissions || []).length + ' permission' + ((role.permissions || []).length === 1 ? '' : 's'),
          side: el('span', { class: 'rowtools' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Move the role ' + role.name + ' up',
              disabled: index === 0 ? true : null,
              onClick: () => move(index, index - 1),
            }, 'Up'),
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Move the role ' + role.name + ' down',
              disabled: index === movable.length - 1 ? true : null,
              onClick: () => move(index, index + 1),
            }, 'Down'),
            el('button', {
              class: 'btn btn--danger btn--sm', type: 'button',
              'aria-label': 'Remove the role ' + role.name,
              onClick: async () => {
                const yes = await confirmDialog({
                  title: 'Remove the role ' + role.name + '?',
                  body: 'Nobody will hold it afterwards, and the permissions it carried go with it.',
                  confirmLabel: 'Remove the role',
                  danger: true,
                });
                if (!yes) return;
                try {
                  await Api.deleteRole(serverId, role.id);
                  status.answered('The server answered: the role was removed.');
                  await load();
                } catch (error) {
                  status.fail(error);
                }
              },
            }, 'Remove')),
        })));
      };

      const move = async (from, to) => {
        if (to < 0 || to >= movable.length) return;
        const order = movable.map((role) => String(role.id));
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        try {
          await Api.reorderRoles(serverId, order);
          status.answered('The server answered: the roles were reordered.');
          await refreshServerRoles(serverId);
          paint();
        } catch (error) {
          status.fail(error);
        }
      };

      paint();
    } catch (error) {
      body.replaceChildren(fold([fault(error, load)]));
    }
  };

  return {
    node: card({
      label: 'The order of the roles', glyph: 'layers',
      body: fold([status.node, body]),
    }),
    onMount: load,
  };
}

// -- the overrides --------------------------------------------------------------

// What one channel or one category allows, whatever the roles say.
//
// Three states per permission: inherited from the roles, allowed here, or
// refused here. An explicit refusal beats an allowance, which is the rule
// the server applies.
function overrideCard(serverId, kind) {
  const isChannel = kind === 'channel';
  const label = isChannel ? 'What a channel allows' : 'What a category allows';
  const glyph = isChannel ? 'hash' : 'layers';
  const body = el('div', { class: 'rowlist' });
  const status = reporter();
  const pick = el('select', {
    class: 'input',
    'aria-label': isChannel ? 'The channel to change' : 'The category to change',
  });

  const entities = () => {
    const tree = State.serverTree.get(serverId) || { channels: [], categories: [] };
    return isChannel ? (tree.channels || []) : (tree.categories || []);
  };

  const paintEntities = () => {
    const list = entities();
    pick.replaceChildren(...list.map((entity) => el('option', {
      value: entity.id,
    }, isChannel ? '#' + entity.name : entity.name)));
  };

  const load = async () => {
    paintEntities();
    if (!pick.value) {
      body.replaceChildren(blank({
        glyph,
        title: isChannel ? 'No channels yet' : 'No categories yet',
        text: isChannel
          ? 'A channel is what an override applies to. Make one first.'
          : 'A category is what an override applies to. Make one first.',
      }));
      return;
    }
    body.replaceChildren(hold('Reading the overrides'));
    try {
      const [answer, catalogue] = await Promise.all([
        isChannel
          ? communityApi.channelOverrides(serverId, pick.value)
          : communityApi.categoryOverrides(serverId, pick.value),
        Api.rolePermissions(serverId),
      ]);
      const overrides = (answer && answer.overrides) || {};
      const all = (answer && answer.all) || (catalogue && catalogue.all) || [];
      const descriptions = (catalogue && catalogue.descriptions) || {};
      const chosen = pick.value;
      const chosenName = (entities().find((entity) => String(entity.id) === String(chosen)) || {}).name || '';
      body.replaceChildren(...all.map((permission) => {
        const current = overrides[permission] || 'inherit';
        const control = el('select', {
          class: 'input',
          'aria-label': 'What ' + permission + ' is allowed in ' + chosenName,
        },
        el('option', { value: 'inherit' }, 'Inherited'),
        el('option', { value: 'allow' }, 'Allowed'),
        el('option', { value: 'deny' }, 'Refused'));
        control.value = current;
        control.addEventListener('change', async () => {
          try {
            if (isChannel) {
              await communityApi.setChannelOverride(serverId, chosen, permission, control.value);
            } else {
              await communityApi.setCategoryOverride(serverId, chosen, permission, control.value);
            }
            status.answered('The server answered: ' + permission + ' is '
              + (control.value === 'inherit' ? 'inherited again' : control.value === 'allow' ? 'allowed here' : 'refused here') + '.');
          } catch (error) {
            status.fail(error);
          }
        });
        return row({
          title: permission,
          sub: descriptions[permission] || '',
          side: control,
        });
      }));
    } catch (error) {
      body.replaceChildren(fold([fault(error, load)]));
    }
  };

  pick.addEventListener('change', load);

  return {
    node: card({
      label, glyph,
      body: fold([status.node, el('div', { class: 'rowtools' }, pick), body]),
    }),
    onMount: load,
  };
}

// -- the sections ---------------------------------------------------------------

// The members. The roster is the community's own, and it carries the
// moderation actions that the reader is allowed to take.
export function membersSection(ctx) {
  const serverId = ctx.serverId;
  return withPage(renderMembers, () => card({
    label: 'Moderation', glyph: 'flag',
    body: fold([
      el('p', { class: 'lede' },
        'Bans, timeouts and removing a member are in the moderation section of this console.'),
      sectionLink(serverId, 'moderation', 'Open moderation'),
    ]),
  }))(ctx);
}

// The roles: the list the community draws, and everything that decides what a
// role may do.
export function rolesSection(ctx) {
  const serverId = ctx.serverId;
  // The controls the server would refuse are not offered. A permission
  // catalogue is a reading of the rules, so it is there for everybody; what
  // changes them is only for somebody who may change them.
  const mayRoles = can(serverId, 'MANAGE_ROLES') || isOwner(serverId);
  const mayChannels = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const catalogue = catalogueCard(serverId);
  const assignment = mayRoles ? assignmentCard(serverId) : null;
  const order = mayRoles ? orderCard(serverId) : null;
  const channelOverrides = mayChannels ? overrideCard(serverId, 'channel') : null;
  const categoryOverrides = mayChannels ? overrideCard(serverId, 'category') : null;
  const cards = [catalogue, assignment, order, channelOverrides, categoryOverrides];
  return withPage(renderRoles, () => ({
    node: fold(cards.map((card) => (card ? card.node : null))),
    onMount: async () => {
      for (const card of cards) {
        if (card && card.onMount) await card.onMount();
      }
    },
  }))(ctx);
}

// The invites.
export function invitesSection(ctx) {
  return withPage(renderInvites)(ctx);
}

// The categories: the list the community draws, and what each category
// allows whatever the roles say.
export function categoriesSection(ctx) {
  const serverId = ctx.serverId;
  const mayChannels = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const overrides = mayChannels ? overrideCard(serverId, 'category') : null;
  return withPage(renderCategories, () => ({
    node: overrides ? overrides.node : null,
    onMount: overrides ? overrides.onMount : null,
  }))(ctx);
}

export default { membersSection, rolesSection, invitesSection, categoriesSection };
