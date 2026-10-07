import { el, qs } from './dom.js';
import { closeContextMenu } from './menus.js';
import { toast } from './feedback.js';

// The hover card, and putting text on the clipboard.
// 
// copyText is here rather than in its own module because it has one caller and the
// hard part is the announcement, which is a UI concern.

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
