import { btn, openModal } from './overlay.js';

import { el, focusQuietly } from './dom.js';
import { toast } from './feedback.js';

// Reporting content.
// 
// The categories sit beside the dialog that offers them so one cannot be added to the
// list and forgotten in the picker.

// Trust & Safety entry point shared by message/user reports. Fixed
export const REPORT_CATEGORIES = [
  'Harassment or bullying',
  'Spam',
  'Scam or fraud',
  'Hate or discriminatory content',
  'Threats or violence',
  'Sexual or inappropriate content',
  'Impersonation',
  'Illegal content',
  'Other',
];

export function openReportDialog({ targetType, targetId, title, subtitle, onSubmit }) {
  // A report that is never sent must not be reported as sent. A missing target
  if (!targetType || !targetId || typeof onSubmit !== 'function') {
    toast('This report cannot be submitted.', 'error');
    return null;
  }
  const err = el('div', { class: 'form-error', hidden: true });
  const sel = el('select', { class: 'input', 'aria-label': 'Reason' });
  for (const c of REPORT_CATEGORIES) sel.appendChild(el('option', { value: c }, c));
  const details = el('textarea', { class: 'textarea', style: { minHeight: '80px' }, maxlength: 4000, placeholder: 'Additional information (optional)' });
  const cancel = btn('Cancel', { variant: 'ghost' });
  const go = el('button', { class: 'btn danger', type: 'button' }, 'Submit report');
  const modal = openModal({
    title: title || 'Report',
    eyebrow: 'Trust & Safety',
    closable: true,
    body: el('div', {},
      subtitle ? el('p', { class: 'muted small' }, subtitle) : null,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), sel),
      el('div', { class: 'field' }, el('label', {}, 'Additional information'), details),
      err),
    footer: el('div', { class: 'row-line' }, cancel, go),
  });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', async () => {
    const category = sel.value || REPORT_CATEGORIES[0];
    const extra = details.value.trim();
    err.hidden = true;
    go.disabled = true;
    try {
      await onSubmit({ targetType, targetId, category, extra });
      modal.close();
      toast('Reported. Moderators will review it.', 'ok');
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Could not send report.';
    } finally {
      go.disabled = false;
    }
  });
  setTimeout(() => { focusQuietly(details) }, 50);
  return modal;
}
