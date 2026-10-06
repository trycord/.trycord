// What is left of ui.js, and where the rest went.
//
// The primitives are in ui/dom.js and the menu system in ui/menus.js. They are
// re-exported from here because almost everything imports them from this one module,
// and pointing 46 files at two others would be churn rather than clarity.
//
// What remains is the part that talks to the reader: toasts, announcements, buttons,
// overlays, the user card and the report dialog.

import { TrycordConfig } from './config.js';

// Re-exported so `import { el, attachMenu } from '../ui.js'` keeps working.
export {
  esc, ICON_PATHS, icon, el, clear, clearAndRebuild, qs, qsa, focusQuietly,
} from './ui/dom.js';
export { attachMenu, showContextMenu, attachContextMenu, closeContextMenu } from './ui/menus.js';



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
export function passwordDialog({ title, message, confirmText = 'Continue' }) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input', type: 'password',
      autocomplete: 'current-password', required: true,
    });
    const err = el('div', { class: 'form-error', hidden: true });
    const form = el('form', { class: 'auth-form' },
      el('div', { class: 'field' }, el('label', {}, 'Password'), input),
      err);
    const cancel = btn('Cancel', { variant: 'ghost' });
    const ok = el('button', { class: 'btn primary', type: 'button' }, confirmText);
    const modal = openModal({
      title,
      body: el('div', {}, message ? el('p', {}, message) : null, form),
      footer: [cancel, ok],
    });

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(value);
    };

    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => {
      const value = input.value;
      if (!value) {
        err.hidden = false;
        err.textContent = 'Enter your password.';
        focusQuietly(input);
        return;
      }
      finish(value);
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); ok.click(); });

    // Close without resolving: the backdrop, Escape and the close button all land
    // here, and all of them mean the same thing.
    modal.onClose = () => finish(null);
    // No explicit focus: openModal already focuses the first field in the dialog on
    // a timer, and that is the password input here.
  });
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, onConfirm }) {
  let doClose = () => {};
  const cancelBtn = btn('Cancel', { variant: 'ghost' });
  const okBtn = el('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button' }, confirmText);
  const modal = openModal({
    title, body: el('p', {}, message),
    footer: [cancelBtn, okBtn],
  });
  doClose = modal.close;
  cancelBtn.addEventListener('click', doClose);
  okBtn.addEventListener('click', async () => {
    try { await onConfirm(); } finally { doClose(); }
  });
  return modal;
}

export function showUserCard(clientX, clientY, { avatarEl, title, sub, statusLine, actions, bannerUrl = null } = {}) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover user-card', role: 'dialog', 'aria-label': title || 'User' });
  // Banner is optional and loads through the authenticated media route, so
  const banner = el('div', { class: 'user-card__banner' });
  if (bannerUrl) {
    import('./components.js').then(({ loadAuthedImage }) => loadAuthedImage(bannerUrl)).then((url) => {
      if (!url || !pop.isConnected) return;
      banner.style.backgroundImage = 'url("' + url + '")';
      banner.classList.add('has-img');
    }).catch(() => {});
  }
  pop.appendChild(banner);
  const head = el('div', { class: 'user-card__head' });
  if (avatarEl) head.appendChild(avatarEl);
  pop.appendChild(head);
  const idBox = el('div', { class: 'user-card__body' });
  idBox.appendChild(el('strong', { class: 'user-card__name' }, title || 'Unknown'));
  if (sub) idBox.appendChild(el('span', { class: 'muted small' }, sub));
  if (statusLine) idBox.appendChild(el('span', { class: 'user-card__status' }, statusLine));
  pop.appendChild(idBox);
  const btnBox = el('div', { class: 'user-card__actions' });
  for (const a of actions || []) {
    const b = el('button', {
      class: 'btn sm' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
      type: 'button',
    }, a.label);
    b.addEventListener('click', () => {
      closeContextMenu();
      if (a.onSelect) a.onSelect();
    });
    btnBox.appendChild(b);
  }
  if (btnBox.children.length) pop.appendChild(btnBox);
  root.appendChild(pop);
  const pr = pop.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + pr.width > innerWidth - 8) left = Math.max(8, innerWidth - pr.width - 8);
  if (top + pr.height > innerHeight - 8) top = Math.max(8, innerHeight - pr.height - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
  const onDown = (e) => { if (!pop.contains(e.target)) closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }, 0);
  pop._ctxCleanup = () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
  return { pop, hide: closeContextMenu };
}

