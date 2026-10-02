// The community settings surface: overview, appearance, structure, members,
// roles, invites, moderation, plus the ownership-transfer and danger-zone
// controls.
import Api from './api.js';
import State from './state.js';

import { can, leaveServerContext, peerPresence, refreshServers, setViewRefresh } from './state.js';
import { clear, confirmDialog, el, relTime, toast } from './ui.js';
import { communityMark, invalidateAuthedImage, loadAuthedImage } from './components.js';
import { renderContextHeader } from './shell.js';
import { ensureServer } from './workspace-shared.js';
import { serverPath } from './links.js';
import { settingsFrame, SETTINGS_IA, findItem } from './settings-shell.js';
import { contextBlock as block, contextFact as fact, contextList as list, contextPara as para } from './context-column.js';
import { sectionHead, sectionCard, setNote } from './settings-ui.js';
import { renderIntegrations } from './pages-integrations.js';
import { renderAnalytics } from './pages-analytics.js';
import { navigate, route } from './nav.js';;

// Community sections are addressed relative to the current community, so the
// href is resolved rather than stored - a stored path would go stale the moment
// a community is renamed or the URL slug changes.
//
// Categories is the exception: it has its own page rather than a settings
// section, so it points there. Sending it to settings/categories would not be a
// 404, which is worse - the router would quietly show Overview.
const SECTION_ROUTE = {
  categories: (serverId) => serverPath(serverId, 'categories'),
};

function resolveCommunityHref(serverId, id) {
  if (SECTION_ROUTE[id]) return SECTION_ROUTE[id](serverId);
  return serverPath(serverId, 'settings', id === 'overview' ? '' : id);
}

function linkedSection({ serverId, title, blurb, href, cta, counts }) {
  const box = el('div', { class: 'settings-panel' });
  box.appendChild(el('h2', { class: 'settings-panel__title' }, title));
  box.appendChild(el('p', { class: 'muted small settings-panel__blurb' }, blurb));
  if (counts && counts.length) {
    const row = el('div', { class: 'role-detail__summary' });
    for (const c of counts) row.appendChild(el('span', {}, c));
    box.appendChild(row);
  }
  const go = el('a', { class: 'btn primary', href: serverPath(serverId, href) }, cta);
  box.appendChild(el('div', { class: 'card-actions' }, go));
  return box;
}

// Kept across range changes so the picker does not spring back to 30 days when
// the section is re-rendered for any other reason.
let analyticsDays = 30;

