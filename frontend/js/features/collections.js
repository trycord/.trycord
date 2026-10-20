// The collections screen.
//
// A collection is a named list of things the reader saved: a message, a file,
// a link. It belongs to a community, and it may be private to the reader or
// shared with that community's members.
//
// The list the server sends is the list the reader may see: their own
// collections, and the shared ones in the communities they belong to. The
// screen shows what came and offers the owner's controls only to the owner,
// so a shared collection somebody else made is read-only here.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State } from '../../packages/store.js';
import {
  listCollections, collection, updateCollection, removeCollection,
  addCollectionItem, removeCollectionItem, isOwner, visibilityOf,
} from '../../packages/personal.js';
import { head, card, row, blank, fault, fold, hold } from '../ui/page.js';
import { openDialog, confirmDialog, errorToast, toast } from '../ui/overlays.js';
import { relativeTime } from '../../packages/format.js';
import { collectionForm } from '../ui/collections.js';

const ITEM_GLYPH = { message: 'message', file: 'file', link: 'link' };

// One saved thing. What a collection holds is a reference, never a copy, so the
// row says what kind of thing it is and names it.
function itemRow(entry, collectionId, canEdit, onChanged) {
  const kind = String(entry.itemType || 'message');
  const title = entry.title
    || (kind === 'link' ? entry.itemRef : null)
    || (kind === 'file' ? 'A file' : 'A message');
  const sub = kind === 'link'
    ? 'Saved link'
    : kind === 'file' ? 'Saved file' : 'Saved message';

  const node = row({
    class: 'collection-item',
    lead: el('span', { class: 'collection-item-glyph' }, icon(ITEM_GLYPH[kind] || 'message', { size: 15 })),
    title,
    sub,
    meta: entry.createdAt ? relativeTime(entry.createdAt) : '',
    side: canEdit
      ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Remove ' + title + ' from this collection',
        onClick: async () => {
          try {
            await removeCollectionItem(collectionId, entry.id);
            toast('Removed from the collection');
            onChanged();
          } catch (error) { errorToast(error); }
        },
      }, 'Remove')
      : null,
  });

  if (kind === 'link' && entry.itemRef) {
    node.querySelector('.cardrow-title').replaceChildren(el('a', {
      class: 'collection-link', href: entry.itemRef,
      target: '_blank', rel: 'noreferrer noopener',
    }, title));
  }
  return node;
}

