// from a fixed vocabulary: there is no HTML box, and the server escapes
import Api from './api.js';
import State from './state.js';
import { esc, el, clear, toast, openModal, confirmDialog } from './ui.js';
import { emptyState } from './components.js';
import { renderContextHeader } from './shell.js';

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
        onClick: () => { location.hash = '#/admin/pages/' + p.route; },
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
        row.appendChild(el('div', { class: 'field' }, el('label', {}, 'Text'), h));
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
        row.appendChild(el('div', { class: 'field' }, el('label', {}, 'Text'), ta));
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
        row.appendChild(el('div', { class: 'field' }, el('label', {}, 'Text'), t));
        row.appendChild(el('div', { class: 'field' },
          el('label', {}, 'Target'), h,
          el('span', { class: 'hint' }, 'http, https, mailto, or a path starting with /')));
      } else if (b.type === 'rule') {
        row.appendChild(el('p', { class: 'muted small' }, 'A horizontal rule.'));
      } else {
        const ta = el('textarea', { class: 'textarea', rows: 3, value: b.text || '' });
        ta.addEventListener('input', () => { b.text = ta.value; onChange(); });
        row.appendChild(el('div', { class: 'field' }, el('label', {}, 'Text'), ta));
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

function pageEditor(container, route) {
  clear(container);
  renderContextHeader({ title: 'Pages', sub: '/' + route });

  const wrap = el('div', { class: 'page atrium settings-layout' });
  const body = el('div', { class: 'settings-body' });
  wrap.appendChild(body);
  container.appendChild(wrap);

  const state = { blocks: [], title: '', page: null, dirty: false };

  const markDirty = () => { state.dirty = true; paintStatus(); };
  const paintStatus = () => {
    const s = body.querySelector('[data-dirty]');
    if (s) s.textContent = state.dirty ? 'Unsaved changes' : 'Saved';
  };

  const rebuild = () => {
    clear(body);

    body.appendChild(el('div', { class: 'row-line' },
      el('button', {
        class: 'btn ghost', type: 'button',
        onClick: () => { location.hash = '#/admin/pages'; },
      }, 'All pages'),
      el('span', { class: 'muted small', 'data-dirty': '' }, 'Saved')));

    const title = el('input', { class: 'input', id: 'page-title', type: 'text', value: state.title });
    title.addEventListener('input', () => { state.title = title.value; markDirty(); });
    body.appendChild(el('div', { class: 'field' }, el('label', { for: 'page-title' }, 'Page title'), title));

    if (state.page.legal) {
      body.appendChild(el('div', { class: 'draft-note', role: 'note' },
        el('strong', {}, 'This is a legal page. '),
        'Publishing is visible to everyone immediately and is written to the audit log. Check the content carefully before you publish.'));
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

    const bar = el('div', { class: 'row-line' });
    bar.appendChild(el('button', {
      class: 'btn', type: 'button',
      onClick: () => Api.adminPreviewPage(route, state.blocks)
        .then((r) => openModal({ title: 'Preview', body: el('div', { class: 'prose', html: r.html }) }))
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
    body.appendChild(bar);

    if (state.page.publishedAt) {
      body.appendChild(el('p', { class: 'muted small' },
        'Last published ' + new Date(state.page.publishedAt).toLocaleString() + '.'));
    }
    paintStatus();
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
  clear(container);
  renderContextHeader({ title: 'Pages', sub: 'Public pages an operator can edit' });
  const wrap = el('div', { class: 'page atrium' });
  wrap.appendChild(el('p', { class: 'muted small' },
    'These pages ship as templates. The sections describing what the software does are accurate everywhere; '
    + 'the fields marked OPERATOR are yours to fill in. Editing a draft does not change what visitors see until you publish.'));
  const body = el('div', { class: 'settings-body' });
  const list = el('div', {});
  list.appendChild(pageList(() => {}));
  body.appendChild(list);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

export default { renderAdminPages };
