// The spaces, on a desk.
//
// A space is a named group of references - channels, documents, boards and
// links - that narrows what a member may see and never widens it. Everything
// in a space is a reference to something that already exists and keeps its own
// access rules.
//
// The list is the community's spaces; the detail is one space and the
// references in it, in the order they are in. The order is the server's, and
// the whole list is sent back when it changes, because a client that dropped an
// item would be refused rather than quietly reordering the rest.
//
// Managing a space needs MANAGE_CHANNELS. The reference the client offers is
// one the reader may see: the channels of the community they are in, the
// documents the server lists for them and the boards they may open.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { iconButton } from '../../ui/primitives.js';
import { openDialog, confirmDialog, toast, errorToast } from '../../ui/overlays.js';
import Api from '../../../packages/api.js';
import { State, channelsOf, refreshServerTree, isOwner } from '../../../packages/store.js';
import { path } from '../../../packages/nav.js';
import {
  Workspace, SPACE_ITEM_LABELS, mayManageStructure,
  spaceRoute, documentRoute, boardRoute,
} from '../../../packages/workspace.js';

// -- the list ------------------------------------------------------------------

export function spacesList(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rowlist' });
  const canManage = mayManageStructure(serverId);

  const node = card({
    label: 'Spaces',
    glyph: 'layers',
    note: 'groups of references',
    actions: canManage
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openSpaceEditor(serverId, null, load),
      }, icon('plus', { size: 14 }), 'New space')
      : null,
    body: host,
    flush: true,
  });

  const load = async () => {
    host.replaceChildren(hold('Reading the spaces'));
    try {
      const spaces = await Workspace.spaces(serverId);
      host.replaceChildren(...(spaces.length
        ? spaces.map((space) => row({
          lead: el('span', { class: 'role-dot' }, icon('layers', { size: 15 })),
          title: space.name,
          sub: space.description || ((space.items || []).length + ' references'),
          meta: space.isPrivate ? el('span', { class: 'chip chip--quiet' }, 'private') : null,
          href: path(spaceRoute(serverId, space.id)),
          link: true,
        }))
        : [blank({
          glyph: 'layers',
          title: 'No spaces yet',
          text: 'A space gathers references and narrows what a member may see of them.',
        })]));
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  return { node, onMount: load, cleanup() {} };
}

// -- one space ----------------------------------------------------------------

export function spacesDetail(ctx) {
  const serverId = ctx.serverId;
  const spaceId = ctx.params.spaceId;
  const canManage = mayManageStructure(serverId);

  if (!spaceId) {
    return {
      node: blank({
        glyph: 'layers',
        title: 'No space open',
        text: 'Choose a space on the left to see the references in it.',
      }),
      onMount: async () => {},
      cleanup() {},
    };
  }

  const head = el('div', { class: 'fold fold--tight' });
  const items = el('div', { class: 'rowlist' });
  let space = null;

  const node = card({
    label: 'The space',
    glyph: 'layers',
    actions: canManage
      ? el('span', { class: 'rowtools' },
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => openSpaceEditor(serverId, space, load),
        }, icon('edit', { size: 14 }), 'Edit'),
        el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          onClick: () => removeSpace(serverId, space, load),
        }, 'Delete'))
      : null,
    body: fold([head, items], { tight: true }),
    flush: true,
  });

  const paint = () => {
    head.replaceChildren(
      el('h2', { class: 'pagehead-title' }, space.name),
      el('p', { class: 'form-note' }, space.description
        || 'A space gathers references. It narrows what a member may see and never widens it.'),
      el('p', { class: 'form-note' },
        (space.items || []).length + ' reference' + ((space.items || []).length === 1 ? '' : 's')
        + (space.isPrivate ? ' · only the members holding the role may see this space' : '')),
    );

    const list = space.items || [];
    if (!list.length) {
      items.replaceChildren(blank({
        glyph: 'list',
        title: 'Nothing referenced yet',
        text: 'Add a channel, a document or a board to point at.',
      }));
      return;
    }

    items.replaceChildren(...list.map((item, index) => referenceRow(serverId, item, index, list, space, canManage, load)));
  };

  const load = async () => {
    items.replaceChildren(hold('Reading the space'));
    try {
      space = await Workspace.space(serverId, spaceId);
      paint();
    } catch (error) {
      items.replaceChildren(fold([fault(error, load)]));
    }
  };

  return {
    node: fold([
      node,
      canManage
        ? el('div', { class: 'actionline' },
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: () => openReferencePicker(serverId, spaceId, load),
          }, icon('plus', { size: 14 }), 'Add a reference'))
        : null,
    ]),
    onMount: load,
    cleanup() {},
  };
}

