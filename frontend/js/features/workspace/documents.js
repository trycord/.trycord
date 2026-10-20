// The documents, on a desk.
//
// A document is a community page: a title and a body made of the same typed
// blocks the page editor stores. The vocabulary, the validation and the limits
// are the server's - the client refuses to write a body the server would
// refuse, and it says why before the write rather than after it.
//
// What a document adds over a page is the collaborative behaviour: a revision
// per save, a history that is never rewritten, comments anchored to the
// document, and links out of it.
//
// The save carries the revision it was written against. A save written against
// an older revision is refused by the server with the current revision in the
// answer, and the desk does not overwrite it silently: it shows the conflict
// and lets the author reload or replace on purpose.
//
// Writing a document needs MEMORIZE; commenting on one needs SEND_MESSAGES;
// acting on somebody else's comment needs MANAGE_MESSAGES.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, hold, memo } from '../../ui/page.js';
import { iconButton } from '../../ui/primitives.js';
import { openDialog, openMenu, confirmDialog, toast, errorToast } from '../../ui/overlays.js';
import { relativeTime } from '../../../packages/format.js';
import { path, navigate } from '../../../packages/nav.js';
import { State } from '../../../packages/store.js';
import { blockErrors, LIMITS } from '../pageSource.js';
import {
  Workspace, BLOCK_LABELS, mayWriteDocuments, mayPost, mayActOn,
  documentRoute,
} from '../../../packages/workspace.js';

// -- the list ------------------------------------------------------------------