export async function copyText(text, label = 'Copied to clipboard.') {
  const value = String(text == null ? '' : text);
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard API unavailable (permissions / non-secure context):
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { toast('Copy failed.', 'error'); return; }
  }
  toast(label, 'ok');
}

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

const EMOJI_CATEGORIES = [
  {
    id: 'faces', label: 'Smileys', emoji: ('😀 😁 😂 🤣 😊 😄 😍 🥰 😘 😗 😙 😚 🙂 🙃 😉 😌 😔 🥺 😢 😭 😤 😠 😡 🤬 '
      + '🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🫡 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 '
      + '❓ ❗ 😇 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🥳 😎 😕 🙃'),
  },
  {
    id: 'people', label: 'People', emoji: ('👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 '
      + '🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁 👅 👄 💋 🩸'),
  },
  {
    id: 'nature', label: 'Nature', emoji: ('🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 '
      + '🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🐓 🦃 🦤 🦚 🦜 🦢 🕊 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿 🦔 🌵 🎄 🌲 🌳 🌴 🪵 🌱 🌿 ☘️ 🍀 🎍 🎋 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻'),
  },
  {
    id: 'food', label: 'Food', emoji: ('🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥙 🧆 🌮 🌯 🥗 🥘 🫕 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊'),
  },
  {
    id: 'activity', label: 'Activity', emoji: ('⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🎆 🎇 🎊 🎉 🎈 🎁 🔔'),
  },
  {
    id: 'travel', label: 'Travel', emoji: ('🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🪝 ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🛖 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 🌁 🌃 🏙️ 🌄 🌅 🌆 🌇 🌉 ♨️ 🎑 🏞️ 🌠 🎇 🎆 🌌'),
  },
  {
    id: 'objects', label: 'Objects', emoji: ('⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏱ ⏲ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🪜 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🪄 🪅 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'),
  },
  {
    id: 'symbols', label: 'Symbols', emoji: ('♥ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 💬 🗯️ ♠️ ♣️ ♥️ ♦️ ♟️ 🃏 🎴 🀄 🕐 ⭐ 🌟 ✨ 🔥 ⚡ 💥 💫'),
  },
];

// works in English. Deliberately partial: it covers the common ones, and
const EMOJI_NAMES = {
  grin: '😀', smile: '😄', joy: '😂', rofl: '🤣', blush: '😊', heart_eyes: '😍',
  thinking: '🤔', neutral: '😐', rolling_eyes: '🙄', sleep: '😴', scream: '😱',
  sob: '😭', rage: '😡', party: '🥳', fire: '🔥', tada: '🎉', sparkles: '✨',
  ok: '👌', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  clap: '👏', pray: '🙏', muscle: '💪', wave: '👋', heart: '♥', broken_heart: '💔',
  hundred: '💯', star: '⭐', zap: '⚡', boom: '💥', eyes: '👀', see_no_evil: '🙈',
  skull: '💀', ghost: '👻', robot: '🤖', poop: '💩', clown: '🤡',
  pizza: '🍕', beer: '🍺', coffee: '☕', cake: '🎂', cookie: '🍪',
  rocket: '🚀', game: '🎮', guitar: '🎸', soccer: '⚽', basketball: '🏀',
  trophy: '🏆', bug: '🐛', cat: '🐱', dog: '🐶', fox: '🦊',
  white_check_mark: '✅', x: '❌', warning: '⚠️', question: '❓', exclamation: '❗',
  bulb: '💡', lock: '🔒', key: '🔑', hammer: '🔨', wrench: '🔧',
  bell: '🔔', link: '🔗', memo: '📝', book: '📚', calendar: '📅',
};

const NAME_OF = (() => {
  const byChar = new Map();
  for (const [name, ch] of Object.entries(EMOJI_NAMES)) byChar.set(ch, name.replace(/_/g, ' '));
  return (e) => byChar.get(e) || e;
})();

