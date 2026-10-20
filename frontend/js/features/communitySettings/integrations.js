// The integrations of a community: webhooks and bot applications.
//
// Both are credentials, and both are handled the same way. The server hands
// the secret out once and cannot read it back, so the console shows it when
// it arrives, offers it for copying, and afterwards shows a mask and the
// actions that change it. Nothing is ever shown twice, and nothing is typed
// into a secret field by hand.

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

// The name of an application, and what it is for.
function appDialog(serverId, app, onDone) {
  const name = el('input', {
    class: 'input', type: 'text', value: app ? (app.name || '') : '',
    'aria-label': 'The name of the application',
    placeholder: 'What this application is called',
  });
  const description = el('input', {
    class: 'input', type: 'text', value: app ? (app.description || '') : '',
    'aria-label': 'What the application does',
    placeholder: 'One sentence on what it does here',
  });
  const problem = el('p', { class: 'form-error', role: 'alert' });

  const dialog = openDialog({
    title: app ? 'Rename the application' : 'New application',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          if (app) {
            await communityApi.updateApp(serverId, app.id, {
              name: name.value.trim(),
              description: description.value.trim(),
            });
            dialog.close();
            onDone();
            return;
          }
          const answer = await communityApi.createApp(serverId, {
            name: name.value.trim(),
            description: description.value.trim(),
          });
          dialog.close();
          onDone();
          // The token is in the answer and nowhere else. It is shown once.
          const created = answer && answer.app ? answer.app : answer;
          if (created && created.token) {
            secretDialog({
              title: 'The application token',
              value: created.token,
              text: 'This token is what the application posts with. It is shown once and it cannot be read again.',
            });
          }
        } catch (error) {
          problem.textContent = (error && error.message) ? error.message : 'That did not save.';
        }
      },
    },
    name,
    description,
    problem,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, app ? 'Save' : 'Create')),
  });
  name.focus();
  return dialog;
}

// The commands one application answers.
async function commandsDialog(serverId, app) {
  const body = el('div', { class: 'fold' }, hold('Reading the commands'));
  const problem = el('p', { class: 'form-error', role: 'alert' });
  const dialog = openDialog({ title: 'The commands of ' + (app.name || 'the application'), body });

  const paint = async () => {
    try {
      const answer = await communityApi.appCommands(serverId, app.id);
      const commands = (answer && answer.commands) || [];
      body.replaceChildren(el('div', { class: 'fold' },
        el('div', { class: 'rowlist' }, ...(commands.length ? commands.map((command) => row({
          title: '/' + command.name,
          sub: command.description || command.response,
          side: el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Remove the command /' + command.name,
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Remove /' + command.name + '?',
                body: 'The application stops answering it. Nothing else it answers changes.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!yes) return;
              try {
                await communityApi.deleteAppCommand(serverId, app.id, command.id);
                await paint();
              } catch (error) {
                problem.textContent = (error && error.message) ? error.message : 'That did not work.';
              }
            },
          }, 'Remove'),
        })) : [blank({
          glyph: 'slash',
          title: 'It answers nothing yet',
          text: 'A command is a word the application answers with a message.',
        })])),
        problem,
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => commandDialog(serverId, app, paint),
        }, icon('plus', { size: 14 }), 'Add a command')));
    } catch (error) {
      body.replaceChildren(fold([fault(error, null)]));
    }
  };
  await paint();
  return dialog;
}

