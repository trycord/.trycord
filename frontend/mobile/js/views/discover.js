// Discover, on a phone.
//
// The public index of communities on this instance. Browsable without an account;
// joining needs a session, so a signed-out reader is sent to sign in and brought
// back.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { serverMark, empty, loading, failure } from '../components.js';
import { State, refreshServers } from '../../../packages/store.js';
import { navigate } from '../../../packages/nav.js';
import { sheet, toast } from '../ui.js';
import Api from '../../../packages/api.js';
import { screen, section, notice } from './util.js';

const PAGE_SIZE = 12;

export function renderDiscover() {
  const host = el('div', { class: 'm-stack' });
  const search = el('input', { class: 'm-input', type: 'search', placeholder: 'Search by name or description', 'aria-label': 'Search communities' });
  let term = '';
  let current = 1;

  const form = el('form', { class: 'm-inline-form' }, search,
    el('button', { class: 'm-btn m-btn--primary', type: 'submit' }, 'Search'));

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Discover'),
      el('div', { class: 'm-hero__sub' }, 'Public communities on this instance. Anyone can look; you need an account to join.')),
    form, host);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    term = search.value.trim();
    current = 1;
    load();
  });

  async function load() {
    host.replaceChildren(loading('Looking for communities'));
    try {
      paint(await Api.discover({ page: current, limit: PAGE_SIZE, q: term }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint(result) {
    const items = result.items || [];
    host.replaceChildren();
    if (!items.length) {
      host.appendChild(empty({
        icon: term ? 'search' : 'compass',
        title: term ? 'No match for "' + term + '"' : 'Nothing is public yet',
        text: term ? 'Try a shorter word, or clear the search.' : 'A community shows up here once its owners make it discoverable.',
        action: term ? el('button', {
          class: 'm-btn m-btn--ghost', type: 'button',
          onClick: () => { search.value = ''; term = ''; current = 1; load(); },
        }, 'Clear search') : null,
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const server of items) list.appendChild(communityRow(server));
    host.appendChild(section('Public communities', list, { note: result.total ? result.total + ' in total' : null }));
    if (result.pages > 1) {
      host.appendChild(el('div', { class: 'm-actions' },
        el('button', { class: 'm-btn m-btn--ghost', type: 'button', disabled: current <= 1, onClick: () => { current -= 1; load(); } }, 'Previous'),
        el('span', { class: 'm-pager-count' }, 'Page ' + (result.page || current) + ' of ' + result.pages),
        el('button', { class: 'm-btn m-btn--ghost', type: 'button', disabled: current >= result.pages, onClick: () => { current += 1; load(); } }, 'Next')));
    }
  }

  function communityRow(server) {
    const members = server.member_count || 0;
    const channels = server.channel_count || 0;
    return el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, serverMark(server, { size: 'md' })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, server.name),
        el('span', { class: 'm-row__sub truncate' }, members + (members === 1 ? ' member' : ' members')
          + (channels ? ' \u00b7 ' + channels + (channels === 1 ? ' channel' : ' channels') : '')
          + (server.description ? ' \u00b7 ' + server.description : ''))),
      el('span', { class: 'm-row__actions' },
        el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => preview(server) }, 'Preview'),
        el('button', { class: 'm-btn m-btn--sm m-btn--primary', type: 'button', onClick: (event) => join(server, event.currentTarget) }, 'Join')));
  }

  async function join(server, button) {
    if (!State.user) {
      toast('Sign in to join a community.', { type: 'info' });
      navigate('/login?next=' + encodeURIComponent('/discover'));
      return;
    }
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
      const out = await Api.joinDiscover(server.id);
      await refreshServers();
      toast('You have joined ' + server.name + '.', { type: 'success' });
      navigate('/server/' + ((out && out.serverId) || server.id));
    } catch (error) {
      toast(error.message, { type: 'danger' });
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }

  async function preview(server) {
    let detail = null;
    try {
      detail = await Api.discoverServer(server.id);
    } catch (error) { toast(error.message, { type: 'danger' }); return; }
    const channels = detail.channels || [];
    const layer = sheet({
      title: detail.name,
      body: el('div', { class: 'm-stack' },
        notice({ text: detail.description || 'This community has not written a description.', tone: 'neutral' }),
        el('div', { class: 'm-section__title' }, 'Channels'),
        channels.length
          ? el('div', { class: 'm-list' }, channels.map((channel) => el('div', { class: 'm-row' },
            el('span', { class: 'm-row__lead' }, icon('hash', { size: 16 })),
            el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, channel.name)))))
          : el('p', { class: 'm-lede' }, 'No channels are visible before you join.')),
      footer: el('button', {
        class: 'm-btn m-btn--block m-btn--primary', type: 'button',
        onClick: (event) => { layer.close(); join(server, event.currentTarget); },
      }, 'Join'),
    });
  }

  return { node, head: { title: 'Discover' }, onMount: load };
}

export default { renderDiscover };
