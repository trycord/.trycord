import Api from '../api.js';
import { el, openModal, confirmDialog, relTime, toast } from '../ui.js';
import { settingRow, dangerZone, dangerRow, dangerButton, setEmpty } from '../settings-ui.js';

// Moved here from integrations.js: this is the only thing that calls it, and
// integrations.js already imports this module, so importing it back closes a cycle.
function commandEditor(ctx, appId) {
  const wrap = el('div', { class: 'command-editor' });
  const list = el('div', { class: 'command-list' });
  const form = el('form', { class: 'secret-form' });
  const cmdName = el('input', { class: 'input', type: 'text', placeholder: 'ping', maxlength: '32', 'aria-label': 'Command name' });
  const cmdResp = el('input', { class: 'input', type: 'text', placeholder: 'Reply sent when someone types /ping', maxlength: '2000', 'aria-label': 'Command reply' });
  const cmdDesc = el('input', { class: 'input', type: 'text', placeholder: 'Description (optional)', maxlength: '255', 'aria-label': 'Command description' });
  // Declared options, one per line, as name:type. The declaration is what the
  // server binds arguments against, so a typo here becomes a refusal at send
  // time rather than a silently ignored argument.
  const cmdOpts = el('input', {
    class: 'input', type: 'text', maxlength: '400',
    placeholder: 'Options: loud:boolean times:number mood:choice(happy,sad)',
    'aria-label': 'Command options',
  });
  const save = el('button', { class: 'btn', type: 'submit' }, 'Save command');
  form.append(cmdName, cmdDesc, cmdResp, cmdOpts, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = cmdName.value.trim().replace(/^\/+/, '');
    const response = cmdResp.value;
    if (!n || !response) { toast('A command needs a name and a reply.', 'error'); return; }
    try {
      let options;
      const spec = cmdOpts.value.trim();
      if (spec) {
        options = spec.split(/[,\n]/).map((part) => part.trim()).filter(Boolean).map((part) => {
          const m = /^([a-z0-9][a-z0-9_-]*)(?::([a-z]+))?(?:\(([^)]*)\))?$/i.exec(part);
          if (!m) throw new Error('cannot read the option "' + part + '" - use name:type');
          const o = { name: m[1], type: (m[2] || 'string').toLowerCase() };
          if (m[3]) o.choices = m[3].split(',').map((c) => c.trim()).filter(Boolean);
          return o;
        });
      }
      await Api.setAppCommand(ctx.serverId, appId, {
        name: n, response, description: cmdDesc.value.trim() || undefined, options,
      });
      cmdName.value = ''; cmdDesc.value = ''; cmdResp.value = ''; cmdOpts.value = '';
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
      if ((c.options || []).length) {
        const names = c.options.map((o) => (o.required ? '' : '[') + o.name + (o.required ? '' : ']')
          + (o.type === 'choice' ? '(' + (o.choices || []).join('|') + ')' : '')).join(' ');
        main.appendChild(el('code', { class: 'command-row__usage' }, '/' + c.name + ' ' + names));
      }
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

// The webhook list, the app list, and the modal that shows a secret once.
//
// These were declared inside renderIntegrations and handed back out through a ctx object,
// because a function declared inside a closure is not reachable from a module-level one -
// and there was a comment saying it had to be that way. A community is all they actually
// needed, and the page has one.

export function showSecret(title, intro, value) {
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

export async function renderWebhookList(node) {
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

export async function renderAppList(node) {
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
    if (app.status === 'disabled') head.appendChild(el('span', { class: 'tag warn' }, 'Disabled'));
    head.appendChild(el('span', { class: 'muted small' }, 'created ' + relTime(app.createdAt)));
    card.appendChild(head);
    if (app.description) card.appendChild(el('p', { class: 'muted small' }, app.description));

    // A disabled application keeps its commands but answers nobody. The button
    // says which state it is in rather than "toggle", so the label is never
    // describing the opposite of the current state.
    const live = el('input', { class: 'switch', type: 'checkbox', id: 'app-' + app.id });
    live.checked = (app.status || 'active') === 'active';
    live.addEventListener('change', async () => {
      try {
        await Api.updateApp(ctx.serverId, app.id, { status: live.checked ? 'active' : 'disabled' });
        toast(live.checked ? 'Application enabled.' : 'Application disabled. It will answer nobody.', 'ok');
        renderAppList(node);
      } catch (ex) {
        live.checked = !live.checked;
        toast(ex.message || 'Could not change the application.', 'error');
      }
    });
    card.appendChild(settingRow({
      label: 'Answering',
      hint: 'A disabled application keeps its commands and stops replying to them.',
      control: live,
    }));
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
