import Api from '../api.js';
import State from '../state.js';

import { can, enterServer, peerPresence, refreshBans, setViewRefresh } from '../state.js';
import { clear, confirmDialog, el, openModal, relTime, toast, attachContextMenu } from '../ui.js';
import { avatar, emptyState } from '../components.js';
import { errorState, loadingState, onStale } from '../view-states.js';
import { renderContextHeader, memberActions } from '../shell.js';
import { openRoleAssignModal, rolePill } from '../role-assignment.js';
import { userNameButton } from '../user-actions.js';
import {
  openNicknameModal, openBanModal, openTimeoutModal,
} from './member-moderation.js';
import { ensureServer, reloadServer } from '../workspace-shared.js';
import { navigate } from '../nav.js';

function memberTopRole(m) {
  const roles = Array.isArray(m.roles) ? m.roles : [];
  const byId = new Map((State.roles || []).map((r) => [String(r.id), r]));
  let top = null;
  for (const r of roles) {
    const full = byId.get(String(r.id)) || r;
    if (!top || Number(full.position || 0) > Number(top.position || 0)) top = full;
  }
  return top;
}

function timedOutUntil(m) {
  if (!m || !m.timeout_expires_at) return null;
  const t = new Date(m.timeout_expires_at).getTime();
  return Number.isFinite(t) && t > Date.now() ? m.timeout_expires_at : null;
}





