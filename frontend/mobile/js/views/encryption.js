// The phone's encryption settings.
//
// The account's own half of end-to-end encryption, in the phone's shape: a
// screen of lists and bottom sheets rather than a page of cards.
//
// Five things live here.
//
//   1. This device: the name the server knows it by, the fingerprint a reader
//      compares, and whether the server has it.
//   2. The account's devices: every one of them, and the means to revoke one.
//   3. The safety number with a peer, and the warning when it changes.
//   4. The key backup: whether there is one, and how to make one.
//   5. Recovery: the way back into a device that was lost.
//
// The rules the screen keeps:
//
//   1. The private keys never leave this phone. What the server holds is the
//      public keys and a sealed blob it cannot open.
//   2. The recovery key is shown once. The screen says so, and once it has
//      been shown it offers no way to see it again.
//   3. Recovering registers a NEW device. The lost device keeps its identity
//      until it is revoked, and revoking it is a separate, deliberate act.
//
// The screen is one settings body: the account scope draws it in place of the
// others, and the phone's own primitives do the rest.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { State } from '../../../packages/store.js';
import { createDevice, deviceFromBackup } from '../../../packages/e2ee/index.js';
import { client as encryptionClient, deviceLabel } from '../encrypted.js';
import { copyText } from '../clipboard.js';
import { empty, failure, loading } from '../components.js';
import { notice, section } from './util.js';
import { confirm, sheet, toast } from '../ui.js';

// Where the phone remembers the last safety number it saw for a peer, and
// which device it has already shown a recovery key for. The phone keeps its
// own store: the desk's is the desk's business.
const SAFETY_STORE = 'trycord.mobile.e2ee.safety.';
const SHOWN_STORE = 'trycord.mobile.e2ee.recovery-shown.';

/** The account the screen is about. Two people on one phone keep two sets. */
function scope() {
  const user = State.user;
  return user && user.id ? safePart(user.id) : 'guest';
}