// One command, and the answer it gives.
function commandDialog(serverId, app, onDone) {
  const name = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The name of the command',
    placeholder: 'ping',
  });
  const description = el('input', {
    class: 'input', type: 'text', 'aria-label': 'What the command is for',
    placeholder: 'One sentence on what it does',
  });
  const response = el('textarea', {
    class: 'input', rows: '3', 'aria-label': 'The message the command answers with',
    placeholder: 'The answer, with {name} for an argument',
  });
  const problem = el('p', { class: 'form-error', role: 'alert' });

  const dialog = openDialog({
    title: 'New command',
    body: el('form', {
      class: 'fold',
      onSubmit: async (event) => {
        event.preventDefault();
        try {
          await communityApi.setAppCommand(serverId, app.id, {
            name: name.value.trim().replace(/^\//, ''),
            description: description.value.trim(),
            response: response.value,
          });
          dialog.close();
          onDone();
        } catch (error) {
          problem.textContent = (error && error.message) ? error.message : 'That did not save.';
        }
      },
    },
    name,
    description,
    response,
    problem,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
  });
  name.focus();
  return dialog;
}

export function integrationsSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });
  const report = reporter();

  let hooks = [];
  let apps = [];
  let channels = [];

  const load = async () => {
    host.replaceChildren(hold('Reading the integrations'));
    try {
      const [hookAnswer, appAnswer] = await Promise.all([
        Api.webhooks(serverId),
        communityApi.apps(serverId),
      ]);
      hooks = (hookAnswer && hookAnswer.webhooks) || [];
      apps = (appAnswer && appAnswer.apps) || [];
      const tree = State.serverTree.get(serverId);
      channels = (tree && tree.channels) || [];
      paint();
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  const paint = () => {
    const webhookBody = el('div', { class: 'rowlist' });
    const appBody = el('div', { class: 'rowlist' });

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

    // -- the applications ----------------------------------------------------
    if (!apps.length) {
      appBody.replaceChildren(blank({
        glyph: 'bot',
        title: 'No applications',
        text: 'An application posts as itself and answers commands.',
      }));
    } else {
      appBody.replaceChildren(...apps.map((app) => el('div', {},
        row({
          lead: el('span', { class: 'role-dot' }, icon('bot', { size: 15 })),
          title: app.name || 'Application',
          sub: app.description || (app.status === 'active' ? 'Active' : 'Disabled'),
          side: el('span', { class: 'rowtools' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Rename the application ' + (app.name || ''),
              onClick: () => appDialog(serverId, app, load),
            }, icon('edit', { size: 14 })),
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'The commands of the application ' + (app.name || ''),
              onClick: () => commandsDialog(serverId, app),
            }, icon('slash', { size: 14 })),
            el('button', {
              class: 'btn btn--danger btn--sm', type: 'button',
              'aria-label': 'Remove the application ' + (app.name || ''),
              onClick: async () => {
                const yes = await confirmDialog({
                  title: 'Remove this application?',
                  body: 'It stops posting, and its token goes with it.',
                  confirmLabel: 'Remove',
                  danger: true,
                });
                if (!yes) return;
                try {
                  await communityApi.deleteApp(serverId, app.id);
                  report.answered('The server answered: the application was removed.');
                  await load();
                } catch (error) {
                  report.fail(error);
                }
              },
            }, 'Remove')),
        }),
        managedSecret({
          label: 'The application token',
          state: 'set',
          note: 'The token is shown once, when the application is made. The server keeps only a hash of it, so a new token means a new application.',
          replaceLabel: 'Replace',
          onReplace: async () => {
            const yes = await confirmDialog({
              title: 'Make a new application?',
              body: 'A token cannot be replaced in place, so this makes a second application with the same name and shows its token. The old one keeps working until it is removed.',
              confirmLabel: 'Make a new one',
              danger: true,
            });
            if (!yes) return;
            try {
              const answer = await communityApi.createApp(serverId, {
                name: app.name,
                description: app.description || '',
              });
              report.answered('The server answered: a new application was made.');
              const created = answer && answer.app ? answer.app : answer;
              if (created && created.token) {
                secretDialog({
                  title: 'The new application token',
                  value: created.token,
                  text: 'This is the new token, and the only time it can be shown.',
                });
              }
              await load();
            } catch (error) {
              report.fail(error);
            }
          },
          onClear: async () => {
            const yes = await confirmDialog({
              title: 'Remove the application?',
              body: 'Removing the application removes its token with it. Nothing can post as it afterwards.',
              confirmLabel: 'Remove the application',
              danger: true,
            });
            if (!yes) return;
            try {
              await communityApi.deleteApp(serverId, app.id);
              report.answered('The server answered: the application was removed.');
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
      card({
        label: 'Applications', glyph: 'bot',
        body: fold([
          appBody,
          el('div', { class: 'rowtools' },
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => appDialog(serverId, null, load),
            }, icon('plus', { size: 14 }), 'New application')),
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
