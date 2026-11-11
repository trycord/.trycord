// Friends.
//
// The people the reader chose, remade as a people page: a greeting, the counts
// that describe the room, the requests asking for an answer as their own cards,
// and the roster as a wall of faces rather than a filing cabinet of rows. Every
// action here still ends in a conversation or a profile, never in a settings
// screen.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { SESSION_EVENTS, on } from '../../packages/realtime.js';
import {
  State, nameOf, refreshFriends, refreshPresence, presenceOf, on as onStore,
} from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { avatar } from '../ui/primitives.js';
import { card, row, blank, fault, fold, head } from '../ui/page.js';
import { personSheetEntries, personContextMenu } from '../ui/person.js';
import { presenceLabel } from '../ui/members.js';
import { relativeTime } from '../../packages/format.js';
import { errorToast, toast } from '../ui/overlays.js';

// A presence is an answer about now; a last-active time is an answer about
// then. Both are worth saying on a face, and saying which is which is what
// keeps "Offline" from reading as "gone".
function activityLine(person, presence) {
  const state = presenceLabel(presence);
  const active = person.lastActiveAt && presence === 'offline'
    ? 'last active ' + relativeTime(person.lastActiveAt)
    : null;
  return [active || state, person.statusText].filter(Boolean).join(' · ');
}

function friendTile(person) {
  const presence = presenceOf(person.id);
  const actions = el('span', { class: 'friendtile-tools' },
    el('button', {
      class: 'iconbtn iconbtn--tile', type: 'button',
      'aria-label': 'Message ' + nameOf(person),
      onClick: async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const dm = await Api.createDm(person.id);
          navigate('/dms/' + (dm.id || dm.conversationId));
        } catch (e) { errorToast(e); }
      },
    }, icon('message', { size: 15 })),
    el('button', {
      class: 'iconbtn iconbtn--tile', type: 'button',
      'aria-label': 'Open the profile of ' + nameOf(person),
      onClick: (event) => { event.preventDefault(); navigate('/users/' + person.id); },
    }, icon('user', { size: 15 })));

  const tile = el('a', {
    class: 'friendtile', href: path('/users/' + person.id),
    'aria-label': 'Open ' + nameOf(person),
  },
  avatar(person, { size: 'md', rounded: true, presence }),
  el('span', { class: 'friendtile-main' },
    el('span', { class: 'friendtile-name' }, nameOf(person) || person.username),
    el('span', { class: 'friendtile-sub' }, activityLine(person, presence)),
  ),
  actions,
  );
  // A face is a person, and a person can be asked for things: the tile carries
  // that person's menu on a right-click.
  personContextMenu(tile, person);
  return tile;
}

function requestCardTile(entry, onChange) {
  const from = entry.user || entry.from || {};
  return el('div', { class: 'requestcard' },
    avatar(from, { size: 'lg', rounded: true }),
    el('span', { class: 'requestcard-main' },
      el('span', { class: 'requestcard-name' }, nameOf(from) || from.username || 'Someone'),
      el('span', { class: 'requestcard-sub' }, 'Wants to be your friend · '
        + (entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : 'just now'))),
    el('span', { class: 'requestcard-actions' },
      el('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        'aria-label': 'Accept the request from ' + (nameOf(from) || 'this person'),
        onClick: async () => {
          try {
            await Api.acceptFriendRequest(entry.id);
            toast('You are friends now');
            onChange();
          } catch (e) { errorToast(e); }
        },
      }, 'Accept'),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Decline the request from ' + (nameOf(from) || 'this person'),
        onClick: async () => {
          try {
            await Api.declineFriendRequest(entry.id);
            onChange();
          } catch (e) { errorToast(e); }
        },
      }, 'Decline')),
  );
}

function stat(value, label) {
  return el('div', { class: 'stat' },
    el('span', { class: 'stat-value' }, String(value)),
    el('span', { class: 'stat-label' }, label));
}

