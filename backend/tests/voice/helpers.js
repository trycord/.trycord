// The scaffolding the voice tests share.
//
// A voice call needs three things a test has to provide: an instance with
// voice on, a community with a voice channel in it, and - for the mesh - a
// relay that answers. The relay is a small STUN responder: the smallest thing
// that answers a binding request, which is what the mesh asks of the addresses
// it hands to its peers.
//
// The instance's own relay is not used here. It is the shipped one, and a test
// that depends on it is a test that depends on a defect nobody has fixed yet.

'use strict';

const dgram = require('dgram');
const { startInstance, registerUser } = require('../helpers/instance');

// A STUN responder.
//
// It answers a binding request with a binding response carrying the
// transaction id it was sent, which is what a client checks.
function startRelay() {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (message, rinfo) => {
    if (message.length < 20) return;
    if (message.readUInt16BE(0) !== 0x0001) return; // a binding request
    if (message.readUInt32BE(4) !== 0x2112a442) return; // the magic cookie

    const transactionId = message.slice(8, 20);
    const body = Buffer.alloc(8);
    body[0] = 0;
    body[1] = 0x01; // the XOR-mapped address
    body.writeUInt16BE(rinfo.port ^ 0x2112, 2);
    const octets = rinfo.address.split('.').map((part) => Number(part) || 0);
    const mask = [0x21, 0x12, 0xa4, 0x42];
    for (let i = 0; i < 4; i++) body[4 + i] = octets[i] ^ mask[i];

    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0); // a binding response
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(0x2112a442, 4);
    transactionId.copy(header, 8);

    socket.send(Buffer.concat([header, body]), rinfo.port, rinfo.address);
  });

  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => {
      resolve({
        port: socket.address().port,
        close: () => { try { socket.close(); } catch { /* already closed */ } },
      });
    });
  });
}

// A port nothing is listening on.
function closedPort() {
  return new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    probe.once('error', reject);
    probe.bind(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// An instance with voice on, and the people who will use it.
async function voiceInstance(options = {}) {
  const env = Object.assign({
    ADMIN_USERNAMES: 'owner',
    VOICE_VIDEO_ENABLED: 'on',
    // A short probe: a test that waits on a closed port should not wait long.
    TRYCORD_VOICE_PROBE_TIMEOUT_MS: '600',
  }, options.env || {});

  const instance = await startInstance({ env });
  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');
  return { instance, owner, member };
}

// A community with a voice channel in it.
async function voiceChannel(api, name) {
  const community = await api.post('/api/servers', {
    name: name || 'Voice Test',
    description: 'A community with a voice channel.',
  });
  if (!community.data || !community.data.serverId) {
    throw new Error('the community could not be created: ' + JSON.stringify(community.data));
  }
  const serverId = community.data.serverId;
  const channel = await api.post('/api/servers/' + serverId + '/channels', {
    name: 'Voice',
    type: 'voice',
  });
  if (!channel.data || !channel.data.id) {
    throw new Error('the voice channel could not be created: ' + JSON.stringify(channel.data));
  }
  return { serverId, channelId: channel.data.id, joinCode: community.data.joinCode };
}

// Join the community, so that the person is a member of it.
//
// A voice channel belongs to a community, and only its members may sit in it.
async function joinCommunity(api, joinCode) {
  const res = await api.post('/api/servers/join/' + encodeURIComponent(joinCode), {});
  if (res.status >= 400) {
    throw new Error('the community could not be joined: ' + JSON.stringify(res.data));
  }
  return res.data;
}

// Save instance settings as an administrator.
//
// The voice settings are changed in the voice console, and the general
// Configuration page refuses them - so a save of one goes to the voice
// console's own route. The consequential ones - voice on, the provider - have
// to be confirmed, and the console confirms them.
async function saveSettings(api, values) {
  const res = await api.put('/api/admin/voice/settings', Object.assign({ __confirm: true }, values));
  return res;
}

// The provider report the console reads.
async function providers(api) {
  const res = await api.get('/api/voice/providers');
  if (res.status !== 200) throw new Error('the providers could not be read: ' + JSON.stringify(res.data));
  return res.data;
}

// One provider's entry in the report.
function providerOf(report, id) {
  return (report.providers || []).find((provider) => provider.id === id) || null;
}

module.exports = {
  startRelay,
  closedPort,
  voiceInstance,
  voiceChannel,
  joinCommunity,
  saveSettings,
  providers,
  providerOf,
};
