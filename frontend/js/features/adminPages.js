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
import Api from '../../packages/api.js';
import TrycordConfig from '../../packages/config.js';
import { State } from '../../packages/store.js';
import { head, card, row, blank, fault, fold, facts, hold, memo } from '../ui/page.js';
import { errorToast, toast, confirmDialog, openDialog, openMenu } from '../ui/overlays.js';
import { iconButton } from '../ui/primitives.js';
import {
  sourceToBlocks, blocksToSource, blockErrors, linkProblem,
} from './pageSource.js';

// -- reusable blocks ----------------------------------------------------------
//
// A reusable block is one that can stand in more than one page. The server
// stores a page as a list of blocks and has no library of its own, so the
// library lives in this browser: the blocks are expanded into the page when
// they are inserted, and the page stores what any page stores.

function snippetKey() {
  let origin = 'local';
  try { origin = new URL(TrycordConfig.backendUrl()).origin; } catch { /* keep the raw address */ }
  return 'trycord.pages.snippets.' + origin;
}

function readSnippets() {
  try {
    const raw = localStorage.getItem(snippetKey());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeSnippets(list) {
  try { localStorage.setItem(snippetKey(), JSON.stringify(list)); } catch { /* storage is off */ }
}

function newSnippetId() {
  return 'snippet-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

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

// -- the diff -----------------------------------------------------------------
//
// Which lines of the source changed, so a draft can be compared with what is
// published. The revision list the server keeps carries no body, so the
// comparison that can be made honestly is between the two bodies the server
// does hold: the working draft and the published page.

function diffLines(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const table = [];
  for (let i = 0; i <= a.length; i++) table.push(new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: 'removed', text: a[i] }); i++; }
    else { out.push({ kind: 'added', text: b[j] }); j++; }
  }
  while (i < a.length) { out.push({ kind: 'removed', text: a[i] }); i++; }
  while (j < b.length) { out.push({ kind: 'added', text: b[j] }); j++; }
  return out;
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
      { label: 'Rule', icon: 'slash', onSelect: () => insertBlock({ type: 'rule' }, at) },
    ];
    openMenu({ anchor: event.currentTarget, items });
  };

  const saveAsReusable = (index) => {
    const block = working.blocks[index];
    if (!block) return;
    const name = el('input', { class: 'input', type: 'text', 'aria-label': 'Name for this reusable block', placeholder: 'Contact details' });
    const dialog = openDialog({
      title: 'Save as a reusable block',
      sub: 'It joins the library in this browser and can be inserted in any page.',
      body: el('form', {
        class: 'fold',
        onSubmit: (event) => {
          event.preventDefault();
          const label = name.value.trim();
          if (!label) { name.focus(); return; }
          const list = readSnippets();
          list.push({ id: newSnippetId(), name: label, blocks: [Object.assign({}, block)] });
          writeSnippets(list);
          toast('Saved to the reusable blocks');
          dialog.close();
          paintSnippets();
        },
      }, name, el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
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
        body.appendChild(items,
          el('button', {
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
        body.appendChild(el('div', { class: 'pageblock-row' }, label, target),
          problem ? el('p', { class: 'field-error' }, problem) : null);
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
        + '[label](target) for a link, --- for a rule. **bold**, *italic*, `code` inside a line.'),
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

  const snippetHost = el('div', { class: 'rowlist' });

  const paintSnippets = () => {
    const list = readSnippets();
    if (!list.length) {
      snippetHost.replaceChildren(blank({
        glyph: 'copy', title: 'No reusable blocks yet',
        text: 'Save a block as reusable and it can be inserted in any page you edit.',
      }));
      return;
    }
    snippetHost.replaceChildren(...list.map((snippet) => row({
      lead: el('span', { class: 'role-dot' }, icon('copy', { size: 15 })),
      title: snippet.name,
      sub: (snippet.blocks || []).map((block) => BLOCK_LABELS[block.type] || block.type).join(', '),
      side: el('span', { class: 'rowtools' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Insert ' + snippet.name,
          onClick: () => {
            for (const block of snippet.blocks || []) {
              insertBlock(Object.assign({}, block), working ? working.blocks.length : undefined);
            }
          },
        }, 'Insert'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Delete the reusable block ' + snippet.name,
          onClick: () => {
            writeSnippets(readSnippets().filter((entry) => entry.id !== snippet.id));
            paintSnippets();
          },
        }, 'Delete')),
    })));
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
      const revisions = await Api.pageRevisions(current.route, 20);
      const items = Array.isArray(revisions) ? revisions : (revisions && revisions.items) || [];
      if (!items.length) {
        historyHost.replaceChildren(blank({
          glyph: 'book', title: 'No history yet', text: 'Every save and every publish is recorded here.',
        }));
        return;
      }
      historyHost.replaceChildren(...items.map((revision) => row({
        title: 'Revision ' + revision.revision,
        sub: (revision.state || 'draft') + ' · ' + (revision.created_at || revision.createdAt || '')
          + (revision.author_id ? ' · ' + revision.author_id : ''),
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

  // The comparison the server can support: the working draft against the
  // published page. The revision list carries no body, so a revision can be
  // restored but not diffed.
  const compare = () => {
    const published = current && current.published ? current.published : [];
    const before = blocksToSource(published);
    const after = mode === 'source' ? source : blocksToSource(working ? working.blocks : []);    const lines = diffLines(before, after);
    const body = el('div', { class: 'pagediff' });
    for (const line of lines) {
      body.appendChild(el('p', { class: 'pagediff-line pagediff-line--' + line.kind },
        el('span', { class: 'pagediff-mark' }, line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '),
        el('span', { class: 'pagediff-text' }, line.text || ' ')));
    }
    openDialog({
      title: 'Draft against the published page',
      sub: published.length ? 'The published page is on the left of each pair.' : 'Nothing is published yet.',
      wide: true,
      body,
    });
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
    paintSnippets();

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
          }, icon('edit', { size: 14 }), 'Compare'),
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
        note: 'kept in this browser',
        body: snippetHost,
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
      if (pages.length) await openPage(pages[0].route);
    },
    cleanup() {},
  };
}

export default { adminPageEditor };
