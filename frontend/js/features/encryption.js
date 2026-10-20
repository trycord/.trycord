// Settings: encryption.
//
// The account's own half of end-to-end encryption: the devices it has
// registered, the fingerprints a reader compares, the safety number with a
// peer, the key backup, and the recovery of a device that was lost.
//
// The rules the page keeps:
//
//   1. The private keys never leave the browser. What the server holds is
//      the public keys, and the private material sealed under the recovery
//      key - a blob it cannot open.
//   2. The recovery key is shown once, and the reader is told what it is
//      for. It is the only thing that can open the backup, and the server
//      never sees it.
//   3. Recovering registers a NEW device. The lost device keeps its identity
//      until it is revoked, and revoking it is a separate, deliberate act.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State } from '../../packages/store.js';
import { head, card, row, blank, fault, fold, memo } from '../ui/page.js';
import { errorToast, toast, confirmDialog } from '../ui/overlays.js';
import { copyText } from '../ui/clipboard.js';
import { client, deviceLabel } from '../ui/encrypted.js';
import { createDevice, deviceFromBackup } from '../../packages/e2ee/index.js';

/** Where the last safety number for a peer is remembered. */
const SAFETY_STORE = 'trycord.e2ee.safety.';

function safetyKey(userId) {
  return SAFETY_STORE + String(userId || '');
}

function rememberedSafety(userId) {
  try {
    return localStorage.getItem(safetyKey(userId));
  } catch {
    return null;
  }
}

function rememberSafety(userId, digits) {
  try {
    localStorage.setItem(safetyKey(userId), String(digits || ''));
  } catch { /* storage is not available; the number is simply not remembered */ }
}

/** The fingerprint of a device, in the blocks a reader compares. */
function fingerprintBlocks(fingerprint) {
  const hex = String(fingerprint || '');
  if (!hex) return 'unknown';
  const blocks = [];
  for (let i = 0; i < hex.length; i += 8) blocks.push(hex.slice(i, i + 8).toUpperCase());
  return blocks.join(' ');
}

