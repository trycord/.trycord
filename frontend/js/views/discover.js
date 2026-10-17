// Discover.
//
// The public index of communities on this instance. Readable without an account,
// because the point of a directory is to be browsed before you join one. Joining
// needs a session, so a signed-out reader is sent to sign in and brought back.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { serverMark } from '../ui/primitives.js';
import { State, refreshServers } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import { openDialog, toast, errorToast } from '../ui/overlays.js';
import Api from '../../packages/api.js';
import { page, band, panel, prow, loading, failure, empty } from './util.js';

const PAGE_SIZE = 12;

export function renderDiscover() {
  const host = el('div', { class: 'stack' });
  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search by name or description',
    'aria-label': 'Search communities',
  });
  let term = '';
  let current = 1;

  const form = el('form', { class: 'search-row' },
    search,
    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Search'));

  const node = page([
    band({
      eyebrow: 'Discover',
      icon: 'compass',
      title: 'Communities on this instance',
      lede: 'Public communities are listed here. Anyone can look; you need an account to join.',
      actions: form,
    }),
    host,
  ]);

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
      host.appendChild(term
        ? empty({
          icon: 'search',
          title: 'No match for "' + term + '"',
          text: 'Try a shorter word, or clear the search to see everything.',
          action: el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => { search.value = ''; term = ''; current = 1; load(); },
          }, 'Clear search'),
        })
        : empty({
          icon: 'compass',
          title: 'Nothing is public yet',
          text: 'A community shows up here once its owners make it discoverable.',
        }));
      return;
    }

    host.appendChild(panel({
      title: 'Public communities',
      note: result.total ? String(result.total) + ' in total' : null,
      rows: items.map(communityRow),
    }));

    if (result.pages > 1) {
      host.appendChild(el('div', { class: 'pager' },
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          disabled: current <= 1, onClick: () => { current -= 1; load(); },
        }, 'Previous'),
        el('span', { class: 'pager-count' }, 'Page ' + (result.page || current) + ' of ' + result.pages),
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          disabled: current >= result.pages, onClick: () => { current += 1; load(); },
        }, 'Next')));
    }
  }

  function communityRow(server) {
    const members = server.member_count || 0;
    const channels = server.channel_count || 0;
    return prow({
      lead: serverMark(server, { size: 'md' }),
      title: server.name,
      sub: members + (members === 1 ? ' member' : ' members')
        + (channels ? ' · ' + channels + (channels === 1 ? ' channel' : ' channels') : '')
        + (server.description ? ' · ' + server.description : ''),
      actions: [
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => preview(server),
        }, 'Preview'),
        el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          onClick: (event) => join(server, event.currentTarget),
        }, 'Join'),
      ],
    });
  }

  async function join(server, button) {
    if (!State.user) {
      toast('Sign in to join a community.', { type: 'info' });
      navigate('/login?next=' + encodeURIComponent('/discover'));
      return;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const out = await Api.joinDiscover(server.id);
      await refreshServers();
      toast('You have joined ' + server.name + '.', { type: 'success' });
      navigate('/server/' + ((out && out.serverId) || server.id));
    } catch (error) {
      errorToast(error);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function preview(server) {
    let detail = null;
    try {
      detail = await Api.discoverServer(server.id);
    } catch (error) {
      errorToast(error);
      return;
    }
    const channels = (detail.channels || []);
    const dialog = openDialog({
      title: detail.name,
      sub: (detail.member_count || 0) + (detail.member_count === 1 ? ' member' : ' members'),
      body: [
        detail.description
          ? el('p', { class: 'prow-sub' }, detail.description)
          : el('p', { class: 'prow-sub' }, 'This community has not written a description.'),
        el('div', { class: 'split-label' }, 'Channels'),
        channels.length
          ? el('div', { class: 'stack stack--tight' }, channels.map((channel) => el('div', { class: 'prow' },
            el('span', { class: 'prow-lead' }, icon('hash', { size: 16 })),
            el('div', { class: 'prow-main' }, el('div', { class: 'prow-title' }, channel.name)))))
          : el('p', { class: 'prow-sub' }, 'No channels are visible before you join.'),
      ],
      foot: [
        el('button', { class: 'btn btn--default', type: 'button', onClick: () => dialog.close() }, 'Close'),
        el('button', {
          class: 'btn btn--primary', type: 'button',
          onClick: (event) => { dialog.close(); join(server, event.currentTarget); },
        }, 'Join'),
      ],
    });
  }

  return { node, onMount: load };
}

export default { renderDiscover };
