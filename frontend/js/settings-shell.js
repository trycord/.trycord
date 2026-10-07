// The settings framework: one implementation for account, community and admin.
//
// Sections are data, not markup. The nav works as a sidebar on a wide screen and as a
// disclosure on a phone, off the same description.
import { el, clear } from './ui.js';
import { icon } from './components.js';
import { route } from './nav.js';
import { scopeNav } from './pages/registry.js';

// Groups, not a flat list. A flat list of eight destinations is a wall; the
// grouping is what tells you that Security and Privacy are one decision and
// that Backend and Updates are somewhere else entirely.
//
// Only capabilities the server actually backs appear here. Notifications and
// blocking were absent from the IA while they existed on the server, which left
// both unreachable: a reader who had muted something everywhere, or blocked
// someone who was still messaging them, had no section that said so. The comment
// that used to sit here said no notification table and no block list existed.
// They do, and the sections that read them are in privacy-ui.js.
// href is optional per scope: community sections are addressed relative to the
// current community, so the caller supplies a resolver rather than every item
// hard-coding a path that would go stale.
// One icon name in the registry is a word rather than a glyph. Kept here rather
// than corrected in the registry so the page definitions stay readable as English.
const ICON_ALIASES = { megaphone: 'bell' };

function iconFor(name) {
  return icon(ICON_ALIASES[name] || name);
}

// A section with a route is addressed by it; a community section has none and is
// addressed relative to whichever community is open, which the caller resolves.
export function resolveHref(item, resolve) {
  if (item.route) return route(item.route);
  return resolve ? resolve(item.tab) : null;
}

// `tabs`, not `id`: a section is identified by what it answers to, and the settings
// tree has always had more addresses than screens. /settings/sessions and
// /settings/password both mean Security, and both still resolve.
export function isActive(item, active) {
  if (!active) return false;
  return (item.tabs || []).includes(active);
}

export function findItem(scope, active) {
  for (const g of scopeNav(scope)) {
    for (const i of g.items) if (isActive(i, active)) return i;
  }
  return null;
}

export function blurbFor(scope, active) {
  const item = findItem(scope, active);
  return item ? item.blurb || '' : '';
}

/**
 * The settings navigation.
 *
 * Sticky sidebar from 900px up. Below that it becomes a disclosure, because a
 * 240px column of section names beside a 390px form leaves the form 130px wide,
 * which is the reason the old account nav was a horizontal pill row instead.
 *
 * @param {object} opts
 * @param {string} opts.scope      'account' | 'community' | 'admin'
 * @param {string} opts.active     section id
 * @param {Function} [opts.resolve] id -> href, for community sections
 * @param {Node} [opts.footer]     appended after the groups (sign-out lives here)
 */
export function settingsNav({ scope, active, resolve, footer, searchable = true }) {
  const groups = scopeNav(scope);
  const wrap = el('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' });

  // Below 900px the groups are collapsed, so they need something to expand
  // them. It is display:none above the breakpoint, where the nav is a plain
  // sidebar and an expander would be meaningless.
  const current = findItem(scope, active);
  const toggle = el('button', {
    type: 'button', class: 'settings-nav__toggle', 'aria-expanded': 'false',
  },
  el('span', { class: 'settings-nav__toggle-icon' }, icon('menu')),
  el('span', {}, current ? current.label : 'Sections'),
  icon('menu', { class: 'settings-nav__toggle-caret' }));
  toggle.addEventListener('click', () => {
    const open = wrap.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  wrap.appendChild(toggle);

  let input = null;
  if (searchable && groups.length > 1) {
    const field = el('div', { class: 'settings-nav__search' });
    input = el('input', {
      type: 'search',
      class: 'input',
      placeholder: 'Filter sections',
      'aria-label': 'Filter settings sections',
      autocomplete: 'off',
    });
    const clearBtn = el('button', {
      type: 'button', class: 'settings-nav__search-clear', 'aria-label': 'Clear filter',
    }, icon('close'));
    clearBtn.addEventListener('click', () => {
      input.value = '';
      input.focus();
      apply('');
    });
    field.append(input, clearBtn);
    wrap.appendChild(field);
  }

  const list = el('div', { class: 'settings-nav__groups' });
  const none = el('p', { class: 'settings-nav__empty', hidden: true }, 'No section matches that.');

  for (const g of groups) {
    const block = el('div', { class: 'settings-nav__group' });
    block.appendChild(el('h2', { class: 'settings-nav__heading' }, g.group));
    for (const item of g.items) {
      const href = resolveHref(item, resolve);
      const on = isActive(item, active);
      const node = el('a', {
        class: 'settings-nav__item' + (on ? ' is-active' : ''),
        href: href || '#',
        'aria-current': on ? 'page' : null,
        dataset: { section: item.tab, search: (item.label + ' ' + (item.blurb || '')).toLowerCase() },
      },
      el('span', { class: 'settings-nav__icon' }, iconFor(item.icon)),
      el('span', { class: 'settings-nav__label' }, item.label));
      if (item.trailing) node.appendChild(item.trailing);
      // A section with no destination yet should not read as broken when tapped.
      if (!href) node.addEventListener('click', (e) => e.preventDefault());
      block.appendChild(node);
    }
    list.appendChild(block);
  }

  function apply(q) {
    const needle = (q || '').trim().toLowerCase();
    let shown = 0;
    for (const block of list.children) {
      let any = 0;
      for (const a of block.querySelectorAll('.settings-nav__item')) {
        const hit = !needle || a.dataset.search.includes(needle);
        a.hidden = !hit;
        if (hit) any++;
      }
      block.hidden = any === 0;
      shown += any;
    }
    none.hidden = shown > 0;
  }

  if (input) {
    input.addEventListener('input', () => apply(input.value));
    apply('');
  }

  wrap.append(list, none);
  if (footer) wrap.appendChild(footer);
  return wrap;
}

// Sticky nav beside the content pane, plus a third region on the right that is
// only given width when the viewport can spend it.
//
// That region is part of the frame from the first render, not something a media
// query conjures: it holds real content that a narrow viewport hides by a
// decision rather than by omission. No `context` renders an empty region that
// occupies no track.
//
// Returns the pane to render into and the context region, and marks the frame as
// entered so content animates in once instead of on every re-render.
export function settingsFrame({ scope, active, resolve, footer, searchable, contentClass = '', context = null }) {
  const frame = el('div', { class: 'settings-layout' });
  const nav = settingsNav({ scope, active, resolve, footer, searchable });
  const pane = el('div', { class: 'settings-pane ' + contentClass });
  const aside = el('aside', { class: 'settings-context' });
  if (context) {
    aside.setAttribute('aria-label', context.label || 'About this section');
    aside.append(...[context].flat(Infinity).filter(Boolean));
    frame.dataset.hasContext = 'yes';
  }
  frame.append(nav, pane, aside);
  return { frame, pane, nav, context: aside };
}

// The back affordance for a nested settings route. Every settings page is
// reachable by URL as well as by clicking, and a deep link used to leave the
// reader with no way back to the surface's own section list.
export function settingsBack(href, label) {
  const a = el('a', { class: 'settings-back', href }, icon('close'), label || 'Back');
  return a;
}


export default { settingsNav, settingsFrame, settingsBack, blurbFor, findItem, isActive, clear };