export function encryptionView() {
  const devicesList = el('div', { class: 'rowlist' });
  const thisDevice = el('div', { class: 'rowlist' });
  const safetyBox = el('div', { class: 'fold' });
  const recoveryBox = el('div', { class: 'fold' });

  const node = el('div', { class: 'fold' },
    head({
      kicker: 'Settings',
      title: 'Encryption',
      lede: 'The devices this account reads and writes with, and the keys that hold them together.',
    }),
    card({
      label: 'This device',
      note: 'Where your private keys are',
      body: thisDevice,
    }),
    card({
      label: 'Devices',
      note: 'Every device registered to this account',
      body: devicesList,
    }),
    card({
      label: 'Safety number',
      note: 'Compare this with the person you are talking to',
      body: safetyBox,
    }),
    card({
      label: 'Key backup and recovery',
      note: 'Getting a lost device back',
      body: recoveryBox,
    }),
  );

  // -- this device -------------------------------------------------------------

  const paintThisDevice = async () => {
    try {
      const open = await client();
      if (!open.device) {
        thisDevice.replaceChildren(blank({
          glyph: 'lock',
          title: 'No device yet',
          text: 'This browser has not registered a device. It does so the first time you send an encrypted message.',
        }));
        return;
      }
      const keys = open.device.publicKeys();
      thisDevice.replaceChildren(
        memo({
          tone: 'success',
          glyph: 'lock',
          title: open.device.label,
          text: 'Your private keys are in this browser and are never sent anywhere. The server holds the public keys, and a copy of the private material sealed under your recovery key.',
          body: el('div', { class: 'fold fold--tight' },
            el('p', { class: 'cardrow-sub' }, 'Fingerprint: ', el('code', {}, fingerprintBlocks(await open.device.fingerprint()))),
            el('p', { class: 'cardrow-sub' }, 'Recovery key: ', el('code', { class: 'keyblock' }, open.device.recoveryKey)),
            el('p', { class: 'cardrow-sub' },
              'Keep the recovery key somewhere safe. It is the only thing that can open the backup, and the server never sees it.')),
          actions: el('div', { class: 'memo-actions' },
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => copyText(open.device.recoveryKey, 'Recovery key'),
            }, 'Copy the recovery key'),
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => saveBackup(open),
            }, 'Back up the keys')),
        }),
      );
    } catch (error) {
      thisDevice.replaceChildren(fold([fault(error, () => paintThisDevice())]));
    }
  };

  const saveBackup = async (open) => {
    try {
      await open.backup();
      toast('The key backup is stored');
    } catch (error) {
      errorToast(error);
    }
  };

  // -- the account's devices ----------------------------------------------------

  const paintDevices = async () => {
    try {
      const open = await client();
      const answer = await open.api.listDevices();
      const devices = (answer && answer.devices) || [];
      if (!devices.length) {
        devicesList.replaceChildren(blank({
          glyph: 'monitor',
          title: 'No devices',
          text: 'This account has not registered a device yet.',
        }));
        return;
      }
      devicesList.replaceChildren(...devices.map((device) => row({
        lead: el('span', { class: 'role-dot' }, icon(device.revoked ? 'x' : 'lock', { size: 15 })),
        title: device.label + (device.id === open.device.id ? ' (this browser)' : ''),
        sub: el('span', {},
          el('code', {}, fingerprintBlocks(device.keyFingerprint)),
          device.revoked ? el('span', { class: 'cardrow-sub' }, ' · revoked') : null,
          device.recoveryEnabled ? el('span', { class: 'cardrow-sub' }, ' · can be recovered') : null),
        side: device.revoked || device.id === open.device.id ? null : el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Revoke ' + device.label,
          onClick: () => revoke(device),
        }, 'Revoke'),
      })));
    } catch (error) {
      devicesList.replaceChildren(fold([fault(error, () => paintDevices())]));
    }
  };

  const revoke = async (device) => {
    const yes = await confirmDialog({
      title: 'Revoke this device?',
      body: 'It stops being able to read this account\'s conversations, and it has to be registered again to come back.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!yes) return;
    try {
      const open = await client();
      await open.api.revokeDevice(device.id);
      toast('That device is revoked');
      paintDevices();
    } catch (error) {
      errorToast(error);
    }
  };

  // -- the safety number --------------------------------------------------------

  const paintSafety = () => {
    const input = el('input', {
      class: 'input', type: 'text', placeholder: 'The other person\'s user id',
      'aria-label': 'The other person\'s user id',
    });
    const output = el('div', { class: 'fold' });
    const form = el('form', {
      class: 'fold fold--tight',
      onSubmit: async (event) => {
        event.preventDefault();
        const userId = input.value.trim();
        if (!userId) return;
        output.replaceChildren(el('p', { class: 'holdline' }, 'Reading the safety number'));
        try {
          const open = await client();
          const answer = await open.api.safetyNumber(userId);
          const digits = (answer && answer.digits) || '';
          const before = rememberedSafety(userId);
          rememberSafety(userId, digits);
          output.replaceChildren(
            el('p', { class: 'cardrow-sub' }, 'Read this out and compare it with the other person.'),
            el('p', { class: 'keyblock' }, (answer && answer.display) || digits),
            before && before !== digits
              ? memo({
                tone: 'warning',
                glyph: 'alert',
                title: 'The safety number has changed',
                text: 'It was ' + before + ' before. A number that changes is either a device that was added or one that was revoked - or somebody in the middle. Compare it before you trust the conversation.',
              })
              : null,
          );
        } catch (error) {
          output.replaceChildren(fold([fault(error)]));
        }
      },
    }, input, el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Show'));
    safetyBox.replaceChildren(form, output);
  };

  // -- the recovery -------------------------------------------------------------

  const paintRecovery = () => {
    const key = el('input', {
      class: 'input', type: 'password', autocomplete: 'off',
      placeholder: 'The recovery key', 'aria-label': 'The recovery key',
    });
    const status = el('p', { class: 'cardrow-sub' });
    const form = el('form', {
      class: 'fold fold--tight',
      onSubmit: async (event) => {
        event.preventDefault();
        const recoveryKey = key.value.trim();
        if (!recoveryKey) return;
        status.textContent = 'Opening the backup…';
        try {
          const open = await client();
          const material = await open.openBackup(recoveryKey);
          if (!material) {
            status.textContent = 'There is no key backup on the server for this account.';
            return;
          }
          const sourceKeys = deviceFromBackup(material);
          const newDevice = await createDevice({
            userId: State.user.id,
            label: deviceLabel() + ' (recovered)',
            recoveryKey,
          });
          const answer = await open.recover({
            userId: State.user.id,
            sourceDeviceId: material.deviceId,
            sourceKeys,
            newDevice,
          });
          await open.adoptDevice(newDevice);
          await open.register();
          await open.publishPrekeys();
          status.textContent = 'This browser is now a new device'
            + (answer && answer.device && answer.device.label ? ' (' + answer.device.label + ')' : '')
            + '. Revoke the lost one when you are ready: until it is revoked it can still read this account\'s conversations.';
          key.value = '';
          toast('Recovered: this browser is a new device');
          paintDevices();
          paintThisDevice();
        } catch (error) {
          status.textContent = '';
          errorToast(error);
        }
      },
    },
      el('p', { class: 'cardrow-sub' },
        'Recovering registers a new device with new keys. It does not take the lost device\'s identity, '
        + 'so the lost device can still be revoked afterwards - and should be.'),
      key,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Recover this account'),
      status);
    recoveryBox.replaceChildren(form);
  };

  const onMount = () => {
    paintThisDevice();
    paintDevices();
    paintSafety();
    paintRecovery();
  };

  return { node, onMount, cleanup() {} };
}

export default { encryptionView };
