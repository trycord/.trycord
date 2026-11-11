// The Trycord Mobile shell.
//
// The concept: one hand, three doors. A bar that names where you are, one
// screen at a time, and a bottom row of doors — Chats, Places, You — with the
// bell riding the bar, because alerts belong to everywhere. Actions live in
// sheets, not in pages. Views never reach into the shell; they hand it a
// description and the shell paints it.

import { el, clear } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandMark } from '../../packages/brand.js';
import { path, navigate } from '../../packages/nav.js';
import { State, nameOf, signedIn } from '../../packages/store.js';
import { avatar } from '../../js/ui/primitives.js';

let refs = null;
let doors = [];

// The screen a view hands over. Every part is optional except `node`.
//   head   { back:bool, title, sub, face, actions:[nodes] }
//   door   the tab the screen belongs to, so the bar can light it
//   bare   the screen manages its own padding (conversations, auth)
//   raw    the shell chrome hides entirely (auth), `node` stands alone
export function mountShell() {
  const barFace = el('button', { class: 'm-bar__face', type: 'button', hidden: true, 'aria-label': 'Who this is' });
  const backBtn = el('button', {
    class: 'm-bar__btn', type: 'button', hidden: true,
    'aria-label': 'Back', onClick: () => history.back(),
  }, icon('arrow-left', { size: 22 }));
  const mark = el('a', {
    class: 'm-bar__btn', href: path('/home'), 'aria-label': 'Trycord home',
  }, brandMark({ size: 26 }));
  const titles = el('div', { class: 'm-bar__titles' },
    el('div', { class: 'm-bar__title' }),
    el('div', { class: 'm-bar__sub', hidden: true }));
  const bellBadge = el('span', { class: 'm-bar__badge', hidden: true }, '');
  const bell = el('a', {
    class: 'm-bar__btn m-bar__mark', href: path('/notifications'), 'aria-label': 'Alerts',
  }, icon('bell', { size: 22 }), bellBadge);
  const actions = el('div', { class: 'm-bar__actions' });
  const bar = el('header', { class: 'm-bar' },
    backBtn, mark, barFace, titles, actions, bell);

  const banner = el('div', { class: 'm-banner', hidden: true, role: 'status' });
  const screen = el('main', { class: 'm-screen', id: 'm-screen', tabindex: '-1' });
  const composerSlot = el('div', { class: 'm-send-slot', hidden: true });
  const doorsRow = el('nav', { class: 'm-doors', 'aria-label': 'Primary' });

  const root = el('div', { class: 'm-root' },
    el('div', { class: 'm-chrome' }, banner, bar, screen, composerSlot, doorsRow));
  const toasts = el('div', { class: 'm-toasts', id: 'm-toasts' });
  root.appendChild(toasts);

  refs = { banner, bar, backBtn, mark, barFace, titles, actions, bell, bellBadge, screen, composerSlot, doorsRow, toasts, node: root };
  paintDoors();
  watchKeyboard();
  return root;
}

// The keyboard.
//
// The viewport units describe the screen, not the part of it a person can
// see. When the on-screen keyboard opens, the bottom of the layout viewport
// is behind it, and the shell's bottom row - the composer - goes with it. The
// covered height is kept in a variable on the shell's root, and the root's
// height takes it off, so the composer rides up with the keyboard instead of
// disappearing behind it. Where there is no keyboard the variable is zero, and
// the shell is exactly the screen.
function watchKeyboard() {
  const viewport = typeof window !== 'undefined' && window.visualViewport;
  if (!viewport || !refs) return;
  const measure = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)));
    refs.node.style.setProperty('--m-keyboard', covered + 'px');
  };
  viewport.addEventListener('resize', measure);
  viewport.addEventListener('scroll', measure);
  measure();
}

function doorButton(label, glyph, address) {
  return el('a', {
    class: 'm-door', href: path(address), 'data-door': address,
  }, el('span', { class: 'm-door__icon' }, icon(glyph, { size: 22 })),
    el('span', { class: 'm-door__label' }, label),
    el('span', { class: 'm-door__pip', hidden: true }));
}

function paintDoors() {
  doors = [
    { address: '/dms', node: doorButton('Chats', 'message', '/dms') },
    { address: '/communities', node: doorButton('Places', 'globe', '/communities') },
    { address: '/you', node: doorButton('You', 'settings', '/you') },
  ];
  clear(refs.doorsRow);
  for (const door of doors) refs.doorsRow.appendChild(door.node);
}

function lightDoors(address) {
  for (const door of doors) {
    const on = address === door.address || address.startsWith(door.address + '/');
    if (on) door.node.setAttribute('aria-current', 'page');
    else door.node.removeAttribute('aria-current');
  }
}