export function renderFriends() {
  const rosterBody = el('div', { class: 'peoplegrid' });
  const requestBody = el('div', { class: 'requestlist' });
  const rosterCard = card({ label: 'The roster', glyph: 'users', body: rosterBody, tight: true });
  const requestCard = card({ label: 'Asking for an answer', glyph: 'mail', body: requestBody, tight: true });
  const statstrip = el('div', { class: 'statstrip' });

  const searchInput = el('input', {
    class: 'input', type: 'search',
    placeholder: 'Find people by name',
    'aria-label': 'Search for people to add as a friend',
    autocomplete: 'off', spellcheck: 'false',
  });
  const searchResults = el('div', { class: 'rowlist' });
  const searchCard = card({
    label: 'Add people', glyph: 'user-plus', tight: true,
    body: fold([searchInput, searchResults]),
  });

  const paintSearch = (people) => {
    searchResults.replaceChildren(...(people || []).map((person) => {
      const known = State.friends.some((f) => String(f.id) === String(person.id));
      const presence = presenceOf(person.id);
      return row({
        lead: avatar(person, { size: 'sm', rounded: true, presence }),
        title: nameOf(person) || person.username,
        sub: [presenceLabel(presence), person.statusText].filter(Boolean).join(' · '),
        href: path('/users/' + person.id),
        link: true,
        // A search result is a person: the row carries that person's menu.
        menu: () => personSheetEntries(person),
        side: known
          ? el('span', { class: 'chip chip--quiet' }, 'Friends')
          : el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            'aria-label': 'Send a friend request to ' + (nameOf(person) || person.username),
            onClick: async (event) => {
              event.preventDefault();
              event.stopPropagation();
              try {
                await Api.sendFriendRequest(person.id);
                toast('Request sent to ' + (nameOf(person) || person.username));
              } catch (e) { errorToast(e); }
            },
          }, 'Add'),
      });
    }));
    if (!searchResults.childNodes.length) {
      searchResults.replaceChildren(blank({
        glyph: 'search',
        title: 'Nobody by that name',
        text: 'Names, not nicknames, are what find people here.',
      }));
    }
  };

  const searchNow = async () => {
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.replaceChildren();
      searchResults.hidden = true;
      return;
    }
    searchResults.hidden = false;
    let people = [];
    try {
      people = await Api.searchUsers(q);
    } catch (e) {
      searchResults.replaceChildren(fold([fault(e, () => searchNow())]));
      return;
    }
    paintSearch(people);
    // The search answer carries no presence; the presence map does, once it
    // has been asked for the people actually on screen.
    const ids = (people || []).map((person) => person.id);
    if (ids.length) {
      refreshPresence(ids)
        .then(() => paintSearch(people))
        .catch(() => {});
    }
  };
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchNow(); }, 220);
  });
  searchNow();

  // The roster and the request tray hold their breath until the first read has
  // answered: an empty store during that wait is "not asked yet", not "you have
  // no friends", and the difference matters - a page that says empty at 250ms is
  // lying about what it knows.
  let ready = false;

  function paintStats(friends, incoming, outgoing) {
    statstrip.replaceChildren(
      stat(friends.length, 'friends'),
      stat(incoming.length, 'waiting on you'),
      stat(outgoing.length, 'sent'));
  }

  const paint = () => {
    const friends = State.friends || [];
    const incoming = (State.friendRequests && State.friendRequests.incoming) || [];
    const outgoing = (State.friendRequests && State.friendRequests.outgoing) || [];
    paintStats(friends, incoming, outgoing);

    if (!friends.length && !ready) {
      rosterBody.replaceChildren(el('p', { class: 'holdline' }, 'Reading your people'));
    } else if (!friends.length) {
      rosterBody.replaceChildren(blank({
        glyph: 'users',
        title: 'No friends yet',
        text: 'Add someone below; they will fill this wall.',
      }));
    } else {
      // Online first, then the people who were here recently, then the rest.
      // The order is the answer to the question a friends page is actually
      // asked: who can I talk to right now?
      const online = [];
      const recent = [];
      const offline = [];
      const recentFloor = Date.now() - (7 * 24 * 60 * 60 * 1000);
      for (const person of friends) {
        const presence = presenceOf(person.id);
        if (presence && presence !== 'offline') {
          online.push(person);
        } else if (person.lastActiveAt && new Date(person.lastActiveAt).getTime() >= recentFloor) {
          recent.push(person);
        } else {
          offline.push(person);
        }
      }
      const sections = [
        ['Online', online],
        ['Recently active', recent],
        ['Offline', offline],
      ].filter(([, list]) => list.length);
      rosterBody.replaceChildren(...sections.flatMap(([label, list]) => [
        el('div', { class: 'peoplegrid-label' },
          el('span', {}, label),
          el('span', { class: 'peoplegrid-count' }, String(list.length))),
        ...list.map((person) => friendTile(person)),
      ]));
      refreshPresence(friends.slice(0, 40).map((p) => p.id)).catch(() => {});
    }
    if (!ready) {
      requestBody.replaceChildren();
    } else if (incoming.length) {
      requestBody.replaceChildren(...incoming.map((entry) => requestCardTile(entry, paint)));
    } else {
      requestBody.replaceChildren(blank({
        glyph: 'mail',
        title: 'No requests waiting',
        text: 'When someone asks to be your friend, the question lands here.',
      }));
    }
  };

  paint();

  // The account-scoped push arrives when a request or an acceptance happens
  // elsewhere; the roster then reads fresh rather than staying stale silently.
  const unloadFriends = on(SESSION_EVENTS.FRIEND, () => {
    refreshFriends().then(() => paint()).catch(() => {});
  });
  // Presence arrives over the socket and through refreshPresence(), so the
  // faces are repainted from the store rather than from the copy they were
  // built with.
  const unloadPresence = onStore('presence', paint);
  const unloadResync = onStore('resync', () => {
    refreshFriends().then(() => paint()).catch(() => {});
  });

  return {
    node: fold([
      (() => {
        const banner = head({
          kicker: 'People',
          title: 'Friends',
          lede: 'The people you chose, and the ones asking to be chosen.',
          actions: [
            el('button', {
              class: 'btn btn--ghost', type: 'button', onClick: () => navigate('/discover'),
            }, icon('compass', { size: 15 }), 'Discover'),
            el('a', { class: 'btn btn--primary', href: '#add-people' }, icon('user-plus', { size: 15 }), 'Add people'),
          ],
        });
        banner.classList.add('hero');
        return banner;
      })(),
      statstrip,
      requestCard,
      rosterCard,
      (() => { const wrap = el('div', { class: 'anchor', id: 'add-people' }); wrap.appendChild(searchCard); return wrap; })(),
    ]),
    onMount: async () => {
      try {
        await refreshFriends();
        ready = true;
        paint();
      } catch (e) {
        rosterBody.replaceChildren(fold([fault(e, () => refreshFriends().then(() => paint()))]));
      }
    },
    cleanup() {
      unloadFriends();
      unloadPresence();
      unloadResync();
      clearTimeout(searchTimer);
    },
  };
}

export default { renderFriends };
