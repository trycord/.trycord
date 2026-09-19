/* .trycord web client: auth -> servers -> channels -> realtime chat.
   API base: ?api= override, else localhost:3000 for file:// and :5500,
   else same origin (the server serves this page itself). */
const API = (() => {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  if (location.protocol === 'file:' || location.port === '5500') return 'http://localhost:3000';
  return location.origin;
})();

const $ = (id) => document.getElementById(id);
const token = {
  get: () => localStorage.getItem('trycord.token'),
  set: (t) => (t ? localStorage.setItem('trycord.token', t) : localStorage.removeItem('trycord.token')),
};
const headers = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.get() });
const state = { serverId: null, serverName: '', channelId: null, ws: null };

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, opts);
  } catch {
    setOffline(true);
    throw new Error('cannot reach server at ' + API);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  setOffline(false);
  return data;
}

async function probe() {
  try {
    const res = await fetch(API + '/health');
    setOffline(!res.ok);
  } catch {
    setOffline(true);
  }
}
function setOffline(off) { $('offline-banner').hidden = !off; }
$('retry-btn').onclick = () => enter();

function show(name) {
  ['auth-screen', 'join-screen', 'chat-screen'].forEach((id) => {
    $(id).hidden = id !== name + '-screen';
  });
}

// --- auth ---------------------------------------------------------------
$('show-register').onclick = () => { $('register-form').hidden = false; };
$('show-login').onclick = () => { $('register-form').hidden = true; };

$('reg-btn').onclick = async () => {
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  if (!username || !password) return alert('username + password required');
  try {
    const r = await api('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    token.set(r.token);
    enterServers();
  } catch (e) { alert(e.message); }
};

$('login-btn').onclick = async () => {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) return alert('username + password required');
  try {
    const r = await api('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    token.set(r.token);
    enterServers();
  } catch (e) { alert(e.message); }
};

$('logout-btn').onclick = () => {
  token.set(null);
  if (state.ws) { state.ws.close(); state.ws = null; }
  show('auth');
};

// --- servers ------------------------------------------------------------
async function enterServers() {
  show('join');
  const servers = await api('/api/servers', { headers: headers() }).catch(() => []);
  const ul = $('my-servers');
  ul.innerHTML = '';
  servers.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.name;
    li.onclick = () => openServer(s.id, s.name);
    ul.appendChild(li);
  });
}

$('join-btn').onclick = async () => {
  const code = $('join-code').value.trim().toLowerCase();
  if (!code) return;
  try {
    const srv = await api('/api/servers/by-code/' + encodeURIComponent(code), { headers: headers() });
    $('preview-name').textContent = srv.name;
    $('preview-desc').textContent = srv.description || '';
    $('join-preview').hidden = false;
    $('join-preview').dataset.serverId = srv.id;
    $('join-preview').dataset.name = srv.name;
  } catch (e) { alert(e.message); }
};

$('confirm-join').onclick = async () => {
  const code = $('join-code').value.trim().toLowerCase();
  try {
    const r = await api('/api/servers/join/' + encodeURIComponent(code), {
      method: 'POST', headers: headers(),
    });
    const name = $('join-preview').dataset.name || code;
    openServer(r.serverId, name);
  } catch (e) { alert(e.message); }
};

$('leave-btn').onclick = () => {
  if (state.ws) { state.ws.close(); state.ws = null; }
  enterServers();
};

// --- channels + messages ------------------------------------------------
async function openServer(serverId, name) {
  state.serverId = serverId;
  state.serverName = name;
  $('current-server').textContent = name;
  const channels = await api(`/api/servers/${serverId}/channels`, { headers: headers() });
  const list = $('channel-list');
  list.innerHTML = '';
  channels.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'channel-item' + (i === 0 ? ' active' : '');
    div.textContent = '# ' + c.name;
    div.onclick = () => {
      list.querySelectorAll('.channel-item').forEach((el) => el.classList.remove('active'));
      div.classList.add('active');
      selectChannel(c.id, c.name);
    };
    list.appendChild(div);
  });
  show('chat');
  connectWs();
  if (channels[0]) selectChannel(channels[0].id, channels[0].name);
  else $('message-list').innerHTML = '<li>No channels yet.</li>';
}

async function selectChannel(id, name) {
  state.channelId = id;
  $('channel-header').textContent = '# ' + name;
  const msgs = await api(`/api/channels/${id}/messages`, { headers: headers() });
  $('message-list').innerHTML = '';
  msgs.forEach(addMessage);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'join', channelId: id }));
  }
}

function addMessage(m) {
  const li = document.createElement('li');
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = m.user || m.author_name || 'user';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
  const body = document.createElement('div');
  body.textContent = m.content || '';
  li.append(author, time, body);
  $('message-list').appendChild(li);
  li.scrollIntoView();
}

async function send() {
  const input = $('message-input');
  const content = input.value.trim();
  if (!content || !state.channelId) return;
  input.value = '';
  try {
    await api(`/api/channels/${state.channelId}/messages`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ content }),
    });
    const msgs = await api(`/api/channels/${state.channelId}/messages`, { headers: headers() });
    $('message-list').innerHTML = '';
    msgs.forEach(addMessage);
  } catch (e) { alert(e.message); }
}
$('send-btn').onclick = send;
$('message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// --- realtime -----------------------------------------------------------
function connectWs() {
  if (state.ws) state.ws.close();
  const ws = new WebSocket(API.replace('http', 'ws') + '/?token=' + token.get());
  state.ws = ws;
  ws.onopen = () => {
    if (state.channelId) ws.send(JSON.stringify({ type: 'join', channelId: state.channelId }));
  };
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'message' && data.channel_id === state.channelId) addMessage(data);
    } catch { /* ignore */ }
  };
}

// --- boot ---------------------------------------------------------------
async function enter() {
  await probe();
  if (token.get()) enterServers().catch(() => show('auth'));
  else show('auth');
}
enter();
