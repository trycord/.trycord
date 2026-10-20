// What the reader keeps, on a phone.
//
// The templates they insert into a message, and the collections they save
// things into. Both belong to the reader: the server answers the lists from
// the owner, and the phone shows what came.
//
// A phone has no room for a dialog in the middle of the screen, so both the
// template picker and the collection picker are sheets that come up from the
// edge a thumb can reach.

import { el, clear } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State } from '../../packages/store.js';
import {
  listTemplates, createTemplate, removeTemplate, expandShortcut,
  listCollections, addCollectionItem, SHORTCUT_MARK,
} from '../../packages/personal.js';
import { empty, loading, failure, iconButton } from './components.js';
import { sheet, confirm, toast } from './ui.js';

let cache = null;

// The reader's templates, read once and kept for this session.
export function templates() {
  if (!cache) {
    cache = listTemplates().then((rows) => (Array.isArray(rows) ? rows : []));
  }
  return cache;
}

export function forgetTemplates() {
  cache = null;
}

// Expand the shortcut at the end of a draft, if there is one.
export async function expandInDraft(draft) {
  const rows = await templates().catch(() => []);
  return expandShortcut(draft, rows);
}

// The form that makes a template.
function templateForm(onSaved) {
  const name = el('input', { class: 'm-input', type: 'text', 'aria-label': 'The name of the template', placeholder: 'Greeting' });
  const body = el('textarea', { class: 'm-input m-input--area', rows: '4', 'aria-label': 'The text of the template', placeholder: 'Hello - glad to be here.' });
  const shortcut = el('input', { class: 'm-input', type: 'text', 'aria-label': 'The shortcut that inserts it', placeholder: 'greet' });

  const layer = sheet({
    title: 'New template',
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'Type ' + SHORTCUT_MARK + ' and the shortcut in the composer to insert it.'),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Name'), name),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Text'), body),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Shortcut'), shortcut)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async () => {
        if (!name.value.trim() || !body.value.trim()) {
          toast('A template needs a name and some text.', { type: 'danger' });
          return;
        }
        try {
          await createTemplate({
            name: name.value.trim(),
            body: body.value,
            shortcut: shortcut.value.trim(),
          });
          forgetTemplates();
          layer.close();
          toast('Template saved.', { type: 'success' });
          if (onSaved) onSaved();
        } catch (error) { toast(error.message, { type: 'danger' }); }
      },
    }, 'Save'),
  });
  return layer;
}

// The picker: the reader's templates, and the ways to use them.
export function templateSheet(onPick) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({
    title: 'Templates',
    body,
  });

  async function paint() {
    clear(body);
    body.appendChild(loading('Reading your templates'));
    try {
      const rows = await templates();
      clear(body);
      if (!rows.length) {
        body.appendChild(empty({
          icon: 'zap',
          title: 'You have no templates yet',
          text: 'One is a piece of text you insert often.',
        }));
      } else {
        const list = el('div', { class: 'm-list' });
        for (const entry of rows) {
          list.appendChild(el('div', { class: 'm-row' },
            el('button', {
              class: 'm-row__body m-row__body--button', type: 'button',
              onClick: () => {
                layer.close();
                if (onPick) onPick(entry);
              },
            },
            el('span', { class: 'm-row__title' }, entry.name),
            el('span', { class: 'm-row__sub truncate' },
              entry.shortcut ? SHORTCUT_MARK + entry.shortcut + ' · ' : ''
              + String(entry.body || '').slice(0, 80))),
            el('span', { class: 'm-row__actions' },
              iconButton('trash', 'Remove the template ' + entry.name, async () => {
                const sure = await confirm({
                  title: 'Remove this template?',
                  text: entry.name + ' goes, and the shortcut stops answering.',
                  confirmLabel: 'Remove',
                  danger: true,
                });
                if (!sure) return;
                try {
                  await removeTemplate(entry.id);
                  forgetTemplates();
                  paint();
                } catch (error) { toast(error.message, { type: 'danger' }); }
              }))));
        }
        body.appendChild(list);
      }
      body.appendChild(el('button', {
        class: 'm-btn m-btn--block m-btn--ghost', type: 'button',
        onClick: () => templateForm(paint),
      }, icon('plus', { size: 18 }), 'New template'));
    } catch (error) {
      clear(body);
      body.appendChild(failure(error, paint));
    }
  }

  paint();
  return layer;
}

// The picker: which collection does this go into.
//
// The item is described, not carried: a message is named by its id, a link by
// its address. Nothing but the reference crosses.
export function collectionSheet(serverId, item) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({
    title: 'Save into a collection',
    body,
  });

  listCollections().then((rows) => {
    const me = State.user && State.user.id;
    const collections = (Array.isArray(rows) ? rows : [])
      .filter((entry) => String(entry.serverId) === String(serverId)
        && String(entry.ownerId) === String(me));
    clear(body);
    if (!collections.length) {
      body.appendChild(empty({
        icon: 'folder',
        title: 'You have no collection in this community yet',
        text: 'Make one on the collections screen, then save into it.',
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const entry of collections) {
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: async () => {
          try {
            await addCollectionItem(entry.id, item);
            layer.close();
            toast('Saved into ' + entry.name + '.', { type: 'success' });
          } catch (error) { toast(error.message, { type: 'danger' }); }
        },
      },
      el('span', { class: 'm-row__lead' }, icon('folder', { size: 18 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, entry.name),
        el('span', { class: 'm-row__sub' }, entry.visibility === 'community'
          ? 'Shared with the community' : 'Private'))));
    }
    body.appendChild(list);
  }).catch((error) => {
    clear(body);
    body.appendChild(failure(error, () => collectionSheet(serverId, item)));
  });

  return layer;
}

export default { templates, forgetTemplates, expandInDraft, templateSheet, collectionSheet };
