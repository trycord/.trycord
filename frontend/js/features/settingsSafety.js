// Settings: privacy.
// Who can reach you, and who can see you. The scopes the backend honours are
// anyone, friends and nobody; the toggles mirror them exactly.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { nameOf } from '../../packages/store.js';
import { avatar, switchControl, fieldRow } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';

export function privacyView() {
  const reportsList = el('div', { class: 'rowlist' });

  // I'll insert the card in the node array. Need to edit the node. Let me add card after Blocked.
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

  const body = el('div', { class: 'anticipation-line' }, holdBlock());

  function holdBlock() {
    return el('p', { class: 'holdline' }, 'Reading your contact policy');
  }

  const paintBlocks = async () => {
    const blocks = await Api.blocks();
    const rows = Array.isArray(blocks) ? blocks : (blocks && blocks.items) || [];
    blocksList.replaceChildren(...(rows.length ? rows.map((blocked) => row({
      lead: avatar(blocked, { size: 'sm', rounded: true }),
      title: nameOf(blocked) || blocked.username || 'Someone',
      sub: 'Blocked',
      side: el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Unblock ' + (blocked.username || 'this person'),
        onClick: async () => {
          try {
            await Api.unblockUser(blocked.id);
            toast('Unblocked');
            paintBlocks();
          } catch (e) { errorToast(e); }
        },
      }, 'Unblock'),
    })) : [blank({
      glyph: 'ban', title: 'Nobody blocked',
      text: 'Blocking starts on a person, in their profile.',
    })]));
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
        body: fold([
          scopePick('friendRequests', 'Friend requests', 'Who can ask to be your friend'),
          scopePick('dms', 'Messages', 'Who can open a conversation with you'),
          scopePick('presence', 'Presence', 'Who can tell when you are here'),
          el('button', {
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
          }, 'Save reach'),
          saved,
        ]),
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
          const box = discoverToggle.querySelector('input');
          if (box) box.checked = privacy.discoverable;
        }
        body.replaceChildren();
        await paintBlocks();
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
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}
