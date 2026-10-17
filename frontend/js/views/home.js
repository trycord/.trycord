// Home.
//
// The first screen after signing in and the one a reader keeps coming back to.
// It is a launchpad, not a feed: a greeting that says who you are and when, the
// places you can step into, and whatever the instance wants to say. Nothing here
// is a stack of welcome cards, because a welcome card is a thing you read once
// and then scroll past forever.
//
// Module structure:
//   - greeting(): time-based greeting
//   - today(): formatted date string
//   - renderPlaces(): community list
//   - renderNews(): announcements
//   - view(): main view composer

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { serverMark } from '../ui/primitives.js';
import { State, nameOf } from '../../packages/store.js';
import { path } from '../../packages/nav.js';
import Api from '../../packages/api.js';
import { relativeTime } from '../../packages/format.js';
import { page, band, panel, prow, notice, loading, failure, empty } from './util.js';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function today() {
  const now = new Date();
  return DAY[now.getDay()] + ', ' + now.getDate() + ' ' + MONTH[now.getMonth()];
}

function view() {
  const places = el('div', { class: 'stack stack--tight' });
  const news = el('div', { class: 'stack stack--tight' });

  const node = page({ wide: true },
    band({
      eyebrow: 'Home',
      icon: 'home',
      meta: today(),
      title: greeting() + ', ' + (State.user ? nameOf(State.user) : 'there') + '.',
      lede: 'Where things stand right now.',
      actions: [
        el('a', { class: 'btn btn--primary', href: path('/servers/new') },
          icon('plus', { size: 17 }), 'New community'),
        el('a', { class: 'btn btn--default', href: path('/discover') },
          icon('compass', { size: 17 }), 'Discover'),
      ],
    }),
    el('div', { class: 'split split--wide-aside' },
      panel({
        title: 'Your communities',
        note: State.servers.length ? String(State.servers.length) : null,
        body: places,
      }),
      panel({
        title: 'From the instance',
        note: 'Announcements',
        body: news,
      }),
    ),
  );

  async function load() {
    renderPlaces(places);
    news.replaceChildren(loading('Reading announcements'));
    try {
      const rows = await Api.announcements();
      renderNews(news, rows || []);
    } catch (error) {
      news.replaceChildren(failure(error, load));
    }
  }

  return { node, onMount: load };
}

function renderPlaces(host) {
  host.replaceChildren();
  if (!State.servers || !State.servers.length) {
    host.appendChild(empty({
      icon: 'users',
      title: 'You are not in a community yet',
      text: 'Start one, or find somewhere that already exists.',
      action: el('div', { class: 'row-actions' },
        el('a', { class: 'btn btn--primary btn--sm', href: path('/servers/new') }, 'Create one'),
        el('a', { class: 'btn btn--default btn--sm', href: path('/discover') }, 'Discover')),
    }));
    return;
  }
  for (const server of State.servers) {
    host.appendChild(prow({
      href: path('/server/' + server.id),
      lead: serverMark(server, { size: 'md' }),
      title: server.name,
      sub: (server.member_count || 0) + ' members',
      actions: icon('arrow-right', { size: 16 }),
    }));
  }
}

function renderNews(host, rows) {
  host.replaceChildren();
  if (!rows.length) {
    host.appendChild(notice({
      icon: 'info',
      title: 'Nothing to announce right now',
      text: 'Instance news shows up here when there is any.',
    }));
    return;
  }
  for (const row of rows.slice(0, 8)) {
    host.appendChild(notice({
      tone: row.level || 'info',
      icon: row.level === 'warning' ? 'alert' : row.level === 'danger' ? 'alert' : 'info',
      title: row.title || 'Announcement',
      text: row.body || null,
      meta: row.created_at ? relativeTime(row.created_at) : null,
    }));
  }
}

export function renderHome() {
  return view();
}

export default { renderHome };