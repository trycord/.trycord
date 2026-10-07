import Api from '../api.js';
import { esc, el, btn, relTime } from '../ui.js';
import { navigate } from '../nav.js';
import { currentSeq, statTile } from './shared.js';

import { statusChip } from '../components.js';

export async function renderOverview(body, show, seq) {
  const data = await Api.adminOverview();
  if (seq !== currentSeq()) return;
  const grid = el('div', { class: 'admin-stats' });
  grid.append(
    statTile('Users', data.users),
    statTile('Communities', data.servers),
    statTile('Enforced accounts', data.enforcedUsers),
    statTile('Open reports', data.openReports),
    statTile('Open appeals', data.openAppeals));
  const recent = el('div', { class: 'admin-block' });
  recent.appendChild(el('div', { class: 'section-label' }, 'Recent audit activity'));
  if (!data.recentAudit || !data.recentAudit.length) {
    recent.appendChild(el('div', { class: 'muted small' }, 'No activity yet.'));
  } else {
    for (const a of data.recentAudit || []) {
      recent.appendChild(el('div', { class: 'admin-history-row' },
        statusChip(a.action),
        el('div', { class: 'grow' },
          el('div', {}, el('span', { class: 'muted small' }, esc(a.targetType || '') + ' '), esc(a.targetId || '')),
          el('div', { class: 'muted small' }, '…')),
        el('div', { class: 'muted small admin-when' }, relTime(a.createdAt))));
    }
  }
  recent.appendChild(el('div', { class: 'row-line admin-more' },
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => { navigate('/admin/audit'); } }, 'Open audit log')));
  show(el('div', { class: 'admin-block admin-block--sections' }, grid, recent));
}
