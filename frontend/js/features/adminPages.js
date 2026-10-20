// Admin: the page editor.
//
// The public pages this instance serves, written in one place. A page body is
// a list of typed blocks, and this editor writes that list two ways: as
// blocks, and as source text. The two are the same model, so an operator can
// move between them without the page changing underneath them.
//
// Everything here is one editor rather than a set of screens, because the work
// is one act: write a page, see how it reads, keep it, publish it, and be
// able to go back to how it was. The list of pages, the two modes, the
// reusable blocks, the history, the preview and the publish controls are
// parts of that act.
//
// The server is the authority on what a page may contain and who may change
// it. This editor does not pretend otherwise: it refuses to write a body the
// server would refuse, it says when a page has moved on the server since it
// was opened, and it never shows a control the reader's own account cannot
// use.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api, { request } from '../../packages/api.js';
import { State } from '../../packages/store.js';
import { head, card, row, blank, fault, fold, facts, hold, memo } from '../ui/page.js';
import { errorToast, toast, confirmDialog, openDialog, openMenu } from '../ui/overlays.js';
import { iconButton } from '../ui/primitives.js';
import {
  sourceToBlocks, blocksToSource, blockErrors, blockToSource, linkProblem,
  imageProblem, languageProblem, LIMITS,
} from './pageSource.js';

// -- reusable blocks ----------------------------------------------------------
//
// A reusable block is one that can stand in more than one page: the contact
// details at the foot of every policy, the standard note about moderation.
//
// The library is on the server. A block that lives in one browser cannot be
// shared with the person at the next desk, and a block that two administrators
// of the same instance cannot both use is not a shared block.
//
// A page holds the content of a block rather than a reference to it. Inserting
// a block copies its blocks into the page, so a later change to the library
// cannot change a page that has already been published and read.
//
// These four calls are not in the shared API surface, so they are made here.

const libraryPath = '/api/admin/pages/blocks';

const libraryList = () => request('GET', libraryPath);
const libraryWrite = (body) => request('POST', libraryPath, { body });
const libraryRename = (id, body) => request('PUT', libraryPath + '/' + encodeURIComponent(id), { body });
const libraryRemove = (id) => request('DELETE', libraryPath + '/' + encodeURIComponent(id));

// -- the preview --------------------------------------------------------------
//
// The preview is rendered by the server, through the same renderer a
// published page goes through, so what an operator sees is what a visitor
// gets. The HTML is parsed rather than assigned, and anything that could
// execute is dropped on the way in: a page body is text, and no part of it
// should ever be able to run.

function renderServerHtml(host, html) {
  const parsed = new DOMParser().parseFromString('<div>' + String(html || '') + '</div>', 'text/html');
  const root = parsed.body.firstElementChild;
  if (!root) { host.replaceChildren(); return; }
  for (const node of Array.from(root.querySelectorAll('script'))) node.remove();
  for (const node of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^\s*(javascript|data):/i.test(href)) node.removeAttribute('href');
    }
  }
  host.replaceChildren(...Array.from(root.childNodes));
}

// -- the comparison -----------------------------------------------------------
//
// What changed between two revisions. The server keeps the body of every
// revision and answers what was added, what was removed and what was
// rewritten, because how two revisions are shown is the client's decision and
// a server that answered with markup would be deciding it for everybody.

// What the server says changed, as lines an operator can read. A block is
// shown as the source writes it, which is text and never markup.
function comparisonLines(report) {
  const answer = report || {};
  const summary = answer.summary || {};
  const lines = [el('p', { class: 'form-note' },
    (summary.added || 0) + ' added, ' + (summary.removed || 0) + ' removed, '
    + (summary.changed || 0) + ' changed, ' + (summary.unchanged || 0) + ' unchanged'
    + (answer.titleChanged ? ' · the title changed' : ''))];
  for (const entry of answer.added || []) {
    lines.push(el('p', { class: 'pagediff-line pagediff-line--added' },
      el('span', { class: 'pagediff-mark' }, '+'),
      el('span', { class: 'pagediff-text' }, blockToSource(entry.block))));
  }
  for (const entry of answer.removed || []) {
    lines.push(el('p', { class: 'pagediff-line pagediff-line--removed' },
      el('span', { class: 'pagediff-mark' }, '−'),
      el('span', { class: 'pagediff-text' }, blockToSource(entry.block))));
  }
  for (const entry of answer.changed || []) {
    lines.push(el('p', { class: 'pagediff-line' },
      el('span', { class: 'pagediff-mark' }, '~'),
      el('span', { class: 'pagediff-text' },
        blockToSource(entry.before) + ' → ' + blockToSource(entry.after))));
  }
  return lines;
}

// -- the editor ---------------------------------------------------------------

const BLOCK_LABELS = {
  heading: 'Heading',
  lead: 'Description',
  paragraph: 'Paragraph',
  list: 'List',
  note: 'Note',
  link: 'Link',
  rule: 'Rule',
  image: 'Image',
  quote: 'Quotation',
  code: 'Code',
  table: 'Table',
};

