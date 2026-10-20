// Admin: instance infrastructure.
// The announcements an operator broadcasts, the public pages this instance
// serves, where the data lives, and the federation switch called Continuum.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, facts, memo, deck, hold, stamp } from '../ui/page.js';
import { badge, switchControl, fieldRow } from '../ui/primitives.js';
import { errorToast, toast, confirmDialog, openDialog } from '../ui/overlays.js';

// -- announcements -----------------------------------------------------------

export function adminAnnouncements() {
  const list = el('div', { class: 'rowlist' });

  const paintRows = async () => {
    try {
      const rows = await Api.allAnnouncements();
      const items = Array.isArray(rows) ? rows : (rows && (rows.items || rows.announcements)) || [];
      const remove = async (announcement) => {
        const yes = await confirmDialog({
          title: 'Delete this announcement?',
          body: 'Everyone stops seeing it at once.',
          confirmLabel: 'Delete', danger: true,
        });
        if (!yes) return;
        try {
          await Api.deleteAnnouncement(announcement.id);
          toast('Announcement removed');
          paintRows();
        } catch (e) { errorToast(e); }
      };
      list.replaceChildren(...(items.length ? items.map((a) => row({
        lead: el('span', { class: 'role-dot' }, icon('bell', { size: 15 })),
        title: a.title || 'An announcement',
        sub: a.body ? String(a.body).slice(0, 90) : '',
        side: el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Delete the announcement ' + (a.title || ''),
          onClick: () => remove(a),
        }, 'Delete'),
        // The same thing, raised by a right-click on the row.
        menu: () => [
          { label: 'Delete the announcement', icon: 'trash', danger: true, onSelect: () => remove(a) },
        ],
      })) : [blank({
        glyph: 'bell', title: 'Nothing announced',
        text: 'An announcement reaches everyone who opens this instance.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, null)]));
    }
  };

  const compose = () => {
    const title = el('input', {
      class: 'input', type: 'text', 'aria-label': 'Announcement title',
      placeholder: 'What it says at a glance',
    });
    const text = el('textarea', {
      class: 'input', rows: '4', 'aria-label': 'Announcement body',
      placeholder: 'What everyone is told',
    });
    const dialog = openDialog({
      title: 'New announcement',
      body: el('form', {
        class: 'fold', onSubmit: async (event) => {
          event.preventDefault();
          try {
            await Api.createAnnouncement({ title: title.value.trim(), body: text.value });
            dialog.close();
            toast('The announcement is up');
            paintRows();
          } catch (e) { errorToast(e); }
        },
      }, title, text,
        el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Announce')),
    });
    title.focus();
  };

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Announcements',
        lede: 'Messages shown to everyone.',
        actions: el('button', {
          class: 'btn btn--default btn--sm', type: 'button', onClick: compose,
        }, icon('plus', { size: 14 }), 'New announcement'),
      }),
      card({ label: 'Announcements', glyph: 'bell', body: list, flush: true }),
    ]),
    onMount: paintRows,
    cleanup() {},
  };
}

// -- pages ---------------------------------------------------------------------
//
// The page editor has its own module: it is a whole editor rather than one
// panel of the instance console, and it is the only place in the client that
// writes a document body. See adminPages.js.

// -- database ----------------------------------------------------------------------

// -- diagnostics ------------------------------------------------------------------
//
// What each subsystem of this instance is really doing. The backend asks each
// one in its own terms, so a subsystem that is configured but cannot prove
// itself says so rather than showing a green tick.

const STATE_TONE = {
  healthy: 'chip--on',
  degraded: 'chip--quiet',
  failed: 'chip--quiet',
  disabled: 'chip--quiet',
  configured: 'chip--quiet',
  unknown: 'chip--quiet',
};

