// Community integrations: outgoing webhooks and bot applications.
//
// One section for both, because they answer the same question for an
// administrator - "what can post into this community from outside it" - and
// because an application and its slash commands are one object split across two
// tables. The credential rules are the same for both, so they are stated once at
// the top of the section instead of twice inside two panels.
//
// Nothing here keeps a secret in memory after it is shown. A webhook secret and
// an application token are stored hashed, so the only way to obtain one is to
// create or rotate it, and the UI never pretends otherwise by offering to reveal
// a stored one.

import Api from './api.js';
import { clear, confirmDialog, el, openModal, relTime, toast } from './ui.js';
import { sectionHead, sectionCard, settingRow, dangerZone, dangerRow, dangerButton, setEmpty } from './settings-ui.js';

const EVENT_LABELS = {
  'message.created': 'Message posted',
  'member.joined': 'Member joined',
  'member.left': 'Member left',
  'channel.created': 'Channel created',
  'channel.deleted': 'Channel deleted',
  'role.created': 'Role created',
  'role.updated': 'Role changed',
  'role.deleted': 'Role deleted',
  'command.created': 'Slash command used',
};

function copyable(label, value, note) {
  const box = el('div', { class: 'secret-reveal' });
  box.appendChild(el('p', { class: 'muted small' }, note));
  const row = el('div', { class: 'secret-reveal__row' });
  const input = el('input', { class: 'input', type: 'text', readonly: true, value: value, 'aria-label': label });
  const copy = el('button', { class: 'btn', type: 'button' }, 'Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied to clipboard.', 'ok');
    } catch {
      // Clipboard access is refused in some contexts and over plain http; the
      // field is selectable either way, so say so rather than doing nothing.
      input.focus();
      input.select();
      toast('Copy the selected text.', 'info');
    }
  });
  row.append(input, copy);
  box.appendChild(row);
  return box;
}

function deliveryStatus(d) {
  if (d.status === 'delivered') return el('span', { class: 'tag ok' }, 'Delivered');
  if (d.status_code) return el('span', { class: 'tag warn' }, 'HTTP ' + d.status_code);
  return el('span', { class: 'tag bad' }, 'Failed');
}

function webhookPanel(ctx) {
  const box = el('div', { class: 'settings-panel' });
  box.appendChild(sectionHead('Outgoing webhooks', 'This community POSTs an event to a URL you choose. Each request is signed, and the signature travels in x-trycord-signature so the receiver can verify it.'));

  const form = el('form', { class: 'secret-form' });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'Deploy hook', maxlength: '64', 'aria-label': 'Webhook name' });
  const url = el('input', { class: 'input', type: 'url', placeholder: 'https://example.com/hooks/trycord', 'aria-label': 'Webhook URL' });
  const add = el('button', { class: 'btn primary', type: 'submit' }, 'Add webhook');
  form.append(name, url, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = name.value.trim();
    const target = url.value.trim();
    if (!label || !target) { toast('A webhook needs a name and a URL.', 'error'); return; }
    try {
      const res = await Api.createWebhook(ctx.serverId, { name: label, url: target });
      name.value = ''; url.value = '';
      ctx.showWebhookSecret(res.webhook, label);
      await ctx.refreshWebhooks();
    } catch (ex) { toast(ex.message || 'Could not create the webhook.', 'error'); }
  });
  box.appendChild(form);
  box.appendChild(el('p', { class: 'muted small' }, 'HTTPS only. Addresses inside this instance\'s own network are refused.'));

  // The list owns a node of its own. Handing it the panel would mean its
  // re-render - which empties its host before repopulating - also deleting the
  // form and the heading above it.
  const list = el('div', { class: 'hook-list' });
  box.appendChild(list);
  ctx.refreshWebhooks = () => ctx.renderWebhooks(list);
  ctx.renderWebhooks(list);
  return box;
}

