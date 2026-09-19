/* .trycord client – auth, join, channels, messages + WS realtime */
const API = location.origin.includes(':5500') || location.protocol === 'file:'
  ? 'http://localhost:3000'
  : location.origin.replace(/:\d+$/, ':3000') === location.origin ? location.origin : 'http://localhost:3000';

const LS_TOKEN = 'trycord.token';
const getToken = () => localStorage.getItem(LS_TOKEN);
const setToken = (t) => (t ? localStorage.setItem(LS_TOKEN, t) : localStorage.removeItem(LS_TOKEN));
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` });

const $ = (id) => document.getElementById(id);
const state = { server: null, serverId: null, channelId: null, ws: null };

function show(id) {
  ['auth-screen', 'join-screen', 'chat-screen'].forEach((s) => {
    $(s).style.display = s === id ? '' : 'none';
  });
  if (id === 'chat-screen') $('chat-screen').style.display = 'flex';
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ---- Auth ----
$('switch-to-reg').onclick = () => { $('reg-section').style.display = ''; };
$('switch-to-login').onclick = () => { $('reg-section').style.display = 'none'; };

$('reg-btn').onclick = async () => {
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  if (!username || !password) return alert('username + password required');
  try {
    const r = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    setToken(r.token);
    show('join-screen');
  } catch (e) { alert(e.message); }
};

$('login-btn').onclick = async () => {
  const username = $('login-username').value.trim();
  const password = ($('login-password') && $('login-password').value) || '';
  if (!username || !password) return alert('username + password required');
  try {
    const r = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    setToken(r.token);
    show('join-screen');
  } catch (e) { alert(e.message); }
};

$('logout-btn').onclick = () => {
  setToken(null);
  if (state.ws) { state.ws.close(); state.ws = null; }
  show('auth-screen');
};

// ---- Join ----
$('join-btn').onclick = async () => {
  const code = $('join-code').value.trim().toLowerCase();
  if (!code) return;
  try {
    let srv = null;
    try { srv = await api(`/api/servers/by-code/${code}`, { headers: authHeaders() }); }
    catch { srv = await api(`/api/servers/${code}`, { headers: authHeaders() }); }
    $('server-name').textContent = srv.name || code;
    $('server-desc').textContent = srv.description || '';
    $('server-info').style.display = '';
    $('server-info').dataset.code = code;
  } catch (e) { alert(e.message); }
};

$('confirm-join').onclick = async () => {
  const code = $('server-info').dataset.code || $('join-code').value.trim().toLowerCase();
  try {
    const r = await api(`/api/servers/join/${code}`, { method: 'POST', headers: authHeaders() });
    const serverId = r.serverId;
    state.serverId = serverId;
    let srv = null;
    try { srv = await api(`/api/servers/by-code/${code}`, { headers: authHeaders() }); } catch { srv = { name: code }; }
    state.server = srv;
    $('current-server').textContent = srv.name || code;
    await loadChannels();
    show('chat-screen');
    connectWs();
  } catch (e) { alert(e.message); }
};

// ---- Channels + messages ----
async function loadChannels() {
  const channels = await api(`/api/servers/${state.serverId}/channels`, { headers: authHeaders() });
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
    if (i === 0) selectChannel(c.id, c.name);
  });
  if (!channels.length) $('message-list').innerHTML = '<li>No channels yet</li>';
}

async function selectChannel(id, name) {
  state.channelId = id;
  $('current-channel').textContent = '# ' + name;
  await loadMessages();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'join', serverId: state.serverId, channelId: id }));
  }
}

async function loadMessages() {
  const msgs = await api(`/api/channels/${state.channelId}/messages`, { headers: authHeaders() });
  $('message-list').innerHTML = '';
  msgs.forEach(addMessage);
}

function addMessage(m) {
  const li = document.createElement('li');
  const when = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
  li.innerHTML = `<span class="author"></span><span class="time"></span><div class="body"></div>`;
  li.querySelector('.author').textContent = m.user || m.author_name || 'user';
  li.querySelector('.time').textContent = when;
  li.querySelector('.body').textContent = m.content || '';
  $('message-list').appendChild(li);
  li.scrollIntoView();
}

async function sendMessage() {
  const input = $('message-input');
  const content = input.value.trim();
  if (!content || !state.channelId) return;
  input.value = '';
  // Prefer REST (persisted); WS will echo back
  try {
    await api(`/api/channels/${state.channelId}/messages`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ content }) });
    await loadMessages();
  } catch (e) { alert(e.message); }
}

$('send-btn').onclick = sendMessage;
$('message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

// ---- WS ----
function connectWs() {
  if (state.ws) state.ws.close();
  const wsUrl = API.replace('http', 'ws') + `/?token=${getToken()}`;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', serverId: state.serverId, channelId: state.channelId }));
  };
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'message' && data.channelId === state.channelId) addMessage(data);
    } catch { /* ignore */ }
  };
}

// Auto-resume
if (getToken()) show('join-screen');