export function documentsList(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rowlist' });
  const canWrite = mayWriteDocuments(serverId);

  const node = card({
    label: 'Documents',
    glyph: 'file',
    note: 'the community’s pages',
    actions: canWrite
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openNewDocument(serverId),
      }, icon('plus', { size: 14 }), 'New document')
      : null,
    body: host,
    flush: true,
  });

  const load = async () => {
    host.replaceChildren(hold('Reading the documents'));
    try {
      const documents = await Workspace.documents(serverId);
      host.replaceChildren(...(documents.length
        ? documents.map((document) => row({
          lead: el('span', { class: 'role-dot' }, icon('file', { size: 15 })),
          title: document.title,
          sub: 'revision ' + document.revision + ' · ' + relativeTime(document.updatedAt),
          href: path(documentRoute(serverId, document.id)),
          link: true,
        }))
        : [blank({
          glyph: 'file',
          title: 'No documents yet',
          text: 'A document is a page the community writes together.',
        })]));
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  return { node, onMount: load, cleanup() {} };
}

// -- one document ---------------------------------------------------------------

export function documentsDetail(ctx) {
  const serverId = ctx.serverId;
  const documentId = ctx.params.documentId;

  if (!documentId) {
    return {
      node: blank({
        glyph: 'file',
        title: 'No document open',
        text: 'Choose a document on the left to read it.',
      }),
      onMount: async () => {},
      cleanup() {},
    };
  }

  const canWrite = mayWriteDocuments(serverId);
  const canComment = mayPost(serverId);

  let doc = null;         // the document as the server last reported it
  let working = null;     // the copy being written: { title, blocks }
  let editing = false;
  let dirty = false;

  const title = el('h2', { class: 'pagehead-title' });
  const meta = el('div', { class: 'fold fold--tight' });
  const body = el('div', { class: 'fold' });
  const conflict = el('div', { class: 'fold fold--tight' });
  const history = el('div', { class: 'rowlist' });
  const comments = el('div', { class: 'rowlist' });
  const links = el('div', { class: 'rowlist' });

  const node = fold([
    conflict,
    card({
      label: 'The document',
      glyph: 'file',
      actions: el('span', { class: 'rowtools' },
        canWrite
          ? el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => (editing ? save() : startEditing()),
          }, icon(editing ? 'check' : 'edit', { size: 14 }), editing ? 'Save' : 'Edit')
          : null,
        canWrite && editing
          ? el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => stopEditing(),
          }, 'Cancel')
          : null),
      body: fold([title, meta, body], { tight: true }),
    }),
    card({ label: 'History', glyph: 'book', body: history, flush: true }),
    card({ label: 'Comments', glyph: 'message', body: comments, flush: true }),
    card({
      label: 'Links',
      glyph: 'link',
      actions: canWrite
        ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openLinkEditor(serverId, documentId, loadLinks),
        }, icon('plus', { size: 14 }), 'Add')
        : null,
      body: links,
      flush: true,
    }),
  ]);

  // -- reading -----------------------------------------------------------------

  const paintMeta = () => {
    meta.replaceChildren(
      el('p', { class: 'form-note' },
        'Revision ' + doc.revision + ' · ' + relativeTime(doc.updatedAt)
        + (dirty ? ' · unsaved changes in this browser' : '')),
    );
  };

  const paintBody = () => {
    if (editing) {
      body.replaceChildren(editor());
      return;
    }
    const blocks = doc.body || [];
    if (!blocks.length) {
      body.replaceChildren(blank({
        glyph: 'file',
        title: 'An empty document',
        text: canWrite ? 'Edit it to write the first block.' : 'Nobody has written it yet.',
      }));
      return;
    }
    body.replaceChildren(el('div', { class: 'fold' }, ...blocks.map((block) => blockNode(block))));
  };

  // -- writing -----------------------------------------------------------------

  const startEditing = () => {
    working = {
      title: doc.title,
      blocks: (doc.body || []).map((block) => Object.assign({}, block)),
    };
    editing = true;
    dirty = false;
    paintMeta();
    paintBody();
  };

  const stopEditing = () => {
    editing = false;
    working = null;
    dirty = false;
    paintMeta();
    paintBody();
  };

  const markDirty = () => {
    dirty = true;
    paintMeta();
  };

  const write = (index, changes) => {
    if (!working) return;
    working.blocks[index] = Object.assign({}, working.blocks[index], changes);
    markDirty();
  };

  const clearField = (index, field) => {
    if (!working) return;
    const next = Object.assign({}, working.blocks[index]);
    delete next[field];
    working.blocks[index] = next;
    markDirty();
  };

  const moveBlock = (index, delta) => {
    if (!working) return;
    const to = index + delta;
    if (to < 0 || to >= working.blocks.length) return;
    const list = working.blocks.slice();
    const [moved] = list.splice(index, 1);
    list.splice(to, 0, moved);
    working.blocks = list;
    markDirty();
    paintBody();
  };

  const removeBlock = (index) => {
    if (!working) return;
    working.blocks = working.blocks.filter((_, one) => one !== index);
    markDirty();
    paintBody();
  };

  const insertBlock = (block, at) => {
    if (!working) return;
    const list = working.blocks.slice();
    const index = at === undefined || at === null ? list.length : Math.max(0, Math.min(at, list.length));
    list.splice(index, 0, block);
    working.blocks = list;
    markDirty();
    paintBody();
  };

  // The problems the server would refuse, said the way the server says it.
  const problems = () => (working ? blockErrors(working.blocks) : []);

  // -- saving -------------------------------------------------------------------

  const showConflict = (error) => {
    const current = (error && error.details && error.details.currentRevision) || null;
    conflict.replaceChildren(memo({
      tone: 'warning',
      title: 'This document changed while you were writing it',
      text: current
        ? 'The server holds revision ' + current + '. Your work has not been saved.'
        : 'Your work has not been saved.',
      actions: el('span', { class: 'rowtools' },
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: async () => {
            conflict.replaceChildren();
            await load();
            stopEditing();
          },
        }, 'Reload from the server'),
        el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          onClick: () => save({ overwrite: true }),
        }, 'Replace it with mine')),
    }));
  };

  const save = async (options) => {
    const opts = options || {};
    if (!working) return;
    const faults = problems();
    if (faults.length) {
      toast(faults.map((fault) => fault.message).join(' · '), { type: 'error' });
      return;
    }
    try {
      const saved = await Workspace.saveDocument(serverId, documentId, {
        title: working.title,
        body: working.blocks,
        revision: doc.revision,
        overwrite: opts.overwrite === true,
      });
      doc = saved;
      working = { title: saved.title, blocks: (saved.body || []).map((block) => Object.assign({}, block)) };
      dirty = false;
      conflict.replaceChildren();
      paintMeta();
      paintBody();
      toast('Saved as revision ' + saved.revision);
      await loadHistory();
    } catch (error) {
      if (error && error.code === 'CONFLICT' && error.details) {
        showConflict(error);
        return;
      }
      errorToast(error);
    }
  };

  // -- the editor -----------------------------------------------------------------

  const editor = () => {
    const titleField = el('input', {
      class: 'input', type: 'text', maxlength: '128', 'aria-label': 'The title of the document',
    });
    titleField.value = working.title;
    titleField.addEventListener('input', () => {
      working.title = titleField.value;
      markDirty();
    });

    const blocks = working.blocks.map((block, index) => blockEditor(block, index));
    const problems_ = el('div', { class: 'fold fold--tight' });
    const paintProblems = () => {
      const faults = problems();
      problems_.replaceChildren(...(faults.length
        ? [memo({
          tone: 'danger',
          title: 'This document cannot be saved as it is',
          text: faults.map((fault) => (
            fault.index === -1 ? fault.message : 'Block ' + (fault.index + 1) + ': ' + fault.message
          )).join('\n'),
        })]
        : []));
    };
    paintProblems();

    const node = el('div', { class: 'fold' },
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Title'), titleField),
      problems_,
      ...blocks,
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: (event) => openBlockMenu(event, working.blocks.length),
      }, icon('plus', { size: 14 }), 'Add a block'));
    // The problems are repainted whenever the body changes, so the writer sees
    // the refusal before the write rather than after it.
    node.addEventListener('input', paintProblems);
    return node;
  };

  // One block, written. The fields are the ones the server reads, so a block
  // written here is a block the server will accept.
  const blockEditor = (block, index) => {
    const head = el('div', { class: 'pageblock-head' },
      el('span', { class: 'pageblock-kind' }, BLOCK_LABELS[block.type] || block.type),
      el('span', { class: 'rowtools' },
        iconButton('chevron-up', {
          label: 'Move this block up', class: 'icon-btn--sm',
          onClick: () => moveBlock(index, -1),
        }),
        iconButton('chevron-down', {
          label: 'Move this block down', class: 'icon-btn--sm',
          onClick: () => moveBlock(index, 1),
        }),
        iconButton('trash', {
          label: 'Remove this block', class: 'icon-btn--sm',
          onClick: () => removeBlock(index),
        })));

    const fields = el('div', { class: 'pageblock-body' });
    const node = el('div', { class: 'pageblock', 'data-block-type': block.type }, head, fields);

    const text = (value, options) => {
      const opts = options || {};
      const input = el(opts.multiline ? 'textarea' : 'input', {
        class: 'input', rows: opts.rows || null,
        placeholder: opts.placeholder || null,
        'aria-label': opts.label || 'Text',
      });
      input.value = value == null ? '' : String(value);
      input.addEventListener('input', () => write(index, { text: input.value }));
      return input;
    };

    switch (block.type) {
      case 'heading': {
        const level = el('select', { class: 'select', 'aria-label': 'The level of the heading' },
          el('option', { value: '2', selected: block.level !== 3 }, 'Heading'),
          el('option', { value: '3', selected: block.level === 3 }, 'Subheading'));
        level.addEventListener('change', () => write(index, { level: Number(level.value) }));
        fields.appendChild(el('div', { class: 'pageblock-row' }, level,
          text(block.text || '', { label: 'The text of the heading' })));
        break;
      }
      case 'lead':
        fields.appendChild(text(block.text || '', {
          multiline: true, rows: 2, label: 'The description under the title',
        }));
        break;
      case 'paragraph':
        fields.appendChild(text(block.text || '', { multiline: true, rows: 3, label: 'The text of the paragraph' }));
        break;
      case 'note': {
        const kind = el('select', { class: 'select', 'aria-label': 'The kind of the note' },
          el('option', { value: 'info', selected: block.kind !== 'warn' }, 'Note'),
          el('option', { value: 'warn', selected: block.kind === 'warn' }, 'Warning'));
        kind.addEventListener('change', () => write(index, { kind: kind.value }));
        fields.appendChild(el('div', { class: 'pageblock-row' }, kind,
          text(block.text || '', { multiline: true, rows: 2, label: 'The text of the note' })));
        break;
      }
      case 'list': {
        const ordered = el('input', {
          type: 'checkbox', 'aria-label': 'A numbered list', checked: block.ordered === true,
        });
        ordered.addEventListener('change', () => write(index, { ordered: ordered.checked }));
        const items = el('div', { class: 'pageblock-items' });
        (block.items || []).forEach((item, itemIndex) => {
          const value = el('input', {
            class: 'input', type: 'text', 'aria-label': 'Item ' + (itemIndex + 1) + ' of the list',
          });
          value.value = item == null ? '' : String(item);
          value.addEventListener('input', () => {
            const next = (working.blocks[index].items || []).slice();
            next[itemIndex] = value.value;
            write(index, { items: next });
          });
          items.appendChild(el('div', { class: 'pageblock-item' }, value,
            iconButton('x', {
              label: 'Remove item ' + (itemIndex + 1), class: 'icon-btn--sm',
              onClick: () => {
                const next = (working.blocks[index].items || []).filter((_, one) => one !== itemIndex);
                write(index, { items: next });
                paintBody();
              },
            })));
        });
        fields.appendChild(el('div', { class: 'pageblock-row' }, ordered));
        fields.appendChild(items);
        fields.appendChild(el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => {
            const next = (working.blocks[index].items || []).concat(['']);
            write(index, { items: next });
            paintBody();
          },
        }, icon('plus', { size: 14 }), 'Add item'));
        break;
      }
      case 'link': {
        const label = el('input', { class: 'input', type: 'text', 'aria-label': 'The text of the link' });
        label.value = block.text || '';
        label.addEventListener('input', () => write(index, { text: label.value }));
        const target = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Where the link points',
          placeholder: 'https://example.org/handbook',
        });
        target.value = block.href || '';
        target.addEventListener('input', () => write(index, { href: target.value }));
        fields.appendChild(el('div', { class: 'pageblock-row' }, label, target));
        break;
      }
      case 'image': {
        const source = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Where the picture is',
          placeholder: 'https://example.org/picture.png',
        });
        source.value = block.src || '';
        source.addEventListener('input', () => write(index, { src: source.value }));
        const alt = el('input', {
          class: 'input', type: 'text', 'aria-label': 'What the picture shows',
        });
        alt.value = block.alt || '';
        alt.addEventListener('input', () => write(index, { alt: alt.value }));
        const width = el('input', {
          class: 'input', type: 'number', min: '1', max: String(LIMITS.imageWidth),
          'aria-label': 'The width of the picture in pixels',
        });
        width.value = block.width == null ? '' : String(block.width);
        width.addEventListener('input', () => {
          const value = width.value.trim();
          if (!value) { clearField(index, 'width'); return; }
          write(index, { width: Number(value) });
        });
        fields.appendChild(el('div', { class: 'pageblock-row' }, source, width));
        fields.appendChild(alt);
        break;
      }
      case 'quote': {
        const quoted = el('textarea', { class: 'input', rows: '3', 'aria-label': 'The quotation' });
        quoted.value = block.text || '';
        quoted.addEventListener('input', () => write(index, { text: quoted.value }));
        const attribution = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Who said it',
        });
        attribution.value = block.attribution || '';
        attribution.addEventListener('input', () => write(index, { attribution: attribution.value }));
        fields.appendChild(quoted);
        fields.appendChild(attribution);
        break;
      }
      case 'code': {
        const code = el('textarea', {
          class: 'input', rows: '8', spellcheck: 'false', 'aria-label': 'The code',
        });
        code.value = block.text || '';
        code.addEventListener('input', () => write(index, { text: code.value }));
        const language = el('input', {
          class: 'input', type: 'text', 'aria-label': 'The language of the code', placeholder: 'javascript',
        });
        language.value = block.language || '';
        language.addEventListener('input', () => {
          const value = language.value.trim().toLowerCase();
          if (!value) { clearField(index, 'language'); return; }
          write(index, { language: value });
        });
        fields.appendChild(code);
        fields.appendChild(el('div', { class: 'pageblock-row' }, language));
        break;
      }
      case 'table': {
        const caption = el('input', { class: 'input', type: 'text', 'aria-label': 'The caption of the table' });
        caption.value = block.caption || '';
        caption.addEventListener('input', () => write(index, { caption: caption.value }));
        const headers = Array.isArray(block.headers) ? block.headers : [];
        const rows = Array.isArray(block.rows) ? block.rows : [];
        const grid = el('table', { class: 'pageblock-table' });
        const headingRow = el('tr');
        headers.forEach((heading, column) => {
          const field = el('input', {
            class: 'input', type: 'text', 'aria-label': 'Column ' + (column + 1) + ' heading',
          });
          field.value = heading == null ? '' : String(heading);
          field.addEventListener('input', () => {
            const next = (working.blocks[index].headers || []).slice();
            next[column] = field.value;
            write(index, { headers: next });
          });
          headingRow.appendChild(el('th', {}, field));
        });
        const toolsRow = el('tr');
        headers.forEach((heading, column) => {
          toolsRow.appendChild(el('th', {}, iconButton('x', {
            label: 'Remove column ' + (column + 1), class: 'icon-btn--sm',
            onClick: () => {
              const next = (working.blocks[index].headers || []).filter((_, one) => one !== column);
              const body = (working.blocks[index].rows || []).map((line) => (line || []).filter((_, one) => one !== column));
              write(index, { headers: next, rows: body });
              paintBody();
            },
          })));
        });
        grid.appendChild(el('thead', {}, headingRow, toolsRow));
        const bodyRows = el('tbody');
        rows.forEach((line, rowIndex) => {
          const tr = el('tr');
          (line || []).forEach((cell, column) => {
            const field = el('input', {
              class: 'input', type: 'text',
              'aria-label': 'Row ' + (rowIndex + 1) + ', column ' + (column + 1),
            });
            field.value = cell == null ? '' : String(cell);
            field.addEventListener('input', () => {
              const next = (working.blocks[index].rows || []).map((one) => (one || []).slice());
              next[rowIndex][column] = field.value;
              write(index, { rows: next });
            });
            tr.appendChild(el('td', {}, field));
          });
          bodyRows.appendChild(tr);
        });
        grid.appendChild(bodyRows);
        fields.appendChild(caption);
        fields.appendChild(grid);
        fields.appendChild(el('div', { class: 'pageblock-row' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => {
              const next = (working.blocks[index].headers || []).concat(['']);
              const body = (working.blocks[index].rows || []).map((line) => (line || []).concat(['']));
              write(index, { headers: next, rows: body });
              paintBody();
            },
          }, icon('plus', { size: 14 }), 'Add column'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => {
              const columns = Math.max(1, (working.blocks[index].headers || []).length);
              const next = (working.blocks[index].rows || []).concat([new Array(columns).fill('')]);
              write(index, { rows: next });
              paintBody();
            },
          }, icon('plus', { size: 14 }), 'Add row')));
        break;
      }
      case 'rule':
        fields.appendChild(el('p', { class: 'form-note' }, 'A line between two parts of the document.'));
        break;
      default:
        fields.appendChild(el('p', { class: 'field-error' },
          'Unknown block type: ' + (block.type || '(missing)')));
    }

    return node;
  };

  // The blocks a document may be made of. The same eleven the page editor
  // writes and the server accepts.
  const openBlockMenu = (event, at) => {
    const items = [
      { header: 'Add a block' },
      { label: 'Heading', icon: 'edit', onSelect: () => insertBlock({ type: 'heading', level: 2, text: '' }, at) },
      { label: 'Description', icon: 'info', onSelect: () => insertBlock({ type: 'lead', text: '' }, at) },
      { label: 'Paragraph', icon: 'file', onSelect: () => insertBlock({ type: 'paragraph', text: '' }, at) },
      { label: 'List', icon: 'list', onSelect: () => insertBlock({ type: 'list', ordered: false, items: [''] }, at) },
      { label: 'Note', icon: 'alert', onSelect: () => insertBlock({ type: 'note', kind: 'info', text: '' }, at) },
      { label: 'Link', icon: 'link', onSelect: () => insertBlock({ type: 'link', text: '', href: '' }, at) },
      { label: 'Image', icon: 'image', onSelect: () => insertBlock({ type: 'image', src: '', alt: '' }, at) },
      { label: 'Quotation', icon: 'chat', onSelect: () => insertBlock({ type: 'quote', text: '' }, at) },
      { label: 'Code', icon: 'code', onSelect: () => insertBlock({ type: 'code', text: '' }, at) },
      { label: 'Table', icon: 'grid', onSelect: () => insertBlock({ type: 'table', headers: [''], rows: [['']] }, at) },
      { label: 'Rule', icon: 'slash', onSelect: () => insertBlock({ type: 'rule' }, at) },
    ];
    openMenu({ anchor: event.currentTarget, items });
  };

  // -- the history ---------------------------------------------------------------

  const loadHistory = async () => {
    history.replaceChildren(hold('Reading the history'));
    try {
      const revisions = await Workspace.documentRevisions(serverId, documentId, 25);
      history.replaceChildren(...(revisions.length
        ? revisions.map((revision, index) => row({
          title: 'Revision ' + revision.revision,
          sub: relativeTime(revision.createdAt) + (revision.authorId ? ' · by ' + revision.authorId : ''),
          meta: revision.title,
          side: el('span', { class: 'rowtools' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Compare revision ' + revision.revision + ' with the one before it',
              disabled: index === revisions.length - 1 ? true : null,
              onClick: () => compare(revision.revision, revisions[index + 1].revision),
            }, 'Compare'),
            canWrite
              ? el('button', {
                class: 'btn btn--ghost btn--sm', type: 'button',
                'aria-label': 'Restore revision ' + revision.revision,
                onClick: () => restore(revision.revision),
              }, 'Restore')
              : null),
        }))
        : [blank({ glyph: 'book', title: 'No history yet', text: 'Every save is recorded here.' })]));
    } catch (error) {
      history.replaceChildren(fold([fault(error, loadHistory)]));
    }
  };

  // What changed between two revisions. The server holds the revisions and
  // knows the block model, so the desk asks it and shows the report.
  const compare = async (from, to) => {
    const report = el('div', { class: 'pagediff' });
    const dialog = openDialog({
      title: 'Revision ' + from + ' and revision ' + to,
      sub: 'What the server says changed between them.',
      wide: true,
      body: report,
    });
    report.replaceChildren(hold('Asking what changed'));
    try {
      const answer = await Workspace.compareDocument(serverId, documentId, from, to);
      const changes = answer && answer.changes ? answer.changes : [];
      report.replaceChildren(
        el('p', { class: 'form-note' },
          (answer && answer.titleChanged ? 'The title changed. ' : '')
          + changes.length + ' block' + (changes.length === 1 ? '' : 's') + ' differ.'),
        ...changes.map((change) => el('p', { class: 'pagediff-line pagediff-line--' + markFor(change.change) },
          el('span', { class: 'pagediff-mark' }, markFor(change.change)),
          el('span', { class: 'pagediff-text' },
            plainBlock(change.before) + ' → ' + plainBlock(change.after)))),
      );
    } catch (error) {
      report.replaceChildren(fold([fault(error, () => compare(from, to))]));
    }
  };

  const markFor = (change) => (change === 'added' ? 'added' : (change === 'removed' ? 'removed' : 'changed'));

  const restore = async (revision) => {
    const yes = await confirmDialog({
      title: 'Restore revision ' + revision + '?',
      body: 'It becomes the current document as a new revision. Nothing is deleted: '
        + 'the revision stays in the history.',
      confirmLabel: 'Restore',
    });
    if (!yes) return;
    try {
      doc = await Workspace.restoreDocument(serverId, documentId, revision);
      working = { title: doc.title, blocks: (doc.body || []).map((block) => Object.assign({}, block)) };
      editing = false;
      dirty = false;
      conflict.replaceChildren();
      paintMeta();
      paintBody();
      toast('Revision ' + revision + ' is the document now');
      await loadHistory();
    } catch (error) {
      if (error && error.code === 'CONFLICT' && error.details) { showConflict(error); return; }
      errorToast(error);
    }
  };

  // -- the comments ---------------------------------------------------------------

  const loadComments = async () => {
    comments.replaceChildren(hold('Reading the comments'));
    try {
      const rows = await Workspace.documentComments(serverId, documentId);
      const me = State.user && State.user.id;
      const drawn = (rows.length
        ? rows.map((entry) => row({
          lead: el('span', { class: 'role-dot' }, icon('message', { size: 15 })),
          title: entry.body,
          sub: relativeTime(entry.createdAt) + (entry.resolvedAt ? ' · resolved' : ''),
          meta: entry.resolvedAt ? el('span', { class: 'chip chip--on' }, 'resolved') : null,
          side: mayActOn(serverId, entry.authorId, me)
            ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': (entry.resolvedAt ? 'Reopen' : 'Resolve') + ' this comment',
              onClick: () => resolve(entry),
            }, entry.resolvedAt ? 'Reopen' : 'Resolve')
            : null,
        }))
        : [blank({
          glyph: 'message',
          title: 'No comments yet',
          text: canComment ? 'A comment says what is missing or what is wrong.' : 'Nobody has commented yet.',
        })]);
      // A null child would be drawn as the word "null", so the comment box is
      // added only when there is one.
      comments.replaceChildren(...drawn);
      if (canComment) comments.appendChild(commentBox());
    } catch (error) {
      comments.replaceChildren(fold([fault(error, loadComments)]));
    }
  };

  const commentBox = () => {
    const field = el('textarea', {
      class: 'input', rows: '2', maxlength: '4000', 'aria-label': 'Your comment',
      placeholder: 'What is missing, or what is wrong?',
    });
    const button = el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      onClick: async () => {
        const text = field.value.trim();
        if (!text) { field.focus(); return; }
        button.disabled = true;
        try {
          await Workspace.addDocumentComment(serverId, documentId, { body: text });
          field.value = '';
          toast('Comment added');
          await loadComments();
        } catch (error) {
          errorToast(error);
        } finally {
          button.disabled = false;
        }
      },
    }, 'Comment');
    return el('div', { class: 'fold fold--tight' }, field, button);
  };

  const resolve = async (entry) => {
    try {
      await Workspace.resolveDocumentComment(serverId, documentId, entry.id, !entry.resolvedAt);
      await loadComments();
    } catch (error) {
      errorToast(error);
    }
  };

  // -- the links -------------------------------------------------------------------

  const loadLinks = async () => {
    links.replaceChildren(hold('Reading the links'));
    try {
      const rows = await Workspace.documentLinks(serverId, documentId);
      links.replaceChildren(...(rows.length
        ? rows.map((entry) => {
          const href = entry.kind === 'url'
            ? entry.url
            : (entry.targetId ? path(documentRoute(serverId, entry.targetId)) : null);
          const node = row({
            lead: el('span', { class: 'role-dot' }, icon(entry.kind === 'url' ? 'external' : 'file', { size: 15 })),
            title: entry.label || (entry.kind === 'url' ? entry.url : 'Another document'),
            sub: entry.kind === 'url' ? entry.url : 'A document in this community',
            href: href,
            link: href ? true : null,
          });
          if (entry.kind === 'url') {
            const anchor = node.querySelector('a');
            if (anchor) {
              anchor.target = '_blank';
              anchor.rel = 'noreferrer noopener';
            }
          }
          return node;
        })
        : [blank({
          glyph: 'link',
          title: 'No links yet',
          text: 'A link points at another document or at a place on the web.',
        })]));
    } catch (error) {
      links.replaceChildren(fold([fault(error, loadLinks)]));
    }
  };

  // -- the whole document -----------------------------------------------------------

  const load = async () => {
    body.replaceChildren(hold('Opening the document'));
    try {
      doc = await Workspace.document(serverId, documentId);
      title.textContent = doc.title;
      paintMeta();
      paintBody();
    } catch (error) {
      body.replaceChildren(fold([fault(error, load)]));
    }
  };

  return {
    node,
    onMount: async () => {
      await load();
      await loadHistory();
      await loadComments();
      await loadLinks();
    },
    cleanup() {},
  };
}