export function adminPageEditor() {
  const listHost = el('div', { class: 'rowlist' });
  const stage = el('div', { class: 'fold' });

  // What is open, and what is being written.
  let pages = [];
  let current = null;      // the page as the server last reported it
  let working = null;      // { title, blocks } - the copy being written
  let mode = 'blocks';     // 'blocks' or 'source'
  let source = '';         // the source text, when the source mode is open
  let dirty = false;
  let openedAt = null;     // the draft timestamp the editor opened with
  let canEdit = false;
  let revisions = [];      // the revisions the server holds for this page

  const mayEdit = () => !!(State.user && State.user.isAdmin);

  // -- the page list ----------------------------------------------------------

  const statusChip = (page) => {
    if (page.status === 'PUBLISHED') return el('span', { class: 'chip chip--on' }, 'live');
    if (page.status === 'DRAFT') return el('span', { class: 'chip chip--quiet' }, 'draft');
    return el('span', { class: 'chip chip--quiet' }, 'untouched');
  };

  const paintList = () => {
    if (!pages.length) {
      listHost.replaceChildren(blank({
        glyph: 'file', title: 'No pages', text: 'This instance serves no editable pages.',
      }));
      return;
    }
    listHost.replaceChildren(...pages.map((page) => row({
      lead: el('span', { class: 'role-dot' }, icon('file', { size: 15 })),
      title: page.title || page.route,
      sub: '/' + page.route + (page.legal ? ' · legal' : ''),
      href: null,
      meta: statusChip(page),
      side: el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Edit ' + (page.title || page.route),
        onClick: () => openPage(page.route),
      }, current && current.route === page.route ? 'Open' : 'Edit'),
    })));
  };

  const loadList = async () => {
    listHost.replaceChildren(hold('Reading the pages'));
    try {
      const rows = await Api.adminPages();
      pages = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      paintList();
    } catch (error) {
      listHost.replaceChildren(fold([fault(error, loadList)]));
    }
  };

  // -- opening a page --------------------------------------------------------

  const openPage = async (route) => {
    stage.replaceChildren(fold([hold('Opening the page')]));
    try {
      const record = await Api.adminPage(route);
      current = record;
      openedAt = record.draftAt || null;
      const body = (record.draft && record.draft.length)
        ? record.draft
        : ((record.published && record.published.length) ? record.published : []);
      working = { title: record.title || '', blocks: body.map((block) => Object.assign({}, block)) };
      source = blocksToSource(working.blocks);
      dirty = false;
      mode = 'blocks';
      paintList();
      renderEditor();
    } catch (error) {
      current = null;
      working = null;
      stage.replaceChildren(fold([fault(error, () => openPage(route))]));
    }
  };

  const markDirty = () => {
    dirty = true;
    paintStatus();
  };

  // -- the editor ------------------------------------------------------------

  const statusLine = el('p', { class: 'form-note', role: 'status' });
  const problemHost = el('div', { class: 'fold fold--tight' });
  const blockHost = el('div', { class: 'fold' });
  const sourceHost = el('div', { class: 'fold fold--tight' });
  // The two ways of writing the body share one place in the page, so
  // switching between them swaps what is there rather than rebuilding the
  // page around it.
  const bodyHost = el('div', { class: 'fold' });
  const metaHost = el('div', { class: 'fold fold--tight' });
  const historyHost = el('div', { class: 'fold fold--tight' });
  const previewHost = el('div', { class: 'page-preview' });

  const paintBody = () => {
    bodyHost.replaceChildren(mode === 'blocks' ? blockHost : sourceHost);
  };

  const paintStatus = () => {
    statusLine.textContent = dirty
      ? 'Unsaved changes in this browser.'
      : (current ? 'Saved as the draft of /' + current.route + '.' : '');
  };

  // The title of the page is part of what is written, so it is edited here
  // rather than in a separate place.
  const titleInput = el('input', {
    class: 'input', type: 'text', maxlength: '128',
    'aria-label': 'Page title',
  });
  titleInput.addEventListener('input', () => {
    if (!working) return;
    working.title = titleInput.value;
    markDirty();
  });

  const paintMeta = () => {
    if (!current) return;
    const facts_ = [
      { value: current.route, label: 'route' },
      { value: current.status || 'UNTOUCHED', label: 'status' },
      { value: current.draftAt ? String(current.draftAt) : '—', label: 'draft saved' },
      { value: current.publishedAt ? String(current.publishedAt) : '—', label: 'published' },
    ];
    const outstanding = current.outstandingFields || [];
    metaHost.replaceChildren(
      facts(facts_),
      outstanding.length
        ? memo({
          tone: 'warning',
          title: 'The shipped template still has fields to fill',
          text: outstanding.join(' · '),
        })
        : null,
    );
  };

  // -- the blocks ------------------------------------------------------------

  const writeBlock = (index, changes) => {
    if (!working) return;
    working.blocks[index] = Object.assign({}, working.blocks[index], changes);
    markDirty();
  };

  // A field the operator empties is taken out of the block rather than left
  // empty in it, so the body that is written is the body that was meant.
  const clearBlockField = (index, field) => {
    if (!working) return;
    const next = Object.assign({}, working.blocks[index]);
    delete next[field];
    working.blocks[index] = next;
    markDirty();
  };

  // A column is added to every row, and a row is added with a cell for every
  // column, so a table is never ragged: the server refuses a row that is not
  // as wide as the headings.
  const addColumn = (index) => {
    const block = working && working.blocks[index];
    if (!block) return;
    const headers = (block.headers || []).concat(['']);
    const rows = (block.rows || []).map((row) => (row || []).concat(['']));
    writeBlock(index, { headers, rows });
    renderBlocks();
  };

  const removeColumn = (index, column) => {
    const block = working && working.blocks[index];
    if (!block) return;
    const headers = (block.headers || []).filter((_, one) => one !== column);
    const rows = (block.rows || []).map((row) => (row || []).filter((_, one) => one !== column));
    writeBlock(index, { headers, rows });
    renderBlocks();
  };

  const addRow = (index) => {
    const block = working && working.blocks[index];
    if (!block) return;
    const columns = Math.max(1, (block.headers || []).length);
    const rows = (block.rows || []).concat([new Array(columns).fill('')]);
    writeBlock(index, { rows });
    renderBlocks();
  };

  const removeRow = (index, row) => {
    const block = working && working.blocks[index];
    if (!block) return;
    const rows = (block.rows || []).filter((_, one) => one !== row);
    writeBlock(index, { rows });
    renderBlocks();
  };

  const moveBlock = (index, delta) => {
    if (!working) return;
    const to = index + delta;
    if (to < 0 || to >= working.blocks.length) return;
    const list = working.blocks.slice();
    const [moved] = list.splice(index, 1);
    list.splice(to, 0, moved);
    working.blocks = list;
    renderBlocks();
    markDirty();
  };

  const removeBlock = (index) => {
    if (!working) return;
    working.blocks = working.blocks.filter((_, i) => i !== index);
    renderBlocks();
    markDirty();
  };

  const insertBlock = (block, at) => {
    if (!working) return;
    const list = working.blocks.slice();
    const index = at === undefined || at === null ? list.length : Math.max(0, Math.min(at, list.length));
    list.splice(index, 0, block);
    working.blocks = list;
    renderBlocks();
    markDirty();
  };

  const addBlockMenu = (event, at) => {
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

  const saveAsReusable = (index) => {
    const block = working.blocks[index];
    if (!block) return;
    const name = el('input', { class: 'input', type: 'text', 'aria-label': 'Name for this reusable block', placeholder: 'Contact details' });
    const scope = el('select', { class: 'select', 'aria-label': 'Who may use this reusable block' },
      el('option', { value: 'SHARED', selected: true }, 'Every administrator on this instance'),
      el('option', { value: 'PERSONAL', selected: false }, 'Only me'));
    const dialog = openDialog({
      title: 'Save as a reusable block',
      sub: 'It joins the library on the server and can be inserted in any page.',
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          const label = name.value.trim();
          if (!label) { name.focus(); return; }
          try {
            await libraryWrite({
              name: label,
              body: [Object.assign({}, block)],
              scope: scope.value || 'SHARED',
            });
            toast('Saved to the reusable blocks');
            dialog.close();
            await loadLibrary();
          } catch (error) {
            errorToast(error);
          }
        },
      }, name, scope, el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
    });
    name.focus();
  };

  const blockTools = (index) => el('span', { class: 'rowtools' },
    iconButton('chevron-up', {
      label: 'Move this block up',
      class: 'icon-btn--sm',
      onClick: () => moveBlock(index, -1),
    }),
    iconButton('chevron-down', {
      label: 'Move this block down',
      class: 'icon-btn--sm',
      onClick: () => moveBlock(index, 1),
    }),
    iconButton('copy', {
      label: 'Save this block as a reusable block',
      class: 'icon-btn--sm',
      onClick: () => saveAsReusable(index),
    }),
    iconButton('trash', {
      label: 'Remove this block',
      class: 'icon-btn--sm',
      onClick: () => removeBlock(index),
    }));

  const blockRow = (block, index) => {
    const header = el('div', { class: 'pageblock-head' },
      el('span', { class: 'pageblock-kind' }, BLOCK_LABELS[block.type] || block.type),
      blockTools(index));

    const body = el('div', { class: 'pageblock-body' });
    const node = el('div', { class: 'pageblock', 'data-block-type': block.type }, header, body);

    const text = (value, options) => {
      const opts = options || {};
      const input = el(opts.multiline ? 'textarea' : 'input', {
        class: 'input', value: opts.multiline ? null : value,
        rows: opts.rows || null,
        placeholder: opts.placeholder || null,
        'aria-label': opts.label || 'Text',
      });
      if (opts.multiline) input.value = value;
      input.addEventListener('input', () => writeBlock(index, { text: input.value }));
      return input;
    };

    switch (block.type) {
      case 'heading': {
        const level = el('select', { class: 'select', 'aria-label': 'Heading level' },
          el('option', { value: '2', selected: block.level !== 3 }, 'Heading'),
          el('option', { value: '3', selected: block.level === 3 }, 'Subheading'));
        level.addEventListener('change', () => writeBlock(index, { level: Number(level.value) }));
        body.appendChild(el('div', { class: 'pageblock-row' }, level, text(block.text || '', { label: 'Heading text' })));
        break;
      }
      case 'lead':
        body.appendChild(text(block.text || '', {
          multiline: true, rows: 2, label: 'Description', placeholder: 'The sentence under the title',
        }));
        break;
      case 'paragraph':
        body.appendChild(text(block.text || '', { multiline: true, rows: 3, label: 'Paragraph text' }));
        break;
      case 'note': {
        const kind = el('select', { class: 'select', 'aria-label': 'Note kind' },
          el('option', { value: 'info', selected: block.kind !== 'warn' }, 'Note'),
          el('option', { value: 'warn', selected: block.kind === 'warn' }, 'Warning'));
        kind.addEventListener('change', () => writeBlock(index, { kind: kind.value }));
        body.appendChild(el('div', { class: 'pageblock-row' }, kind,
          text(block.text || '', { multiline: true, rows: 2, label: 'Note text' })));
        break;
      }
      case 'list': {
        const items = el('div', { class: 'pageblock-items' });
        (block.items || []).forEach((item, itemIndex) => {
          const value = el('input', { class: 'input', type: 'text', 'aria-label': 'List item ' + (itemIndex + 1) });
          value.value = item;
          value.addEventListener('input', () => {
            const next = (working.blocks[index].items || []).slice();
            next[itemIndex] = value.value;
            writeBlock(index, { items: next });
          });
          items.appendChild(el('div', { class: 'pageblock-item' }, value,
            iconButton('x', {
              label: 'Remove this item',
              class: 'icon-btn--sm',
              onClick: () => {
                const next = (working.blocks[index].items || []).filter((_, i) => i !== itemIndex);
                writeBlock(index, { items: next });
                renderBlocks();
              },
            })));
        });
        body.appendChild(items);
        body.appendChild(el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => {
            const next = (working.blocks[index].items || []).concat(['']);
            writeBlock(index, { items: next });
            renderBlocks();
          },
        }, icon('plus', { size: 14 }), 'Add item'));
        break;
      }
      case 'link': {
        const label = el('input', { class: 'input', type: 'text', 'aria-label': 'Link text' });
        label.value = block.text || '';
        label.addEventListener('input', () => writeBlock(index, { text: label.value }));
        const target = el('input', { class: 'input', type: 'text', 'aria-label': 'Link target', placeholder: 'https://example.org/policy' });
        target.value = block.href || '';
        target.addEventListener('input', () => writeBlock(index, { href: target.value }));
        const problem = linkProblem(block.href);
        body.appendChild(el('div', { class: 'pageblock-row' }, label, target));
        if (problem) body.appendChild(el('p', { class: 'field-error' }, problem));
        break;
      }
      case 'image': {
        const source = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Image source',
          placeholder: 'https://example.org/picture.png',
        });
        source.value = block.src || '';
        source.addEventListener('input', () => writeBlock(index, { src: source.value }));
        // The alt text is what a reader who cannot see the picture is told,
        // so the server refuses an image without one.
        const alt = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Image alt text',
          placeholder: 'What the picture shows',
        });
        alt.value = block.alt || '';
        alt.addEventListener('input', () => writeBlock(index, { alt: alt.value }));
        const width = el('input', {
          class: 'input', type: 'number', min: '1', max: String(LIMITS.imageWidth),
          'aria-label': 'Image width in pixels',
        });
        width.value = block.width == null ? '' : String(block.width);
        width.addEventListener('input', () => {
          const value = width.value.trim();
          if (!value) { clearBlockField(index, 'width'); return; }
          writeBlock(index, { width: Number(value) });
        });
        const problem = imageProblem(block.src);
        body.appendChild(el('div', { class: 'pageblock-row' }, source, width));
        body.appendChild(alt);
        if (problem) body.appendChild(el('p', { class: 'field-error' }, problem));
        break;
      }
      case 'quote': {
        const text = el('textarea', { class: 'input', rows: '3', 'aria-label': 'Quotation text' });
        text.value = block.text || '';
        text.addEventListener('input', () => writeBlock(index, { text: text.value }));
        const attribution = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Quotation attribution',
        });
        attribution.value = block.attribution || '';
        attribution.addEventListener('input', () => {
          const value = attribution.value.trim();
          if (!value) { clearBlockField(index, 'attribution'); return; }
          writeBlock(index, { attribution: value });
        });
        body.appendChild(text);
        body.appendChild(attribution);
        break;
      }
      case 'code': {
        // The code is written in a field that keeps its indentation, because
        // the indentation is what the code means.
        const text = el('textarea', {
          class: 'input', rows: '8', spellcheck: 'false', 'aria-label': 'Code text',
        });
        text.value = block.text || '';
        text.addEventListener('input', () => writeBlock(index, { text: text.value }));
        const language = el('input', {
          class: 'input', type: 'text', 'aria-label': 'Code language', placeholder: 'javascript',
        });
        language.value = block.language || '';
        language.addEventListener('input', () => {
          const value = language.value.trim().toLowerCase();
          if (!value) { clearBlockField(index, 'language'); return; }
          writeBlock(index, { language: value });
        });
        const problem = languageProblem(block.language);
        body.appendChild(text);
        body.appendChild(el('div', { class: 'pageblock-row' }, language));
        if (problem) body.appendChild(el('p', { class: 'field-error' }, problem));
        break;
      }
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers : [];
        const rows = Array.isArray(block.rows) ? block.rows : [];

        const caption = el('input', { class: 'input', type: 'text', 'aria-label': 'Table caption' });
        caption.value = block.caption || '';
        caption.addEventListener('input', () => {
          const value = caption.value.trim();
          if (!value) { clearBlockField(index, 'caption'); return; }
          writeBlock(index, { caption: value });
        });

        // The table is a table, so the columns line up: the headings, the
        // control that takes a column away under each of them, and a row for
        // every line of the table.
        const grid = el('table');
        const headingRow = el('tr');
        headers.forEach((heading, column) => {
          const field = el('input', {
            class: 'input', type: 'text', 'aria-label': 'Column ' + (column + 1) + ' heading',
          });
          field.value = heading == null ? '' : String(heading);
          field.addEventListener('input', () => {
            const next = (working.blocks[index].headers || []).slice();
            next[column] = field.value;
            writeBlock(index, { headers: next });
          });
          headingRow.appendChild(el('th', {}, field));
        });
        const toolsRow = el('tr');
        headers.forEach((heading, column) => {
          toolsRow.appendChild(el('th', {}, iconButton('x', {
            label: 'Remove column ' + (column + 1),
            class: 'icon-btn--sm',
            onClick: () => removeColumn(index, column),
          })));
        });
        grid.appendChild(el('thead', {}, headingRow, toolsRow));

        const bodyRows = el('tbody');
        rows.forEach((row, rowIndex) => {
          const line = el('tr');
          (row || []).forEach((cell, column) => {
            const field = el('input', {
              class: 'input', type: 'text',
              'aria-label': 'Row ' + (rowIndex + 1) + ', column ' + (column + 1),
            });
            field.value = cell == null ? '' : String(cell);
            field.addEventListener('input', () => {
              const next = (working.blocks[index].rows || []).map((one) => (one || []).slice());
              next[rowIndex][column] = field.value;
              writeBlock(index, { rows: next });
            });
            line.appendChild(el('td', {}, field));
          });
          line.appendChild(el('td', {}, iconButton('x', {
            label: 'Remove row ' + (rowIndex + 1),
            class: 'icon-btn--sm',
            onClick: () => removeRow(index, rowIndex),
          })));
          bodyRows.appendChild(line);
        });
        grid.appendChild(bodyRows);

        body.appendChild(caption);
        body.appendChild(grid);
        body.appendChild(el('div', { class: 'pageblock-row' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => addColumn(index),
          }, icon('plus', { size: 14 }), 'Add column'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => addRow(index),
          }, icon('plus', { size: 14 }), 'Add row')));
        break;
      }
      case 'rule':
        body.appendChild(el('p', { class: 'form-note' }, 'A line between two parts of the page.'));
        break;
      default:
        body.appendChild(el('p', { class: 'field-error' }, 'Unknown block type: ' + block.type));
    }

    return node;
  };

  const renderBlocks = () => {
    if (!working) return;
    const rows = working.blocks.map((block, index) => blockRow(block, index));
    blockHost.replaceChildren(
      ...(rows.length ? rows : [blank({
        glyph: 'file', title: 'An empty page', text: 'Add the first block to begin.',
      })]),
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: (event) => addBlockMenu(event, working.blocks.length),
      }, icon('plus', { size: 14 }), 'Add a block'),
    );
    paintProblems();
  };

  // -- the source ------------------------------------------------------------

  const sourceArea = el('textarea', {
    class: 'input page-source', rows: '18', spellcheck: 'false',
    'aria-label': 'Page source',
  });
  sourceArea.addEventListener('input', () => {
    source = sourceArea.value;
    markDirty();
    paintProblems();
  });

  const renderSource = () => {
    sourceArea.value = source;
    sourceHost.replaceChildren(
      el('p', { class: 'form-note' },
        'One block per paragraph. ## heading, ! description, > quotation, ~ note, - item, 1. item, '
        + '[label](target) for a link, ![alt](src) for an image, ``` for a code block, '
        + '| a | b | for a table and --- for a rule. **bold**, *italic*, `code` inside a line.'),
      sourceArea,
    );
    paintProblems();
  };

  // -- problems --------------------------------------------------------------

  const paintProblems = () => {
    const problems = [];
    if (mode === 'source') {
      const parsed = sourceToBlocks(source);
      for (const error of parsed.errors) {
        problems.push('Line ' + error.line + ': ' + error.message);
      }
    } else if (working) {
      for (const error of blockErrors(working.blocks)) {
        problems.push(error.index === -1
          ? error.message
          : 'Block ' + (error.index + 1) + ': ' + error.message);
      }
    }
    problemHost.replaceChildren(...(problems.length
      ? [memo({ tone: 'danger', title: 'This page cannot be saved as it is', text: problems.join('\n') })]
      : []));
    return problems;
  };

  // -- the mode switch -------------------------------------------------------

  const modeSwitch = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'How the page is written' });

  const paintMode = () => {
    modeSwitch.replaceChildren(
      el('button', {
        class: 'segmented-item', type: 'button', role: 'tab',
        'aria-selected': String(mode === 'blocks'),
        onClick: () => setMode('blocks'),
      }, 'Blocks'),
      el('button', {
        class: 'segmented-item', type: 'button', role: 'tab',
        'aria-selected': String(mode === 'source'),
        onClick: () => setMode('source'),
      }, 'Source'),
    );
  };

  const setMode = (next) => {
    if (next === mode) return;
    if (next === 'source') {
      source = blocksToSource(working ? working.blocks : []);
      mode = 'source';
      renderSource();
    } else {
      const parsed = sourceToBlocks(source);
      if (parsed.errors.length) {
        // The source cannot be read as blocks, so it stays in source mode with
        // the lines that are wrong named.
        mode = 'source';
        renderSource();
        paintBody();
        paintProblems();
        toast('The source has lines that do not read as blocks', { type: 'error' });
        return;
      }
      working.blocks = parsed.blocks;
      mode = 'blocks';
      renderBlocks();
    }
    paintMode();
    paintBody();
    paintProblems();
  };

  // -- reusable blocks -------------------------------------------------------
  //
  // The library is the server's: the blocks an administrator may use, and the
  // ones they wrote. A block is inserted as its content rather than as a
  // reference, so a page that has taken a block keeps it whatever happens to
  // the library afterwards.

  const libraryHost = el('div', { class: 'rowlist' });
  let library = [];

  const paintLibrary = () => {
    if (!library.length) {
      libraryHost.replaceChildren(blank({
        glyph: 'copy', title: 'No reusable blocks yet',
        text: 'Save a block as reusable and it can be inserted in any page on this instance.',
      }));
      return;
    }
    libraryHost.replaceChildren(...library.map((entry) => row({
      lead: el('span', { class: 'role-dot' }, icon('copy', { size: 15 })),
      title: entry.name,
      sub: (entry.body || []).map((block) => BLOCK_LABELS[block.type] || block.type).join(', '),
      meta: el('span', { class: 'chip chip--quiet' }, entry.scope === 'SHARED' ? 'shared' : 'personal'),
      side: el('span', { class: 'rowtools' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Insert ' + entry.name,
          onClick: () => {
            for (const block of entry.body || []) {
              insertBlock(Object.assign({}, block), working ? working.blocks.length : undefined);
            }
          },
        }, 'Insert'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Rename the reusable block ' + entry.name,
          onClick: () => renameLibraryEntry(entry),
        }, 'Rename'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Delete the reusable block ' + entry.name,
          onClick: () => deleteLibraryEntry(entry),
        }, 'Delete')),
    })));
  };

  const loadLibrary = async () => {
    try {
      const listed = await libraryList();
      library = Array.isArray(listed) ? listed : [];
      paintLibrary();
    } catch (error) {
      library = [];
      libraryHost.replaceChildren(fold([fault(error, loadLibrary)]));
    }
  };

  const renameLibraryEntry = (entry) => {
    const name = el('input', { class: 'input', type: 'text', 'aria-label': 'Name for this reusable block' });
    name.value = entry.name || '';
    const dialog = openDialog({
      title: 'Rename this reusable block',
      sub: 'The blocks it holds do not change.',
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          const label = name.value.trim();
          if (!label) { name.focus(); return; }
          try {
            await libraryRename(entry.id, { name: label });
            toast('Renamed');
            dialog.close();
            await loadLibrary();
          } catch (error) {
            errorToast(error);
          }
        },
      }, name, el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
    });
    name.focus();
  };

  const deleteLibraryEntry = async (entry) => {
    const yes = await confirmDialog({
      title: 'Delete ' + entry.name + '?',
      body: 'The block is taken out of the library. The pages that already hold it keep it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await libraryRemove(entry.id);
      toast('Deleted from the reusable blocks');
      await loadLibrary();
    } catch (error) {
      errorToast(error);
    }
  };

  // -- saving, publishing, history -------------------------------------------

  const conflictHost = el('div', { class: 'fold fold--tight' });

  const showConflict = (message) => {
    conflictHost.replaceChildren(memo({
      tone: 'warning',
      title: 'This page changed on the server',
      text: message,
      actions: el('span', { class: 'rowtools' },
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => openPage(current.route),
        }, 'Reload from the server'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => { conflictHost.replaceChildren(); },
        }, 'Keep editing')),
    }));
  };

  // The blocks the editor is holding, whichever way they are being written.
  // In the source mode the text is the truth until it is read back, so the
  // body that is written is the one the source describes - never the blocks
  // the source was opened from.
  const currentBlocks = () => {
    if (mode !== 'source') return working ? working.blocks : [];
    const parsed = sourceToBlocks(source);
    if (parsed.errors.length) return null;
    return parsed.blocks;
  };

  const saveDraft = async (options) => {
    const opts = options || {};
    if (!working) return null;
    const problems = paintProblems();
    if (problems.length) {
      toast('The page has problems that stop it being saved', { type: 'error' });
      return null;
    }
    const blocks = currentBlocks();
    if (!blocks) {
      toast('The source has lines that do not read as blocks', { type: 'error' });
      paintProblems();
      return null;
    }
    // Before writing, the server is asked what it holds. A page that moved
    // under the editor is not overwritten silently: the operator is told, and
    // chooses.
    if (!opts.overwrite) {
      try {
        const fresh = await Api.adminPage(current.route);
        if (String(fresh.draftAt || '') !== String(openedAt || '')) {
          showConflict('Someone saved this page while you were writing it. '
            + 'Reloading brings their version in; overwriting replaces it with yours.');
          conflictHost.querySelector('.rowtools').appendChild(el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            onClick: () => saveDraft({ overwrite: true }),
          }, 'Overwrite with mine'));
          return null;
        }
      } catch (error) {
        errorToast(error);
        return null;
      }
    }
    try {
      const saved = await Api.savePageDraft(current.route, {
        title: working.title,
        body: blocks,
      });
      current = saved;
      openedAt = saved.draftAt || null;
      working.blocks = blocks;
      dirty = false;
      conflictHost.replaceChildren();
      paintStatus();
      paintMeta();
      paintList();
      toast('Draft saved');
      return saved;
    } catch (error) {
      errorToast(error);
      return null;
    }
  };

  const publish = async () => {
    if (!current) return;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return;
    }
    const yes = await confirmDialog({
      title: 'Publish /' + current.route + '?',
      body: 'Every visitor sees this page from now on. The revision before it stays in the history.',
      confirmLabel: 'Publish',
    });
    if (!yes) return;
    try {
      // The server asks for the route to be typed back for a legal page, and
      // for every other one the operator confirms here.
      let confirm = current.route;
      if (current.legal) {
        const typed = window.prompt('Type the route to confirm publishing: ' + current.route);
        if (typed === null) return;
        if (typed !== current.route) {
          toast('The route did not match, so nothing was published', { type: 'error' });
          return;
        }
        confirm = typed;
      }
      current = await Api.publishPage(current.route, confirm);
      openedAt = current.draftAt || null;
      paintMeta();
      paintList();
      toast('Published /' + current.route);
    } catch (error) {
      errorToast(error);
    }
  };

  const unpublish = async () => {
    if (!current) return;
    const yes = await confirmDialog({
      title: 'Unpublish /' + current.route + '?',
      body: 'The page stops being served. The draft and the history stay.',
      confirmLabel: 'Unpublish',
      danger: true,
    });
    if (!yes) return;
    try {
      current = await Api.unpublishPage(current.route);
      paintMeta();
      paintList();
      toast('Unpublished /' + current.route);
    } catch (error) {
      errorToast(error);
    }
  };

  const paintHistory = async () => {
    historyHost.replaceChildren(hold('Reading the history'));
    try {
      const listed = await Api.pageRevisions(current.route, 20);
      revisions = Array.isArray(listed) ? listed : (listed && listed.items) || [];
      if (!revisions.length) {
        historyHost.replaceChildren(blank({
          glyph: 'book', title: 'No history yet', text: 'Every save and every publish is recorded here.',
        }));
        return;
      }
      historyHost.replaceChildren(...revisions.map((revision) => row({
        title: 'Revision ' + revision.revision,
        sub: (revision.state || 'draft') + ' · ' + (revision.createdAt || '')
          + (revision.authorId ? ' · ' + revision.authorId : ''),
        meta: revision.title || '',
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Restore revision ' + revision.revision,
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Restore revision ' + revision.revision + '?',
              body: 'It becomes the current draft. Nothing is deleted: the revision stays in the history.',
              confirmLabel: 'Restore',
            });
            if (!yes) return;
            try {
              current = await Api.restorePageRevision(current.route, revision.revision);
              const body = (current.draft && current.draft.length) ? current.draft : [];
              working = { title: current.title || '', blocks: body.map((block) => Object.assign({}, block)) };
              source = blocksToSource(working.blocks);
              openedAt = current.draftAt || null;
              dirty = false;
              renderBlocks();
              renderSource();
              paintStatus();
              paintMeta();
              paintList();
              toast('Revision ' + revision.revision + ' restored');
            } catch (error) { errorToast(error); }
          },
        }, 'Restore'),
      })));
    } catch (error) {
      historyHost.replaceChildren(fold([fault(error, paintHistory)]));
    }
  };

  // The comparison the server can support: what changed between two
  // revisions. The answer is a report about the content - the blocks that
  // were added, removed and rewritten - rather than a diff of two texts, so
  // the blocks are shown as the source writes them.
  const compare = () => {
    if (!current) return;
    if (revisions.length < 2) {
      toast('There are not two revisions to compare yet', { type: 'error' });
      return;
    }
    const name = (revision) => 'Revision ' + revision.revision
      + (revision.isPublished ? ' (published)' : '')
      + (revision.isDraft ? ' (draft)' : '');
    const from = el('select', { class: 'select', 'aria-label': 'The revision to compare from' },
      ...revisions.map((revision) => el('option', { value: String(revision.revision) }, name(revision))));
    from.value = String(revisions[1].revision);
    const to = el('select', { class: 'select', 'aria-label': 'The revision to compare to' },
      ...revisions.map((revision) => el('option', { value: String(revision.revision) }, name(revision))));
    to.value = String(revisions[0].revision);
    const report = el('div', { class: 'pagediff' });

    const show = async () => {
      report.replaceChildren(hold('Asking what changed'));
      try {
        const answer = await request('GET', '/api/admin/pages/' + encodeURIComponent(current.route)
          + '/revisions/compare?from=' + encodeURIComponent(from.value)
          + '&to=' + encodeURIComponent(to.value));
        report.replaceChildren(...comparisonLines(answer));
      } catch (error) {
        report.replaceChildren(fold([fault(error, show)]));
      }
    };

    openDialog({
      title: 'Compare two revisions',
      sub: 'What the server says changed between them.',
      wide: true,
      body: el('div', { class: 'fold' },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'From'), from),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'To'), to),
        el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: show }, 'Compare'),
        report),
    });
    show();
  };

  const preview = async () => {
    const blocks = currentBlocks();
    if (!blocks) {
      toast('The source has lines that do not read as blocks', { type: 'error' });
      paintProblems();
      return;
    }
    const problems = blockErrors(blocks);
    if (problems.length) {
      toast('The page has problems that stop it being shown', { type: 'error' });
      paintProblems();
      return;
    }
    previewHost.replaceChildren(hold('Rendering the page'));
    try {
      const out = await Api.previewPage(current.route, blocks);
      renderServerHtml(previewHost, out && out.html);
    } catch (error) {
      previewHost.replaceChildren(fold([fault(error, preview)]));
    }
  };

  // -- the whole editor ------------------------------------------------------

  const renderEditor = () => {
    if (!current || !working) {
      stage.replaceChildren(blank({
        glyph: 'file', title: 'Choose a page', text: 'Pick one of the pages above to write it.',
      }));
      return;
    }
    canEdit = mayEdit();
    titleInput.value = working.title;
    paintMode();
    paintMeta();
    paintStatus();
    renderBlocks();
    renderSource();
    paintBody();
    paintLibrary();

    stage.replaceChildren(
      head({
        kicker: 'Instance',
        title: current.title || current.route,
        lede: 'The body is a list of blocks. Write it as blocks or as source; it is the same page.',
        actions: el('div', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: preview,
          }, icon('eye', { size: 14 }), 'Preview'),
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: compare,
          }, icon('edit', { size: 14 }), 'Compare revisions'),
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            disabled: canEdit ? null : true,
            onClick: () => saveDraft(),
          }, icon('check', { size: 14 }), 'Save draft'),
          current.status === 'PUBLISHED'
            ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              disabled: canEdit ? null : true,
              onClick: unpublish,
            }, 'Unpublish')
            : el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              disabled: canEdit ? null : true,
              onClick: publish,
            }, 'Publish')),
      }),
      canEdit ? null : memo({
        tone: 'warning',
        title: 'This account cannot change these pages',
        text: 'The server refuses the change. Everything below can be read, and nothing here can be written.',
      }),
      conflictHost,
      card({
        label: 'The page', glyph: 'file',
        body: fold([
          el('label', { class: 'field' },
            el('span', { class: 'field-label' }, 'Title'), titleInput),
          metaHost,
          statusLine,
        ]),
      }),
      card({
        label: 'The body', glyph: 'file',
        note: 'the same content, two ways to write it',
        actions: modeSwitch,
        body: fold([problemHost, bodyHost], { tight: true }),
      }),
      card({
        label: 'Reusable blocks', glyph: 'copy',
        note: 'the library on this instance',
        body: libraryHost,
        flush: true,
      }),
      card({
        label: 'Preview', glyph: 'eye',
        note: 'rendered by the server, as a visitor sees it',
        body: previewHost,
      }),
      card({
        label: 'History', glyph: 'book',
        body: historyHost,
        flush: true,
      }),
    );
    paintHistory();
  };

  // -- the page --------------------------------------------------------------

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Pages',
        lede: 'The public pages this instance serves.',
        actions: el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          'aria-label': 'Read the pages again',
          onClick: loadList,
        }, icon('refresh', { size: 14 }), 'Refresh'),
      }),
      card({ label: 'Pages', glyph: 'file', body: listHost, flush: true }),
      stage,
    ]),
    onMount: async () => {
      await loadList();
      await loadLibrary();
      if (pages.length) await openPage(pages[0].route);
    },
    cleanup() {},
  };
}

export default { adminPageEditor };
