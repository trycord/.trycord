import Api from '../api.js';
import { esc, el, clear, relTime, fullTime } from '../ui.js';
import { emptyState } from '../components.js';
import { adminError, currentSeq, debounced, reportListFailure } from './shared.js';

import { statusChip } from '../components.js';

function auditRow(a) {
  const row = el('div', { class: 'card card--list--row' });
  row.appendChild(statusChip(a.action));
  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, libChip(a.target_type), ' ', el('span', { class: 'muted small' }, '#' + esc(a.target_id))),
    el('div', { class: 'muted small' }, (a.actor_name ? 'by ' + esc(a.actor_name) : esc(a.actor_id || '')) + (a.target_name ? ' · ' + esc(a.target_name) : '')),
    a.reason ? el('div', { class: 'muted small' }, esc(String(a.reason).slice(0, 160))) : null);
  row.appendChild(idt);
  row.appendChild(el('div', { class: 'muted small admin-when' }, relTime(a.created_at)));
  row.title = fullTime(a.created_at);
  return row;
}

function libChip(type) {
  return el('span', { class: 'admin-tag' }, esc(type || ''));
}

export async function renderAudit(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Filter by action, e.g. MODERATION_ACCOUNT_BAN…', 'aria-label': 'Filter audit log by action' });
  const info = el('span', { class: 'muted small' }, 'This instance keeps the most recent entries per query.');
  toolbar.append(search, info);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (action) => {
    listWrap.setAttribute('aria-busy', 'true');
    clear(listWrap);
    try {
      const found = await Api.adminAudit({ action });
      if (seq !== currentSeq()) return;
      if (!found || !found.length) {
        listWrap.appendChild(emptyState('', 'No audit entries.', 'Try a different action filter.'));
        return;
      }
      for (const a of found) listWrap.appendChild(auditRow(a));
    } catch (ex) {
      listWrap.appendChild(el('p', { class: 'form-error' }, adminError(ex, 'Could not load audit entries.')));
    } finally {
      listWrap.removeAttribute('aria-busy');
    }
  };
  search.addEventListener('input', debounced(() => render(search.value.trim().toUpperCase()).catch(reportListFailure(listWrap))));
  await render(search.value.trim().toUpperCase());
}
