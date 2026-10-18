// The Pulse, remade.
//
// The stage opens on the reader, not on a form: a greeting that names the day,
// then a working board - the live feed wide on the left, the places the reader
// keeps and the fast paths beside it, the instance's words under all of it.
// Every tile is the same kit the rest of the app speaks.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { serverMark } from '../ui/primitives.js';
import { State, nameOf } from '../../packages/store.js';
import { path } from '../../packages/nav.js';
import Api from '../../packages/api.js';
import { head, card, memo, fold, hold, fault, blank, stamp } from '../ui/page.js';
import { activityRow } from './activity.js';

const RECENT = 8;

function partOfDay(now) {
  const h = now.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function hero() {
  const now = new Date();
  const status = State.user && State.user.statusText;
  const banner = head({
    kicker: now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    title: partOfDay(now) + ', ' + (nameOf(State.user) || 'friend'),
    lede: status || 'What reached you, and where you can go next.',
    actions: [
      el('a', { class: 'btn btn--primary', href: path('/servers/new') }, icon('plus', { size: 16 }), 'New community'),
      el('a', { class: 'btn btn--default', href: path('/discover') }, icon('compass', { size: 16 }), 'Discover'),
    ],
  });
  banner.classList.add('hero');
  return banner;
}

function placeTile(server) {
  return el('a', {
    class: 'placecard', href: path('/server/' + server.id),
    'aria-label': 'Open ' + (server.name || 'community'),
  },
  serverMark(server, { size: 'lg' }),
  el('span', { class: 'placecard-main' },
    el('span', { class: 'placecard-name' }, server.name || 'Community'),
    el('span', { class: 'placecard-meta' }, (server.member_count || 0) + ' member' + (server.member_count === 1 ? '' : 's'))),
  el('span', { class: 'placecard-go' }, icon('arrow-right', { size: 15 })),
  );
}

function quickTile(href, glyph, label) {
  return el('a', { class: 'quickcard', href: path(href) },
    el('span', { class: 'quickcard-glyph' }, icon(glyph, { size: 16 })),
    el('span', { class: 'quickcard-label' }, label),
    el('span', { class: 'quickcard-go' }, icon('arrow-right', { size: 14 })));
}

export function renderHome() {
  const stream = el('div', { class: 'cardrow-list' });
  const places = el('div', { class: 'placelist' });
  const memos = el('div', { class: 'memo-list' });

  const unreadNote = el('span', { class: 'cardhead-note' }, '');
  const activityCard = card({
    label: 'Live', glyph: 'bell',
    note: unreadNote,
    actions: el('a', { class: 'btn btn--ghost btn--sm', href: path('/notifications') }, 'Open inbox'),
    body: stream,
    flush: true,
  });

  const pathsCard = card({
    label: 'Fast paths',
    tight: true,
    body: el('div', { class: 'quickgrid' },
      quickTile('/dms', 'message', 'Direct messages'),
      quickTile('/friends', 'user-plus', 'Friends'),
      quickTile('/users/' + (State.user ? State.user.id : 'me'), 'user', 'Your profile'),
      quickTile('/settings', 'settings', 'Preferences')),
  });

  const node = fold([
    hero(),
    el('div', { class: 'board' },
      el('div', { class: 'board-col board-col--wide' }, activityCard),
      el('div', { class: 'board-col board-col--side' },
        card({ label: 'Your places', glyph: 'users', body: places, flush: true }),
        pathsCard),
    ),
    card({ label: 'This instance', glyph: 'globe', note: 'Announcements', body: memos, tight: true }),
  ]);

  function paintActivity() {
    const items = (State.notifications && State.notifications.items) || [];
    const unread = items.filter((entry) => !entry.readAt).length;
    unreadNote.textContent = unread ? unread + ' unread' : 'All read';
    if (!items.length) {
      stream.replaceChildren(blank({
        glyph: 'bell',
        title: 'Nothing new yet',
        text: 'Messages, mentions, replies and requests land here the moment they arrive.',
      }));
      return;
    }
    stream.replaceChildren(...items.slice(0, RECENT).map((entry) => activityRow(entry, paintActivity)));
  }

  function paintPlaces() {
    if (!State.servers.length) {
      places.replaceChildren(blank({
        glyph: 'users',
        title: 'No communities yet',
        text: 'Start one, or find somewhere that already exists.',
        action: el('div', { class: 'actionline' },
          el('a', { class: 'btn btn--primary btn--sm', href: path('/servers/new') }, 'Create one'),
          el('a', { class: 'btn btn--default btn--sm', href: path('/discover') }, 'Discover')),
      }));
      return;
    }
    places.replaceChildren(...State.servers.slice(0, 9).map(placeTile));
  }

  async function load() {
    paintActivity();
    paintPlaces();
    memos.replaceChildren(hold('Reading the instance'));
    try {
      paintMemos(await Api.announcements() || []);
    } catch (error) {
      memos.replaceChildren(fault(error, load));
    }
  }

  function paintMemos(rows) {
    if (!rows.length) {
      memos.replaceChildren(memo({
        tone: 'info',
        glyph: 'info',
        title: 'Nothing to announce',
        text: 'Instance news appears here when there is any.',
      }));
      return;
    }
    memos.replaceChildren(...rows.slice(0, 8).map((entry) => memo({
      tone: entry.level || 'info',
      glyph: entry.level === 'warning' || entry.level === 'danger' ? 'alert' : 'info',
      title: entry.title || 'Announcement',
      text: entry.body || null,
      stamp: entry.created_at ? stamp(entry.created_at) : null,
    })));
  }

  return { node, onMount: load };
}

export default { renderHome };
