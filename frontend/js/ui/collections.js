// Saving things into collections.
//
// A collection belongs to a community, and sharing it is with that community:
// a private collection is the reader's alone, a shared one is visible to the
// members of the community it belongs to. The server decides that, and the
// client asks for the list rather than deciding who may see what.
//
// The two dialogs here are the ones the reader meets: the picker that says
// which collection something goes into, and the form that makes a collection.
// Both are used by the collections screen and by the message menu, so there is
// one implementation of each.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State } from '../../packages/store.js';
import { listCollections, createCollection, addCollectionItem } from '../../packages/personal.js';
import { openDialog, errorToast, toast } from './overlays.js';

// The reader's own collections in one community. A shared collection somebody
// else made is visible but not writable, so it is not offered here.
export async function ownCollectionsIn(serverId) {
  const rows = await listCollections();
  const collections = Array.isArray(rows) ? rows : [];
  const me = State.user && State.user.id;
  return collections.filter((entry) => String(entry.serverId) === String(serverId)
    && String(entry.ownerId) === String(me));
}

// The picker: which collection does this go into.
//
// The item is described, not carried: a message is named by its id, a link by
// its address. Nothing but the reference crosses.
export function saveToCollection(serverId, item) {
  const list = el('div', { class: 'rowlist' });
  const status = el('p', { class: 'form-note', role: 'status', 'aria-live': 'polite' });

  const dialog = openDialog({
    title: 'Save into a collection',
    body: el('div', { class: 'fold' }, status, list),
  });

  async function paint() {
    list.replaceChildren(el('p', { class: 'holdline' }, 'Reading your collections'));
    try {
      const collections = await ownCollectionsIn(serverId);
      if (!collections.length) {
        list.replaceChildren(el('p', { class: 'form-note' },
          'You have no collection in this community yet.'));
        return;
      }
      list.replaceChildren(...collections.map((entry) => el('button', {
        class: 'cardrow cardrow--link collection-pick', type: 'button',
        'aria-label': 'Save into ' + entry.name,
        onClick: async () => {
          try {
            await addCollectionItem(entry.id, item);
            dialog.close();
            toast('Saved into ' + entry.name);
          } catch (error) { errorToast(error); }
        },
      },
      el('span', { class: 'cardrow-main' },
        el('span', { class: 'cardrow-title' }, entry.name),
        el('span', { class: 'cardrow-sub' }, entry.visibility === 'community'
          ? 'Shared with the community'
          : 'Private')),
      el('span', { class: 'cardrow-side' }, icon('arrow-right', { size: 14 })))));
    } catch (error) {
      list.replaceChildren(el('p', { class: 'form-error' },
        (error && error.message) || 'The collections could not be read.'));
    }
  }

  paint();
  return dialog;
}

// The form that makes a collection.
//
// A collection belongs to a community, so the community is chosen here rather
// than assumed, and sharing is a choice the reader makes on purpose.
export function collectionForm(serverId, onSaved) {
  const name = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The name of the collection',
    placeholder: 'Reading for later',
  });
  const community = el('select', { class: 'input', 'aria-label': 'The community this collection belongs to' });
  const communities = State.servers || [];
  for (const server of communities) {
    community.appendChild(el('option', {
      value: server.id,
      selected: String(server.id) === String(serverId) ? true : null,
    }, server.name));
  }
  if (!communities.length) {
    community.appendChild(el('option', { value: '' }, 'No communities'));
  }

  const visibility = el('select', { class: 'input', 'aria-label': 'Who can see this collection' });
  visibility.appendChild(el('option', { value: 'private' }, 'Private - only you'));
  visibility.appendChild(el('option', { value: 'community' }, 'Shared - the members of the community'));

  const dialog = openDialog({
    title: 'New collection',
    body: el('form', {
      class: 'fold', onSubmit: async (event) => {
        event.preventDefault();
        const where = community.value || serverId;
        if (!where) { errorToast(new Error('A collection belongs to a community.')); return; }
        try {
          const made = await createCollection({
            serverId: where,
            name: name.value.trim(),
            visibility: visibility.value,
          });
          dialog.close();
          toast('Collection created');
          if (onSaved) onSaved(made);
        } catch (error) { errorToast(error); }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Community'), community),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Visibility'), visibility),
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Create')),
  });
  name.focus();
  return dialog;
}

export default { ownCollectionsIn, saveToCollection, collectionForm };