export function renderCollections(ctx) {
  const list = el('div', { class: 'rowlist collection-list' });
  const detail = el('div', { class: 'collection-detail' });
  const sideNote = el('p', { class: 'form-note', role: 'status', 'aria-live': 'polite' });

  let selectedId = (ctx.query && ctx.query.get('id')) || null;
  let entries = [];

  const me = State.user && State.user.id;

  function paintList() {
    list.replaceChildren(...(entries.length ? entries.map((entry) => row({
      class: 'collection-row' + (String(entry.id) === String(selectedId) ? ' cardrow--active' : ''),
      lead: el('span', { class: 'collection-item-glyph' }, icon('folder', { size: 15 })),
      title: entry.name,
      sub: (entry.serverName || 'a community') + ' · ' + visibilityOf(entry).label,
      meta: (entry.itemCount || 0) + (entry.itemCount === 1 ? ' item' : ' items'),
      onClick: () => { selectedId = entry.id; paintList(); paintDetail(); },
    })) : [blank({
      glyph: 'folder',
      title: 'No collections yet',
      text: 'A collection is a named list you save things into. Make one, then save a message or a link into it.',
    })]));
  }

  async function paintDetail() {
    if (!selectedId) {
      detail.replaceChildren(blank({
        glyph: 'folder',
        title: 'Nothing open',
        text: 'Choose a collection to see what is in it.',
      }));
      return;
    }
    detail.replaceChildren(hold('Reading the collection'));
    try {
      const found = await collection(selectedId);
      const mine = isOwner(found, me);
      const items = Array.isArray(found.items) ? found.items : [];
      const visibility = visibilityOf(found);

      detail.replaceChildren(fold([
        el('div', { class: 'collection-head' },
          el('div', { class: 'collection-head-main' },
            el('h2', { class: 'collection-title' }, found.name),
            el('p', { class: 'collection-meta' },
              (found.serverName || 'a community') + ' · ' + visibility.label + ' · '
              + visibility.hint + ' · ' + items.length + (items.length === 1 ? ' item' : ' items'))),
          mine ? el('div', { class: 'collection-head-actions' },
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => renameCollection(found),
            }, 'Rename'),
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => changeVisibility(found),
            }, found.visibility === 'community' ? 'Make private' : 'Share with the community'),
            el('button', {
              class: 'btn btn--danger btn--sm', type: 'button',
              onClick: () => deleteCollection(found),
            }, 'Delete')) : null),
        items.length
          ? el('div', { class: 'rowlist' }, items.map((entry) => itemRow(entry, found.id, mine, paintDetail)))
          : blank({
            glyph: 'inbox',
            title: 'Nothing in it yet',
            text: mine
              ? 'Save a message or a link into it from the conversation, or add a link here.'
              : 'The owner has not put anything in it yet.',
          }),
        mine ? el('div', { class: 'collection-add' },
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => addLink(found),
          }, icon('link', { size: 14 }), 'Add a link')) : null,
      ]));
    } catch (error) {
      detail.replaceChildren(fault(error, paintDetail));
    }
  }

  function renameCollection(found) {
    const name = el('input', {
      class: 'input', type: 'text', value: found.name, 'aria-label': 'The name of the collection',
    });
    const dialog = openDialog({
      title: 'Rename this collection',
      body: el('form', {
        class: 'fold', onSubmit: async (event) => {
          event.preventDefault();
          try {
            await updateCollection(found.id, { name: name.value.trim() });
            dialog.close();
            toast('Collection renamed');
            await load();
          } catch (error) { errorToast(error); }
        },
      }, name,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
    });
    name.focus();
  }

  async function changeVisibility(found) {
    const next = found.visibility === 'community' ? 'private' : 'community';
    const yes = await confirmDialog({
      title: next === 'community' ? 'Share this collection?' : 'Make this collection private?',
      body: next === 'community'
        ? 'The members of ' + (found.serverName || 'the community') + ' will see the list. The things in it keep their own permissions.'
        : 'Only you will see this collection again.',
      confirmLabel: next === 'community' ? 'Share' : 'Make private',
    });
    if (!yes) return;
    try {
      await updateCollection(found.id, { visibility: next });
      toast(next === 'community' ? 'Shared with the community' : 'Now private');
      await load();
      paintDetail();
    } catch (error) { errorToast(error); }
  }

  async function deleteCollection(found) {
    const yes = await confirmDialog({
      title: 'Delete this collection?',
      body: 'The list goes. The messages, files and links in it stay where they are.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await removeCollection(found.id);
      toast('Collection deleted');
      selectedId = null;
      await load();
      paintDetail();
    } catch (error) { errorToast(error); }
  }

  function addLink(found) {
    const address = el('input', {
      class: 'input', type: 'url', 'aria-label': 'The address of the link',
      placeholder: 'https://example.dev/article',
    });
    const title = el('input', { class: 'input', type: 'text', 'aria-label': 'The title of the link' });
    const dialog = openDialog({
      title: 'Add a link',
      body: el('form', {
        class: 'form-stack', onSubmit: async (event) => {
          event.preventDefault();
          try {
            await addCollectionItem(found.id, {
              itemType: 'link',
              itemRef: address.value.trim(),
              title: title.value.trim(),
            });
            dialog.close();
            toast('Link saved');
            paintDetail();
          } catch (error) { errorToast(error); }
        },
      },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Address'), address),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Title'), title),
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
    });
    address.focus();
  }

  async function load() {
    try {
      const rows = await listCollections();
      entries = Array.isArray(rows) ? rows : [];
      sideNote.textContent = entries.length + (entries.length === 1 ? ' collection' : ' collections');
      paintList();
      if (!selectedId && entries.length) selectedId = entries[0].id;
    } catch (error) {
      list.replaceChildren(fault(error, load));
    }
  }

  const node = fold([
    head({
      kicker: 'You',
      title: 'Collections',
      lede: 'The things you saved, and the ones your community saved with you.',
      actions: el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => collectionForm(null, () => load()),
      }, icon('plus', { size: 14 }), 'New collection'),
    }),
    sideNote,
    el('div', { class: 'collection-layout' },
      card({ label: 'Your collections', glyph: 'folder', flush: true, body: list }),
      card({ label: 'What is in it', glyph: 'inbox', flush: true, body: detail })),
  ]);

  return {
    node,
    onMount: async () => {
      await load();
      await paintDetail();
    },
    cleanup() {},
  };
}

export default { renderCollections };
