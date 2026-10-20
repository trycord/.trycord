// Settings: privacy.
// Who can reach you, and who can see you. The scopes the backend honours are
// anyone, friends and nobody; the toggles mirror them exactly.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { nameOf } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import { avatar, switchControl, setSwitch, fieldRow } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';

export function privacyView() {
  const blocksList = el('div', { class: 'rowlist' });
  const reportsList = el('div', { class: 'rowlist' });
  const saved = el('p', { class: 'form-error', role: 'status' });
  const selection = new Map();

  const scopePick = (key, label, note) => {
    const select = el('select', { class: 'input', 'aria-label': label },
      el('option', { value: 'anyone' }, 'Anyone'),
      el('option', { value: 'friends' }, 'Friends only'),
      el('option', { value: 'nobody' }, 'Nobody'));
    selection.set(key, select);
    return fieldRow(label, note, select);
  };

  const discoverToggle = switchControl(true, async (on) => {
    try {
      await Api.setPrivacy({ discoverable: on });
      saved.textContent = on ? 'You are in the directory again' : 'You stay out of the directory';
    } catch (e) { errorToast(e); }
  }, 'In the directory');

  // The reach card holds the working state until the policy has been read, so
  // the reader is not shown a guess while it loads.
  const reachBody = el('div', { class: 'fold' }, el('p', { class: 'holdline' }, 'Reading your contact policy'));

  // The rows are built once, before the policy is read: the values the server
  // gives are set on these very controls, so building them afterwards would
  // throw the answer away.
  const reachRows = [
    scopePick('friendRequests', 'Friend requests', 'Who can ask to be your friend'),
    scopePick('dms', 'Messages', 'Who can open a conversation with you'),
    scopePick('presence', 'Presence', 'Who can tell when you are here'),
  ];

  const saveReach = el('button', {
    class: 'btn btn--primary btn--sm', type: 'button',
    onClick: async () => {
      try {
        await Api.setPrivacy({
          friendRequests: selection.get('friendRequests').value,
          dms: selection.get('dms').value,
          presence: selection.get('presence').value,
        });
        saved.textContent = 'Saved';
      } catch (e) { errorToast(e); }
    },
  }, 'Save reach');

  const paintBlocks = async () => {
    try {
      const blocks = await Api.blocks();
      const rows = Array.isArray(blocks) ? blocks : (blocks && blocks.items) || [];
      const unblock = async (blocked) => {
        try {
          await Api.unblockUser(blocked.id);
          toast('Unblocked');
          paintBlocks();
        } catch (e) { errorToast(e); }
      };
      blocksList.replaceChildren(...(rows.length ? rows.map((blocked) => row({
        lead: avatar(blocked, { size: 'sm', rounded: true }),
        title: nameOf(blocked) || blocked.username || 'Someone',
        sub: 'Blocked',
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Unblock ' + (blocked.username || 'this person'),
          onClick: () => unblock(blocked),
        }, 'Unblock'),
        // The same two things, raised by a right-click on the row.
        menu: () => [
          { label: 'Unblock', icon: 'check', onSelect: () => unblock(blocked) },
          {
            label: 'Open the profile', icon: 'user',
            onSelect: () => navigate('/users/' + blocked.id),
          },
        ],
      })) : [blank({
        glyph: 'ban', title: 'Nobody blocked',
        text: 'Blocking starts on a person, in their profile.',
      })]));
    } catch (e) {
      blocksList.replaceChildren(fold([fault(e, null)]));
    }
  };

  const paintReports = async () => {
    try {
      const reps = await Api.myReports();
      const ritems = Array.isArray(reps) ? reps : (reps && (reps.items || reps.reports)) || [];
      reportsList.replaceChildren(...(ritems.length ? ritems.map((r) => row({
        lead: el('span', { class: 'role-dot' }, icon('flag', { size: 15 })),
        title: r.reason || r.targetType || 'A report',
        sub: r.status || r.createdAt || r.created_at || '',
      })) : [blank({
        glyph: 'flag', title: 'No reports filed',
        text: 'Reports you raise appear here.',
      })]));
    } catch (e) {
      reportsList.replaceChildren(fold([fault(e, null)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Safety',
        title: 'Privacy',
        lede: 'Who can reach you, and who can see you.',
      }),
      card({
        label: 'Reach', glyph: 'compass',
        body: reachBody,
      }),
      card({
        label: 'Directory', glyph: 'users',
        rows: [fieldRow('In the public directory',
          'Strangers searching the instance can find you.', discoverToggle)],
      }),
      card({ label: 'Blocked', glyph: 'ban', body: blocksList, flush: true }),
      card({ label: 'Your reports', glyph: 'flag', body: reportsList, flush: true }),
      card({
        label: 'Your data', glyph: 'download',
        body: fold([
          el('p', { class: 'lede' }, 'Take a copy of everything this instance holds about you.'),
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: async () => {
              try {
                const payload = await Api.exportMyData();
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = el('a', { href: url, download: 'trycord-export.json' });
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                toast('Export downloaded');
              } catch (e) { errorToast(e); }
            },
          }, icon('download', { size: 14 }), 'Export my data'),
        ]),
      }),
    ]),
    onMount: async () => {
      try {
        const privacy = await Api.privacy();
        for (const [key, select] of selection) {
          if (privacy && privacy[key]) select.value = privacy[key];
        }
        if (privacy && typeof privacy.discoverable === 'boolean') {
          setSwitch(discoverToggle, privacy.discoverable);
        }
        reachBody.replaceChildren(...reachRows, saveReach, saved);
      } catch (e) {
        reachBody.replaceChildren(fold([fault(e, null)]));
      }
      await paintBlocks();
      await paintReports();
    },
    cleanup() {},
  };
}