export function adminDiagnostics() {
  const body = el('div', { class: 'anticipation-line' });
  const summary = el('div', { class: 'factline' });

  const describe = (detail) => {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    if (detail.note) return detail.note;
    if (detail.error) return detail.error;
    return '';
  };

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Diagnostics',
        lede: 'What each subsystem of this instance is really doing.',
      }),
      card({ label: 'This instance', glyph: 'activity', body: summary }),
      card({ label: 'Subsystems', glyph: 'settings', body }),
    ]),
    onMount: async () => {
      try {
        const report = await Api.adminDiagnostics();
        const subsystems = report.subsystems || {};
        summary.replaceChildren(
          facts([
            { value: report.instanceId || 'local', label: 'instance' },
            { value: report.version || '—', label: 'version' },
            { value: report.node || '—', label: 'node' },
            { value: report.overall || '—', label: 'overall' },
          ]));

        const rows = Object.entries(subsystems).map(([name, entry]) => row({
          lead: el('span', { class: 'role-dot' }, icon('activity', { size: 15 })),
          title: name,
          sub: describe(entry.detail),
          side: el('span', { class: 'chip ' + (STATE_TONE[entry.state] || 'chip--quiet') }, entry.state),
        }));
        body.replaceChildren(...rows);
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

export function adminDatabase() {
  const factsBody = el('div', { class: 'anticipation-line' });
  const quotaBody = el('div', { class: 'anticipation-line' });
  const backupBody = el('div', { class: 'fold fold--tight' });
  const backupButton = el('button', {
    class: 'btn btn--primary btn--sm', type: 'button',
    onClick: async () => {
      backupButton.disabled = true;
      backupBody.replaceChildren(hold('Taking the backup'));
      try {
        const out = await Api.adminTakeBackup();
        const info = (out && out.backup) || {};
        toast('Backup written');
        backupBody.replaceChildren(
          el('p', { class: 'lede' },
            (info.tables || 0) + ' tables, ' + (info.rows || 0) + ' rows, '
            + Math.round((info.bytes || 0) / 1048576) + ' MB.'),
          el('p', { class: 'form-note' }, info.path || ''));
        paintBackups();
      } catch (e) {
        backupBody.replaceChildren(fold([fault(e, null)]));
        backupButton.disabled = false;
      }
    },
  }, 'Back up now');

  async function paintBackups() {
    try {
      const out = await Api.adminBackups();
      const items = (out && out.backups) || [];
      if (!items.length) {
        backupBody.replaceChildren(el('p', { class: 'form-note' },
          'No backups on this host yet. ' + ((out && out.directory) || '')));
        return;
      }
      backupBody.replaceChildren(...items.map((b) => el('p', { class: 'form-note' },
        b.name + ' · ' + Math.round(b.bytes / 1048576) + ' MB · ' + b.writtenAt)));
    } catch (e) {
      backupBody.replaceChildren(fold([fault(e, null)]));
    }
  }

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Database',
        lede: 'Where this instance keeps its data, and how to move it.',
      }),
      card({ label: 'Where it lives', glyph: 'database', body: factsBody }),
      card({ label: 'Storage quota', glyph: 'hard-drive', body: quotaBody }),
      card({
        label: 'Backups', glyph: 'download',
        body: fold([backupButton, backupBody]),
      }),
    ]),
    onMount: async () => {
      try {
        const config = await Api.databaseConfig();
        const entries = (config && typeof config === 'object' && !Array.isArray(config))
          ? Object.entries(config).filter(([, v]) => typeof v !== 'object')
          : [];
        factsBody.replaceChildren(
          facts(entries.slice(0, 6).map(([key, value]) => ({
            value: String(value === undefined || value === null ? '—' : value),
            label: String(key).replace(/_/g, ' '),
          }))),
          blank({
            glyph: 'database',
            title: 'Read from here, change with care',
            text: 'Moving a database is a migration, not a setting: a backup first, then one change.',
          }));
      } catch (e) {
        factsBody.replaceChildren(fold([fault(e, null)]));
      }
      try {
        const q = await Api.attachmentQuota();
        const entries = (q && typeof q === 'object' && !Array.isArray(q))
          ? Object.entries(q).filter(([, v]) => typeof v !== 'object' || v === null)
          : [];
        quotaBody.replaceChildren(entries.length
          ? facts(entries.slice(0, 8).map(([key, value]) => ({
            value: String(value === undefined || value === null ? '—' : value),
            label: String(key).replace(/_/g, ' '),
          })))
          : blank({
            glyph: 'hard-drive', title: 'No quota data',
            text: 'Storage usage appears here when the backend reports it.',
          }));
      } catch (e) {
        quotaBody.replaceChildren(fold([fault(e, null)]));
      }
      await paintBackups();
    },
    cleanup() {},
  };
}

