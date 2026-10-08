// Outgoing webhooks and bot applications, as one section: both answer "what can post
// into this community from outside it" and both store their credential hashed. Nothing
// here can reveal a stored secret, because there is no way to get one back.

import Api from '../api.js';
import { showSecret } from './integrations-lists.js';
import { clear, confirmDialog, el, openModal, relTime, toast } from '../ui.js';
import { sectionHead, sectionCard, settingRow, dangerZone, dangerRow, dangerButton, setEmpty } from '../settings-ui.js';

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
  // Optional, and deliberately optional: a working application needs neither.
  // The icon is checked by the server against the same address guard a preview
  // uses, so this field cannot be a way to point a reader at a private host.
  const desc = el('input', { class: 'input', type: 'text', placeholder: 'What it does (optional)', maxlength: '500', 'aria-label': 'Application description' });
  const icon = el('input', { class: 'input', type: 'url', placeholder: 'Icon URL (optional)', 'aria-label': 'Application icon URL' });
  const add = el('button', { class: 'btn primary', type: 'submit' }, 'Create application');
  form.append(name, desc, icon, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = name.value.trim();
    if (!label) { toast('An application needs a name.', 'error'); return; }
    try {
      const res = await Api.createApp(ctx.serverId, {
        name: label,
        description: desc.value.trim() || undefined,
        iconUrl: icon.value.trim() || undefined,
      });
      name.value = ''; desc.value = ''; icon.value = '';
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

export async function renderIntegrations(container, serverId) {
  clear(container);

  // Secrets live in a modal rather than inline, so a screen share or a
  // screenshot of the section does not capture a token that is only ever shown
  // once. openModal removes its backdrop on close, which is what takes the token
  // out of the document - merely hiding a panel would leave it readable in the
  // live DOM for as long as the section stayed mounted.

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