// One reference, drawn. A reference the reader may open is a link; a link to
// the outside world opens in a new tab, because the address belongs to
// somewhere else and the workspace is still here when it closes.
function referenceRow(serverId, item, index, list, space, canManage, load) {
  const href = hrefForItem(serverId, item);
  const label = item.title || SPACE_ITEM_LABELS[item.kind] || item.kind;
  const node = row({
    lead: el('span', { class: 'role-dot' }, icon(iconForItem(item), { size: 15 })),
    title: label,
    sub: item.kind === 'resource' ? item.url : (SPACE_ITEM_LABELS[item.kind] || item.kind),
    href: href,
    link: href ? true : null,
    side: canManage
      ? el('span', { class: 'rowtools' },
        index > 0
          ? iconButton('chevron-up', {
            label: 'Move ' + label + ' up',
            class: 'icon-btn--sm',
            onClick: () => move(serverId, space, list, index, -1, load),
          })
          : null,
        index < list.length - 1
          ? iconButton('chevron-down', {
            label: 'Move ' + label + ' down',
            class: 'icon-btn--sm',
            onClick: () => move(serverId, space, list, index, 1, load),
          })
          : null,
        el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Remove ' + label + ' from the space',
          onClick: () => removeItem(serverId, space, item, load),
        }, 'Remove'))
      : null,
  });
  if (href && item.kind === 'resource') {
    const anchor = node.querySelector('a');
    if (anchor) {
      anchor.target = '_blank';
      anchor.rel = 'noreferrer noopener';
    }
  }
  return node;
}

// The glyph a reference is drawn with.
function iconForItem(item) {
  if (item.kind === 'channel') return 'hash';
  if (item.kind === 'document') return 'file';
  if (item.kind === 'board') return 'grid';
  return 'link';
}

// Where a reference points. A link is a place the member opens themselves; the
// server never fetches it.
function hrefForItem(serverId, item) {
  if (item.kind === 'channel' && item.targetId) {
    return path('/server/' + serverId + '/channel/' + item.targetId);
  }
  if (item.kind === 'document' && item.targetId) return path(documentRoute(serverId, item.targetId));
  if (item.kind === 'board' && item.targetId) return path(boardRoute(serverId, item.targetId));
  if (item.kind === 'resource' && item.url) return item.url;
  return null;
}

// -- the writes ----------------------------------------------------------------

// Move a reference one place up or down. The whole list goes back, because the
// server refuses an order that does not hold exactly the items of the space.
async function move(serverId, space, list, index, delta, load) {
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  const order = list.slice();
  const [moved] = order.splice(index, 1);
  order.splice(to, 0, moved);
  try {
    await Workspace.reorderSpaceItems(serverId, space.id, order.map((item) => item.id));
    toast('The order is saved');
    if (load) await load();
  } catch (error) {
    errorToast(error);
  }
}

// A reference taken out of a space.
async function removeItem(serverId, space, item, reload) {
  const yes = await confirmDialog({
    title: 'Remove ' + (item.title || 'this reference') + '?',
    body: 'The thing it points at stays where it is; only the space forgets it.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!yes) return;
  try {
    await Workspace.removeSpaceItem(serverId, space.id, item.id);
    toast('Removed from the space');
    if (reload) await reload();
  } catch (error) {
    errorToast(error);
  }
}

// A space deleted.
async function removeSpace(serverId, space, load) {
  const yes = await confirmDialog({
    title: 'Delete ' + space.name + '?',
    body: 'The space goes. The channels, documents and boards it pointed at stay.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!yes) return;
  try {
    await Workspace.deleteSpace(serverId, space.id);
    toast('The space is deleted');
    if (load) await load();
  } catch (error) {
    errorToast(error);
  }
}

// -- the editors ----------------------------------------------------------------

// A space, made or changed.
//
// A private space names the role that may see it, and the server refuses a
// role the creator does not hold. The client therefore offers the roles the
// reader holds - all of them, for the owner - rather than every role in the
// community.
function openSpaceEditor(serverId, space, onDone) {
  const name = el('input', {
    class: 'input', type: 'text', maxlength: '64',
    'aria-label': 'The name of the space', placeholder: 'Engineering',
  });
  name.value = space ? space.name : '';
  const description = el('textarea', {
    class: 'input', rows: '2', maxlength: '1000',
    'aria-label': 'What the space is for', placeholder: 'What the members of this space share',
  });
  description.value = space ? space.description : '';

  const privacy = el('input', { type: 'checkbox', id: 'space-private', 'aria-label': 'Private' });
  privacy.checked = !!(space && space.isPrivate);
  const role = el('select', { class: 'select', 'aria-label': 'The role that may see the space' });
  const roleNote = el('p', { class: 'form-note' });
  const error = el('p', { class: 'form-error', hidden: true });

  const dialog = openDialog({
    title: space ? 'Edit ' + space.name : 'New space',
    sub: 'A space gathers references and narrows what its members may see.',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        const label = name.value.trim();
        if (!label) { error.hidden = false; error.textContent = 'Give the space a name.'; return; }
        const body = { name: label, description: description.value.trim() };
        if (privacy.checked) {
          if (!role.value) {
            error.hidden = false;
            error.textContent = 'A private space needs the role that may see it.';
            return;
          }
          body.isPrivate = true;
          body.requiredRoleId = role.value;
        } else {
          body.isPrivate = false;
        }
        try {
          if (space) await Workspace.updateSpace(serverId, space.id, body);
          else await Workspace.createSpace(serverId, body);
          toast(space ? 'The space is saved' : 'The space is made');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The space could not be saved.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description),
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'Private'),
      privacy),
    role, roleNote, error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, space ? 'Save' : 'Create')),
  });

  const paintRoles = async () => {
    role.replaceChildren();
    roleNote.textContent = '';
    if (!privacy.checked) return;
    try {
      const roles = await heldRoles(serverId);
      if (!roles.length) {
        roleNote.textContent = 'You hold no role that could see a private space.';
        return;
      }
      for (const entry of roles) {
        role.appendChild(el('option', { value: entry.id, selected: entry.id === (space && space.requiredRoleId) }, entry.name));
      }
    } catch (error) {
      roleNote.textContent = (error && error.message) || 'The roles could not be read.';
    }
  };

  privacy.addEventListener('change', paintRoles);
  paintRoles();
  name.focus();
}

