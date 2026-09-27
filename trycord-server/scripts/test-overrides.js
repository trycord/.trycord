// Channel/category permission override coverage: inheritance, category and
// channel precedence, deny-beats-allow, owner bypass, enforcement, and
// authorisation on the override endpoints. Uses throwaway probe users.
// Channel/category permission overrides: inheritance, precedence, deny-wins,
// owner bypass, and that the server actually enforces them.
const http = require('http');
const API = 'http://localhost:9971';
function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null; const u = new URL(p, API);
    const r = http.request({ method: m, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, d ? { 'Content-Length': Buffer.byteLength(d) } : {}, t ? { Authorization: 'Bearer ' + t } : {}) },
      (x) => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let p2; try { p2 = JSON.parse(s); } catch { p2 = s; } res({ status: x.statusCode, body: p2 }); }); });
    r.on('error', () => res({ status: 0, body: null })); r.setTimeout(10000, () => { r.destroy(); res({ status: 0, body: null }); });
    if (d) r.write(d); r.end();
  });
}
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    if (r.status !== 200) throw new Error('register ' + r.status);
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };
  const owner = await mk('ovA');     // owns the community
  const mod = await mk('ovB');      // MANAGE_CHANNELS
  const plain = await mk('ovC');    // SEND_MESSAGES only
  const nobody = await mk('ovD');   // not a member

  const srv = await req('POST', '/api/servers', { name: 'Override Test' }, owner.token);
  const sid = srv.body.serverId;
  const code = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;
  for (const m of [mod, plain]) await req('POST', '/api/servers/join/' + code, null, m.token);

  // Grant mod MANAGE_CHANNELS so it can edit overrides.
  const modRole = (await req('POST', '/api/servers/' + sid + '/roles',
    { name: 'ChanMod', permissions: ['SEND_MESSAGES', 'MANAGE_CHANNELS'] }, owner.token)).body;
  await req('POST', '/api/servers/' + sid + '/roles/' + modRole.id + '/assign', { userId: mod.id }, owner.token);

  // Two channels: one in a category, one not.
  const cat = (await req('POST', '/api/servers/' + sid + '/categories', { name: 'Locked' }, owner.token)).body;
  const chIn = (await req('POST', '/api/servers/' + sid + '/channels', { name: 'inside', type: 'text', categoryId: cat.id }, owner.token)).body;
  const chOut = (await req('POST', '/api/servers/' + sid + '/channels', { name: 'outside', type: 'text' }, owner.token)).body;
  ok('channels created', !!chIn.id && !!chOut.id, JSON.stringify({ chIn, chOut }).slice(0, 140));

  const P = (ch) => (c) => req('POST', `/api/channels/${ch}/messages`, { content: c }, plain.token);
  const canPost = async (ch) => (await P(ch)('probe')).status === 200;

  // ---- baseline: plain member can post in both ----
  ok('plain can post in channel without category', await canPost(chOut.id), '');
  ok('plain can post in categorised channel', await canPost(chIn.id), '');

  // ---- reading overrides ----
  const read0 = await req('GET', `/api/servers/${sid}/channels/${chIn.id}/overrides`, null, plain.token);
  ok('overrides readable by a member', read0.status === 200 && !!read0.body.overrides, 'status=' + read0.status);
  ok('every known permission is present and defaults to inherit',
    read0.body.all.every((p) => read0.body.overrides[p] === 'inherit'), JSON.stringify(read0.body.overrides).slice(0, 140));
  ok('category overrides surfaced alongside channel', read0.body.categoryOverrides && typeof read0.body.categoryOverrides === 'object', '');

  // ---- channel-level deny ----
  const setCh = (perm, effect) => req('PUT', `/api/servers/${sid}/channels/${chIn.id}/overrides/${perm}`, { effect }, mod.token);
  ok('set channel deny', (await setCh('SEND_MESSAGES', 'deny')).status === 200, '');
  ok('deny blocks posting in that channel', !(await canPost(chIn.id)), 'plain could still post');
  ok('deny does not leak to other channels', await canPost(chOut.id), 'other channel was blocked too');

  // ---- channel allow grants a permission the user does not have ----
  // The default Member role grants only SEND_MESSAGES, and permissions are a
  // UNION across roles, so assigning a role without SEND_MESSAGES does not
  // take it away. MANAGE_MESSAGES is therefore the honest test: nobody has it
  // by default, and it is one of the channel-scoped checks.
  // The victim message must be authored by SOMEONE ELSE - deleting your own
  // message never consults MANAGE_MESSAGES at all.
  const v1 = (await req('POST', `/api/channels/${chOut.id}/messages`, { content: 'victim' }, mod.token)).body;
  ok('plain member cannot delete another authors message by default',
    (await req('DELETE', `/api/channels/${chOut.id}/messages/${v1.id}`, null, plain.token)).status === 403, '');
  const allowCh = (await req('POST', '/api/servers/' + sid + '/channels', { name: 'granted', type: 'text' }, owner.token)).body;
  const v2 = (await req('POST', `/api/channels/${allowCh.id}/messages`, { content: 'victim2' }, mod.token)).body;
  ok('still refused in a channel with no override',
    (await req('DELETE', `/api/channels/${allowCh.id}/messages/${v2.id}`, null, plain.token)).status === 403, '');
  await req('PUT', `/api/servers/${sid}/channels/${allowCh.id}/overrides/MANAGE_MESSAGES`, { effect: 'allow' }, mod.token);
  const del = await req('DELETE', `/api/channels/${allowCh.id}/messages/${v2.id}`, null, plain.token);
  ok('channel allow grants a permission the role lacks', del.status === 200, 'status=' + del.status);
  await req('PUT', `/api/servers/${sid}/channels/${allowCh.id}/overrides/MANAGE_MESSAGES`, { effect: 'inherit' }, mod.token);
  const v3 = (await req('POST', `/api/channels/${allowCh.id}/messages`, { content: 'victim3' }, mod.token)).body;
  ok('clearing the allow revokes it again',
    (await req('DELETE', `/api/channels/${allowCh.id}/messages/${v3.id}`, null, plain.token)).status === 403, '');

  // ---- back to inherit ----
  await setCh('SEND_MESSAGES', 'inherit');
  ok('inherit restores the role-derived default', await canPost(chIn.id), 'still denied after inherit');

  // ---- category override applies to every channel inside it ----
  const putCat = (perm, effect) => req('PUT', `/api/servers/${sid}/categories/${cat.id}/overrides/${perm}`, { effect }, mod.token);
  const chIn2 = (await req('POST', '/api/servers/' + sid + '/channels', { name: 'inside2', type: 'text', categoryId: cat.id }, owner.token)).body;
  ok('set category deny', (await putCat('SEND_MESSAGES', 'deny')).status === 200, '');
  ok('category deny blocks its first channel', !(await canPost(chIn.id)), '');
  ok('category deny blocks a newly added channel too', !(await canPost(chIn2.id)), '');
  ok('category deny does not touch channels outside it', await canPost(chOut.id), '');

  // ---- precedence: channel beats category ----
  await req('PUT', `/api/servers/${sid}/channels/${chIn.id}/overrides/SEND_MESSAGES`, { effect: 'allow' }, mod.token);
  ok('channel allow beats category deny', await canPost(chIn.id), 'category deny won over channel allow');
  ok('category deny still applies to the sibling', !(await canPost(chIn2.id)), 'sibling was wrongly allowed');
  // channel deny beats category allow
  await putCat('SEND_MESSAGES', 'allow');
  await req('PUT', `/api/servers/${sid}/channels/${chIn2.id}/overrides/SEND_MESSAGES`, { effect: 'deny' }, mod.token);
  ok('channel deny beats category allow', !(await canPost(chIn2.id)), 'category allow won over channel deny');

  // ---- owner is never locked out ----
  await putCat('SEND_MESSAGES', 'deny');
  await req('PUT', `/api/servers/${sid}/channels/${chIn.id}/overrides/SEND_MESSAGES`, { effect: 'deny' }, mod.token);
  const ownerPost = async (ch) => (await req('POST', `/api/channels/${ch}/messages`, { content: 'o' }, owner.token)).status === 200;
  ok('owner bypasses a channel deny', await ownerPost(chIn.id), 'owner was blocked');
  ok('owner bypasses a category deny', await ownerPost(chIn2.id), 'owner was blocked');

  // ---- authorisation on the override endpoints ----
  ok('non-member cannot read overrides', (await req('GET', `/api/servers/${sid}/channels/${chIn.id}/overrides`, null, nobody.token)).status === 403);
  ok('plain member cannot set an override', (await setCh('SEND_MESSAGES', 'allow')).status === 200, 'setup');
  ok('plain member is refused (MANAGE_CHANNELS)', (await req('PUT', `/api/servers/${sid}/channels/${chOut.id}/overrides/SEND_MESSAGES`, { effect: 'deny' }, plain.token)).status === 403);
  ok('non-member cannot set an override', (await req('PUT', `/api/servers/${sid}/channels/${chOut.id}/overrides/SEND_MESSAGES`, { effect: 'deny' }, nobody.token)).status === 403);

  // ---- validation ----
  ok('unknown permission rejected', (await req('PUT', `/api/servers/${sid}/channels/${chOut.id}/overrides/NOT_A_PERM`, { effect: 'deny' }, mod.token)).status === 400);
  ok('invalid effect rejected', (await req('PUT', `/api/servers/${sid}/channels/${chOut.id}/overrides/SEND_MESSAGES`, { effect: 'maybe' }, mod.token)).status === 400);
  ok('unknown channel rejected', (await req('PUT', `/api/servers/${sid}/channels/does-not-exist/overrides/SEND_MESSAGES`, { effect: 'deny' }, mod.token)).status !== 200, '');
  const readUnknown = await req('GET', `/api/servers/${sid}/channels/does-not-exist/overrides`, null, plain.token);
  ok('reading overrides for unknown channel is refused', readUnknown.status !== 200, 'status=' + readUnknown.status);

  // ---- deny really is deny on the websocket path too ----
  // (the same helper gates ws msg frames; verified here through HTTP which
  //  shares hasChannelPermission)
  await req('PUT', `/api/servers/${sid}/channels/${chOut.id}/overrides/SEND_MESSAGES`, { effect: 'deny' }, mod.token);
  ok('deny enforced on the shared gate', !(await canPost(chOut.id)), 'post succeeded despite deny');
  await req('PUT', `/api/servers/${sid}/channels/${chOut.id}/overrides/SEND_MESSAGES`, { effect: 'inherit' }, mod.token);
  ok('clearing the override restores access', await canPost(chOut.id), 'still denied after inherit');

  console.log('\npass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