async function renderServerSettings(container, serverId, section = 'overview') {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  if (!can('MANAGE_SERVER')) {
    renderContextHeader({ title: 'Settings', sub: server.name });
    container.appendChild(el('div', { class: 'form-error' },
      "You need permission to manage this community's settings."));
    return;
  }
  const known = SETTINGS_IA.community.flatMap((g) => g.items).map((i) => i.id);
  if (!known.includes(section)) section = 'overview';
  const item = findItem('community', section);
  renderContextHeader({ title: 'Settings', sub: item && item.blurb ? item.blurb : server.name });

  const { frame, pane, context } = settingsFrame({
    scope: 'community',
    active: section,
    resolve: (id) => resolveCommunityHref(serverId, id),
    contentClass: 'settings-body',
  });
  const wrap = el('div', { class: 'page roles-page' }, frame);
  const panel = pane;
  container.appendChild(wrap);

  // Painted here rather than at the end: every section below finishes with an
  // early return, so a call after them would only run for the one that falls
  // through. The counts come from the same values the pane is built from, so
  // there is no second request and nothing to wait for.
  paintCommunityContext(context, section, server, {
    members: (State.members || []).length,
    channels: ((State.channels && State.channels.channels) || []).length,
    roles: (State.roles || []).length,
  });

  const reload = async () => { await ensureServer(serverId); };
  setViewRefresh(() => { reload().catch(() => {}); });

  const memberCount = (State.members || []).length;
  const channelCount = ((State.channels && State.channels.channels) || []).length;
  const categoryCount = ((State.channels && State.channels.categories) || []).length;
  const roleCount = (State.roles || []).length;
  const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;

  if (section === 'overview') {
    const err = el('div', { class: 'form-error', hidden: true });
    const name = el('input', { class: 'input', type: 'text', value: server.name || '', maxlength: 64 });
    const desc = el('textarea', { class: 'textarea', maxlength: 400, rows: 3, placeholder: 'What is this community about?' }, server.description || '');
    const isPublic = el('input', { type: 'checkbox', checked: !!server.is_public });
    const isDisc = el('input', { type: 'checkbox', checked: !!server.is_discoverable });
    const saveBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Save changes');

    const form = el('form', { class: 'settings-panel' }, err,
      el('h2', { class: 'settings-panel__title' }, 'Identity'),
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Description'), desc,
        el('span', { class: 'hint' }, 'Shown on the community landing page and in browse.')),
      el('h2', { class: 'settings-panel__title' }, 'Visibility'),
      el('div', { class: 'field' },
        el('label', { class: 'switch' }, isPublic, ' Public — anyone with a join code or invite can join'),
        el('span', { class: 'hint' }, 'A private community can only be entered by invitation.')),
      el('div', { class: 'field' },
        el('label', { class: 'switch' }, isDisc, ' Discoverable — listed in the browse feed'),
        el('span', { class: 'hint' }, 'Independent of Public: a private community can still be discoverable by name.')),
      el('div', { class: 'card-actions' }, saveBtn));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      saveBtn.disabled = true;
      try {
        await Api.updateServer(serverId, {
          name: name.value.trim(),
          description: desc.value.trim(),
          isPublic: isPublic.checked,
          isDiscoverable: isDisc.checked,
        });
        await refreshServers();
        await reload();
        toast('Settings saved.', 'ok');
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message || 'Could not save settings.';
      } finally { saveBtn.disabled = false; }
    });
    panel.appendChild(form);

    const facts = el('div', { class: 'settings-panel' });
    facts.appendChild(el('h2', { class: 'settings-panel__title' }, 'At a glance'));
    const summary = el('div', { class: 'role-detail__summary' });
    summary.append(
      el('span', {}, memberCount + ' member' + (memberCount === 1 ? '' : 's')),
      el('span', {}, onlineCount + ' online'),
      el('span', {}, channelCount + ' channel' + (channelCount === 1 ? '' : 's')),
      el('span', {}, categoryCount + ' categor' + (categoryCount === 1 ? 'y' : 'ies')),
      el('span', {}, roleCount + ' role' + (roleCount === 1 ? '' : 's')),
      el('span', {}, server.join_code ? 'Join code ' + server.join_code : 'No join code'));
    facts.appendChild(summary);
    facts.appendChild(el('p', { class: 'muted small' },
      'Created ' + relTime(server.created_at) + '. Every area has its own page — this is the index.'));
    panel.appendChild(facts);
    return;
  }

  if (section === 'appearance') {
    // authenticated media route, so the preview reads them with the session.
    const box = el('div', { class: 'settings-panel' });
    box.appendChild(el('h2', { class: 'settings-panel__title' }, 'Community icon'));
    box.appendChild(el('p', { class: 'muted small settings-panel__blurb' },
      'Shown in the community list, the member sidebar and the browse feed. A square image works best.'));

    const media = el('div', { class: 'community-media' });
    const preview = el('div', { class: 'community-media__preview' });
    const bannerPreview = el('div', { class: 'community-media__banner' });
    const status = el('div', { class: 'muted small', 'aria-live': 'polite' });

    const paint = () => {
      clear(preview);
      preview.appendChild(communityMark(server.name || '?', { size: 'lg', server }));
      preview.appendChild(el('span', { class: 'muted small' },
        server.icon_url ? 'Custom icon set' : 'Using a generated initial'));
      clear(bannerPreview);
      if (server.banner_url) {
        loadAuthedImage(server.banner_url).then((url) => {
          if (url) bannerPreview.style.backgroundImage = 'url("' + url + '")';
        });
        bannerPreview.textContent = '';
      } else {
        bannerPreview.textContent = 'No banner set';
      }
    };
    paint();

    const iconInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
    const bannerInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
    const iconBtn = el('button', { class: 'btn', type: 'button' }, server.icon_url ? 'Replace icon' : 'Upload icon');
    const iconRm = el('button', { class: 'btn ghost sm', type: 'button' }, 'Remove');
    iconRm.hidden = !server.icon_url;
    const bannerBtn = el('button', { class: 'btn', type: 'button' }, server.banner_url ? 'Replace banner' : 'Upload banner');
    const bannerRm = el('button', { class: 'btn ghost sm', type: 'button' }, 'Remove');
    bannerRm.hidden = !server.banner_url;

    const upload = async (kind, file) => {
      if (!file) return;
      if (!/^image\//.test(file.type || '')) { toast('Only images can be used.', 'error'); return; }
      status.textContent = 'Uploading ' + kind + '…';
      const prev = kind === 'icon' ? server.icon_url : server.banner_url;
      try {
        const out = await Api.setServerImage(serverId, kind, file);
        if (prev) invalidateAuthedImage(prev);
        server[kind === 'icon' ? 'icon_url' : 'banner_url'] = out.url;
        await refreshServers();
        await reload();
        paint();
        iconRm.hidden = kind !== 'icon' || !server.icon_url;
        bannerRm.hidden = kind !== 'banner' || !server.banner_url;
        iconBtn.textContent = 'Replace icon';
        bannerBtn.textContent = 'Replace banner';
        status.textContent = kind === 'icon' ? 'Icon updated.' : 'Banner updated.';
        toast(kind === 'icon' ? 'Community icon updated.' : 'Community banner updated.', 'ok');
      } catch (ex) {
        status.textContent = '';
        toast(ex.message || 'Upload failed', 'error');
      }
    };
    const remove = async (kind) => {
      const prev = kind === 'icon' ? server.icon_url : server.banner_url;
      try {
        await Api.removeServerImage(serverId, kind);
        if (prev) invalidateAuthedImage(prev);
        server[kind === 'icon' ? 'icon_url' : 'banner_url'] = null;
        await refreshServers();
        await reload();
        paint();
        if (kind === 'icon') { iconRm.hidden = true; iconBtn.textContent = 'Upload icon'; }
        else { bannerRm.hidden = true; bannerBtn.textContent = 'Upload banner'; }
        status.textContent = (kind === 'icon' ? 'Icon' : 'Banner') + ' removed.';
        toast((kind === 'icon' ? 'Icon' : 'Banner') + ' removed.', 'ok');
      } catch (ex) { toast(ex.message || 'Could not remove that image.', 'error'); }
    };

    iconBtn.addEventListener('click', () => iconInput.click());
    bannerBtn.addEventListener('click', () => bannerInput.click());
    iconInput.addEventListener('change', () => upload('icon', iconInput.files[0]));
    bannerInput.addEventListener('change', () => upload('banner', bannerInput.files[0]));
    iconRm.addEventListener('click', () => remove('icon'));
    bannerRm.addEventListener('click', () => remove('banner'));

    media.append(preview, el('div', { class: 'community-media__actions' }, iconBtn, iconRm, bannerBtn, bannerRm),
      bannerPreview, status, iconInput, bannerInput);
    box.appendChild(media);
    panel.appendChild(box);
    return;
  }

  if (section === 'structure') {
    panel.appendChild(linkedSection({
      serverId,
      title: 'Channels',
      blurb: 'Create and edit text channels, and reorder them within their categories.',
      href: route('/channels/new'),
      cta: 'Create a channel',
      counts: [channelCount + ' channel' + (channelCount === 1 ? '' : 's'), categoryCount + ' categor' + (categoryCount === 1 ? 'y' : 'ies')],
    }));
    panel.appendChild(linkedSection({
      serverId,
      title: 'Categories',
      blurb: 'Group channels so a busy community stays navigable. Categories can also carry their own permission overrides.',
      href: route('/categories'),
      cta: 'Manage categories',
      counts: [categoryCount + ' categor' + (categoryCount === 1 ? 'y' : 'ies')],
    }));
    return;
  }

  if (section === 'members') {
    panel.appendChild(linkedSection({
      serverId,
      title: 'Members',
      blurb: 'Search the roster, assign roles, set nicknames, and remove or ban people. Role assignment respects the hierarchy — you can only hand out roles below your own highest role.',
      href: route('/members'),
      cta: 'Open members',
      counts: [memberCount + ' member' + (memberCount === 1 ? '' : 's'), onlineCount + ' online'],
    }));
    return;
  }

  if (section === 'roles') {
    panel.appendChild(linkedSection({
      serverId,
      title: 'Roles',
      blurb: 'Roles are ordered, and position is what decides what each member may manage. Drag to reorder; permissions are grouped per role. Roles are assigned by people with Manage Roles - members never pick their own.',
      href: route('/roles'),
      cta: 'Open the role hierarchy',
      counts: [roleCount + ' role' + (roleCount === 1 ? '' : 's')],
    }));
    return;
  }

  // These two are full surfaces in their own right. They render into the same
  // pane as the settings rows above rather than into the page, so the nav, the
  // context column and the back link stay identical whichever section is open.
  if (section === 'integrations') {
    await renderIntegrations(panel, serverId);
    return;
  }

  if (section === 'analytics') {
    // Re-rendering only the pane on a range change keeps the nav and the
    // surrounding frame from flickering, and costs one request.
    await renderAnalytics(panel, serverId, {
      days: analyticsDays,
      onRange: async (d) => {
        analyticsDays = d;
        const url = serverPath(serverId, 'settings', 'analytics');
        history.replaceState(null, '', url);
        await renderAnalytics(panel, serverId, { days: d });
      },
    });
    return;
  }

  if (section === 'invites') {
    panel.appendChild(linkedSection({
      serverId,
      title: 'Invites',
      blurb: 'Create and revoke invite links, set use limits and expiry, and copy a link to share.',
      href: route('/invites'),
      cta: 'Manage invites',
    }));
    return;
  }

  if (section === 'moderation') {
    const box = el('div', { class: 'settings-panel' });
    box.appendChild(el('h2', { class: 'settings-panel__title' }, 'Bans'));
    const bans = State.bans || [];
    box.appendChild(el('p', { class: 'muted small' },
      bans.length
        ? bans.length + ' member' + (bans.length === 1 ? ' is' : 's are') + ' currently banned from this community.'
        : 'Nobody is banned from this community.'));
    if (bans.length) {
      const list = el('div', { class: 'role-members' });
      for (const b of bans.slice(0, 20)) {
        list.appendChild(el('div', { class: 'role-holder' },
          el('span', { class: 'role-holder__name' }, '@' + (b.username || b.user_id || 'Unknown')),
          el('span', { class: 'muted small' },
            b.expires_at ? 'until ' + relTime(b.expires_at) : 'permanent')));
      }
      box.appendChild(list);
      if (bans.length > 20) box.appendChild(el('p', { class: 'muted small' }, '+ ' + (bans.length - 20) + ' more'));
    }
    const link = el('div', { class: 'card-actions' },
      el('a', { class: 'btn', href: serverPath(serverId, 'members') }, 'Manage on the member roster'));
    box.appendChild(link);
    panel.appendChild(box);
    return;
  }

  if (section === 'ownership') {
    const isOwner = !!server.is_owner;

    // ---- transfer ownership ----------------------------------------------
    // The leave and delete flows both tell an owner to transfer first, and the
    // capability.
    const transfer = el('div', { class: 'settings-panel' });
    transfer.appendChild(el('h2', { class: 'settings-panel__title' }, 'Transfer ownership'));
    if (!isOwner) {
      transfer.appendChild(el('p', { class: 'muted small' },
        'Only the current owner can transfer this community. You are not the owner.'));
    } else {
      transfer.appendChild(el('p', { class: 'muted small' },
        'Ownership moves to one member. You stay in the community as a member, and only the new owner can transfer it away or delete it.'));
      const err = el('div', { class: 'form-error', hidden: true });
      const select = el('select', { class: 'input', 'aria-label': 'New owner' });
      select.appendChild(el('option', { value: '' }, 'Choose a member…'));
      // Never offer yourself, and never offer the owner row.
      for (const m of State.members || []) {
        const id = m.user_id || m.id;
        if (m.is_owner) continue;
        if (String(id) === String(State.me && State.me.id)) continue;
        select.appendChild(el('option', { value: id },
          (m.nickname || m.display_name || m.username || 'Unknown') + ' (@' + (m.username || '?') + ')'));
      }
      const btn = el('button', { class: 'btn primary', type: 'button' }, 'Transfer ownership');
      btn.addEventListener('click', () => {
        err.hidden = true;
        const target = select.value;
        if (!target) { err.hidden = false; err.textContent = 'Choose who should take ownership.'; return; }
        const label = select.options[select.selectedIndex].textContent;
        confirmDialog({
          title: 'Transfer ownership?',
          message: label + ' becomes the owner of ' + (server.name || 'this community') +
            '. You will remain a member without owner rights. This cannot be undone by you.',
          danger: true,
          confirmText: 'Transfer',
          onConfirm: async () => {
            btn.disabled = true;
            try {
              await Api.transferServer(serverId, target);
              await refreshServers();
              leaveServerContext();
              toast('Ownership transferred.', 'ok');
              navigate('/home');
            } catch (ex) {
              err.hidden = false;
              err.textContent = ex.message || 'Could not transfer ownership.';
              btn.disabled = false;
            }
          },
        });
      });
      transfer.append(err, el('div', { class: 'field' }, el('label', {}, 'New owner'), select),
        el('div', { class: 'card-actions' }, btn));
    }
    panel.appendChild(transfer);

    const danger = el('div', { class: 'settings-panel settings-panel--danger' });
    danger.appendChild(el('h2', { class: 'settings-panel__title' }, 'Danger zone'));

    const leaveBtn = el('button', { class: 'btn danger', type: 'button' }, 'Leave community');
    leaveBtn.addEventListener('click', () => {
      if (isOwner) { toast('You own this community. Transfer or delete it first.', 'warn'); return; }
      confirmDialog({
        title: 'Leave ' + (server.name || 'this community') + '?',
        message: 'You can rejoin later with a new invite.',
        danger: true,
        confirmText: 'Leave',
        onConfirm: async () => {
          try {
            await Api.leaveServer(serverId);
            await refreshServers();
            leaveServerContext();
            navigate('/home');
          } catch (ex) { toast(ex.message || 'Could not leave.', 'error'); }
        },
      });
    });
    danger.appendChild(el('div', { class: 'field' },
      el('label', {}, 'Leave this community'),
      el('p', { class: 'muted small' }, 'Removes you from the roster. Other members are unaffected.'),
      el('div', { class: 'card-actions' }, leaveBtn)));

    if (isOwner) {
      const delInput = el('input', { class: 'input', type: 'text', placeholder: 'Type ' + (server.name || 'the name') + ' to confirm' });
      const delBtn = el('button', { class: 'btn danger', type: 'button' }, 'Delete community');
      delBtn.addEventListener('click', async () => {
        if (delInput.value.trim() !== (server.name || '')) {
          toast('Type the exact community name to confirm.', 'warn');
          return;
        }
        confirmDialog({
          title: 'Delete ' + (server.name || 'this community') + '?',
          message: 'This permanently deletes the community, its channels, messages, roles and memberships. This cannot be undone.',
          danger: true,
          confirmText: 'Delete forever',
          onConfirm: async () => {
            try {
              await Api.deleteServer(serverId);
              await refreshServers();
              leaveServerContext();
              toast('Community deleted.', 'warn');
              navigate('/home');
            } catch (ex) { toast(ex.message || 'Could not delete.', 'error'); }
          },
        });
      });
      danger.appendChild(el('div', { class: 'field' },
        el('label', {}, 'Delete this community'),
        el('p', { class: 'muted small' }, 'Permanent. Everything in this community goes with it.'),
        delInput,
        el('div', { class: 'card-actions' }, delBtn)));
    }
    panel.appendChild(danger);
    return;
  }

}

