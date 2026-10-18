// Discover.
//
// The public face of this instance: communities a visitor can join without a
// code. The page is the browser's front door, so it works signed out, and every
// card carries the honest facts - who is here, what it is about.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { signedIn } from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { serverMark } from '../ui/primitives.js';
import { head, card, blank, fault, fold, facts, hold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';

function communityCard(community) {
  const members = community.memberCount !== undefined
    ? community.memberCount : (community.member_count || null);
  const channels = community.channelCount !== undefined
    ? community.channelCount : (community.channel_count || null);
  const slug = community.slug || community.id;
  return card({
    label: community.name,
    lead: serverMark(community, { size: 'sm' }),
    body: fold([
      el('p', { class: 'lede' }, community.description || 'No description yet.'),
      members !== null
        ? facts([
          { value: String(members), label: 'members' },
          { value: String(channels || '—'), label: 'channels' },
        ])
        : null,
    ]),
    foot: el('div', { class: 'cardfoot cardfoot--end' },
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        'aria-label': 'Join ' + community.name,
        onClick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          try {
            if (signedIn()) {
              await Api.joinDiscover(community.id);
              toast('Welcome to ' + community.name);
              navigate(path('/c/' + slug));
            } else {
              navigate('/register?next=' + encodeURIComponent('/c/' + slug));
            }
          } catch (e) {
            btn.disabled = false;
            errorToast(e);
          }
        },
      }, icon('arrow-right', { size: 14 }), 'Join')),
  });
}

function loadStage() {
  return hold('Reading what is public');
}

export function renderDiscover() {
  const stage = el('div', { class: 'cardgrid' }, loadStage());
  const input = el('input', {
    class: 'input', type: 'search',
    placeholder: 'Search public communities',
    'aria-label': 'Search public communities',
    autocomplete: 'off', spellcheck: 'false',
  });

  let previousQuery = null;

  const load = async () => {
    const q = input.value.trim();
    if (q === previousQuery && stage.querySelector('.card'))
      return;
    previousQuery = q;
    stage.replaceChildren(loadStage());
    try {
      const page = await Api.discover({ page: 1, q });
      const items = (page && (page.items || page.servers)) || (Array.isArray(page) ? page : []);
      if (items.length) {
        stage.replaceChildren(...items.map(communityCard));
      } else {
        stage.replaceChildren(fold([
          blank({
            glyph: 'compass',
            title: q ? 'No results' : 'Nothing public yet',
            text: 'When communities choose to be discoverable, they will appear here.',
          }),
        ]));
      }
    } catch (e) {
      stage.replaceChildren(fold([fault(e, () => { previousQuery = null; load(); })]));
    }
  };

  let timer = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; load(); }, 240);
  });

  return {
    node: fold([
      (() => {
        const banner = head({
          kicker: 'Public',
          title: 'Discover',
          lede: 'Communities that chose to be found. Take a look around; joining is free.',
          actions: el('a', { class: 'btn btn--ghost', href: path('/servers/new') }, icon('plus', { size: 15 }), 'Create a community'),
        });
        banner.classList.add('hero');
        return banner;
      })(),
      el('div', { class: 'searchbar' },
        el('span', { class: 'searchbar-glyph' }, icon('search', { size: 16 })),
        input),
      stage,
    ]),
    onMount: load,
    cleanup() {
      if (timer) clearTimeout(timer);
    },
  };
}
