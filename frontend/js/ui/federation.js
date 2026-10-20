// Reporting something on another instance.
//
// A report carries a reference and a reason, and nothing else. What crosses
// and what does not is written down by the server, and this module shows that
// text rather than a paraphrase of it: the reader is told, in the server's
// own words, what is being sent away from them.
//
// The dialog is used from the list of relayed messages and from anywhere else
// a report can be filed, so there is one way of asking.

import { el } from '../../packages/dom.js';
import Api from '../../packages/api.js';
import { openDialog, errorToast, toast } from './overlays.js';

// What the server says crosses with a report, and what does not.
//
// The words are the server's: the client shows them and adds nothing of its
// own, because this is the one place where the reader has to be told exactly
// what is being sent away from them.
export function disclosurePanel(disclosure) {
  if (!disclosure) return null;
  const shared = Array.isArray(disclosure.shared) ? disclosure.shared : [];
  const notShared = Array.isArray(disclosure.notShared) ? disclosure.notShared : [];
  if (!shared.length && !notShared.length) return null;
  return el('div', { class: 'disclosure' },
    el('h3', { class: 'disclosure-title' }, 'What crosses with a report'),
    el('ul', { class: 'disclosure-list' }, shared.map((line) => el('li', {}, line))),
    el('h3', { class: 'disclosure-title' }, 'What does not cross'),
    el('ul', { class: 'disclosure-list' }, notShared.map((line) => el('li', {}, line))));
}

// The dialog that files one.
//
// The reason is required, because a report with no reason is a report nobody
// can act on. The disclosure is shown before the report is sent when the
// server has already told us what it says, and again from the answer.
export function reportDialog(target, options) {
  const opts = options || {};
  const reason = el('input', {
    class: 'input', type: 'text', 'aria-label': 'Why you are reporting this',
    placeholder: 'What is wrong with it',
  });
  const description = el('textarea', {
    class: 'textarea', rows: '3', 'aria-label': 'Anything else the other instance should know',
  });
  const note = el('p', { class: 'form-note', role: 'status', 'aria-live': 'polite' });

  const dialog = openDialog({
    title: 'Report to the other instance',
    sub: opts.sub || null,
    body: el('form', {
      class: 'form-stack', onSubmit: async (event) => {
        event.preventDefault();
        if (!reason.value.trim()) {
          note.textContent = 'Say why, so the other instance can act on it.';
          return;
        }
        try {
          const filed = await Api.fileFederationReport({
            targetInstanceId: target.targetInstanceId,
            communityId: target.communityId,
            channelId: target.channelId,
            contentId: target.contentId,
            contentType: target.contentType || 'message',
            reason: reason.value.trim(),
            description: description.value.trim() || undefined,
          });
          dialog.close();
          toast('The report has been filed');
          if (opts.onFiled) opts.onFiled(filed);
        } catch (error) { errorToast(error); }
      },
    },
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'Reason'),
      reason),
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'Anything else'),
      description),
    disclosurePanel(opts.disclosure),
    note,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'File the report')),
  });
  reason.focus();
  return dialog;
}

export default { disclosurePanel, reportDialog };
