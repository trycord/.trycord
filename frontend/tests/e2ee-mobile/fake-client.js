// A stand-in for the phone's encryption client.
//
// The screen asks a client about this device, the account's devices, the key
// backup, the safety number and the recovery. This answers those questions
// and records what it was asked, so a check can hear both the answer and the
// question - which is the whole of what the screen does with the protocol.

/** A device, as the screen sees one. */
export function fakeDevice(overrides) {
  return Object.assign({
    id: 'device-this-phone',
    userId: 'u1',
    label: 'This phone',
    registered: true,
    recoveryKey: 'the-recovery-key-of-this-device',
    fingerprint: () => 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  }, overrides || {});
}

/**
 * A client.
 *
 * @param {object} options { device, devices, safety, backup, material }
 */
export function fakeClient(options) {
  const opts = options || {};
  const calls = [];
  const state = {
    devices: opts.devices || [],
    safety: opts.safety || { digits: '000001111122222333334444455555', display: '00000 11111 22222 33333 44444 55555' },
    backup: opts.backup || null,
    material: opts.material || null,
  };

  function note(method, ...args) {
    calls.push({ method, args });
  }

  const client = {
    calls,
    state,
    device: opts.device === null ? null : fakeDevice(opts.device),
    api: {
      listDevices: async () => {
        note('listDevices');
        return { devices: state.devices };
      },
      revokeDevice: async (id) => {
        note('revokeDevice', id);
        return { device: { id, revoked: true } };
      },
      safetyNumber: async (peerId) => {
        note('safetyNumber', peerId);
        return state.safety;
      },
      fetchBackup: async () => {
        note('fetchBackup');
        if (!state.backup) {
          const error = new Error('no key backup has been stored');
          error.status = 404;
          throw error;
        }
        return { backup: state.backup };
      },
    },
    backup: async () => {
      note('backup');
      return { salt: 'salt' };
    },
    openBackup: async (key) => {
      note('openBackup', key);
      return state.material;
    },
    recover: async (recoverOptions) => {
      note('recover', recoverOptions);
      return { device: { id: recoverOptions.newDevice.id, label: recoverOptions.newDevice.label } };
    },
    adoptDevice: async (device) => {
      note('adoptDevice', device.id);
      client.device = device;
      return device;
    },
    register: async () => {
      note('register');
      return client.device;
    },
    publishPrekeys: async () => {
      note('publishPrekeys');
      return {};
    },
    ready: async (readyOptions) => {
      note('ready', readyOptions);
      client.device = fakeDevice({ registered: true, recoveryKey: 'a-brand-new-recovery-key' });
      return client.device;
    },
  };

  return client;
}

/** The calls a client was asked for, by name. */
export function callsTo(client, method) {
  return client.calls.filter((call) => call.method === method);
}

export default { fakeClient, fakeDevice, callsTo };