// -- reading a body -----------------------------------------------------------------

// One block, read. The blocks are the whole vocabulary of a document, so each
// one is drawn as itself rather than as markup the client invented.
export function blockNode(block) {
  switch (block.type) {
    case 'heading':
      return el(block.level === 3 ? 'h3' : 'h2', {}, block.text);
    case 'lead':
      return el('p', { class: 'lede' }, block.text);
    case 'paragraph':
      return el('p', {}, block.text);
    case 'list':
      return el(block.ordered ? 'ol' : 'ul', {},
        ...(block.items || []).map((item) => el('li', {}, item)));
    case 'note':
      return el('div', { class: 'draft-note', role: 'note' }, block.text);
    case 'link':
      return el('p', {}, el('a', { href: block.href }, block.text || block.href));
    case 'rule':
      return el('hr', {});
    case 'image':
      return el('figure', { class: 'page-image' },
        el('img', {
          src: block.src, alt: block.alt || '',
          width: block.width || null, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
        }));
    case 'quote':
      return el('blockquote', {},
        el('p', {}, block.text),
        block.attribution ? el('footer', { class: 'page-quote-source' }, block.attribution) : null);
    case 'code':
      // The language of a code block is carried as data rather than as a class:
      // it is a word the writer chose, and the stylesheet has no rule for it.
      return el('pre', { class: 'page-code' },
        el('code', block.language ? { 'data-language': block.language } : {}, block.text));
    case 'table':
      return el('table', { class: 'page-table' },
        block.caption ? el('caption', {}, block.caption) : null,
        el('thead', {}, el('tr', {}, ...(block.headers || []).map((heading) => el('th', { scope: 'col' }, heading)))),
        el('tbody', {}, ...(block.rows || []).map((line) => el('tr', {},
          ...(line || []).map((cell) => el('td', {}, cell))))));
    default:
      return el('p', { class: 'field-error' }, 'Unknown block type: ' + (block.type || '(missing)'));
  }
}

