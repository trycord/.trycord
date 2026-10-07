import { icon, el, qs, focusQuietly } from './dom.js';

// Buttons, and the thing that covers the page.
// 
// openModal owns focus, the scrim, the escape key, and the sheet shape a phone gets
// instead of a centred card. Same markup, one component.

// The button factory. Not a style convenience - `type` defaults to 'button'
// because a <button> with no type is a submit button, and most of these live
// inside a <form>. Every call site that wrote `type: 'button'` by hand was
// re-deriving the same three lines and one omission submitted the surrounding
// form by accident. `submit: true` is the deliberate opt-in for the exception.
export function btn(label, opts = {}) {
  const { variant = '', size = '', icon: iconArg, onClick, type, title, ariaLabel, disabled, className = '' } = opts;
  const classes = ['btn', variant, size, className].filter(Boolean).join(' ');
  const node = el('button', {
    class: classes,
    type: type || (opts.submit ? 'submit' : 'button'),
    onClick,
    title: title || null,
    'aria-label': ariaLabel || null,
    disabled: !!disabled,
  });
  // A name draws the glyph; anything else is taken as ready-made content. Every
  // call site passes a name, and appending the string itself printed "mail" and
  // "bell" on the button instead of an icon.
  if (iconArg) {
    const content = typeof iconArg === 'string' ? icon(iconArg) : iconArg;
    node.appendChild(el('span', { class: 'btn__icon', 'aria-hidden': 'true' }, content));
  }
  node.appendChild(el('span', {}, label));
  return node;
}

export function openModal({ title, eyebrow, closable, body, footer, closeText = 'Close', onClose }) {
  let box;
  const backdrop = el('div', { class: 'backdrop' }, (box = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
  })));
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
  const doClose = () => close();
  if (title || closable) {
    const head = el('div', { class: 'modal-head' });
    const titles = el('div', {});
    if (eyebrow) titles.appendChild(el('p', { class: 'eyebrow' }, eyebrow));
    if (title) {
      box.setAttribute('aria-labelledby', titleId);
      titles.appendChild(el('h2', { id: titleId }, title));
    } else {
      box.setAttribute('aria-label', 'Dialog');
    }
    head.appendChild(titles);
    if (closable) {
      const x = el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close dialog' }, '×');
      x.addEventListener('click', doClose);
      head.appendChild(x);
    }
    box.appendChild(head);
  } else {
    box.setAttribute('aria-label', 'Dialog');
  }
  if (body) box.appendChild(el('div', {}, body));
  if (footer) box.appendChild(el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)', justifyContent: 'flex-end' } }, footer));

  const prevFocus = document.activeElement;

  function focusables() {
    return Array.from(box.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    // Escape and a backdrop click land here too, not only the footer buttons, so a
    // caller waiting on an answer has to hear about those. Without this a dialog
    // that asks a question could be dismissed with the question unanswered and the
    // promise left pending for the life of the page.
    if (onClose) onClose();
    if (prevFocus && prevFocus !== document.body && typeof prevFocus.focus === 'function') {
      focusQuietly(prevFocus)
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  (qs('#modal-root') || document.body).appendChild(backdrop);
  const first = box.querySelector('input, button, textarea, select, [tabindex]');
  if (first) setTimeout(() => first.focus(), 30);
  else { box.tabIndex = -1; setTimeout(() => box.focus(), 30); }
  return { close, box };
}

// An image at full size, in place. Built on openModal rather than as its own
// overlay so Escape, backdrop-click, focus return and the focus trap are the
// same behaviour every other dialog has.
export function openLightbox({ url, alt = '', name = '' }) {
  const img = el('img', { class: 'lightbox-img', src: url, alt });
  const body = el('div', { class: 'lightbox' }, img);
  if (name) body.appendChild(el('p', { class: 'lightbox-name' }, name));
  const modal = openModal({ body, closable: true, title: name || 'Image' });
  modal.box.classList.add('modal--lightbox');
  // A click on the image itself should not close it - only the backdrop around
  // it, Escape, or the close button.
  img.addEventListener('click', (e) => e.stopPropagation());
  return modal;
}

// Asks for a password, which confirmDialog cannot: it is a yes/no question and this
// needs a typed answer. The two places that wanted one were calling window.prompt(),
// which is the only native dialog left in the client - an OS-styled prompt in the
// middle of an otherwise consistent UI, and one the desktop build may not show at
// all.
//
// Resolves null when cancelled, so a caller can tell that apart from an empty string.
// An empty password is a legitimate thing to send and the server decides.