function appsPanel(ctx) {
  const box = el('div', { class: 'settings-panel' });
  box.appendChild(sectionHead('Applications', 'An application posts under its own name using a token instead of a session, and can answer slash commands typed in any channel it can reach.'));

  const form = el('form', { class: 'secret-form' });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'Reminder bot', maxlength: '64', 'aria-label': 'Application name' });
  const add = el('button', { class: 'btn primary', type: 'submit' }, 'Create application');
  form.append(name, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = name.value.trim();
    if (!label) { toast('An application needs a name.', 'error'); return; }
    try {
      const res = await Api.createApp(ctx.serverId, label);
      name.value = '';
      ctx.showAppToken(res.app);
      // Relisted from the server, so what is on screen is what was stored. The
      // optimistic alternative would show an application before the row exists
      // and would survive a failed write.
      await ctx.refreshApps();
    } catch (ex) { toast(ex.message || 'Could not create the application.', 'error'); }
  });
  box.appendChild(form);

  const list = el('div', { class: 'app-list' });
  box.appendChild(list);
  ctx.refreshApps = () => ctx.renderApps(list);
  ctx.renderApps(list);
  return box;
}

function commandEditor(ctx, appId) {
  const wrap = el('div', { class: 'command-editor' });
  const list = el('div', { class: 'command-list' });
  const form = el('form', { class: 'secret-form' });
  const cmdName = el('input', { class: 'input', type: 'text', placeholder: 'ping', maxlength: '32', 'aria-label': 'Command name' });
  const cmdResp = el('input', { class: 'input', type: 'text', placeholder: 'Reply sent when someone types /ping', maxlength: '2000', 'aria-label': 'Command reply' });
  const cmdDesc = el('input', { class: 'input', type: 'text', placeholder: 'Description (optional)', maxlength: '255', 'aria-label': 'Command description' });
  const save = el('button', { class: 'btn', type: 'submit' }, 'Save command');
  form.append(cmdName, cmdDesc, cmdResp, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = cmdName.value.trim().replace(/^\/+/, '');
    const response = cmdResp.value;
    if (!n || !response) { toast('A command needs a name and a reply.', 'error'); return; }
    try {
      await Api.setAppCommand(ctx.serverId, appId, {
        name: n, response, description: cmdDesc.value.trim() || undefined,
      });
      cmdName.value = ''; cmdDesc.value = ''; cmdResp.value = '';
      await load();
      toast('Command saved.', 'ok');
    } catch (ex) { toast(ex.message || 'Could not save the command.', 'error'); }
  });

  async function load() {
    list.textContent = '';
    let commands;
    try { commands = (await Api.appCommands(ctx.serverId, appId)).commands || []; }
    catch (ex) {
      list.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load commands.'));
      return;
    }
    if (!commands.length) {
      list.appendChild(el('p', { class: 'muted small' }, 'No commands yet. Anyone in this community can trigger one by typing /name.'));
      return;
    }
    for (const c of commands) {
      const row = el('div', { class: 'command-row' });
      const main = el('div', { class: 'command-row__main' });
      main.appendChild(el('code', { class: 'command-row__name' }, '/' + c.name));
      if (c.description) main.appendChild(el('span', { class: 'muted small' }, c.description));
      main.appendChild(el('p', { class: 'command-row__response' }, c.response));
      row.appendChild(main);
      row.appendChild(dangerButton('Delete', () => {
        confirmDialog({
          title: 'Delete command',
          message: 'Delete /' + c.name + '? Anyone who types it stops getting a reply.',
          confirmText: 'Delete', danger: true,
          onConfirm: async () => {
            try {
              await Api.deleteAppCommand(ctx.serverId, appId, c.id);
              await load();
              toast('Command deleted.', 'ok');
            } catch (ex) { toast(ex.message || 'Could not delete the command.', 'error'); }
          },
        });
      }));
      list.appendChild(row);
    }
  }

  wrap.append(list, form);
  load();
  return wrap;
}