// A block, as a line of text. Used where two blocks are shown side by side -
// in a comparison - and where the shape of the block is not the point.
export function plainBlock(block) {
  if (!block) return '';
  switch (block.type) {
    case 'heading':
    case 'lead':
    case 'paragraph':
    case 'note':
    case 'quote':
    case 'code':
      return String(block.text || '');
    case 'list':
      return (block.items || []).join(' · ');
    case 'link':
      return String(block.text || block.href || '');
    case 'image':
      return String(block.alt || block.src || '');
    case 'table':
      return (block.headers || []).join(' · ');
    case 'rule':
      return '—';
    default:
      return '';
  }
}

// -- the editors -----------------------------------------------------------------------

// A document made from nothing but a title.
function openNewDocument(serverId) {
  const title = el('input', {
    class: 'input', type: 'text', maxlength: '128', 'aria-label': 'The title of the document',
    placeholder: 'How this community works',
  });
  const error = el('p', { class: 'form-error', hidden: true });
  const dialog = openDialog({
    title: 'New document',
    sub: 'The body is written after the document exists.',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        const name = title.value.trim();
        if (!name) { error.hidden = false; error.textContent = 'Give the document a title.'; return; }
        try {
          const created = await Workspace.createDocument(serverId, { title: name, body: [] });
          toast('The document is made');
          dialog.close();
          navigate(documentRoute(serverId, created.id));
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The document could not be made.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Title'), title),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Create')),
  });
  title.focus();
}

