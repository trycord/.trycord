// The administration frame.
//
// The console's own shell: a masthead that says what this is, the sections
// grouped the way the registry groups them, and the page inside. The counts
// on the doors are the overview endpoint's own numbers - open reports, open
// appeals, enforced accounts - so a door is not just a name; it is the work
// waiting behind it. A count that could not be read is not shown, and a door
// never pretends to be empty: the pages still open with the count absent.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { path } from '../../packages/nav.js';
import { State, nameOf } from '../../packages/store.js';
import Api from '../../packages/api.js';
import { scopeNav } from '../../packages/registry.js';

// Which doors carry a live count, and where the overview's answer is read
// from. Only the numbers the endpoint really reports are ever shown.
const BADGES = {
  'admin.reports': (overview) => (overview && overview.openReports) || 0,
  'admin.appeals': (overview) => (overview && overview.openAppeals) || 0,
  'admin.users': (overview) => (overview && overview.enforcedUsers) || 0,
};

export function adminFrame(activeId) {
  const stage = el('div', { class: 'adminframe-stage' });
  const nav = el('nav', { class: 'adminframe-nav', 'aria-label': 'Administration sections' });

  const masthead = el('header', { class: 'adminframe-head' },
    el('div', { class: 'adminframe-headmain' },
      el('p', { class: 'adminframe-kicker' }, 'Administration'),
      el('div', { class: 'adminframe-headline' }, 'The instance, in your hands')),
    el('span', { class: 'adminframe-who truncate' }, State.user ? nameOf(State.user) : ''));

  // The doors are built from the registry so the nav and the routes cannot
  // disagree; the badges arrive from the overview endpoint when it answers.
  const doors = new Map();
  for (const group of scopeNav('admin')) {
    nav.appendChild(el('p', { class: 'adminframe-group' }, group.group));
    for (const item of group.items) {
      const badge = el('span', { class: 'adminframe-badge', hidden: true });
      nav.appendChild(el('a', {
        class: 'adminframe-door' + (item.id === activeId ? ' is-active' : ''),
        href: path(item.route),
        'aria-current': item.id === activeId ? 'page' : null,
      },
        icon(item.icon || 'circle-dot', { size: 16 }),
        el('span', { class: 'adminframe-label truncate' }, item.label),
        badge));
      doors.set(item.id, badge);
    }
  }

  Api.adminOverview()
    .then((overview) => {
      for (const [id, read] of Object.entries(BADGES)) {
        const count = read(overview);
        const badge = doors.get(id);
        if (!badge || !count) continue;
        badge.hidden = false;
        badge.textContent = count > 999 ? '999+' : String(count);
      }
    })
    .catch(() => { /* the doors stay without numbers; the pages still work */ });

  return {
    root: el('div', { class: 'adminframe' }, masthead,
      el('div', { class: 'adminframe-body' }, nav, stage)),
    stage,
  };
}

export default { adminFrame };