// -- continuum ------------------------------------------------------------------------
//
// The federation manager. Continuum is this instance's opt-in relationship with other
// Trycord instances: signed envelopes delivered over HTTPS to peers an operator added
// here, an outbox that retries with backoff, and an inbox that verifies and
// deduplicates what arrives. Everything below reads the real backend state: the
// discovery document for identity, the settings store for the master switch, and the
// admin routes for peers and traffic. The switch is live - the settings store owns the
// flag and every route re-checks it, so turning it on or off here takes effect at once.

export function adminContinuum() {
  const stage = el('div', { class: 'fold fold--tight' });

  // The catalogue entry for the master switch, fetched through the same settings
  // console the rest of the configuration uses.
  const readSwitchEntry = async () => {
    const catalogue = await Api.instanceSettings();
    for (const category of (catalogue && catalogue.categories) || []) {
      const found = (category.settings || []).find((s) => s.key === 'continuum.enabled');
      if (found) return found;
    }
    return null;
  };

    const repaintables = {}; // repaint handlers the live panels register below

  const flip = async (on) => {
    try {
      // The desktop page asks before turning federation on; the settings
      // endpoint still needs its own confirmation flag for a consequential
      // value, so the click that is already a decision carries it.
      await Api.updateInstanceSettings(on
        ? { 'continuum.enabled': true, __confirm: true }
        : { 'continuum.enabled': false });
      toast(on ? 'Continuum is on' : 'Continuum is off');
      await paint();
    } catch (e) { errorToast(e); }
  };

  const switchCard = (entry) => card({
    label: 'The federation switch', glyph: 'power',
    body: fold([
      fieldRow(
        'Community Continuum',
        (entry && entry.source === 'environment')
          ? 'Currently forced on by the deployment environment. A value saved here takes over once it is saved.'
          : 'While on, trusted peers receive signed events from this instance, and this one accepts events from instances an operator added. While off nothing is sent and the discovery document answers that federation is not available.',
        switchControl(!!(entry && entry.value), async (on) => {
          if (on) {
            const yes = await confirmDialog({
              title: 'Turn on Community Continuum?',
              body: 'From then on this instance accepts federation traffic an operator allows, and its discovery document is public.',
              confirmLabel: 'Turn on',
            });
            if (!yes) return;
          }
          await flip(on);
        }, 'Community Continuum'),
      ),
      el('p', { class: 'settings-note' }, (entry && entry.description) || ''),
    ]),
  });

  // Identity: what the discovery document tells the world about this instance.
  // While federation is off the document answers 404, so the card says that
  // instead of guessing.
  const identityCard = async () => {
    try {
      const doc = await Api.continuumDiscovery();
      const keyButton = el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(String(doc.public_key || ''));
            toast('Public key copied');
          } catch { errorToast(new Error('The clipboard refused the copy.')); }
        },
      }, 'Copy public key');
      return card({
        label: 'This instance', glyph: 'share', foot: keyButton,
        body: fold([
          memo({
            tone: 'info',
            title: 'Other operators reach this instance at its origin, under /.well-known/trycord',
            text: 'The document below is exactly what they see. Nothing in it is secret; the key is the half used to verify what this instance sends.',
          }),
          facts([
            { value: doc.instance_id || '—', label: 'instance id' },
            { value: doc.protocol_version || '—', label: 'protocol' },
            { value: Array.isArray(doc.capabilities) ? doc.capabilities.length : 0, label: 'capabilities' },
          ]),
          el('pre', { class: 'keyblock' }, String(doc.public_key || '')),
        ], { tight: true }),
      });
    } catch (e) {
      return card({
        label: 'This instance', glyph: 'share',
        body: memo({
          tone: 'info',
          title: 'The discovery document is closed while federation is off',
          text: 'No instance id and no key are published until the switch above is turned on.',
        }),
      });
    }
  };

  const trustChip = (status) => badge(status || 'pending',
    status === 'trusted' ? 'success' : status === 'blocked' ? 'danger' : 'warning');

  const setTrust = async (id, status) => {
    try {
      await Api.continuumSetTrust(id, status);
      toast(status === 'trusted' ? 'Instance trusted' : status === 'blocked' ? 'Instance blocked' : 'Trust reset to pending');
      if (repaintables.peers) await repaintables.peers();
    } catch (e) { errorToast(e); }
  };

  const peersCard = () => {
    const list = el('div', { class: 'rowlist' });
    const paint = async () => {
      try {
        const peers = await Api.continuumInstances();
        const rows = Array.isArray(peers) ? peers : [];
        list.replaceChildren(...(rows.length ? rows.map((peer) => row({
          lead: el('span', { class: 'role-dot' }, icon('server', { size: 15 })),
          title: peer.name || 'An unnamed instance',
          sub: (peer.id || '') + ' · ' + (peer.origin || ''),
          side: el('div', { class: 'cardrow-side' },
            trustChip(peer.trust_status),
            peer.trust_status !== 'trusted'
              ? el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: () => void setTrust(peer.id, 'trusted') }, 'Trust')
              : el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: () => void setTrust(peer.id, 'blocked') }, 'Block'),
            peer.trust_status !== 'pending'
              ? el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: () => void setTrust(peer.id, 'pending') }, 'Unblock')
              : null),
        })) : [blank({
          glyph: 'share',
          title: 'No peers yet',
          text: 'This instance is local-only right now. Add the first one below: point the check at a remote Trycord instance and add what it says about itself.',
        })]));
      } catch (e) {
        list.replaceChildren(fold([fault(e, paint)]));
      }
    };
    const node = card({ label: 'Connected instances', glyph: 'share', body: list });
    repaintables.peers = paint;
    void paint();
    return node;
  };

  const addCard = () => {
    const originField = el('input', { class: 'input', type: 'url', 'aria-label': 'Remote origin', placeholder: 'https://peer.example.dev' });
    const probeButton = el('button', { class: 'btn btn--default', type: 'button', onClick: () => void runProbe() }, 'Check instance');
    const out = el('div', { class: 'fold fold--tight' });

    const idField = el('input', { class: 'input', 'aria-label': 'Instance id', placeholder: 'their instance id' });
    const nameField = el('input', { class: 'input', 'aria-label': 'Display name', placeholder: 'what to call them here' });
    const keyField = el('textarea', { class: 'input keyblock', rows: 3, 'aria-label': 'Public key', placeholder: '-----BEGIN PUBLIC KEY-----' });
    const addButton = el('button', { class: 'btn btn--primary', type: 'button', onClick: () => void runAdd() }, 'Add instance');

    const runProbe = async () => {
      out.replaceChildren(hold('Asking the remote instance'));
      try {
        const result = await Api.continuumProbe(originField.value.trim());
        const doc = (result && result.discovery) || {};
        idField.value = doc.instance_id || idField.value;
        if (!nameField.value) nameField.value = doc.instance_id || '';
        keyField.value = String(doc.public_key || '').trim() || keyField.value;
        out.replaceChildren(fold([
          memo({
            tone: 'success',
            title: 'The remote answered',
            text: 'Instance id ' + (doc.instance_id || 'unknown') + ', protocol ' + (doc.protocol || 'unknown')
              + (doc.enabled === false ? ', federation currently switched off there.' : ', federation on there.'),
          }),
          idField, nameField, keyField,
          el('div', { class: 'formfoot' }, addButton),
        ], { tight: true }));
      } catch (e) {
        out.replaceChildren(fold([fault(e, runProbe)]));
      }
    };

    const runAdd = async () => {
      try {
        await Api.continuumAddInstance({
          id: idField.value.trim(),
          name: nameField.value.trim() || idField.value.trim(),
          origin: originField.value.trim(),
          public_key: keyField.value.trim(),
        });
        toast('Instance added. Trust it to start exchanging events.');
        originField.value = ''; idField.value = ''; nameField.value = ''; keyField.value = '';
        out.replaceChildren();
        if (repaintables.peers) await repaintables.peers();
      } catch (e) { errorToast(e); }
    };

    return card({
      label: 'Add an instance', glyph: 'plus',
      note: 'the check verifies the remote before anything is stored',
      body: fold([
        fieldRow('Remote origin', 'The base address of the other instance. Its discovery document is fetched.', originField),
        el('div', { class: 'formfoot' }, probeButton),
        out,
      ], { tight: true }),
    });
  };

  const eventsCard = () => {
    const list = el('div', { class: 'rowlist' });
    const paint = async () => {
      try {
        const events = await Api.continuumEvents();
        const rows = Array.isArray(events) ? events : [];
        list.replaceChildren(...(rows.length ? rows.map((event) => row({
          lead: el('span', { class: 'role-dot' }, icon('send', { size: 14 })),
          title: event.kind || 'an event',
          sub: (event.error ? String(event.error).slice(0, 120) : '')
            + (event.attempts != null ? (' · attempt ' + event.attempts + ' of ' + (event.max_attempts || '?')) : ''),
          side: badge(event.status || 'pending',
            event.status === 'delivered' ? 'success' : event.status === 'failed' ? 'danger' : 'warning'),
        })) : [blank({
          glyph: 'send',
          title: 'Nothing has left this instance yet',
          text: 'Posting a message to a community enqueues one signed event here, delivered to every trusted peer.',
        })]));
      } catch (e) {
        list.replaceChildren(fold([fault(e, paint)]));
      }
    };
    const node = card({ label: 'Outbox', glyph: 'send', note: 'what went out', body: list });
    repaintables.events = paint;
    void paint();
    return node;
  };

  const inboxCard = () => {
    const list = el('div', { class: 'rowlist' });
    const paint = async () => {
      try {
        const box = await Api.continuumInbox();
        const rows = Array.isArray(box) ? box : [];
        list.replaceChildren(...(rows.length ? rows.map((item) => row({
          lead: el('span', { class: 'role-dot' }, icon('inbox', { size: 14 })),
          title: item.kind || 'an event',
          sub: 'from ' + (item.instance_id || 'an unknown instance') + ' · ' + stamp(item.received_at),
          side: badge(item.processed ? 'processed' : 'held', item.processed ? 'success' : 'warning'),
        })) : [blank({
          glyph: 'inbox',
          title: 'Nothing has arrived yet',
          text: 'When a trusted peer delivers an event it shows here, with whether this instance processed it.',
        })]));
      } catch (e) {
        list.replaceChildren(fold([fault(e, paint)]));
      }
    };
    const node = card({ label: 'Inbox', glyph: 'inbox', note: 'what arrived', body: list });
    repaintables.inbox = paint;
    void paint();
    return node;
  };

  const paint = async () => {
    try {
      const entry = await readSwitchEntry();
      if (entry && entry.value) {
        const identity = await identityCard();
        stage.replaceChildren(
          switchCard(entry),
          identity,
          peersCard(),
          addCard(),
          deck(eventsCard(), inboxCard()),
        );
      } else {
        stage.replaceChildren(
          switchCard(entry),
          fold([await identityCard()], { tight: true }),
        );
      }
    } catch (e) {
      stage.replaceChildren(fold([fault(e, paint)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Continuum',
        lede: 'Federation with compatible Trycord instances.',
        actions: el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          'aria-label': 'Refresh Continuum',
          onClick: () => void paint(),
        }, 'Refresh'),
      }),
      stage,
    ]),
    onMount: () => paint(),
    cleanup() {},
  };
}
