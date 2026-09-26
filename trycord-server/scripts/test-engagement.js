// Engagement regression against a running server (default
// http://localhost:9971). Covers message search scoping, pins lifecycle +
// permissions, reactions validation + summaries, mutes, and @mention
// notifications with mute suppression. Uses throwaway probe users and
// deletes the created server.
//
// Run: node scripts/test-engagement.js [baseUrl]
// Exit 0 = all assertions passed. Exit 1 = failures.
const API = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' :: ' + extra : '')); }
}
async function J(method, p, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(API + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
(async () => {
  const legal = (await J('GET', '/api/legal')).json;
  async function mkuser(pfx) {
    const u = pfx + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    const r = await J('POST', '/api/auth/register', { username: u, password: 'secret123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    ok('mkuser-' + pfx, r.status === 200 && !!(r.json && r.json.token), 'status=' + r.status);
    if (r.status !== 200) throw new Error('register failed, aborting');
    const v = await J('POST', '/api/test/self-verify', null, r.json.token);
    if (v.status !== 200) throw new Error('self-verify failed — boot the server with ALLOW_TEST_HOOKS=true');
    return { name: u, token: r.json.token, id: r.json.user.id };
  }
  const A = await mkuser('gA'); // owner
  const B = await mkuser('gB'); // member
  const C = await mkuser('gC'); // outsider

  const srv = await J('POST', '/api/servers', { name: 'g-server', isPublic: false }, A.token);
  ok('createServer', srv.status === 200 && !!srv.json.serverId);
  const sid = srv.json.serverId, cid = srv.json.channelId;
  const code = (await J('GET', '/api/servers/' + sid, null, A.token)).json.join_code;
  ok('joinB', (await J('POST', '/api/servers/join/' + code, null, B.token)).status === 200);

  // ---- search ----
  const post = await J('POST', '/api/channels/' + cid + '/messages', { content: 'the quick engagement fox' }, A.token);
  ok('post', post.status === 200 && !!post.json.id);
  const mid = post.json.id;
  const hits = await J('GET', '/api/search?q=engagement', null, A.token);
  ok('searchHit', hits.status === 200 && hits.json.length === 1 && hits.json[0].channel_name !== undefined, 'status=' + hits.status);
  const short = await J('GET', '/api/search?q=x', null, A.token);
  ok('searchMinLength', short.status === 400, 'status=' + short.status);
  const outsider = await J('GET', '/api/search?q=engagement', null, C.token);
  ok('searchScoped', outsider.status === 200 && outsider.json.length === 0, 'n=' + (outsider.json || []).length);

  // ---- pins ----
  const pinDenied = await J('POST', '/api/servers/' + sid + '/channels/' + cid + '/pins', { messageId: mid }, B.token);
  ok('pinDenied', pinDenied.status === 403, 'status=' + pinDenied.status);
  ok('pin', (await J('POST', '/api/servers/' + sid + '/channels/' + cid + '/pins', { messageId: mid }, A.token)).status === 200);
  const pins = await J('GET', '/api/servers/' + sid + '/channels/' + cid + '/pins', null, B.token);
  ok('pinList', pins.status === 200 && pins.json.length === 1 && pins.json[0].pinned === true, 'n=' + (pins.json || []).length);
  ok('unpin', (await J('DELETE', '/api/servers/' + sid + '/channels/' + cid + '/pins/' + mid, null, A.token)).status === 200);

  // ---- reactions ----
  const bad = await J('POST', '/api/channels/' + cid + '/messages/' + mid + '/reactions', { emoji: '   ' }, B.token);
  ok('reactRejected', bad.status === 400, 'status=' + bad.status);
  const r1 = await J('POST', '/api/channels/' + cid + '/messages/' + mid + '/reactions', { emoji: '🔥' }, B.token);
  ok('react', r1.status === 200 && r1.json.reactions[0].count === 1 && r1.json.reactions[0].mine === true, JSON.stringify(r1.json).slice(0, 120));
  const r2 = await J('POST', '/api/channels/' + cid + '/messages/' + mid + '/reactions', { emoji: '🔥' }, B.token);
  ok('reactIdempotent', r2.status === 200 && r2.json.reactions[0].count === 1, 'count=' + ((r2.json.reactions || [])[0] || {}).count);
  const hist = await J('GET', '/api/channels/' + cid + '/messages?limit=5', null, A.token);
  const seen = (hist.json || []).find((m) => m.id === mid);
  ok('reactInHistory', !!(seen && seen.reactions && seen.reactions.length === 1), 'reactions=' + JSON.stringify(seen && seen.reactions));
  ok('unreact', (await J('DELETE', '/api/channels/' + cid + '/messages/' + mid + '/reactions/' + encodeURIComponent('🔥'), null, B.token)).status === 200);

  // ---- mentions + mutes ----
  await J('POST', '/api/channels/' + cid + '/messages', { content: 'hey @' + B.name + ' look' }, A.token);
  const bn = await J('GET', '/api/notifications?limit=10', null, B.token);
  const mention = (bn.json.items || []).find((n) => n.type === 'mention');
  ok('mentionCreated', !!mention, 'types=' + JSON.stringify((bn.json.items || []).map((n) => n.type)));
  ok('mentionContext', !!(mention && mention.context && mention.context.channelId === cid), JSON.stringify(mention && mention.context));
  ok('mute', (await J('POST', '/api/mutes', { channelId: cid }, B.token)).status === 200);
  const mutes = await J('GET', '/api/mutes', null, B.token);
  ok('muteList', mutes.status === 200 && mutes.json.includes(cid), JSON.stringify(mutes.json));
  const n0 = (await J('GET', '/api/notifications?limit=30', null, B.token)).json.items.length;
  await J('POST', '/api/channels/' + cid + '/messages', { content: 'again @' + B.name }, A.token);
  const n1 = (await J('GET', '/api/notifications?limit=30', null, B.token)).json.items.length;
  ok('muteSuppresses', n1 === n0, n0 + '->' + n1);
  ok('unmute', (await J('DELETE', '/api/mutes/' + cid, null, B.token)).status === 200);

  // cleanup
  ok('deleteServer', (await J('DELETE', '/api/servers/' + sid, null, A.token)).status === 200);
  console.log('ENGAGEMENT pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
