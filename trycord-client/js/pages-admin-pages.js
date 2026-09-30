// from a fixed vocabulary: there is no HTML box, and the server escapes
import Api from './api.js';
import State from './state.js';
import { esc, el, clear, toast, openModal, confirmDialog } from './ui.js';
import { emptyState } from './components.js';
import { renderContextHeader } from './shell.js';
import { settingsFrame } from './settings-shell.js';
import { sectionHead } from './settings-ui.js';
import { navigate } from './nav.js';

const BLOCK_TYPES = [
  { type: 'heading', label: 'Heading', make: () => ({ type: 'heading', level: 2, text: 'Section' }) },
  { type: 'paragraph', label: 'Paragraph', make: () => ({ type: 'paragraph', text: '' }) },
  { type: 'lead', label: 'Standfirst', make: () => ({ type: 'lead', text: '' }) },
  { type: 'list', label: 'List', make: () => ({ type: 'list', ordered: false, items: [''] }) },
  { type: 'note', label: 'Callout', make: () => ({ type: 'note', kind: 'info', text: '' }) },
  { type: 'link', label: 'Link', make: () => ({ type: 'link', text: 'Link text', href: 'https://' }) },
  { type: 'rule', label: 'Divider', make: () => ({ type: 'rule' }) },
];

function summaryOf(block) {
  if (!block) return '(empty)';
  if (block.type === 'list') return `${block.items.length} item(s)`;
  if (block.type === 'rule') return 'divider';
  if (block.type === 'link') return `${block.text} → ${block.href}`;
  return block.text || '(empty)';
}

function statusChipFor(page) {
  if (page.status === 'PUBLISHED') return ['Published', 'resolved'];
  if (page.status === 'DRAFT') return ['Draft', 'open'];
  return ['Not edited', 'dismissed'];
}

function pageList(refresh) {
  const wrap = el('div', { class: 'card-list' });
  Api.adminPages().then((pages) => {
    if (!pages.length) {
      wrap.appendChild(emptyState('', 'No editable pages.', 'This instance exposes no static pages.'));
      return;
    }
    for (const p of pages) {
      const row = el('div', { class: 'card card--list--row' });
      const [label, cls] = statusChipFor(p);
      row.appendChild(el('span', { class: 'status-chip ' + cls }, label));
      if (p.legal) row.appendChild(el('span', { class: 'status-chip warning' }, 'legal'));

      const info = el('div', { class: 'grow' });
      info.appendChild(el('div', { class: 'admin-name' }, '/' + p.route));
      info.appendChild(el('div', { class: 'muted small' }, p.title));
      const lines = [];
      if (p.publishedAt) lines.push('published ' + new Date(p.publishedAt).toLocaleString());
      if (p.draftAt && p.status !== 'PUBLISHED') lines.push('draft saved ' + new Date(p.draftAt).toLocaleString());
      if (p.outstandingFields && p.outstandingFields.length) {
        lines.push(p.outstandingFields.length + ' operator field(s) still unfilled');
      }
      if (lines.length) info.appendChild(el('div', { class: 'muted small' }, lines.join(' · ')));
      row.appendChild(info);

      const acts = el('div', { class: 'card--list__actions' });
      acts.appendChild(el('button', {
        class: 'btn sm', type: 'button',
        onClick: () => { navigate('#/admin/pages/' + p.route); },
      }, 'Edit'));
      acts.appendChild(el('button', {
        class: 'btn ghost sm', type: 'button',
        onClick: () => { window.open('/' + p.route, '_blank', 'noopener'); },
      }, 'View'));
      row.appendChild(acts);
      wrap.appendChild(row);
    }
  }).catch((ex) => {
    wrap.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load pages.'));
  });
  return wrap;
}

