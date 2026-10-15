// Home, on a phone.
//
// The first screen after signing in. A launchpad, not a feed: a greeting, the
// communities the reader can step into, and whatever the instance wants to say.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { serverMark, empty, loading, failure } from '../components.js';
import { State, nameOf } from '../../../packages/store.js';
import { path } from '../../../packages/nav.js';
import Api from '../../../packages/api.js';
import { relativeTime } from '../../../packages/format.js';
import { screen, heading, notice, section } from './util.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderPlaces(host) {
  host.replaceChildren();
  if (!State.servers.length) {
    host.appendChild(empty({
      icon: 'users',
      title: 'You are not in a community yet',
      text: 'Start one, or find somewhere that already exists.',
      action: el('div', { class: 'm-actions' },
        el('a', { class: 'm-btn m-btn--primary', href: path('/servers/new') }, 'Create one'),
        el('a', { class: 'm-btn m-btn--ghost', href: path('/discover') }, 'Discover')),
    }));
    return;
  }
  for (const server of State.servers) {
    host.appendChild(el('a', { class: 'm-row', href: path('/server/' + server.id) },
      el('span', { class: 'm-row__lead' }, serverMark(server, { size: 'md' })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, server.name),
        el('span', { class: 'm-row__sub truncate' }, (server.member_count || 0) + ' members')),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
  }
}

function renderNews(host, rows) {
  host.replaceChildren();
  if (!rows.length) {
    host.appendChild(notice({ title: 'Nothing to announce right now', text: 'Instance news shows up here when there is any.' }));
    return;
  }
  for (const item of rows.slice(0, 8)) {
    host.appendChild(notice({
      tone: item.level || 'info',
      title: item.title || 'Announcement',
      text: item.body || null,
      meta: item.created_at ? relativeTime(item.created_at) : null,
    }));
  }
}

export function renderHome() {
  const places = el('div', { class: 'm-stack' });
  const news = el('div', { class: 'm-stack' });

  const node = screen(
    el('div', { class: 'm-hero' },
      el('div', { class: 'm-hero__eyebrow' }, 'Home'),
      el('h1', { class: 'm-hero__title' }, greeting() + ', ' + (State.user ? nameOf(State.user) : 'there')),
      el('div', { class: 'm-actions' },
        el('a', { class: 'm-btn m-btn--primary', href: path('/servers/new') }, icon('plus', { size: 17 }), 'New community'),
        el('a', { class: 'm-btn m-btn--ghost', href: path('/discover') }, icon('compass', { size: 17 }), 'Discover'))),
    section('Your communities', places, { note: State.servers.length ? String(State.servers.length) : null }),
    section('From the instance', news, { note: 'Announcements' }),
  );

  async function load() {
    renderPlaces(places);
    news.replaceChildren(loading('Reading announcements'));
    try {
      renderNews(news, (await Api.announcements()) || []);
    } catch (error) {
      news.replaceChildren(failure(error, load));
    }
  }

  return { node, head: { title: 'Home' }, onMount: load };
}

export default { renderHome };
