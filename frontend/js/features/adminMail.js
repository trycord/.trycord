// The mail console.
//
// The one panel that answers "does email actually work here". It renders
// whatever the mail registry says exists - three modes drawn from the backend's
// own catalogue, the configured one marked, an honest status line, and a test
// send that is only offered when a transport could actually carry it. A
// configuration the instance did not make is not shown as working.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { errorToast, toast } from '../ui/overlays.js';

const statusLine = (current, describe) => {
  if (current === 'disabled') {
    return 'Mail is switched off. Email-dependent features say so rather than pretending to work.';
  }
  if (describe && describe.ready) {
    return 'Mail is configured and ready to send.';
  }
  const problems = (describe && describe.problems) || [];
  return problems.length
    ? 'Mail is not ready: ' + problems.join(' ')
    : 'Mail is not ready.';
};

export function mailConsolePanel() {
  const modesHost = el('div', { class: 'cfg-mail__modes', role: 'radiogroup', 'aria-label': 'Delivery mode' });
  const status = el('p', { class: 'cfg-mail__status', role: 'status' });
  const detail = el('div', { class: 'cfg-mail__detail' });
  const panel = el('section', { class: 'cfg-mail', 'aria-label': 'Mail delivery' },
    status, modesHost, detail);

  let current = 'disabled';

  const paint = (consoleData) => {
    const providers = (consoleData && consoleData.providers) || [];
    current = (consoleData && consoleData.current) || 'disabled';
    const describe = consoleData && consoleData.status;

    status.textContent = statusLine(current, describe);
    modesHost.replaceChildren(...providers.map((provider) => {
      const active = provider.mode === current;
      const button = el('button', {
        class: 'cfg-mail__mode' + (active ? ' active strong' : ''),
        type: 'button', role: 'radio',
        'aria-checked': active ? 'true' : 'false',
        'aria-label': provider.label + ' delivery mode',
        onClick: async () => {
          if (provider.mode === current) return;
          try {
            await Api.updateInstanceSettings({ 'mail.mode': provider.mode });
            toast('The delivery mode is ' + provider.label.toLowerCase());
            load();
          } catch (e) { errorToast(e); }
        },
      },
        el('strong', {}, provider.label),
        el('span', { class: 'cfg-mail__mode-summary' }, provider.summary || ''));
      return button;
    }));

    const provider = providers.find((p) => p.mode === current) || null;
    const children = [];
    if (provider) {
      children.push(el('p', { class: 'cfg-mail__detail-text' }, provider.summary || ''));
    }
    if (current !== 'disabled') {
      const to = el('input', {
        class: 'input cfg-mail__to', type: 'email', inputmode: 'email',
        'aria-label': 'Address the test message goes to',
        placeholder: 'you@example.com',
      });
      children.push(el('div', { class: 'cfg-mail__detail-actions' },
        to,
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: async () => {
            try {
              await Api.mailTestSend(to.value.trim() || undefined);
              toast('A test message was queued');
            } catch (e) { errorToast(e); }
          },
        }, icon('send', { size: 14 }), 'Send a test message')));
    } else {
      children.push(el('p', { class: 'cfg-mail__detail-text cfg-mail__detail-note' },
        'Pick a mode above and the test send appears once a transport is chosen.'));
    }
    detail.replaceChildren(...children);
  };

  const load = async () => {
    try {
      paint(await Api.mailConsole());
    } catch (e) {
      panel.replaceChildren(el('div', { class: 'fold' },
        el('p', { class: 'form-error', role: 'alert' },
          (e && e.message) || 'The mail console did not open.')));
    }
  };

  return {
    node: panel,
    refresh: load,
    onMount: load,
  };
}
