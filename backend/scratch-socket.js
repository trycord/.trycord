'use strict';

// A scratch script: does the socket path work at all in this harness?
const { startInstance, registerUser } = require('./tests/helpers/instance');
const WebSocket = require('ws');

(async () => {
  const instance = await startInstance();
  const alice = await registerUser(instance, 'alice');
  const community = await alice.post('/api/servers', { name: 'C', description: 'd' });
  const channelId = community.data.channelId;
  const user = await instance.db.get('SELECT id, email_verified_at FROM users WHERE id = ?', [alice.user.id]);
  console.log('user row', JSON.stringify(user));
  const ticket = await alice.post('/api/auth/ws/ticket', {});
  const socket = new WebSocket('ws://127.0.0.1:' + instance.port + '/?ticket=' + ticket.data.ticket);
  socket.on('error', (e) => console.log('socket error', e.message));
  socket.on('close', (code, reason) => console.log('socket closed', code, reason.toString()));
  socket.on('message', (raw) => console.log('event', raw.toString().slice(0, 200)));
  await new Promise((resolve) => socket.once('open', resolve));
  console.log('opened');
  socket.send(JSON.stringify({ type: 'join', channelId }));
  await new Promise((r) => setTimeout(r, 300));
  socket.send(JSON.stringify({ type: 'msg', content: 'hello over the socket' }));
  await new Promise((r) => setTimeout(r, 1000));
  const rows = await instance.db.all('SELECT id, content FROM messages');
  console.log('rows', JSON.stringify(rows));
  const rest = await alice.post('/api/channels/' + channelId + '/messages', { content: 'hello over http' });
  console.log('rest', rest.status);
  await instance.stop();
  process.exit(0);
})();
