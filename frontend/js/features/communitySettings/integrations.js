// The integrations of a community: webhooks.
//
// The community's surface for outside software. The platform's applications -
// bots and the rest of the developer platform - live in the developer portal,
// not here: this is where the community manages what its own software may
// talk to it, and the developer portal manages what Trycord itself is. The
// two are different jobs, and this surface is only the first.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { head, card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { confirmDialog, openDialog } from '../../ui/overlays.js';
import { State, refreshServerTree } from '../../../packages/store.js';
import { communityApi } from '../../../packages/communitySettings.js';
import { reporter, managedSecret, secretDialog } from './parts.js';

// The address of a webhook: the name it is known by, where it posts to, and
// which channel of this community it posts into.
function webhookDialog(serverId, hook, channels, onDone) {
  const name = el('input', {
    class: 'input', type: 'text', value: hook ? (hook.name || '') : '',
    'aria-label': 'The name of the webhook',
    placeholder: 'What this webhook is for',
  });
  const url = el('input', {
    class: 'input', type: 'url', value: hook ? (hook.url || '') : '',
    'aria-label': 'The address the webhook posts to',
    placeholder: 'https://example.org/hook',
  });
  const channel = el('select', { class: 'input', 'aria-label': 'The channel it posts into' },
    el('option', { value: '' }, 'No channel'));
  const problem = el('p', { class: 'form-error', role: 'alert' });
  for (const item of channels) {
    channel.appendChild(el('option', {
      value: item.id,
      selected: hook && hook.channelId === item.id ? true : null,
    }, '#' + item.name));
  }

  const dialog = openDialog({
    title: hook ? 'Edit the webhook' : 'New webhook',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        const body = { name: name.value.trim(), url: url.value.trim(), channelId: channel.value || null };
        try {
          if (hook) {
            await Api.updateWebhook(serverId, hook.id, body);
            dialog.close();
            onDone();
            return;
          }
          const answer = await Api.createWebhook(serverId, body);
          dialog.close();
          onDone();
          // The secret is in the answer and nowhere else. It is shown once.
          const created = answer && answer.webhook ? answer.webhook : answer;
          if (created && created.secret) {
            secretDialog({
              title: 'The webhook secret',
              value: created.secret,
              text: 'This webhook posts to ' + created.url + '. It signs what it sends, and this is the only time it can be shown.',
            });
          }
        } catch (error) {
          // The dialog stays open with what was typed, and says what failed.
          problem.textContent = (error && error.message) ? error.message : 'That did not save.';
        }
      },
    },
    name,
    url,
    channel,
    problem,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, hook ? 'Save' : 'Create')),
  });
  name.focus();
  return dialog;
}

// The delivery history of one webhook.
async function deliveryHistory(serverId, hook) {
  const body = el('div', { class: 'fold' }, hold('Reading the delivery history'));
  const dialog = openDialog({ title: 'What ' + (hook.name || 'the webhook') + ' delivered', body });
  try {
    const answer = await communityApi.webhookDeliveries(serverId, hook.id);
    const rows = (answer && answer.deliveries) || [];
    if (!rows.length) {
      body.replaceChildren(blank({
        glyph: 'zap',
        title: 'Nothing delivered yet',
        text: 'The deliveries appear here once the community does something the webhook listens for.',
      }));
      return;
    }
    body.replaceChildren(el('div', { class: 'rowlist' }, ...rows.map((delivery) => row({
      lead: el('span', { class: 'role-dot' }, icon(
        delivery.status === 'delivered' ? 'check' : 'alert', { size: 15 })),
      title: delivery.eventType || 'An event',
      sub: (delivery.status || 'failed')
        + (delivery.statusCode ? ' · HTTP ' + delivery.statusCode : '')
        + (delivery.error ? ' · ' + delivery.error : '')
        + (delivery.createdAt ? ' · ' + delivery.createdAt : ''),
    }))));
  } catch (error) {
    body.replaceChildren(fold([fault(error, null)]));
  }
}