// A toolbar bound to one input, so a click can act on that field's selection.
// Returned as a node rather than inserted inline at every call site, because the
// point is that every text field gets one and a missed field is a formatting
// feature that silently does not exist there.
function bbcodeBar(input, onChange) {
  const bar = el('div', { class: 'bbcode-bar', role: 'toolbar', 'aria-label': 'Formatting' });
  for (const spec of BBCODE_TOOLS) {
    bar.appendChild(el('button', {
      class: 'bbcode-bar__btn', type: 'button', title: spec.title, 'aria-label': spec.title,
      onClick: (e) => {
        e.preventDefault();
        applyBBCode(input, spec);
        onChange();
      },
    }, spec.label));
  }
  return bar;
}

// A text field plus its toolbar. Every editable string in a block goes through
// this, so formatting behaves the same everywhere and cannot be added to some
// fields and forgotten on others.
function bbcodeField(label, input, onChange, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    input,
    hint ? el('span', { class: 'hint' }, hint) : null,
    bbcodeBar(input, onChange));
}

function blockEditor(page, blocks, onChange) {
  const list = el('div', { class: 'card-list' });

  const rerender = () => {
    clear(list);
    blocks.forEach((b, i) => {
      const row = el('div', { class: 'card' });
      row.appendChild(el('div', { class: 'admin-form' },
        el('div', { class: 'section-label' }, b.type)));

      if (b.type === 'heading') {
        const h = el('input', { class: 'input', type: 'text', value: b.text || '' });
        h.addEventListener('input', () => { b.text = h.value; onChange(); });
        row.appendChild(bbcodeField('Text', h, onChange));
        const sel = el('select', { class: 'select' });
        for (const lv of [2, 3]) sel.appendChild(el('option', { value: String(lv) }, 'Level ' + lv));
        sel.value = String(b.level || 2);
        sel.addEventListener('change', () => { b.level = Number(sel.value); onChange(); });
        row.appendChild(el('div', { class: 'field' }, el('label', {}, 'Level'), sel));
      } else if (b.type === 'list') {
        const box = el('div', { class: 'field' });
        box.appendChild(el('label', {}, 'Items, one per line'));
        const ta = el('textarea', { class: 'textarea', rows: 4 });
        ta.value = (b.items || []).join('\n');
        ta.addEventListener('input', () => {
          b.items = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
          onChange();
        });
        box.appendChild(ta);
        row.appendChild(box);
        const ord = el('input', { type: 'checkbox', class: 'input' });
        ord.checked = b.ordered === true;
        ord.addEventListener('change', () => { b.ordered = ord.checked; onChange(); });
        row.appendChild(el('label', {}, ord, ' Numbered'));
      } else if (b.type === 'note') {
        const ta = el('textarea', { class: 'textarea', rows: 3, value: b.text || '' });
        ta.addEventListener('input', () => { b.text = ta.value; onChange(); });
        row.appendChild(bbcodeField('Text', ta, onChange));
        const sel = el('select', { class: 'select' });
        for (const k of ['info', 'warn']) sel.appendChild(el('option', { value: k }, k));
        sel.value = b.kind || 'info';
        sel.addEventListener('change', () => { b.kind = sel.value; onChange(); });
        row.appendChild(el('div', { class: 'field' }, el('label', {}, 'Kind'), sel));
      } else if (b.type === 'link') {
        const t = el('input', { class: 'input', type: 'text', value: b.text || '' });
        t.addEventListener('input', () => { b.text = t.value; onChange(); });
        const h = el('input', { class: 'input', type: 'text', value: b.href || '' });
        h.addEventListener('input', () => { b.href = h.value; onChange(); });
        row.appendChild(bbcodeField('Text', t, onChange));
        row.appendChild(el('div', { class: 'field' },
          el('label', {}, 'Target'), h,
          el('span', { class: 'hint' }, 'http, https, mailto, or a path starting with /')));
      } else if (b.type === 'rule') {
        row.appendChild(el('p', { class: 'muted small' }, 'A horizontal rule.'));
      } else {
        const ta = el('textarea', { class: 'textarea', rows: 3, value: b.text || '' });
        ta.addEventListener('input', () => { b.text = ta.value; onChange(); });
        row.appendChild(bbcodeField('Text', ta, onChange));
      }

      const tools = el('div', { class: 'row-line' });
      tools.appendChild(el('button', {
        class: 'btn ghost sm', type: 'button', disabled: i === 0,
        onClick: () => { const [x] = blocks.splice(i, 1); blocks.splice(i - 1, 0, x); onChange(); rerender(); },
      }, 'Move up'));
      tools.appendChild(el('button', {
        class: 'btn ghost sm', type: 'button', disabled: i === blocks.length - 1,
        onClick: () => { const [x] = blocks.splice(i, 1); blocks.splice(i + 1, 0, x); onChange(); rerender(); },
      }, 'Move down'));
      tools.appendChild(el('button', {
        class: 'btn danger sm', type: 'button',
        onClick: () => { blocks.splice(i, 1); onChange(); rerender(); },
      }, 'Remove'));
      row.appendChild(tools);
      list.appendChild(row);
    });
  };
  rerender();
  return list;
}

