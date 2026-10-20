// The clipboard, on a phone.
//
// One place that puts a value on the clipboard and says so. A browser that
// refuses the write is not a failure the reader needs to be told about twice:
// the value is shown instead, so they can take it by hand.

import { el } from '../../packages/dom.js';
import { toast } from './ui.js';

export async function copyText(value, what) {
  const text = String(value || '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = el('textarea', { class: 'visually-hidden' }, text);
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast((what || 'Link') + ' copied', { type: 'success' });
    return true;
  } catch {
    if (text) toast(text);
    return false;
  }
}

export default { copyText };
