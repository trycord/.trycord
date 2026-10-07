import { currentRoute } from './route.js';
import { memberMenu } from './menus.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from '../components.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from '../state.js';
import { navigate, route } from '../nav.js';
import { layoutUsesSidebar, layoutUsesMembers } from '../layout.js';

// The member panel: who is here, what they can do, and how to change it.

const LS_HIDE_MEMBERS = 'trycord.hideMembers';

export function membersHidden() {
  try { return localStorage.getItem(LS_HIDE_MEMBERS) === '1'; } catch { return false; }
}

export function toggleMembers() {
  try {
    localStorage.setItem(LS_HIDE_MEMBERS, membersHidden() ? '0' : '1');
  } catch { /* ignore */ }
  renderMemberSidebar(qs('#member-sidebar'));
}

export function renderMemberSidebar(region) {
  clear(region);
  // A member panel only means something inside a community. The route's layout
  // decides that, not the panel's own guess about the path, so a surface that
  // has no member panel cannot leave one reserving width it will not fill.
  if (!isAuthed() || !layoutUsesMembers() || !currentServerId()
    || !State.serverDetail || !currentRoute().startsWith('/server/')) {
    region.hidden = true;
    return;
  }
  if (membersHidden()) {
    region.hidden = true;
    return;
  }
  region.hidden = false;
  const server = State.serverDetail;
  const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;
  region.appendChild(el('div', { class: 'member-sidebar__header' },
    el('span', {}, 'Members'),
    el('span', { class: 'member-count' }, String(onlineCount) + ' online')
  ));

  const roles = Array.isArray(State.roles) ? [...State.roles].sort((a,b) => (Number(b.position)||0) - (Number(a.position)||0)) : [];
  const roleById = new Map(roles.map(r => [String(r.id), r]));
  const groups = new Map();
  const roleKey = (member) => {
    if (member.is_owner) return '__owner__';
    const top = Array.isArray(member.roles) && member.roles.length
      ? member.roles.map(r => roleById.get(String(r.id)) || r).sort((a,b) => (Number(b.position)||0) - (Number(a.position)||0))[0]
      : null;
    return top ? String(top.id) : '__member__';
  };
  for (const m of State.members || []) {
    const k = roleKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const order = ['__owner__', ...roles.map(r => String(r.id)), '__member__'];
  const seen = new Set();
  for (const key of order) {
    if (seen.has(key)) continue; seen.add(key);
    const members = groups.get(key) || [];
    if (!members.length) continue;
    let label = 'MEMBERS';
    if (key === '__owner__') label = 'OWNER';
    else if (key !== '__member__') {
      const role = roleById.get(key);
      label = role ? String(role.name || 'ROLE').toUpperCase() : 'ROLE';
    }
    const group = el('section', { class: 'member-group' });
    const groupLabel = el('div', { class: 'member-group__label' }, label + ' · ' + members.length);
    if (key !== '__owner__' && key !== '__member__') {
      const role = roleById.get(key);
      if (role && role.color) groupLabel.style.color = role.color;
    }
    group.appendChild(groupLabel);
    for (const m of members) {
      const id = m.user_id || m.id;
      const name = m.nickname || m.display_name || m.username || 'Unknown';
      const rolesForMember = Array.isArray(m.roles) ? m.roles : [];
      const top = m.is_owner ? null
        : rolesForMember.map((r) => roleById.get(String(r.id)) || r)
          .sort((a, b) => Number(b.position || 0) - Number(a.position || 0))[0] || null;
      const rowWrap = el('div', { class: 'member-row-wrap' });
      const row = el('button', { class: 'row row--member', type: 'button', title: '@' + (m.username || '') });
      row.appendChild(avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'sm', withPresence: true }));
      const info = el('span', { class: 'member-item__info' });
      const nameLine = el('span', { class: 'member-item__name' }, name);
      if (m.is_bot) nameLine.appendChild(el('span', { class: 'bot-tag' }, 'BOT'));
      info.appendChild(nameLine);
      const roleText = m.is_owner ? 'Owner' : (top && top.name) || 'Member';
      const roleLine = el('span', { class: 'member-item__role' });
      if (top && top.color) roleLine.appendChild(el('span', { class: 'role-color-dot', style: { background: top.color } }));
      roleLine.appendChild(el('span', {}, roleText));
      info.appendChild(roleLine);
      row.appendChild(info);
      row.addEventListener('click', () => { navigate('/users/' + id); });
      attachContextMenu(row, memberMenu(m), {
        target: (node) => ({ type: 'member', id: String(m.user_id || m.id) }),
      });
      let hoverTimer = null;
      const hoverCapable = () => {
        try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return true; }
      };
      row.addEventListener('mouseenter', () => {
        if (!hoverCapable()) return;
        hoverTimer = setTimeout(() => {
          const r = row.getBoundingClientRect();
          showUserCard(r.right + 8, r.top, {
            avatarEl: avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'lg', withPresence: true }),
            title: name,
            sub: '@' + (m.username || 'unknown'),
            statusLine: m.status_text || null,
            actions: [],
          });
        }, 420);
      });
      const clearHover = () => { clearTimeout(hoverTimer); hoverTimer = null; };
      row.addEventListener('mouseleave', clearHover);
      row.addEventListener('click', clearHover);
      rowWrap.appendChild(row);
      group.appendChild(rowWrap);
    }
    region.appendChild(group);
  }
  if (!(State.members || []).length) {
    region.appendChild(el('div', { class: 'member-sidebar__empty' }, 'No members to show yet.'));
  }
}


// `icon` is destructured to iconGlyph rather than bound as `icon`: the imported
// icon() below builds the navigation toggle, and a parameter of the same name
// shadowed it. Every caller omits it, so icon() resolved to undefined and threw
// "icon is not a function" on every single header render - which is every page.
// The public { icon } key is unchanged; only the local binding is renamed.
