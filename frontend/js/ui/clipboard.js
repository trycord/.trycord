// The clipboard.
//
// One place that puts a value on the clipboard and says so. A browser that
// refuses the write is not a failure the reader needs to be told about twice:
// the value is shown instead, so they can take it by hand.

import { toast } from './overlays.js';

export async function copyText(text, what) {
  const value = String(text || '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast((what || 'Link') + ' copied');
    return true;
  } catch {
    // A refused clipboard stays quiet; the reader can select by hand.
    if (value) toast(value, { type: 'info' });
    return false;
  }
}

export default { copyText };
