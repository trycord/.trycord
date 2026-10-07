import Api from '../../api.js';
import { el, btn } from '../../ui.js';
import { emptyState } from '../../components.js';
import { navigate } from '../../nav.js';
import { statusChipFor } from './blocks.js';

export function pageList(refresh) {
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
        onClick: () => { navigate('/admin/pages/' + p.route); },
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
