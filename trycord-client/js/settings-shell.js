// The settings framework.
//
// There were three of these and they disagreed: account settings drew a pill
// row, community settings a sticky sidebar, admin its own thing. Same idea, three
// implementations, and none held more than about six destinations before
// wrapping.
//
// This is the one implementation. It owns the information architecture (grouped
// data, not markup), a nav that works as a sidebar and as a disclosure on a
// phone, filtering, and the active-state rules including sections that span
// aliases. Sections are described by data, so adding one is a data change.
import { el, clear } from './ui.js';
import { icon } from './components.js';
import { serverPath } from './links.js';
import { route } from './nav.js';

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
export const SETTINGS_IA = {
  account: [
    {
      group: 'You',
      items: [
        { id: 'profile', label: 'Profile', icon: 'users', href: route('/settings'),
          match: ['profile'], blurb: 'Your name, photo and status' },
      ],
    },
    {
      group: 'Safety',
      items: [
        { id: 'security', label: 'Security', icon: 'shield', href: route('/settings/security'),
          match: ['security', 'password', 'sessions', 'twofactor'], blurb: 'Password, two-factor and sessions' },
        { id: 'privacy', label: 'Privacy', icon: 'ban', href: route('/settings/privacy'),
          match: ['privacy'], blurb: 'Friend requests and who can reach you' },
        { id: 'notifications', label: 'Notifications', icon: 'bell', href: route('/settings/notifications'),
          match: ['notifications'], blurb: 'Muted channels and alerts' },
      ],
    },
    {
      group: 'Preferences',
      items: [
        { id: 'appearance', label: 'Appearance', icon: 'image', href: route('/settings/appearance'),
          match: ['appearance'], blurb: 'Theme, density and motion' },
      ],
    },
    {
      group: 'Instance',
      items: [
        { id: 'backend', label: 'Backend', icon: 'layers', href: route('/settings/backend'),
          match: ['backend'], blurb: 'Which server this device talks to' },
        { id: 'updates', label: 'Updates', icon: 'download', href: route('/settings/updates'),
          match: ['updates'], blurb: 'Version and build information' },
      ],
    },
  ],

  community: [
    {
      group: 'This community',
      items: [
        { id: 'overview', label: 'Overview', icon: 'list', href: null, match: ['overview'] },
        { id: 'appearance', label: 'Appearance', icon: 'image', href: null, match: ['appearance'] },
      ],
    },
    {
      group: 'Structure',
      items: [
        { id: 'structure', label: 'Channels', icon: 'hash', href: null, match: ['structure'] },
        { id: 'categories', label: 'Categories', icon: 'layers', href: null, match: ['categories'] },
      ],
    },
    {
      group: 'Access',
      items: [
        { id: 'members', label: 'Members', icon: 'users', href: null, match: ['members'] },
        { id: 'roles', label: 'Roles', icon: 'shield', href: null, match: ['roles'], blurb: 'Permissions per role' },
        { id: 'invites', label: 'Invites', icon: 'mail', href: null, match: ['invites'] },
      ],
    },
    {
      group: 'Safety',
      items: [
        { id: 'moderation', label: 'Moderation', icon: 'warn', href: null, match: ['moderation'] },
        { id: 'ownership', label: 'Ownership', icon: 'flag', href: null, match: ['ownership'] },
      ],
    },
    {
      group: 'Reach',
      items: [
        { id: 'analytics', label: 'Analytics', icon: 'compass', href: null, match: ['analytics'], blurb: 'Activity, channels, members' },
        { id: 'integrations', label: 'Integrations', icon: 'rocket', href: null, match: ['integrations'], blurb: 'Webhooks, apps, commands' },
      ],
    },
  ],

  admin: [
    {
      group: 'Console',
      items: [
        { id: 'overview', label: 'Overview', icon: 'home', href: route('/admin'),
          match: ['overview'], blurb: 'Platform health and recent activity' },
      ],
    },
    {
      group: 'People',
      items: [
        { id: 'users', label: 'Users', icon: 'users', href: route('/admin/users'), match: ['users'] },
        { id: 'communities', label: 'Communities', icon: 'layers', href: route('/admin/communities'), match: ['communities'] },
      ],
    },
    {
      group: 'Trust and safety',
      items: [
        { id: 'reports', label: 'Reports', icon: 'warn', href: route('/admin/reports'), match: ['reports'] },
        { id: 'appeals', label: 'Appeals', icon: 'flag', href: route('/admin/appeals'), match: ['appeals'] },
        { id: 'audit', label: 'Audit log', icon: 'document', href: route('/admin/audit'), match: ['audit'] },
      ],
    },
    {
      group: 'Content',
      items: [
        { id: 'announcements', label: 'Announcements', icon: 'megaphone', href: route('/admin/announcements'), match: ['announcements'] },
        { id: 'pages', label: 'Pages', icon: 'document', href: route('/admin/pages'), match: ['pages'] },
      ],
    },
    {
      group: 'Compliance',
      items: [
        { id: 'gdpr', label: 'Data requests', icon: 'shield', href: route('/admin/gdpr'), match: ['gdpr'] },
      ],
    },
  ],
};

// The icon set has no megaphone; a bell is the closest thing that reads as
// "broadcast" rather than "alert".
const ICON_ALIASES = { megaphone: 'bell' };

function iconFor(name) {
  return icon(ICON_ALIASES[name] || name);
}

// href is optional per scope: community sections are addressed relative to the
// current community, so the caller supplies a resolver rather than every item
// hard-coding a path that would go stale.
export function resolveHref(item, resolve) {
  if (item.href) return item.href;
  return resolve ? resolve(item.id) : null;
}

export function isActive(item, active) {
  if (!active) return false;
  if (item.id === active) return true;
  return (item.match || []).includes(active);
}

export function findItem(scope, active) {
  for (const g of (SETTINGS_IA[scope] || [])) {
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
  const groups = SETTINGS_IA[scope] || [];
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
        dataset: { section: item.id, search: (item.label + ' ' + (item.blurb || '')).toLowerCase() },
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


export default { SETTINGS_IA, settingsNav, settingsFrame, settingsBack, blurbFor, findItem, isActive, clear };