export function integrationsSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });
  const report = reporter();

  let hooks = [];
  let channels = [];

  const load = async () => {
    host.replaceChildren(hold('Reading the integrations'));
    try {
      const hookAnswer = await Api.webhooks(serverId);
      hooks = (hookAnswer && hookAnswer.webhooks) || [];
      const tree = State.serverTree.get(serverId);
      channels = (tree && tree.channels) || [];
      paint();
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  const paint = () => {
    const webhookBody = el('div', { class: 'rowlist' });

    // -- the webhooks --------------------------------------------------------
    if (!hooks.length) {
      webhookBody.replaceChildren(blank({
        glyph: 'zap',
        title: 'No webhooks',
        text: 'A webhook is an address another program can post messages through.',
      }));
    } else {
      webhookBody.replaceChildren(...hooks.map((hook) => el('div', {},
        row({
          lead: el('span', { class: 'role-dot' }, icon('zap', { size: 15 })),
          title: hook.name || 'Webhook',
          sub: hook.url || '',
          side: el('span', { class: 'rowtools' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Edit the webhook ' + (hook.name || ''),
              onClick: () => webhookDialog(serverId, hook, channels, load),
            }, icon('edit', { size: 14 })),
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Show what the webhook ' + (hook.name || '') + ' delivered',
              onClick: () => deliveryHistory(serverId, hook),
            }, icon('activity', { size: 14 })),
            el('button', {
              class: 'btn btn--danger btn--sm', type: 'button',
              'aria-label': 'Delete the webhook ' + (hook.name || ''),
              onClick: async () => {
                const yes = await confirmDialog({
                  title: 'Delete this webhook?',
                  body: 'It stops being called, and its secret goes with it.',
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!yes) return;
                try {
                  await Api.deleteWebhook(serverId, hook.id);
                  report.answered('The server answered: the webhook was deleted.');
                  await load();
                } catch (error) {
                  report.fail(error);
                }
              },
            }, 'Delete')),
        }),
        managedSecret({
          label: 'The signing secret',
          state: 'set',
          note: 'The secret is kept by the server as a hash. It is shown once, when it is made, and it cannot be read again.',
          replaceLabel: 'Replace',
          onReplace: async () => {
            const yes = await confirmDialog({
              title: 'Replace the secret?',
              body: 'The old secret stops working at once. Whatever signs with it has to be given the new one.',
              confirmLabel: 'Replace the secret',
              danger: true,
            });
            if (!yes) return;
            try {
              const answer = await Api.rotateWebhookSecret(serverId, hook.id);
              report.answered('The server answered: the secret was replaced.');
              if (answer && answer.secret) {
                secretDialog({
                  title: 'The new webhook secret',
                  value: answer.secret,
                  text: 'This is the new secret, and the only time it can be shown.',
                });
              }
              await load();
            } catch (error) {
              report.fail(error);
            }
          },
          onClear: async () => {
            const yes = await confirmDialog({
              title: 'Remove the webhook?',
              body: 'Removing the webhook removes its secret with it. Nothing can call it afterwards.',
              confirmLabel: 'Remove the webhook',
              danger: true,
            });
            if (!yes) return;
            try {
              await Api.deleteWebhook(serverId, hook.id);
              report.answered('The server answered: the webhook was removed.');
              await load();
            } catch (error) {
              report.fail(error);
            }
          },
        }))));
    }

    host.replaceChildren(fold([
      report.node,
      card({
        label: 'Webhooks', glyph: 'zap',
        body: fold([
          webhookBody,
          el('div', { class: 'rowtools' },
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => webhookDialog(serverId, null, channels, load),
            }, icon('plus', { size: 14 }), 'New webhook')),
        ]),
      }),
    ]));
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Integrations',
        lede: 'How other software talks to this place.',
        actions: null,
      }),
      host,
    ]),
    onMount: async () => {
      try {
        await refreshServerTree(serverId, { force: true });
      } catch { /* the channel list is a convenience here, not the point */ }
      await load();
    },
  };
}

export default { integrationsSection };