// The BBCode an operator can insert, and what each one is for. Shown in the
// editor rather than only documented, because the alternative is an operator
// discovering the syntax by reading the raw brackets off someone else's page.
const BBCODE_TOOLS = [
  { tag: 'b', label: 'B', title: 'Bold' },
  { tag: 'i', label: 'I', title: 'Italic' },
  { tag: 'u', label: 'U', title: 'Underline' },
  { tag: 's', label: 'S', title: 'Strikethrough' },
  { tag: 'url', label: 'Link', title: 'Link', arg: 'https://', body: 'link text' },
  { tag: 'quote', label: 'Quote', title: 'Quotation' },
  { tag: 'code', label: 'Code', title: 'Preformatted, contents shown literally' },
  { tag: 'spoiler', label: 'Spoiler', title: 'Hidden until focused' },
  { tag: 'color', label: 'Colour', title: 'Named colour or #hex', arg: 'red' },
  { tag: 'size', label: 'Size', title: '1 (small) to 7 (large)', arg: '5' },
  { tag: 'center', label: 'Centre', title: 'Centred' },
];

// Wraps the current selection, or inserts an empty pair and places the caret
// between the tags. Operates on the textarea the block is built from, which is
// why the block editor passes the input in rather than the block: the caret and
// selection only exist on the element.
function applyBBCode(input, spec) {
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? start : input.selectionEnd;
  const sel = input.value.slice(start, end);
  const open = spec.arg ? '[' + spec.tag + '=' + spec.arg + ']' : '[' + spec.tag + ']';
  const close = '[/' + spec.tag + ']';
  const body = sel || spec.body || '';
  const next = input.value.slice(0, start) + open + body + close + input.value.slice(end);
  input.value = next;
  // Put the caret on the text the operator is meant to edit: inside the pair
  // when they had no selection, over their own text when they did.
  const caret = sel ? start + open.length + sel.length : start + open.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Render an instance's own page HTML for preview.
 *
 * This content is the published document, not application chrome, so its links
 * are documents too. Left unmarked, a relative link inside it would be read as an
 * app route and opened inside the shell - on a self-hosted instance, where the
 * app and the site share the origin root, that turns "read the terms" into a
 * blank page.
 */
function pageProse(html) {
  const node = el('div', { class: 'prose', html });
  for (const a of node.querySelectorAll('a[href]')) {
    if (!(a.getAttribute('href') || '').startsWith('#')) a.setAttribute('data-document', '');
  }
  return node;
}

function pageEditor(container, route) {
  clear(container);

  // Full page means escaping the shell's content column, not just using a wider
  // div inside it. Two things sit between the editor and the viewport: the
  // context header, which the shell renders for every route, and the padding and
  // width cap on .main-content. The editor draws its own bar, so the header is
  // hidden for this route only, by the flag below. Scoped to the route so every
  // other page keeps the chrome it expects, and cleared on the way out so
  // leaving the editor restores it.
  document.documentElement.dataset.fullpage = 'page-editor';

  const wrap = el('div', { class: 'page-editor' });

  const head = el('header', { class: 'page-editor__bar' });
  const back = el('button', {
    class: 'btn ghost sm', type: 'button',
    onClick: () => { navigate('#/admin/pages'); },
  }, '← All pages');
  head.appendChild(back);
  head.appendChild(el('h1', { class: 'page-editor__title' }, '/' + route));
  wrap.appendChild(head);

  const main = el('div', { class: 'page-editor__main' });
  const body = el('div', { class: 'page-editor__body' });
  const side = el('aside', { class: 'page-editor__side' });
  main.appendChild(body);
  main.appendChild(side);
  wrap.appendChild(main);
  container.appendChild(wrap);

  const state = { blocks: [], title: '', page: null, dirty: false };

  const markDirty = () => { state.dirty = true; paintStatus(); queuePreview(); };
  const paintStatus = () => {
    const s = body.querySelector('[data-dirty]');
    if (s) s.textContent = state.dirty ? 'Unsaved changes' : 'Saved';
  };

  // Live preview. Server-rendered, deliberately: a client-side reimplementation
  // of the BBCode parser would be a second parser, and the one thing an editor
  // must not do is preview something different from what gets published. Coalesced
  // because it is a request per keystroke otherwise.
  let previewTimer = null;
  let previewSeq = 0;
  const queuePreview = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const mine = ++previewSeq;
      Api.adminPreviewPage(route, state.blocks)
        .then((r) => {
          // A slower earlier request must not overwrite a newer render.
          if (mine !== previewSeq) return;
          clear(previewOut);
          previewOut.appendChild(pageProse(r.html));
        })
        .catch(() => {
          if (mine !== previewSeq) return;
          clear(previewOut);
          previewOut.appendChild(el('p', { class: 'muted small' }, 'Preview unavailable.'));
        });
    }, 400);
  };

  const previewOut = el('div', { class: 'page-editor__preview prose' });
  side.appendChild(el('div', { class: 'page-editor__side-inner' },
    el('div', { class: 'section-label' }, 'Preview'),
    previewOut,
    el('div', { class: 'section-label' }, 'Formatting'),
    el('p', { class: 'muted small' },
      'Text accepts BBCode, the notation most forums use, so a page can be copied out and keep its formatting. '
      + 'Everything else is shown exactly as typed.'),
    el('ul', { class: 'bbcode-ref' }, ...BBCODE_TOOLS.map((t) => el('li', {},
      el('code', {}, '[' + t.tag + (t.arg ? '=' + t.arg : '') + ']' + (t.body || '…') + '[/' + t.tag + ']'),
      el('span', { class: 'muted small' }, ' ' + t.title))))));

  const rebuild = () => {
    clear(body);

    body.appendChild(el('div', { class: 'page-editor__status' },
      el('span', { class: 'muted small', 'data-dirty': '' }, state.dirty ? 'Unsaved changes' : 'Saved')));

    const title = el('input', { class: 'input', id: 'page-title', type: 'text', value: state.title });
    title.addEventListener('input', () => { state.title = title.value; markDirty(); });
    body.appendChild(el('div', { class: 'field' }, el('label', { for: 'page-title' }, 'Page title'), title));

    if (state.page.legal) {
      body.appendChild(el('div', { class: 'draft-note', role: 'note' },
        el('strong', {}, 'This is a legal page. '),
        'Publishing is visible to everyone immediately and is written to the audit log. Check the content carefully before you publish.'));
    }

    // An empty editor on a page that has never been drafted reads as a broken
    // one. It is not: the shipped file is still live until something is
    // published, and saying so is the difference between an operator who
    // understands what they are looking at and one who assumes the page is
    // empty for visitors too.
    if (!state.blocks.length && state.page.status !== 'PUBLISHED') {
      const box = el('div', { class: 'draft-note', role: 'note' });
      box.appendChild(el('strong', {}, 'Nothing drafted yet. '));
      box.appendChild(el('span', {}, 'Visitors are currently seeing the template that ships with Trycord. '
        + 'Add blocks below, or save an empty draft to publish a blank page.'));
      body.appendChild(box);
    }
    if (state.page.outstandingFields && state.page.outstandingFields.length) {
      const box = el('div', { class: 'field' });
      box.appendChild(el('strong', {}, 'Still to fill in'));
      const ul = el('ul', {});
      for (const f of state.page.outstandingFields) {
        ul.appendChild(el('li', { class: 'muted small' }, f));
      }
      box.appendChild(ul);
      body.appendChild(box);
    }

    const add = el('div', { class: 'row-line' });
    for (const t of BLOCK_TYPES) {
      add.appendChild(el('button', {
        class: 'btn ghost sm', type: 'button',
        onClick: () => { state.blocks.push(t.make()); markDirty(); rebuild(); },
      }, '+ ' + t.label));
    }
    body.appendChild(add);

    body.appendChild(blockEditor(state.page, state.blocks, markDirty));

    const bar = el('div', { class: 'page-editor__actions' });
    bar.appendChild(el('button', {
      class: 'btn', type: 'button',
      onClick: () => Api.adminPreviewPage(route, state.blocks)
        .then((r) => openModal({ title: 'Preview', body: pageProse(r.html) }))
        .catch((ex) => toast(ex.message || 'Preview failed', 'error')),
    }, 'Preview'));
    bar.appendChild(el('button', {
      class: 'btn primary', type: 'button',
      onClick: async () => {
        try {
          const saved = await Api.adminSavePageDraft(route, state.title, state.blocks);
          state.page = saved;
          state.dirty = false;
          toast('Draft saved.', 'ok');
          paintStatus();
        } catch (ex) { toast(ex.message || 'Could not save', 'error'); }
      },
    }, 'Save draft'));

    if (state.page.status === 'PUBLISHED') {
      bar.appendChild(el('button', {
        class: 'btn', type: 'button',
        onClick: () => confirmDialog({
          title: 'Unpublish this page?',
          message: 'Visitors will see the file on disk again until you publish a new draft.',
          danger: true, confirmText: 'Unpublish',
          onConfirm: async () => {
            try {
              state.page = await Api.adminUnpublishPage(route);
              toast('Unpublished.', 'ok');
              rebuild();
            } catch (ex) { toast(ex.message || 'Could not unpublish', 'error'); }
          },
        }),
      }, 'Unpublish'));
      bar.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => publishFlow(state),
      }, 'Publish changes'));
    } else {
      bar.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => publishFlow(state),
      }, 'Publish'));
    }
    bar.appendChild(el('button', {
      class: 'btn ghost', type: 'button',
      onClick: () => showRevisions(state, route),
    }, 'Revision history'));
    wrap.appendChild(bar);

    if (state.page.publishedAt) {
      body.appendChild(el('p', { class: 'muted small' },
        'Last published ' + new Date(state.page.publishedAt).toLocaleString() + '.'));
    }
    paintStatus();
    // Paint the preview on first load and after any structural change, so the
    // pane is never blank waiting for a keystroke.
    queuePreview();
  };

  const publishFlow = async (st) => {
    if (st.dirty) {
      try {
        st.page = await Api.adminSavePageDraft(route, st.title, st.blocks);
        st.dirty = false;
      } catch (ex) { toast(ex.message || 'Save the draft first', 'error'); return; }
    }
    const err = el('div', { class: 'form-error', hidden: true });
    const confirm = el('input', { class: 'input', id: 'publish-confirm', type: 'text', placeholder: route });
    const modal = openModal({
      title: st.page.legal ? 'Publish a legal page?' : 'Publish this page?',
      body: el('div', { class: 'admin-form' }, err,
        st.page.legal
          ? el('div', { class: 'draft-note', role: 'note' },
            el('strong', {}, 'This page may contain legal or privacy terms. Verify the content before publishing.'))
          : null,
        el('p', { class: 'muted small' }, 'Visitors see the change immediately.'),
        el('div', { class: 'field' },
          el('label', { for: 'publish-confirm' }, 'Type /' + route + ' to confirm'), confirm)),
      footer: [
        el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onClick: async () => {
          err.hidden = true;
          try {
            st.page = await Api.adminPublishPage(route, confirm.value);
            modal.close();
            toast('Published.', 'ok');
            rebuild();
          } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not publish'; }
        } }, 'Publish'),
      ],
    });
    confirm.focus();
  };

  const showRevisions = async (st) => {
    let list = [];
    try { list = await Api.adminPageRevisions(route); } catch (ex) { toast(ex.message || 'Could not load history', 'error'); return; }
    const box = el('div', { class: 'card-list' });
    if (!list.length) box.appendChild(emptyState('', 'No revisions yet.', 'Save a draft to start the history.'));
    for (const rev of list) {
      const row = el('div', { class: 'card card--list--row' });
      row.appendChild(el('span', { class: 'status-chip ' + (rev.state === 'PUBLISHED' ? 'resolved' : 'open') }, '#' + rev.revision));
      const info = el('div', { class: 'grow' });
      info.appendChild(el('div', { class: 'muted small' },
        rev.state.toLowerCase() + ' · ' + new Date(rev.created_at).toLocaleString()));
      row.appendChild(info);
      const acts = el('div', { class: 'card--list__actions' });
      acts.appendChild(el('button', {
        class: 'btn sm', type: 'button',
        onClick: () => confirmDialog({
          title: 'Restore revision ' + rev.revision + '?',
          message: 'Its content becomes the current draft. Nothing is deleted: this creates a new revision.',
          confirmText: 'Restore',
          onConfirm: async () => {
            try {
              const page = await Api.adminRestorePageRevision(route, rev.revision);
              st.page = page;
              st.title = page.title;
              st.blocks = (page.draft || []).map((b) => JSON.parse(JSON.stringify(b)));
              st.dirty = false;
              modal.close();
              toast('Restored as a new draft.', 'ok');
              rebuild();
            } catch (ex) { toast(ex.message || 'Could not restore', 'error'); }
          },
        }),
      }, 'Restore'));
      row.appendChild(acts);
      box.appendChild(row);
    }
    const modal = openModal({ title: 'Revision history', body: box });
  };

  Api.adminPage(route).then((page) => {
    state.page = page;
    state.title = page.title;
    state.blocks = (page.draft || []).map((b) => JSON.parse(JSON.stringify(b)));
    state.dirty = false;
    rebuild();
  }).catch((ex) => {
    clear(body);
    body.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load the page.'));
  });
}

export async function renderAdminPages(container, { route } = {}) {
  if (route) {
    pageEditor(container, route);
    return;
  }
  // The editor hid the shell's context header for itself. Leaving it set would
  // take the header away from the page list too, and from whatever the member
  // navigates to next.
  delete document.documentElement.dataset.fullpage;
  clear(container);
  renderContextHeader({ title: 'Pages', sub: 'Public pages an editor can change' });
  // Same frame as every other admin section, so Pages is not the one surface
  // with the nav stacked above the content instead of beside it.
  const { frame, pane: body } = settingsFrame({ scope: 'admin', active: 'pages', contentClass: 'settings-body' });
  const wrap = el('div', { class: 'page atrium' }, frame);
  wrap.appendChild(sectionHead('Pages', 'Public pages an editor can change.'));
  body.appendChild(el('p', { class: 'muted small' },
    'These pages ship as templates. The sections describing what the software does are accurate everywhere; '
    + 'the fields marked OPERATOR are yours to fill in. Editing a draft does not change what visitors see until you publish.'));
  const list = el('div', {});
  list.appendChild(pageList(() => {}));
  body.appendChild(list);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

export default { renderAdminPages };
