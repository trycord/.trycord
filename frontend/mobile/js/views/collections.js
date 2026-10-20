// The collections screen, on a phone.
//
// A collection is a named list of things the reader saved: a message, a file,
// a link. It belongs to a community, and it may be private to the reader or
// shared with that community's members.
//
// The list the server sends is the list the reader may see: their own
// collections, and the shared ones in the communities they belong to. The
// screen shows what came and offers the owner's controls only to the owner,
// so a shared collection somebody else made is read-only here.
//
// A phone has one column, so what is inside a collection is a sheet that comes
// up from the edge a thumb can reach, and the owner's controls are in the same
// place.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { State } from '../../../packages/store.js';
import {
  listCollections, collection, createCollection, updateCollection, removeCollection,
  addCollectionItem, removeCollectionItem, isOwner, visibilityOf,
} from '../../../packages/personal.js';
import { empty, loading, failure, iconButton } from '../components.js';
import { screen, section, actions, primaryButton, ghostButton } from './util.js';
import { sheet, confirm, toast } from '../ui.js';

const ITEM_GLYPH = { message: 'message', file: 'file', link: 'link' };

// The form that makes a collection. A collection belongs to a community, so
// the community is chosen rather than assumed, and sharing is a choice the
// reader makes on purpose.
function collectionForm(selectedId, onSaved) {
  const name = el('input', {
    class: 'm-input', type: 'text', 'aria-label': 'The name of the collection',
    placeholder: 'Reading for later',
  });
  const community = el('select', { class: 'm-input m-input--select', 'aria-label': 'The community' });
  for (const server of State.servers || []) {
    community.appendChild(el('option', { value: server.id }, server.name));
  }
  if (!State.servers || !State.servers.length) {
    community.appendChild(el('option', { value: '' }, 'No communities'));
  }
  const visibility = el('select', { class: 'm-input m-input--select', 'aria-label': 'Who can see it' });
  visibility.appendChild(el('option', { value: 'private' }, 'Private - only you'));
  visibility.appendChild(el('option', { value: 'community' }, 'Shared - the community'));

  const layer = sheet({
    title: 'New collection',
    body: el('div', { class: 'm-stack' },
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Name'), name),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Community'), community),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Visibility'), visibility)),
    footer: actions([
      primaryButton('Create', async () => {
        const where = community.value;
        if (!where) { toast('A collection belongs to a community.', { type: 'danger' }); return; }
        try {
          const made = await createCollection({
            serverId: where,
            name: name.value.trim(),
            visibility: visibility.value,
          });
          layer.close();
          toast('Collection created.', { type: 'success' });
          if (onSaved) onSaved(made);
        } catch (error) { toast(error.message, { type: 'danger' }); }
      }, { block: true }),
    ]),
  });
  return layer;
}

