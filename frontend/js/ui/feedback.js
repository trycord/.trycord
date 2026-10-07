// Toasts, and the live region they announce into.
// 
// announce() is not a quieter toast: it writes to a polite live region and shows
// nothing, which is the point of it.

import { el, qs } from './dom.js';

export function toast(message, kind = 'info', timeout = 4200) {
  const root = qs('#toast-root');
  if (!root) return;
  const t = el('div', { class: 'toast ' + kind }, message);
  root.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 240ms';
    setTimeout(() => t.remove(), 260);
  }, timeout);
}

export function announce(text) {
  const node = qs('#route-announcer');
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}


// The button factory. Not a style convenience - `type` defaults to 'button'
// because a <button> with no type is a submit button, and most of these live
// inside a <form>. Every call site that wrote `type: 'button'` by hand was
// re-deriving the same three lines and one omission submitted the surrounding
// form by accident. `submit: true` is the deliberate opt-in for the exception.