async function renderServerMembers(container, serverId) {
  clear(container);
  // Before the community is even loaded. Everything below sits behind an await, so
  // without this the page is a blank surface until the server detail and the member list
  // both arrive - which reads as broken rather than as waiting.
  const opening = loadingState('Opening community');
  container.appendChild(opening);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { opening.remove(); container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  renderContextHeader({ title: 'Members', sub: server.name });
  const wrap = el('div', { class: 'page community-manager' });
  const counts = el('div', { class: 'stat-inline' });
  wrap.appendChild(counts);

  const toolbar = el('div', { class: 'community-manager__toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search members…' });
  const roleFilter = el('select', { class: 'input sm', title: 'Filter by role' });
  roleFilter.appendChild(el('option', { value: 'all' }, 'All roles'));
  const presFilter = el('select', { class: 'input sm', title: 'Filter by presence' });
  presFilter.appendChild(el('option', { value: 'all' }, 'All statuses'));
  presFilter.appendChild(el('option', { value: 'online' }, 'Online'));
  presFilter.appendChild(el('option', { value: 'offline' }, 'Offline'));
  const botsOnly = el('input', { type: 'checkbox' });
  const sortSel = el('select', { class: 'input sm', title: 'Sort members' });
  [['name', 'Sort: name'], ['newest', 'Sort: newest'], ['oldest', 'Sort: oldest'], ['role', 'Sort: top role']].forEach(([v, label]) => {
    sortSel.appendChild(el('option', { value: v }, label));
  });
  toolbar.append(search, roleFilter, presFilter, el('label', { class: 'switch' }, botsOnly, ' Bots only'), sortSel);
  wrap.appendChild(toolbar);

  const list = el('div', { class: 'community-list' });
  // paint() clears this list first, so the spinner is replaced by rows rather than
  // sitting above them.
  list.appendChild(loadingState('Loading members'));
  wrap.appendChild(list);
  const banSection = el('div', {});
  let bansFailed = false;
  // Only when the viewer can see bans at all - otherwise nothing would ever clear it.
  if (can('BAN_MEMBERS')) banSection.appendChild(loadingState('Loading bans'));
  wrap.appendChild(banSection);

  const loadBans = async () => {
    if (!can('BAN_MEMBERS')) return;
    try {
      await refreshBans();
      bansFailed = false;
    } catch {
      // Keeping the previous value is right - a stale ban list is still a real
      // one - but on a first load there is no previous value, and paint() then
      // renders 'No active bans.' That is a moderator being told nobody is
      // banned when the request is what would have told them so.
      bansFailed = !(State.bans && State.bans.length);
    }
  };

  // Three steps, in increasing cost, and the difference between them is the difference
  // between answering a question and re-asking it:
  //
  //   paint    - draw what state already holds. A filter change, a sort, a new keystroke.
  //   refresh  - the community is already in state and the live-event handlers have
  //     refetched whatever changed, so only the bans need reading. Five requests to
  //     learn nothing is what re-entering the community here would cost.
  //   reload   - someone just kicked a member, lifted a ban or changed a role from this
  //     page, and until the community is read again the list they are looking at is a
  //     picture of a state that no longer exists.
  const refresh = async () => {
    await loadBans();
    paint();
  };

  const reload = async () => {
    await reloadServer(serverId);
    await refresh();
  };
  setViewRefresh(() => { refresh().catch(onStale('Members')); });

  const paint = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const roleId = roleFilter.value || 'all';
    const pres = presFilter.value;
    const bots = botsOnly.checked;
    const sort = sortSel.value;
    const online = (m) => peerPresence(m.user_id || m.id) === 'online';
    let members = (State.members || []).filter((m) => {
      if (q && ![m.username, m.display_name, m.nickname].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      if (roleId !== 'all' && !(Array.isArray(m.roles) && m.roles.some((r) => String(r.id) === roleId))) return false;
      if (pres !== 'all' && (online(m) ? 'online' : 'offline') !== pres) return false;
      if (bots && !m.is_bot) return false;
      return true;
    });
    const dispName = (m) => m.nickname || m.display_name || m.username || 'Unknown';
    const topPos = (m) => { const t = memberTopRole(m); return t ? Number(t.position || 0) : -1; };
    members = [...members].sort((a, b) => {
      if (sort === 'newest') return String(b.joined_at || '').localeCompare(String(a.joined_at || ''));
      if (sort === 'oldest') return String(a.joined_at || '').localeCompare(String(b.joined_at || ''));
      if (sort === 'role') return topPos(b) - topPos(a) || dispName(a).localeCompare(dispName(b));
      return dispName(a).localeCompare(dispName(b));
    });

    const loaded = (State.members || []).length;
    const total = typeof State.memberTotal === 'number' ? State.memberTotal : loaded;
    const onlineCount = (State.members || []).filter(online).length;
    clear(counts);
    if (loaded < total) {
      counts.appendChild(el('span', {}, 'Showing ' + loaded + ' of ' + total + ' members · ' + onlineCount + ' online so far'));
    } else {
      counts.appendChild(el('span', {}, total + ' total · ' + onlineCount + ' online'));
    }
    if (State.memberHasMore) {
      const more = el('button', { class: 'btn sm', type: 'button' }, 'Load more members');
      more.addEventListener('click', async () => {
        more.disabled = true;
        more.textContent = 'Loading…';
        try {
          const res = await Api.serverMembers(serverId, { limit: 200, offset: State.members.length });
          const extra = (res && res.items) || [];
          const seen = new Set((State.members || []).map((m) => String(m.user_id || m.id)));
          for (const m of extra) {
            const id = String(m.user_id || m.id);
            if (seen.has(id)) continue;   // a page boundary must not duplicate a row
            seen.add(id);
            State.members.push(m);
          }
          State.memberTotal = res.total;
          State.memberHasMore = !!res.hasMore;
          paint();
        } catch (ex) {
          more.disabled = false;
          more.textContent = 'Try again';
          toast(ex.message || 'Could not load more members', 'error');
        }
      });
      counts.appendChild(more);
    }

    const curRole = roleFilter.value;
    clear(roleFilter);
    roleFilter.appendChild(el('option', { value: 'all' }, 'All roles'));
    for (const r of [...(State.roles || [])].sort((a, b) => Number(b.position || 0) - Number(a.position || 0))) {
      const o = el('option', { value: String(r.id) }, (r.name || 'Role'));
      if (String(r.id) === curRole) o.selected = true;
      roleFilter.appendChild(o);
    }
    roleFilter.value = [...roleFilter.options].some((o) => o.value === curRole) ? curRole : 'all';

    if (!members.length) {
      list.appendChild(emptyState('search', 'No members found', 'Try a different search or filter.'));
    }
    for (const m of members) {
      const id = m.user_id || m.id;
      const mine = String(id) === String(State.me && State.me.id);
      const row = el('article', { class: 'card card--list' });
      attachContextMenu(row, () => memberActions(m), {
        target: () => ({ type: 'member', id: String(id) }),
      });
      row.appendChild(avatar({ id, username: m.username, displayName: m.nickname || m.display_name, avatarUrl: m.avatar_url }, { size: 'sm', withPresence: true }));
      const info = el('div', { class: 'card--list__info' });
      const nameLine = el('div', { class: 'member-name-line' },
        userNameButton(
          { id, username: m.username, displayName: m.nickname || m.display_name, avatarUrl: m.avatar_url, roles: m.roles },
          { className: 'member-name-btn', serverId, label: dispName(m) }
        ),
        m.is_bot ? el('span', { class: 'bot-tag' }, 'BOT') : null);
      info.appendChild(nameLine);
      const sub = '@' + (m.username || 'unknown') +
        (m.joined_at ? ' · joined ' + relTime(m.joined_at) : '') +
        (m.status_text ? ' · ' + m.status_text : '');
      info.appendChild(el('span', { class: 'muted small' }, sub));
      const to = timedOutUntil(m);
      if (to) info.appendChild(el('span', { class: 'badge warn' }, 'Timed out · ' + relTime(to)));
      const roles = Array.isArray(m.roles) ? m.roles : [];
      const roleBox = el('div', { class: 'role-pills' });
      if (m.is_owner) roleBox.appendChild(el('span', { class: 'role-pill owner' }, 'Owner'));
      for (const r of roles.slice(0, 8)) {
        roleBox.appendChild(rolePill(r, {
          removable: can('MANAGE_ROLES') && !m.is_owner,
          onRemove: async () => {
            try { await Api.unassignRole(serverId, r.id, id); await reload(); toast('Role removed.', 'ok'); }
            catch (ex) { toast(ex.message || 'Could not remove role.', 'error'); }
          },
        }));
      }
      if (!m.is_owner && !roles.length) roleBox.appendChild(el('span', { class: 'role-pill muted-role' }, 'Member'));
      info.appendChild(roleBox);
      row.appendChild(info);
      const actions = el('div', { class: 'card--list__actions' });
      actions.appendChild(el('button', { class: 'btn sm', type: 'button', onClick: () => { navigate('/users/' + id); } }, 'Profile'));
      if (mine || can('KICK_MEMBERS')) {
        actions.appendChild(el('button', { class: 'btn sm', type: 'button', onClick: () => openNicknameModal(serverId, m, () => renderMemberList(wrap, serverId)) }, 'Nickname'));
      }
      if (can('MANAGE_ROLES') && !m.is_owner) {
        const manage = el('button', {
          class: 'btn sm', type: 'button',
          title: 'Assign or remove roles for this member',
        }, 'Roles');
        manage.addEventListener('click', () => openRoleAssignModal({
          serverId, member: m, onChanged: reload,
        }));
        actions.appendChild(manage);
      }
      if (!m.is_owner && !mine && can('KICK_MEMBERS')) {
        actions.appendChild(el('button', { class: 'btn danger sm', type: 'button', onClick: () => {
          confirmDialog({
            title: 'Remove member?', message: '@' + (m.username || '') + ' will leave this community immediately.',
            danger: true, confirmText: 'Remove',
            onConfirm: async () => {
              try { await Api.kickMember(serverId, id); await reload(); toast('Member removed.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not remove member.', 'error'); }
            },
          });
        } }, 'Kick'));
      }
      if (!m.is_owner && !mine && can('BAN_MEMBERS')) {
        actions.appendChild(el('button', { class: 'btn danger sm', type: 'button', onClick: () => openBanModal(serverId, m, reload) }, 'Ban'));
        actions.appendChild(el('button', { class: 'btn sm', type: 'button', onClick: () => openTimeoutModal(serverId, m, reload) }, 'Timeout'));
      }
      row.appendChild(actions);
      list.appendChild(row);
    }

    clear(banSection);
    if (can('BAN_MEMBERS')) {
      banSection.appendChild(el('div', { class: 'section-label' }, 'Banned (' + (State.bans || []).length + ')'));
      if (bansFailed) {
        banSection.appendChild(errorState('Could not load bans.', reload));
      } else if (!(State.bans || []).length) {
        banSection.appendChild(el('p', { class: 'muted small' }, 'No active bans.'));
      }
      const blist = el('div', { class: 'community-list' });
      for (const b of State.bans || []) {
        const row = el('article', { class: 'card card--list' });
        const info = el('div', { class: 'card--list__info' });
        info.appendChild(el('strong', {}, b.displayName || b.username || 'Unknown'));
        info.appendChild(el('span', { class: 'muted small' },
          '@' + (b.username || '?') +
          (b.reason ? ' · ' + b.reason : '') +
          (b.expiresAt ? ' · expires ' + relTime(b.expiresAt) : ' · permanent') +
          (b.actorName ? ' · by ' + b.actorName : '')));
        row.appendChild(info);
        const unban = el('button', { class: 'btn sm', type: 'button' }, 'Unban');
        unban.addEventListener('click', async () => {
          try { await Api.unbanMember(serverId, b.userId); await reload(); toast('Ban lifted.', 'ok'); }
          catch (ex) { toast(ex.message || 'Could not lift ban.', 'error'); }
        });
        row.appendChild(el('div', { class: 'card--list__actions' }, unban));
        blist.appendChild(row);
      }
      banSection.appendChild(blist);
    }
  };
  // The filters are a view concern over data that is already here, so they redraw
  // rather than refetch.
  search.addEventListener('input', paint);
  roleFilter.addEventListener('change', paint);
  presFilter.addEventListener('change', paint);
  botsOnly.addEventListener('change', paint);
  sortSel.addEventListener('change', paint);
  // The page goes up before the data it fills arrives. Tearing down the "Opening
  // community" state and only then awaiting the first fetch left the container empty for
  // the length of the bans request, which reads as a page that failed rather than one
  // that is working.
  container.appendChild(wrap);
  opening.remove();
  await refresh();
}

// Role management, as a hierarchy rather than a permission checklist.

function renderMemberList(wrap, serverId) {
  const old = wrap.querySelector('.member-list');
  if (old) old.remove();
  const listBox = el('div', { class: 'member-list' });
  const canNickname = can('KICK_MEMBERS') || can('*');
  for (const m of (State.members || []).slice(0, 24)) {
    const row = el('div', { class: 'row' });
    const rid = m.user_id || m.id;
    const avatarEl = avatar({ id: rid, username: m.username, displayName: m.display_name, avatarUrl: m.avatar_url }, { withPresence: true });
    avatarEl.style.cursor = 'pointer';
    avatarEl.addEventListener('click', () => { navigate('/users/' + rid); });
    row.appendChild(avatarEl);
    const mm = el('div', { class: 'row-main' });
    const member = {
      id: rid,
      username: m.username,
      displayName: m.display_name,
      avatarUrl: m.avatar_url,
      roles: m.roles,
    };
    const nameEl = userNameButton(member, { className: 'member-name-btn', serverId });
    mm.appendChild(nameEl);
    const sub = m.nickname
      ? '@' + (m.username || '') + (m.display_name && m.display_name !== m.username ? ' · ' + m.display_name : '')
      : '@' + (m.username || '');
    mm.appendChild(el('div', { class: 'row-sub' }, sub));
    row.appendChild(mm);
    const mine = State.me && String(rid) === String(State.me.id);
    if (mine || canNickname) {
      const nick = el('button', { class: 'btn sm', type: 'button', title: 'Set nickname' }, 'nick');
      nick.addEventListener('click', () => openNicknameModal(serverId, m, () => renderMemberList(wrap, serverId)));
      row.appendChild(nick);
    }
    listBox.appendChild(row);
  }
  wrap.appendChild(listBox);
}

export { renderServerMembers, renderMemberList };