// The roles the reader holds in this community.
//
// The server refuses a space named for a role the creator does not hold, so
// the client asks for the roles the reader holds rather than offering every
// role in the community and letting the server refuse.
async function heldRoles(serverId) {
  const roles = await Api.roles(serverId);
  const all = Array.isArray(roles) ? roles : [];
  if (isOwner(serverId)) return all;
  const me = State.user;
  if (!me) return [];
  const page = await Api.serverMembers(serverId, { q: me.username, limit: 5 });
  const items = (page && page.items) || [];
  const mine = items.find((entry) => String(entry.id) === String(me.id));
  const held = new Set((mine && mine.roles || []).map((entry) => String(entry.id)));
  return all.filter((entry) => held.has(String(entry.id)));
}

// The reference picker.
//
// The client offers only what the reader may see: the channels of the
// community they are in, the documents the server lists for them, the boards
// they may open, and a link they write themselves.
function openReferencePicker(serverId, spaceId, onDone) {
  const kind = el('select', { class: 'select', 'aria-label': 'What kind of reference' },
    el('option', { value: 'channel' }, 'Channel'),
    el('option', { value: 'document' }, 'Document'),
    el('option', { value: 'board' }, 'Board'),
    el('option', { value: 'resource' }, 'Link'));
  const target = el('select', { class: 'select', 'aria-label': 'The thing to reference' });
  const url = el('input', {
    class: 'input', type: 'url', 'aria-label': 'The address of the link',
    placeholder: 'https://example.org/handbook',
  });
  const title = el('input', {
    class: 'input', type: 'text', maxlength: '255', 'aria-label': 'The name of the reference',
  });
  const error = el('p', { class: 'form-error', hidden: true });

  const choices = { channel: [], document: [], board: [] };

  const paintTargets = () => {
    target.replaceChildren();
    url.hidden = kind.value !== 'resource';
    title.hidden = kind.value !== 'resource';
    if (kind.value === 'resource') return;
    const list = choices[kind.value] || [];
    if (!list.length) {
      target.appendChild(el('option', { value: '' }, 'Nothing to reference yet'));
      return;
    }
    for (const entry of list) {
      target.appendChild(el('option', { value: entry.id }, entry.label));
    }
  };

  kind.addEventListener('change', paintTargets);

  const dialog = openDialog({
    title: 'Add a reference',
    sub: 'A reference points at something that already exists.',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        const body = { kind: kind.value };
        if (kind.value === 'resource') {
          const address = url.value.trim();
          if (!address) { error.hidden = false; error.textContent = 'Give the link an address.'; return; }
          body.url = address;
          body.title = title.value.trim();
        } else {
          if (!target.value) {
            error.hidden = false;
            error.textContent = 'Choose what to reference.';
            return;
          }
          body.targetId = target.value;
        }
        try {
          await Workspace.addSpaceItem(serverId, spaceId, body);
          toast('Added to the space');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The reference could not be added.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Kind'), kind),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Reference'), target),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Address'), url),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), title),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Add')),
  });

  (async () => {
    try {
      await refreshServerTree(serverId);
      const [documents, boards] = await Promise.all([
        Workspace.documents(serverId),
        Workspace.boards(serverId),
      ]);
      choices.channel = channelsOf(serverId).map((channel) => ({
        id: channel.id,
        label: '#' + (channel.name || 'channel'),
      }));
      choices.document = (documents || []).map((document) => ({
        id: document.id,
        label: document.title,
      }));
      choices.board = (boards || []).map((board) => ({
        id: board.id,
        label: board.name,
      }));
      paintTargets();
    } catch (error) {
      error.hidden = false;
      error.textContent = (error && error.message) || 'What may be referenced could not be read.';
    }
  })();

  paintTargets();
}

export default { spacesList, spacesDetail };