function safePart(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function safetyKey(peerId) {
  return SAFETY_STORE + scope() + '.' + safePart(peerId);
}

/** The safety number this phone last saw for a peer, or null. */
function rememberedSafety(peerId) {
  try {
    return localStorage.getItem(safetyKey(peerId));
  } catch {
    return null;
  }
}

function rememberSafety(peerId, digits) {
  try {
    localStorage.setItem(safetyKey(peerId), String(digits || ''));
  } catch { /* the number is simply not remembered */ }
}

/** Whether this phone has already shown the recovery key of a device. */
function recoveryKeyShown(deviceId) {
  try {
    return localStorage.getItem(SHOWN_STORE + scope() + '.' + safePart(deviceId)) === '1';
  } catch {
    return false;
  }
}

function rememberRecoveryKeyShown(deviceId) {
  try {
    localStorage.setItem(SHOWN_STORE + scope() + '.' + safePart(deviceId), '1');
  } catch { /* storage is not available; the key is shown once all the same */ }
}

/** The fingerprint of a device, in the blocks a reader compares. */
function fingerprintBlocks(fingerprint) {
  const hex = String(fingerprint || '');
  if (!hex) return 'unknown';
  const blocks = [];
  for (let i = 0; i < hex.length; i += 8) blocks.push(hex.slice(i, i + 8).toUpperCase());
  return blocks.join(' ');
}

/** The safety number in the groups of five a reader reads out. */
function digitBlocks(digits) {
  return String(digits || '').replace(/(\d{5})(?=\d)/g, '$1 ').trim();
}

/**
 * The screen.
 *
 * `options.client` is the seam a check uses to stand in for the phone's own
 * encryption client; without it the phone's client is used.
 *
 * @param {object} options { client }
 * @returns {HTMLElement} the body of the encryption settings
 */
export function encryptionBody(options) {
  const opts = options || {};
  const openClient = typeof opts.client === 'function' ? opts.client : encryptionClient;

  const host = el('div', { class: 'm-stack' });

  const thisDevice = el('div', { class: 'm-stack' });
  const deviceList = el('div', { class: 'm-list' });
  const backupBox = el('div', { class: 'm-stack' });

  let opening = null;

  /** The open client, opened once and kept for as long as the screen lives. */
  async function open() {
    if (!opening) {
      opening = Promise.resolve().then(() => openClient()).catch((error) => {
        opening = null;
        throw error;
      });
    }
    return opening;
  }

  // -- this device ------------------------------------------------------------

  const paintThisDevice = async () => {
    thisDevice.replaceChildren(loading('Reading this device'));
    try {
      const client = await open();
      const device = client.device;
      if (!device) {
        thisDevice.replaceChildren(empty({
          icon: 'lock',
          title: 'This phone has no device yet',
          text: 'A device is this phone\'s own identity in the protocol: it holds the private keys and signs what this phone sends. It registers the first time you send an encrypted message.',
          action: el('button', {
            class: 'm-btn m-btn--block m-btn--primary', type: 'button',
            onClick: () => registerThisPhone(),
          }, 'Register this phone'),
        }));
        return;
      }
      thisDevice.replaceChildren(
        el('div', { class: 'm-list' },
          el('div', { class: 'm-row' },
            el('span', { class: 'm-row__lead' }, icon('lock', { size: 18 })),
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title' }, device.label || 'This phone'),
              el('span', { class: 'm-row__sub' }, device.registered
                ? 'Registered with the server'
                : 'Not registered with the server yet')))),
        notice({
          tone: 'info',
          icon: 'key',
          title: 'Fingerprint',
          text: 'The blocks a reader compares, side by side or read out.',
          body: el('code', { class: 'm-code' }, fingerprintBlocks(device.fingerprint())),
        }),
        el('p', { class: 'm-section__lead' },
          'Your private keys stay on this phone. The server holds the public keys, and a copy of the private '
          + 'material sealed under your recovery key — a blob it cannot open.'),
      );
    } catch (error) {
      thisDevice.replaceChildren(failure(error, paintThisDevice));
    }
  };

  /** Register this phone, and show the recovery key while it is new. */
  const registerThisPhone = async () => {
    const user = State.user;
    if (!user || !user.id) {
      toast('There is no account to register this phone with.', { type: 'danger' });
      return;
    }
    try {
      const client = await open();
      await client.ready({ userId: user.id, label: deviceLabel() });
      toast('This phone is registered', { type: 'success' });
      await paintThisDevice();
      await paintDevices();
      // A new device has a recovery key nobody has seen. This is the one
      // moment the screen shows it.
      const device = client.device;
      if (device && device.recoveryKey && !recoveryKeyShown(device.id)) {
        await showRecoveryKey(device);
      } else {
        await paintBackup();
      }
    } catch (error) {
      toast(error && error.message ? error.message : 'This phone could not be registered.', { type: 'danger' });
    }
  };

  // -- the account's devices --------------------------------------------------

  const deviceRow = (device, client) => {
    const mine = !!(client.device && device.id === client.device.id);
    const title = (device.label || 'A device') + (mine ? ' — this phone' : '');
    const state = device.revoked
      ? 'Revoked'
      : device.recoveryEnabled ? 'Registered · can be recovered' : 'Registered';
    return el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, icon(device.revoked ? 'ban' : 'lock', { size: 18 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, title),
        el('span', { class: 'm-row__sub' }, state)),
      el('span', { class: 'm-row__actions' },
        device.revoked || mine ? null : el('button', {
          class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
          'aria-label': 'Revoke ' + (device.label || 'this device'),
          onClick: () => revoke(device),
        }, 'Revoke')));
  };

  const paintDevices = async () => {
    deviceList.replaceChildren(loading('Reading the devices'));
    try {
      const client = await open();
      const answer = await client.api.listDevices();
      const devices = (answer && answer.devices) || [];
      if (!devices.length) {
        deviceList.replaceChildren(empty({
          icon: 'monitor',
          title: 'No devices',
          text: 'This account has not registered a device yet.',
        }));
        return;
      }
      deviceList.replaceChildren(...devices.map((device) => deviceRow(device, client)));
    } catch (error) {
      deviceList.replaceChildren(failure(error, paintDevices));
    }
  };

  /** Revoke a device, after saying what revoking it means. */
  const revoke = async (device) => {
    const name = device.label || 'That device';
    const yes = await confirm({
      title: 'Revoke ' + name + '?',
      text: 'It stops being able to read this account\'s conversations, and the other devices have to rekey what they shared with it. It has to register again to come back.',
      body: device.keyFingerprint
        ? el('div', { class: 'm-stack' },
          el('p', { class: 'm-lede' }, 'Check that this is the device you mean:'),
          el('code', { class: 'm-code' }, fingerprintBlocks(device.keyFingerprint)))
        : null,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!yes) return;
    try {
      const client = await open();
      await client.api.revokeDevice(device.id);
      toast(name + ' is revoked', { type: 'success' });
      await paintDevices();
    } catch (error) {
      toast(error && error.message ? error.message : 'That device could not be revoked.', { type: 'danger' });
    }
  };

  // -- the safety number ------------------------------------------------------

  const paintSafety = () => {
    const input = el('input', {
      class: 'm-input', type: 'text', autocomplete: 'off',
      placeholder: 'Their user id', 'aria-label': 'The other person\'s user id',
    });
    const status = el('p', { class: 'm-lede', role: 'status' });
    const output = el('div', { class: 'm-stack' });
    output.replaceChildren(el('p', { class: 'm-lede' },
      'Two people who read the same number over a channel they trust are talking to the same keys. '
      + 'The number changes when a device is added or revoked, which is the moment it is worth looking again.'));
    const form = el('form', {
      class: 'm-stack',
      onSubmit: async (event) => {
        event.preventDefault();
        const peerId = input.value.trim();
        if (!peerId) {
          status.textContent = 'Give the other person\'s user id.';
          return;
        }
        status.textContent = 'Reading the safety number…';
        try {
          const client = await open();
          const answer = await client.api.safetyNumber(peerId);
          const digits = (answer && answer.digits) || '';
          const before = rememberedSafety(peerId);
          rememberSafety(peerId, digits);
          status.textContent = '';
          const shown = [notice({
            tone: 'info',
            icon: 'shield',
            title: 'Safety number',
            text: 'Read this out and compare it with the other person.',
            body: el('code', { class: 'm-code' }, (answer && answer.display) || digitBlocks(digits)),
          })];
          if (before && before !== digits) {
            shown.push(notice({
              tone: 'warning',
              icon: 'alert',
              role: 'alert',
              title: 'The safety number has changed',
              text: 'It was ' + digitBlocks(before) + ' before. A number that changes is either a device that was added or one that was revoked — or somebody in the middle. Compare it again before you trust the conversation.',
            }));
          }
          output.replaceChildren(...shown);
        } catch (error) {
          status.textContent = '';
          output.replaceChildren(failure(error, null));
          toast(error && error.message ? error.message : 'The safety number could not be read.', { type: 'danger' });
        }
      },
    },
      el('div', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'The other person\'s user id'),
        input),
      el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'submit' }, 'Show the safety number'),
      status);
    return el('div', { class: 'm-stack' }, form, output);
  };

  // -- the key backup ---------------------------------------------------------

  /**
   * Show the recovery key, once.
   *
   * It is the one thing that can open the backup, and the server never sees
   * it. It is shown here and nowhere else, and the phone remembers that it has
   * been shown so that it is never shown a second time.
   */
  const showRecoveryKey = async (device) => {
    let secret = String(device.recoveryKey || '');
    if (!secret) {
      toast('This device has no recovery key.', { type: 'danger' });
      return;
    }
    const block = el('code', { class: 'm-secret' }, secret);
    const layer = sheet({
      title: 'Your recovery key',
      body: el('div', { class: 'm-stack' },
        el('p', { class: 'm-lede' },
          'This is the only time the recovery key is shown. Keep it somewhere safe: it is the only thing '
          + 'that can open the key backup, and the server never sees it.'),
        block),
      footer: el('div', { class: 'm-actions' },
        el('button', {
          class: 'm-btn m-btn--block m-btn--ghost', type: 'button',
          onClick: () => copyText(secret, 'Recovery key'),
        }, 'Copy it'),
        el('button', {
          class: 'm-btn m-btn--block m-btn--primary', type: 'button',
          onClick: () => layer.close(),
        }, 'I have it')),
      onClose: () => {
        secret = '';
        block.textContent = '';
      },
    });
    rememberRecoveryKeyShown(device.id);
    // The screen offers no way to see the key a second time, so the offer goes
    // as soon as the key has been shown.
    await paintBackup();
  };

  const makeBackup = async () => {
    try {
      const client = await open();
      await client.backup();
      toast('The key backup is stored', { type: 'success' });
      await paintBackup();
    } catch (error) {
      toast(error && error.message ? error.message : 'The backup could not be stored.', { type: 'danger' });
    }
  };

  const paintBackup = async () => {
    backupBox.replaceChildren(loading('Looking for the key backup'));
    try {
      const client = await open();
      const device = client.device;
      if (!device) {
        backupBox.replaceChildren(empty({
          icon: 'database',
          title: 'No device yet',
          text: 'There is nothing to back up until this phone has a device.',
        }));
        return;
      }
      let stored = false;
      try {
        const answer = await client.api.fetchBackup();
        stored = !!(answer && answer.backup);
      } catch (error) {
        // The server answers that there is no backup. That is an answer, not a
        // failure: a phone that has never backed up its keys is ordinary.
        if (!error || error.status !== 404) throw error;
      }
      const shown = recoveryKeyShown(device.id);
      backupBox.replaceChildren(
        el('div', { class: 'm-list' },
          el('div', { class: 'm-row' },
            el('span', { class: 'm-row__lead' }, icon('database', { size: 18 })),
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title' }, stored ? 'There is a key backup' : 'There is no key backup'),
              el('span', { class: 'm-row__sub' }, stored
                ? 'The server holds it, sealed under your recovery key'
                : 'Make one and the server will hold it, sealed'))),
          el('div', { class: 'm-row' },
            el('span', { class: 'm-row__lead' }, icon('key', { size: 18 })),
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title' }, 'Recovery key'),
              el('span', { class: 'm-row__sub' }, shown
                ? 'Shown once. It cannot be shown again.'
                : 'Shown once, and never again. Keep it somewhere safe.')),
            el('span', { class: 'm-row__actions' },
              shown ? null : el('button', {
                class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
                'aria-label': 'Show the recovery key',
                onClick: () => showRecoveryKey(device),
              }, 'Show it')))),
        el('p', { class: 'm-section__lead' },
          'The backup is this device\'s private material sealed under the recovery key. The server stores it '
          + 'and cannot open it, and the recovery key itself never goes to the server.'),
        el('button', {
          class: 'm-btn m-btn--block m-btn--primary', type: 'button',
          onClick: () => makeBackup(),
        }, 'Back up the keys'),
      );
    } catch (error) {
      backupBox.replaceChildren(failure(error, paintBackup));
    }
  };

  // -- the recovery -----------------------------------------------------------

  const paintRecovery = () => {
    const key = el('input', {
      class: 'm-input', type: 'password', autocomplete: 'off',
      placeholder: 'The recovery key', 'aria-label': 'The recovery key',
    });
    const status = el('p', { class: 'm-lede', role: 'status' });
    const form = el('form', {
      class: 'm-stack',
      onSubmit: async (event) => {
        event.preventDefault();
        const recoveryKey = key.value.trim();
        if (!recoveryKey) {
          status.textContent = 'The recovery key is needed.';
          return;
        }
        status.textContent = 'Opening the backup…';
        try {
          const client = await open();
          const material = await client.openBackup(recoveryKey);
          if (!material) {
            status.textContent = 'There is no key backup on the server for this account.';
            return;
          }
          const user = State.user;
          const sourceKeys = deviceFromBackup(material);
          const newDevice = await createDevice({
            userId: user && user.id,
            label: deviceLabel() + ' (recovered)',
            recoveryKey,
          });
          const answer = await client.recover({
            userId: user && user.id,
            sourceDeviceId: material.deviceId,
            sourceKeys,
            newDevice,
          });
          await client.adoptDevice(newDevice);
          await client.register();
          await client.publishPrekeys();
          key.value = '';
          status.textContent = 'This phone is now a new device'
            + (answer && answer.device && answer.device.label ? ' (' + answer.device.label + ')' : '')
            + '. Revoke the lost one when you are ready: until it is revoked it can still read this account\'s conversations.';
          toast('Recovered: this phone is a new device', { type: 'success' });
          await paintDevices();
          await paintThisDevice();
          await paintBackup();
        } catch (error) {
          status.textContent = '';
          toast(error && error.message ? error.message : 'That did not work.', { type: 'danger' });
        }
      },
    },
      el('div', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'The recovery key'),
        key),
      el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'submit' }, 'Recover this account'),
      status);

    // The screen says what recovering is before it asks for anything.
    return el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' },
        'Recovering registers a new device with new keys. It does not take the lost device\'s identity, so the '
        + 'lost device can still read this account\'s conversations until you revoke it — and should be.'),
      form);
  };

  // -- the screen -------------------------------------------------------------

  host.append(
    section('This device', thisDevice, { note: 'Where this phone\'s private keys are' }),
    section('This account\'s devices', el('div', { class: 'm-stack' },
      deviceList,
      el('p', { class: 'm-section__lead' },
        'Revoking a device stops it reading anything new. The other devices have to rekey what they shared with '
        + 'it, and it has to register again to come back.')), { note: 'Every device registered to this account' }),
    section('Safety number', paintSafety(), { note: 'Compare this with the person you are talking to' }),
    section('Key backup', backupBox, { note: 'What the server holds for this account' }),
    section('Recovery', paintRecovery(), { note: 'Getting a lost device back' }),
  );

  paintThisDevice();
  paintDevices();
  paintBackup();

  return host;
}

export default { encryptionBody };