export async function renderIntegrations(container, serverId) {
  clear(container);

  // Secrets live in a modal rather than inline, so a screen share or a
  // screenshot of the section does not capture a token that is only ever shown
  // once. openModal removes its backdrop on close, which is what takes the token
  // out of the document - merely hiding a panel would leave it readable in the
  // live DOM for as long as the section stayed mounted.
  function showSecret(title, intro, value) {
    const done = el('button', { class: 'btn primary', type: 'button' }, 'I have copied it');
    const modal = openModal({
      title,
      closable: false,
      body: el('div', {},
        el('p', { class: 'muted small' }, intro),
        copyable(title, value, 'Copy this now.')),
      footer: [done],
    });
    done.addEventListener('click', modal.close);
  }

  const ctx = {
    serverId,
    showWebhookSecret(hook, label) {
      showSecret(
        'Webhook secret',
        'Shown once for ' + (label || hook.name) + '. It is stored hashed, so it cannot be shown again — rotate it if it is lost.',
        hook.secret || ''
      );
    },
    showAppToken(app) {
      showSecret(
        'Application token',
        'Shown once. Anyone holding this token can post as ' + (app.name || 'this application') + '.',
        app.token || ''
      );
    },
  };

  async function renderWebhookList(node) {
    node.textContent = '';
    const host = el('div', { class: 'stack' });
    node.appendChild(host);
    let hooks;
    try { hooks = (await Api.webhooks(serverId)).webhooks || []; }
    catch (ex) {
      host.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load webhooks.'));
      return;
    }
    if (!hooks.length) {
      host.appendChild(setEmpty('No webhooks yet. Add one above to start receiving events.'));
      return;
    }
    for (const h of hooks) {
      const card = el('div', { class: 'card' });
      const head = el('div', { class: 'card-head' });
      head.appendChild(el('strong', {}, h.name));
      head.appendChild(el('span', { class: 'muted small truncate' }, h.url));
      if (!h.active) head.appendChild(el('span', { class: 'tag' }, 'Paused'));
      card.appendChild(head);

      const active = el('input', { class: 'switch', type: 'checkbox', id: 'wh-' + h.id });
      active.checked = !!h.active;
      active.addEventListener('change', async () => {
        try {
          await Api.updateWebhook(serverId, h.id, { active: active.checked });
          toast(active.checked ? 'Webhook resumed.' : 'Webhook paused.', 'ok');
        } catch (ex) {
          active.checked = !active.checked;
          toast(ex.message || 'Could not change the webhook.', 'error');
        }
      });
      card.appendChild(settingRow({
        label: 'Delivering',
        hint: 'A paused webhook keeps its history and resumes with the same signature.',
        control: active,
      }));

      card.appendChild(settingRow({
        label: 'Rotate secret',
        hint: 'Issues a new secret. The old one stops verifying immediately.',
        control: el('button', {
          class: 'btn', type: 'button',
          onClick: async () => {
            try {
              const res = await Api.rotateWebhookSecret(serverId, h.id);
              ctx.showWebhookSecret({ name: h.name, secret: res.secret }, h.name);
              toast('Secret rotated. The previous secret no longer verifies.', 'ok');
            } catch (ex) { toast(ex.message || 'Could not rotate the secret.', 'error'); }
          },
        }, 'Rotate'),
      }));

      const del = el('button', { class: 'btn danger', type: 'button' }, 'Delete');
      del.addEventListener('click', () => {
        confirmDialog({
          title: 'Delete webhook',
          message: 'Delete ' + h.name + '? Deliveries stop immediately and nothing is retried.',
          confirmText: 'Delete', danger: true,
          onConfirm: async () => {
            try {
              await Api.deleteWebhook(serverId, h.id);
              toast('Webhook deleted.', 'ok');
              renderWebhookList(node);
            } catch (ex) { toast(ex.message || 'Could not delete the webhook.', 'error'); }
          },
        });
      });
      card.appendChild(dangerZone('Delete this webhook', 'Deliveries stop immediately. Nothing is retried.', [
        dangerRow({ label: h.name, hint: h.url, control: del }),
      ]));

      const deliveries = el('div', { class: 'delivery-log' });
      card.appendChild(el('h3', { class: 'settings-subhead' }, 'Recent deliveries'));
      deliveries.appendChild(el('p', { class: 'muted small' }, 'Loading…'));
      card.appendChild(deliveries);
      host.appendChild(card);

      Api.webhookDeliveries(serverId, h.id, 20).then((res) => {
        deliveries.textContent = '';
        const rows = (res && res.deliveries) || [];
        if (!rows.length) {
          deliveries.appendChild(el('p', { class: 'muted small' }, 'No deliveries recorded yet.'));
          return;
        }
        const table = el('ul', { class: 'delivery-list' });
        for (const d of rows) {
          const li = el('li', { class: 'delivery-row' });
          li.appendChild(el('code', {}, d.event_type || d.event || 'event'));
          li.appendChild(deliveryStatus(d));
          li.appendChild(el('span', { class: 'muted small' }, relTime(d.created_at)));
          if (d.error) li.appendChild(el('span', { class: 'muted small truncate' }, d.error));
          table.appendChild(li);
        }
        deliveries.appendChild(table);
      }).catch(() => {
        deliveries.textContent = '';
        deliveries.appendChild(el('p', { class: 'muted small' }, 'Could not load the delivery history.'));
      });
    }
  }

  async function renderAppList(node) {
    node.textContent = '';
    const host = el('div', { class: 'stack' });
    node.appendChild(host);
    let apps;
    try { apps = (await Api.apps(serverId)).apps || []; }
    catch (ex) {
      host.appendChild(el('p', { class: 'form-error' }, ex.message || 'Could not load applications.'));
      return;
    }
    if (!apps.length) {
      host.appendChild(setEmpty('No applications yet. Create one above.'));
      return;
    }
    for (const app of apps) {
      const card = el('div', { class: 'card' });
      const head = el('div', { class: 'card-head' });
      head.appendChild(el('strong', {}, app.name));
      head.appendChild(el('span', { class: 'muted small' }, 'created ' + relTime(app.createdAt)));
      card.appendChild(head);
      card.appendChild(el('p', { class: 'muted small' },
        'Post to /api/bot/channels/{channelId}/messages with this token as a Bearer header.'));

      const open = el('details', { class: 'disclosure' });
      open.appendChild(el('summary', {}, 'Slash commands'));
      open.appendChild(commandEditor(ctx, app.id));
      card.appendChild(open);

      const del = el('button', { class: 'btn danger', type: 'button' }, 'Delete application');
      del.addEventListener('click', () => {
        confirmDialog({
          title: 'Delete application',
          message: 'Delete ' + app.name + '? Its token stops working immediately and its commands stop answering.',
          confirmText: 'Delete', danger: true,
          onConfirm: async () => {
            try {
              await Api.deleteApp(serverId, app.id);
              toast('Application deleted. Its token no longer works.', 'ok');
              renderAppList(node);
            } catch (ex) { toast(ex.message || 'Could not delete the application.', 'error'); }
          },
        });
      });
      card.appendChild(dangerZone('Delete this application', 'Its token stops working immediately and its commands stop answering.', [
        dangerRow({ label: app.name, control: del }),
      ]));
      host.appendChild(card);
    }
  }

  // The renderers live in this function's closure, so they are handed to the
  // panels through ctx before the panels are constructed. Building them any
  // earlier calls an undefined function at module scope.
  ctx.renderWebhooks = renderWebhookList;
  ctx.renderApps = renderAppList;

  const head = sectionHead(
    'Integrations',
    'What can reach this community from outside it. Secrets are shown once at creation and stored hashed — nothing here can reveal one later.'
  );
  const panel = el('div', { class: 'settings-stack' });
  // append(), not appendChild(): the latter takes one node and ignores the
  // rest, which drops both panels without an error.
  panel.append(hookPanelNote(), webhookPanel(ctx), appsPanel(ctx));
  container.appendChild(sectionCard(head, panel));
}

function hookPanelNote() {
  const note = el('div', { class: 'settings-note' });
  note.appendChild(el('p', {}, 'Events: ' + Object.values(EVENT_LABELS).join(', ') + '.'));
  note.appendChild(el('p', { class: 'muted small' },
    'Deliveries are signed with HMAC-SHA256 over the exact request body. Verify by recomputing the digest of the raw body with your secret and comparing it to x-trycord-signature in constant time.'));
  return note;
}

export default { renderIntegrations };