// The screen painter. `screen` is the description from the view above.
export function paintScreen(screen) {
  const s = screen || {};
  const bare = !!s.bare;
  const raw = !!s.raw;

  // The chrome's mode is the shell's to hold, and both modes are set here.
  // The class was toggled on the shell's root before, and toggled to false
  // whatever the screen asked for, so a raw screen was painted with the
  // shell's bar sitting over it.
  const chrome = refs.node.querySelector('.m-chrome');
  if (chrome) {
    chrome.classList.toggle('m-chrome--bare', bare);
    chrome.classList.toggle('m-chrome--raw', raw);
  }

  refs.backBtn.hidden = !s.head || !s.head.back;
  refs.barFace.hidden = !(s.head && s.head.face);
  clear(refs.barFace);
  if (s.head && s.head.face) {
    refs.barFace.appendChild(s.head.face);
    refs.barFace.onclick = s.head.onFace || null;
  }

  const titleNode = refs.titles.children[0];
  const subNode = refs.titles.children[1];
  titleNode.textContent = (s.head && s.head.title) || 'Trycord';
  if (s.head && s.head.sub) { subNode.textContent = s.head.sub; subNode.hidden = false; }
  else subNode.hidden = true;

  clear(refs.actions);
  if (s.head && s.head.actions) for (const node of s.head.actions) refs.actions.appendChild(node);

  refs.bell.hidden = raw || !signedIn();

  clear(refs.screen);
  // A bare screen manages its own padding, and a raw one is not the shell's
  // at all: the page it paints fills the screen it is given.
  refs.screen.classList.toggle('m-screen--bare', bare || raw);
  refs.screen.appendChild(s.node || el('div'));
  if (!raw) {
    // The reader's place moves to the screen: to its heading when the screen
    // names itself, and to the screen itself when it does not.
    const heading = refs.screen.querySelector('h1, h2');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
    else refs.screen.focus({ preventScroll: true });
  }

  lightDoors(s.door || '');
  // The doors are hidden by the chrome's own mode, not by this painter: a
  // full-bleed screen and a raw one both have no doors, and the stylesheet is
  // where that is said.
  refs.doorsRow.style.display = '';
  refs.mark.style.visibility = raw ? 'hidden' : 'visible';
  setTitle(s.head && s.head.title !== undefined ? s.head.title : '');
}

// The composer slot beneath the screen. A conversation hands its form over;
// every other screen hides it.
export function paintComposer(node) {
  clear(refs.composerSlot);
  refs.composerSlot.hidden = !node;
  if (node) refs.composerSlot.appendChild(node);
}

// The unread pip on the bar's bell.
export function paintBell(count) {
  if (!refs) return;
  refs.bellBadge.hidden = !count;
  refs.bellBadge.textContent = count > 99 ? '99+' : String(count || '');
}

export function shellRoot() { return refs && refs.node; }
export function screenHost() { return refs && refs.screen; }

// The document names the screen it is on.
export function setTitle(title) {
  try { document.title = title ? title + ' - Trycord' : 'Trycord'; } catch { /* no document */ }
}

// The banner above the bar names what the connection is doing, because words
// that silently stop arriving are words the reader keeps typing into a wall.
export function setConnection(state, label) {
  if (!refs || !state) { if (refs && refs.banner) { refs.banner.hidden = true; refs.banner.replaceChildren(); } return; }
  refs.banner.hidden = false;
  refs.banner.dataset.state = state;
  refs.banner.replaceChildren(
    icon(state === 'offline' ? 'wifi-off' : 'loader', { size: 16 }), el('span', {}, label || ''));
}

// A door's pip: the number of words waiting behind it.
function paintDoorPip(address, count) {
  if (!refs) return;
  const door = refs.doorsRow.querySelector('[data-door="' + address + '"]');
  if (!door) return;
  const pip = door.querySelector('.m-door__pip');
  if (!pip) return;
  pip.hidden = !count;
  pip.textContent = count > 9 ? '9+' : String(count || '');
}

// The chrome refreshes the parts that read the store directly: the bell's
// count and the doors' pips. Both are numbers the store already holds, so a
// paint is a read and never a request.
export function refreshChrome() {
  if (!refs) return;
  // The store keeps the inbox as a page, not as a list: the items, the count
  // and the cursor are its own. Reading it as a list found nothing to count,
  // so the bell never lit.
  const inbox = State.notifications || {};
  const unread = inbox.unreadCount !== undefined
    ? inbox.unreadCount
    : (inbox.items || []).filter((n) => !n.read).length;
  paintBell(unread);
  const dms = Array.isArray(State.dms) ? State.dms : [];
  const waiting = dms.reduce((sum, dm) => sum + Number((dm && dm.unread) || 0), 0);
  paintDoorPip('/dms', waiting);
}