// A link out of the document: another document in this community, or a place on
// the web that the member opens themselves.
function openLinkEditor(serverId, documentId, onDone) {
  const kind = el('select', { class: 'select', 'aria-label': 'What kind of link' },
    el('option', { value: 'document' }, 'Another document'),
    el('option', { value: 'url' }, 'A place on the web'));
  const target = el('select', { class: 'select', 'aria-label': 'The document to link to' });
  const url = el('input', {
    class: 'input', type: 'url', 'aria-label': 'The address', placeholder: 'https://example.org/handbook',
  });
  const label = el('input', { class: 'input', type: 'text', maxlength: '255', 'aria-label': 'The name of the link' });
  const error = el('p', { class: 'form-error', hidden: true });

  const paint = () => {
    url.hidden = kind.value !== 'url';
    target.hidden = kind.value !== 'document';
  };
  kind.addEventListener('change', paint);
  paint();

  const dialog = openDialog({
    title: 'Add a link',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        const body = { kind: kind.value, label: label.value.trim() };
        if (kind.value === 'url') {
          if (!url.value.trim()) { error.hidden = false; error.textContent = 'Give the link an address.'; return; }
          body.url = url.value.trim();
        } else {
          if (!target.value) { error.hidden = false; error.textContent = 'Choose a document.'; return; }
          body.targetId = target.value;
        }
        try {
          await Workspace.addDocumentLink(serverId, documentId, body);
          toast('Link added');
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message) || 'The link could not be added.';
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Kind'), kind),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Document'), target),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Address'), url),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), label),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Add')),
  });

  (async () => {
    try {
      const documents = await Workspace.documents(serverId);
      for (const document of documents || []) {
        if (document.id === documentId) continue;
        target.appendChild(el('option', { value: document.id }, document.title));
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'The documents could not be read.';
    }
  })();
}

export default { documentsList, documentsDetail, blockNode, plainBlock };