export function showEmojiPicker(anchor, onPick) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover emoji-picker', role: 'dialog', 'aria-label': 'Choose an emoji' });

  const search = el('input', {
    class: 'emoji-search', type: 'search', placeholder: 'Search emoji…',
    'aria-label': 'Search emoji', autocomplete: 'off', spellcheck: 'false',
  });
  const results = el('div', { class: 'emoji-results' });
  pop.appendChild(search);
  pop.appendChild(results);

  const flat = [];
  for (const cat of EMOJI_CATEGORIES) {
    for (const e of new Set(cat.emoji.split(' '))) flat.push({ e, name: NAME_OF(e) });
  }

  const cell = (e, name) => {
    const b = el('button', { class: 'emoji-cell', type: 'button', title: name || e, 'aria-label': name || e }, e);
    b.addEventListener('click', () => {
      closeContextMenu();
      if (onPick) onPick(e);
    });
    return b;
  };

  const paintGroups = () => {
    clear(results);
    for (const cat of EMOJI_CATEGORIES) {
      const list = [...new Set(cat.emoji.split(' '))];
      if (!list.length) continue;
      const sec = el('section', { class: 'emoji-group' });
      sec.appendChild(el('div', { class: 'emoji-group__label' }, cat.label));
      const grid = el('div', { class: 'emoji-grid' });
      for (const e of list) grid.appendChild(cell(e, NAME_OF(e)));
      sec.appendChild(grid);
      results.appendChild(sec);
    }
  };

  const paintSearch = (q) => {
    clear(results);
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) { paintGroups(); return; }
    const hits = flat.filter((x) => x.name.toLowerCase().includes(needle) || x.e === needle);
    if (!hits.length) {
      results.appendChild(el('div', { class: 'emoji-empty' }, 'No emoji match "' + String(q).trim() + '"'));
      return;
    }
    const grid = el('div', { class: 'emoji-grid' });
    for (const x of hits) grid.appendChild(cell(x.e, x.name));
    results.appendChild(grid);
  };

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintSearch(search.value), 60);
  });

  results.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    const cells = [...results.querySelectorAll('.emoji-cell')];
    if (!cells.length) return;
    const at = cells.indexOf(document.activeElement);
    e.preventDefault();
    const perRow = Math.max(1, Math.round(cells[0].parentElement.clientWidth / (cells[0].offsetWidth || 1)));
    let next = at;
    if (e.key === 'ArrowRight') next = at + 1;
    else if (e.key === 'ArrowLeft') next = at - 1;
    else if (e.key === 'ArrowDown') next = at + perRow;
    else next = at - perRow;
    if (next < 0) next = 0;
    if (next >= cells.length) next = cells.length - 1;
    cells[next].focus();
  });

  paintGroups();
  root.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - pr.width - 8));
  let top = r.top - pr.height - 8;
  if (top < 8) top = Math.min(innerHeight - pr.height - 8, r.bottom + 8);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
  const onKey = (e) => {
    if (e.key === 'Escape') { closeContextMenu(); return; }
    if (e.target === search || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      search.value += e.key;
      paintSearch(search.value);
      search.focus();
    }
  };
  const onDown = (e) => { if (!pop.contains(e.target)) closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }, 0);
  pop._ctxCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
  return { pop, hide: closeContextMenu };
}

export function insertAtCursor(field, text) {
  try {
    field.focus();
    const s = field.selectionStart == null ? field.value.length : field.selectionStart;
    const e = field.selectionEnd == null ? field.value.length : field.selectionEnd;
    field.setRangeText(String(text), s, e, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    field.value += text;
  }
  focusQuietly(field)
}


// A count and its noun. `plural('member')` reads better at the call site than
// `n + ' member' + (n === 1 ? '' : 's')`, and it cannot be got wrong by forgetting
// the ternary.
export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}


export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}


export function apiSrc(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return TrycordConfig.apiUrl().replace(/\/+$/, '') + path;
}

export default { esc, el, clear, toast, openModal, confirmDialog, relTime, fullTime, apiSrc, announce };
