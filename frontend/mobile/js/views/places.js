// Places: the communities the reader keeps.
//
// Big touchable cards — a face, a name, what kind of place it is — with a
// sheet to make a new place or join one by its invitation code.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import {
  State, refreshServers, refreshFederated, refreshServerTree,
} from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { avatar } from '../../../js/ui/primitives.js';
import { sheet, closeSheet, confirm, attachLongPress, failed, toast, emptyState, hold, failure, field } from '../ui.js';

// An invitation that arrived as a link. It says what it opens into, and one
// press joins it.
export function renderInvite(ctx) {
  const code = (ctx && ctx.params && ctx.params.code) || '';
  const host = el('div', { class: 'm-stack' });

  async function load() {
    clear(host);
    host.appendChild(hold());
    try {
      const preview = await Api.invitePreview(code);
      clear(host);
      const place = preview && (preview.server || preview);
      host.appendChild(emptyState('user-plus', place && place.name ? place.name : 'An invitation',
        'You were invited' + (place && place.name ? ' to ' + place.name : '') + '. The code rides this link.'));
      host.appendChild(el('button', {
        class: 'm-go m-go--block', type: 'button',
        onClick: async () => {
          try {
            const joined = await Api.joinInvite(code);
            await refreshServers();
            if (joined && joined.serverId) navigate(path('/server/' + joined.serverId));
          } catch (e) { failed(e); }
        },
      }, 'Join the place'));
    } catch (e) {
      clear(host);
      host.appendChild(failure(e, load));
    }
  }

  return { node: host, head: { back: true, title: 'An invitation' }, door: '/communities', onMount: load };
}

export function renderPlaces(ctx) {
  const host = el('div', { class: 'm-stack m-places' });

  let version = 0;
  async function load() {
    const mine = ++version;
    await Promise.allSettled([refreshServers(), refreshFederated()]);
    if (mine !== version) return;
    paint();
  }

  function placeCard(server) {
    const where = server.kind === 'federated' || server.federated ? 'A far place' : 'Here';
    const card = el('button', {
      class: 'm-place', type: 'button',
      onClick: () => navigate(path('/server/' + server.id)),
    },
      avatar(server, { size: 'lg', rounded: true }),
      el('div', { class: 'm-place__body' },
        el('div', { class: 'm-place__name' }, server.name || 'A place'),
        el('div', { class: 'm-place__note' }, where + (server.description ? ' · ' + server.description : ''))),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 20 })));
    attachLongPress(card, () => placeActions(server));
    return card;
  }

  function placeActions(server) {
    return [
      { label: 'Open ' + (server.name || 'place'), icon: 'chevron-right', onClick: () => navigate(path('/server/' + server.id)) },
      { label: 'Members', icon: 'users', onClick: () => navigate(path('/server/' + server.id + '/members')) },
      { label: 'Files', icon: 'hard-drive', onClick: () => navigate(path('/server/' + server.id + '/workspace')) },
      { label: 'Leave this place', icon: 'log-out', danger: true, onClick: async () => {
        if (!(await confirm({ title: 'Leave ' + (server.name || 'this place') + '?', text: 'Its channels leave with it until an invitation brings you back.', confirmLabel: 'Leave', danger: true }))) return;
        try { await Api.leaveServer(server.id); await refreshServers(); paint(); toast('Left ' + (server.name || 'the place'), { type: 'success' }); }
        catch (e) { failed(e); }
      } },
    ];
  }

  function paint() {
    clear(host);
    const places = State.servers || [];
    if (!places.length) {
      host.appendChild(emptyState('globe', 'Nowhere yet',
        'A place holds channels, people and files. Make one, or join one with a code.'));
    } else {
      host.appendChild(el('div', { class: 'm-kicker' }, 'Your places'));
      for (const server of places) host.appendChild(placeCard(server));
    }
  }

  const makeSheet = () => {
    const layer = sheet({ title: 'A new place' });
    const name = el('input', { class: 'm-input', type: 'text', placeholder: 'What is it called?', 'aria-label': 'Place name' });
    const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Make it');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const server = await Api.createServer({ name: name.value.trim() });
        await Promise.allSettled([refreshServers(), refreshServerTree(server.id)]);
        layer.close();
        navigate(path('/server/' + server.id));
      } catch (e) { failed(e); go.disabled = false; }
    });
    layer.body.append(field('Name', name), go);
  };

  const joinSheet = () => {
    const layer = sheet({ title: 'Join with a code', note: 'The code rides an invitation someone gave you.' });
    const code = el('input', { class: 'm-input', type: 'text', placeholder: 'The invitation code', 'aria-label': 'Invitation code' });
    const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Join');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const joined = await Api.joinInvite(code.value.trim());
        closeSheet();
        if (joined && joined.serverId) { await refreshServers(); navigate(path('/server/' + joined.serverId)); }
        else { await refreshServers(); paint(); }
        toast('You are in', { type: 'success' });
      } catch (e) { failed(e); go.disabled = false; }
    });
    layer.body.append(field('Code', code), go);
  };

  host.appendChild(hold());
  load().catch((e) => { clear(host); host.appendChild(failure(e, load)); });

  return {
    node: host,
    head: {
      title: 'Places',
      actions: [
        el('button', { class: 'm-bar__btn', type: 'button', 'aria-label': 'Join with a code', onClick: joinSheet }, icon('user-plus', { size: 21 })),
        el('button', { class: 'm-bar__btn', type: 'button', 'aria-label': 'Make a place', onClick: makeSheet }, icon('plus', { size: 22 })),
      ],
    },
    door: '/communities',
    onMount: load,
    cleanup() { version += 1; },
  };
}
