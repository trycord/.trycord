// The reader's message templates.
//
// A template is a named piece of text the reader inserts into a message, and
// a shortcut is the short form they type to insert it: "!greet" and the
// template's text is there.
//
// The picker lists the reader's own templates, because the server answers the
// list from the owner and nobody else. It is also where a template is made,
// because a template the reader cannot write is a template they cannot use.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import {
  listTemplates, createTemplate, removeTemplate, expandShortcut, SHORTCUT_MARK,
} from '../../packages/personal.js';
import { openDialog, confirmDialog, errorToast, toast } from './overlays.js';

let cache = null;

// The reader's templates, read once and kept. The list belongs to the reader
// alone, so it is the same list everywhere in this session.
export function templates() {
  if (!cache) {
    cache = listTemplates().then((rows) => (Array.isArray(rows) ? rows : []));
  }
  return cache;
}

// The list is thrown away when the reader changes it, so the next reader of it
// sees the change.
export function forgetTemplates() {
  cache = null;
}

// The form that makes a template.
function templateForm(onSaved) {
  const name = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The name of the template',
    placeholder: 'Greeting',
  });
  const body = el('textarea', {
    class: 'textarea', rows: '4', 'aria-label': 'The text of the template',
    placeholder: 'Hello - glad to be here.',
  });
  const shortcut = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The shortcut that inserts it',
    placeholder: 'greet',
  });
  const note = el('p', { class: 'form-note', role: 'status', 'aria-live': 'polite' });

  const dialog = openDialog({
    title: 'New template',
    sub: 'Type ' + SHORTCUT_MARK + ' and the shortcut in the composer to insert it.',
    body: el('form', {
      class: 'form-stack', onSubmit: async (event) => {
        event.preventDefault();
        if (!name.value.trim() || !body.value.trim()) {
          note.textContent = 'A template needs a name and some text.';
          return;
        }
        try {
          await createTemplate({
            name: name.value.trim(),
            body: body.value,
            shortcut: shortcut.value.trim(),
          });
          forgetTemplates();
          dialog.close();
          toast('Template saved');
          if (onSaved) onSaved();
        } catch (error) { errorToast(error); }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Text'), body),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Shortcut'), shortcut),
    note,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
  });
  name.focus();
  return dialog;
}

// The picker: the reader's templates, and the ways to use them.
//
// Inserting puts the text in the composer; removing is the reader's own
// template going away, which the server refuses for anybody else's.
export function templatePicker(onPick) {
  const list = el('div', { class: 'rowlist template-list' });
  const dialog = openDialog({
    title: 'Templates',
    sub: 'Type ' + SHORTCUT_MARK + ' and the shortcut in the composer to insert one.',
    body: el('div', { class: 'fold' }, list),
  });

  async function paint() {
    list.replaceChildren(el('p', { class: 'holdline', 'aria-busy': 'true' }, 'Reading your templates'));
    try {
      const rows = await templates();
      list.replaceChildren(...(rows.length ? rows.map((entry) => el('div', { class: 'template-item' },
        el('div', { class: 'template-item-main' },
          el('span', { class: 'template-item-name' }, entry.name),
          entry.shortcut ? el('span', { class: 'template-item-shortcut' },
            SHORTCUT_MARK + entry.shortcut) : null,
          el('span', { class: 'template-item-body' }, String(entry.body || '').slice(0, 160))),
        el('div', { class: 'template-item-actions' },
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            'aria-label': 'Insert the template ' + entry.name,
            onClick: () => {
              dialog.close();
              if (onPick) onPick(entry);
            },
          }, 'Insert'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Remove the template ' + entry.name,
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Remove this template?',
                body: entry.name + ' goes, and the shortcut stops answering.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!yes) return;
              try {
                await removeTemplate(entry.id);
                forgetTemplates();
                paint();
              } catch (error) { errorToast(error); }
            },
          }, 'Remove')))) : [el('p', { class: 'form-note' },
        'You have no templates yet. One is a piece of text you insert often.')],
      ));
      list.appendChild(el('div', { class: 'formfoot' },
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => templateForm(paint),
        }, icon('plus', { size: 14 }), 'New template')));
    } catch (error) {
      list.replaceChildren(el('p', { class: 'form-error' },
        (error && error.message) || 'The templates could not be read.'));
    }
  }

  paint();
  return dialog;
}

// Expand the shortcut at the end of a draft, if there is one.
//
// The templates are read once and kept, so the expansion does not cost a
// request on every keystroke.
export async function expandInDraft(draft) {
  const rows = await templates().catch(() => []);
  return expandShortcut(draft, rows);
}

export default { templates, forgetTemplates, templatePicker, templateForm, expandInDraft };
