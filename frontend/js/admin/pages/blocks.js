import Api from '../../api.js';
import { el, clear, toast, openModal, confirmDialog, btn } from '../../ui.js';
import { emptyState } from '../../components.js';
import { renderContextHeader } from '../../shell.js';
import { navigate, route } from '../../nav.js';

import { bbcodeField } from './bbcode.js';

export const BLOCK_TYPES = [
  { type: 'heading', label: 'Heading', make: () => ({ type: 'heading', level: 2, text: 'Section' }) },
  { type: 'paragraph', label: 'Paragraph', make: () => ({ type: 'paragraph', text: '' }) },
  { type: 'lead', label: 'Standfirst', make: () => ({ type: 'lead', text: '' }) },
  { type: 'list', label: 'List', make: () => ({ type: 'list', ordered: false, items: [''] }) },
  { type: 'note', label: 'Callout', make: () => ({ type: 'note', kind: 'info', text: '' }) },
  { type: 'link', label: 'Link', make: () => ({ type: 'link', text: 'Link text', href: 'https://' }) },
  { type: 'rule', label: 'Divider', make: () => ({ type: 'rule' }) },
];

export function summaryOf(block) {
  if (!block) return '(empty)';
  if (block.type === 'list') return `${block.items.length} item(s)`;
  if (block.type === 'rule') return 'divider';
  if (block.type === 'link') return `${block.text} → ${block.href}`;
  return block.text || '(empty)';
}

export function statusChipFor(page) {
  if (page.status === 'PUBLISHED') return ['Published', 'resolved'];
  if (page.status === 'DRAFT') return ['Draft', 'open'];
  return ['Not edited', 'dismissed'];
}

export function blockEditor(page, blocks, onChange) {
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

export function pageProse(html) {
  const node = el('div', { class: 'prose', html });
  for (const a of node.querySelectorAll('a[href]')) {
    if (!(a.getAttribute('href') || '').startsWith('#')) a.setAttribute('data-document', '');
  }
  return node;
}

export function pageEditor(container, route) {
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
  renderContextHeader({ title: '/' + route, sub: 'Editing this page' });

  const head = el('header', { class: 'page-editor__bar' });
  const back = el('button', {
    class: 'btn ghost sm', type: 'button',
    onClick: () => { navigate('/admin/pages'); },
  }, '← All pages');
  head.appendChild(back);
  head.appendChild(el('div', { class: 'page-editor__title' }, '/' + route));
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