/**
 * The community settings column.
 *
 * This community's shape, read from the values the pane was already built from,
 * plus what the section governs. No fetch: otherwise these would be a third copy
 * of counts the server has already sent twice.
 */
function paintCommunityContext(host, section, server, counts) {
  if (!host || !server) return;
  const out = [block('This community', list(
    fact('Members', String(counts.members)),
    fact('Channels', String(counts.channels)),
    fact('Roles', String(counts.roles)),
  ))];
  const NOTES = {
    overview: 'These counts move when you change anything on the left.',
    structure: 'Deleting a channel removes its messages with it. A category is only an ordering; moving one does not move its channels anywhere.',
    members: 'A role grants exactly what its permissions say. Holding several roles does not add their permissions together beyond what each grants.',
    roles: 'An override on a channel or category beats the role list for that place only.',
    invites: 'An invite is single-use and expires. Revoking one stops it being used again but does not undo it for anyone who already accepted.',
    moderation: 'A timeout lifts itself when it expires. A ban does not, and only an administrator can lift it.',
    ownership: 'Transferring ownership is immediate and cannot be undone from here.',
    appearance: 'Appearance is per member. Nobody else sees the theme you choose.',
  };
  const note = NOTES[section];
  if (note) out.push(block('About this section', para(note)));
  for (const n of out) host.appendChild(n);
  host.closest('.settings-layout').dataset.hasContext = 'yes';
}

export { renderServerSettings };