// What is in one collection.
function openCollection(entry, onChanged) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({
    title: entry.name,
    body,
  });
  const me = State.user && State.user.id;

  async function paint() {
    clear(body);
    body.appendChild(loading('Reading the collection'));
    try {
      const found = await collection(entry.id);
      const mine = isOwner(found, me);
      const items = Array.isArray(found.items) ? found.items : [];
      const visibility = visibilityOf(found);

      const list = el('div', { class: 'm-list' });
      for (const item of items) {
        const kind = String(item.itemType || 'message');
        const title = item.title || (kind === 'link' ? item.itemRef : null)
          || (kind === 'file' ? 'A file' : 'A message');
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon(ITEM_GLYPH[kind] || 'message', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, title),
            el('span', { class: 'm-row__sub' }, kind === 'link' ? 'Saved link'
              : kind === 'file' ? 'Saved file' : 'Saved message')),
          mine ? el('span', { class: 'm-row__actions' },
            iconButton('trash', 'Remove ' + title + ' from this collection', async () => {
              try {
                await removeCollectionItem(found.id, item.id);
                toast('Removed from the collection.', { type: 'success' });
                paint();
                if (onChanged) onChanged();
              } catch (error) { toast(error.message, { type: 'danger' }); }
            })) : null));
      }
      if (!items.length) {
        list.appendChild(empty({
          icon: 'inbox',
          title: 'Nothing in it yet',
          text: mine
            ? 'Save a message or a link into it from the conversation, or add a link here.'
            : 'The owner has not put anything in it yet.',
        }));
      }

      const controls = el('div', { class: 'm-actions' });
      if (mine) {
        controls.append(
          ghostButton('Rename', () => rename(found)),
          ghostButton(found.visibility === 'community' ? 'Make private' : 'Share', () => share(found)),
          ghostButton('Add a link', () => addLink(found)),
          ghostButton('Delete', () => remove(found)));
      }

      clear(body);
      body.append(
        el('p', { class: 'm-lede' },
          (found.serverName || 'a community') + ' · ' + visibility.label + ' · '
          + visibility.hint + ' · ' + items.length + (items.length === 1 ? ' item' : ' items')),
        list,
        controls);
    } catch (error) {
      clear(body);
      body.appendChild(failure(error, paint));
    }
  }

  function rename(found) {
    const name = el('input', {
      class: 'm-input', type: 'text', value: found.name, 'aria-label': 'The name of the collection',
    });
    const renameLayer = sheet({
      title: 'Rename this collection',
      body: el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Name'), name),
      footer: actions([
        primaryButton('Save', async () => {
          try {
            await updateCollection(found.id, { name: name.value.trim() });
            renameLayer.close();
            toast('Collection renamed.', { type: 'success' });
            paint();
            if (onChanged) onChanged();
          } catch (error) { toast(error.message, { type: 'danger' }); }
        }, { block: true }),
      ]),
    });
  }

  async function share(found) {
    const next = found.visibility === 'community' ? 'private' : 'community';
    const sure = await confirm({
      title: next === 'community' ? 'Share this collection?' : 'Make this collection private?',
      text: next === 'community'
        ? 'The members of ' + (found.serverName || 'the community') + ' will see the list.'
        : 'Only you will see this collection again.',
      confirmLabel: next === 'community' ? 'Share' : 'Make private',
    });
    if (!sure) return;
    try {
      await updateCollection(found.id, { visibility: next });
      toast(next === 'community' ? 'Shared with the community.' : 'Now private.', { type: 'success' });
      paint();
      if (onChanged) onChanged();
    } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function remove(found) {
    const sure = await confirm({
      title: 'Delete this collection?',
      text: 'The list goes. The messages, files and links in it stay where they are.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!sure) return;
    try {
      await removeCollection(found.id);
      layer.close();
      toast('Collection deleted.', { type: 'success' });
      if (onChanged) onChanged();
    } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  function addLink(found) {
    const address = el('input', {
      class: 'm-input', type: 'url', 'aria-label': 'The address of the link',
      placeholder: 'https://example.dev/article',
    });
    const title = el('input', { class: 'm-input', type: 'text', 'aria-label': 'The title of the link' });
    const linkLayer = sheet({
      title: 'Add a link',
      body: el('div', { class: 'm-stack' },
        el('label', { class: 'm-field' },
          el('span', { class: 'm-field__label' }, 'Address'), address),
        el('label', { class: 'm-field' },
          el('span', { class: 'm-field__label' }, 'Title'), title)),
      footer: actions([
        primaryButton('Save', async () => {
          try {
            await addCollectionItem(found.id, {
              itemType: 'link',
              itemRef: address.value.trim(),
              title: title.value.trim(),
            });
            linkLayer.close();
            toast('Link saved.', { type: 'success' });
            paint();
          } catch (error) { toast(error.message, { type: 'danger' }); }
        }, { block: true }),
      ]),
    });
  }

  paint();
  return layer;
}

export function renderCollections(ctx) {
  const list = el('div', { class: 'm-list' });
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Collections'),
      el('div', { class: 'm-hero__sub' }, 'The things you saved, and the ones your community saved with you.')),
    host);

  async function paint() {
    clear(list);
    list.appendChild(loading('Reading your collections'));
    try {
      const rows = await listCollections();
      const entries = Array.isArray(rows) ? rows : [];
      clear(list);
      if (!entries.length) {
        list.appendChild(empty({
          icon: 'folder',
          title: 'No collections yet',
          text: 'A collection is a named list you save things into.',
        }));
        return;
      }
      for (const entry of entries) {
        list.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: () => openCollection(entry, paint),
        },
        el('span', { class: 'm-row__lead' }, icon('folder', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, entry.name),
          el('span', { class: 'm-row__sub truncate' },
            (entry.serverName || 'a community') + ' · ' + visibilityOf(entry).label)),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
    } catch (error) {
      clear(list);
      list.appendChild(failure(error, paint));
    }
  }

  host.appendChild(section('Your collections', list, {
    action: el('button', {
      class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
      onClick: () => collectionForm(null, () => paint()),
    }, icon('plus', { size: 16 }), 'New'),
  }));

  return {
    node,
    head: { title: 'Collections' },
    onMount: paint,
  };
}

export default { renderCollections };
