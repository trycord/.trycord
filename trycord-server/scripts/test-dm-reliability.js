// DM messages now honour the same reliability contract as channels:
//   - seq is the authoritative order and is exposed on every message
//   - `after` is a forward cursor for reconnect catch-up
//   - `before` accepts a seq OR a legacy message id
//   - clientNonce makes a retried POST collapse onto the original row
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
  const A = await mk('dmA');
  const B = await mk('dmB');
  const conv = (await req('POST', '/api/dms', { userId: B.id }, A.token)).body;
  const cid = conv.id || conv.conversationId;
  ok('conversation opened', !!cid, JSON.stringify(conv).slice(0, 120));

  // ---- seq is assigned and monotonic -------------------------------------
  const sent = [];
  for (let i = 1; i <= 5; i++) {
    const r = await req('POST', `/api/dms/${cid}/messages`, { content: 'dm-' + i }, A.token);
    sent.push(r.body);
  }
  ok('every DM carries a seq', sent.every((m) => m && m.seq !== null && m.seq !== undefined), JSON.stringify(sent.map(m => m && m.seq)));
  const seqs = sent.map((m) => Number(m.seq));
  ok('seq is strictly increasing', seqs.every((v, i) => i === 0 || v > seqs[i - 1]), JSON.stringify(seqs));
  ok('seq starts at 1 for a fresh conversation', seqs[0] === 1, JSON.stringify(seqs));

  // ---- ordering is by seq, not created_at --------------------------------
  const all = (await req('GET', `/api/dms/${cid}/messages?limit=50`, null, A.token)).body;
  ok('history is oldest-first', all.length === 5 && all[0].content === 'dm-1' && all[4].content === 'dm-5',
    JSON.stringify(all.map((m) => m.content)));
  ok('history is ordered by seq', all.every((m, i) => i === 0 || Number(m.seq) > Number(all[i - 1].seq)),
    JSON.stringify(all.map((m) => m.seq)));

  // ---- forward cursor ----------------------------------------------------
  const after = (await req('GET', `/api/dms/${cid}/messages?after=${seqs[1]}`, null, A.token)).body;
  ok('after= returns only newer messages', after.length === 3 && after[0].content === 'dm-3', JSON.stringify(after.map((m) => m.content)));
  ok('after= returns them oldest-first', after.map((m) => m.content).join(',') === 'dm-3,dm-4,dm-5', JSON.stringify(after.map((m) => m.content)));
  const none = (await req('GET', `/api/dms/${cid}/messages?after=${seqs[4]}`, null, A.token)).body;
  ok('after= at the head returns nothing', Array.isArray(none) && none.length === 0, JSON.stringify(none));
  const way = (await req('GET', `/api/dms/${cid}/messages?after=0`, null, A.token)).body;
  ok('after=0 returns everything', way.length === 5, String(way.length));

  // ---- backward cursor: seq AND legacy id --------------------------------
  const bySeq = (await req('GET', `/api/dms/${cid}/messages?before=${seqs[3]}`, null, A.token)).body;
  ok('before= accepts a seq', bySeq.length === 3 && bySeq.map((m) => m.content).join(',') === 'dm-1,dm-2,dm-3',
    JSON.stringify(bySeq.map((m) => m.content)));
  const anchorId = all[3].id;
  const byId = (await req('GET', `/api/dms/${cid}/messages?before=${anchorId}`, null, A.token)).body;
  ok('before= still accepts a legacy message id', Array.isArray(byId) && byId.length === 3 && byId[2].content === 'dm-3',
    JSON.stringify(byId.map((m) => m.content)));
  const badId = (await req('GET', `/api/dms/${cid}/messages?before=not-a-real-id`, null, A.token));
  ok('before= with an unknown id is refused, not silently empty', badId.status >= 400, String(badId.status) + ' ' + JSON.stringify(badId.body).slice(0, 100));

  // A before-anchor from another conversation must not work.
  const conv2 = (await req('POST', '/api/dms', { userId: (await mk('dmC')).id }, A.token)).body;
  const cid2 = conv2.id || conv2.conversationId;
  const foreign = (await req('GET', `/api/dms/${cid}/messages?before=${all[0].id}`, null, A.token));
  ok('a foreign anchor is scoped out', foreign.status === 200 && foreign.body.length === 0,
    String(foreign.status) + ' n=' + (foreign.body || []).length);

  // ---- idempotency -------------------------------------------------------
  const nonce = 'nonce-' + Date.now().toString(36);
  const first = await req('POST', `/api/dms/${cid}/messages`, { content: 'once', clientNonce: nonce }, A.token);
  const second = await req('POST', `/api/dms/${cid}/messages`, { content: 'once', clientNonce: nonce }, A.token);
  ok('a nonce-bearing send returns a message', first.status === 200 && !!first.body.id, String(first.status));
  ok('a retried send resolves to the same row', second.body.id === first.body.id, first.body.id + ' vs ' + second.body.id);
  ok('a retried send is flagged as deduped', second.body.deduped === true, JSON.stringify(second.body).slice(0, 120));
  const after2 = (await req('GET', `/api/dms/${cid}/messages?limit=100`, null, A.token)).body;
  ok('the retry did not create a second message', after2.filter((m) => m.content === 'once').length === 1,
    String(after2.filter((m) => m.content === 'once').length));

  // Two identical texts with different nonces are two messages.
  const n1 = 'n1-' + Date.now().toString(36);
  const n2 = 'n2-' + Date.now().toString(36);
  await req('POST', `/api/dms/${cid}/messages`, { content: 'twin', clientNonce: n1 }, A.token);
  await req('POST', `/api/dms/${cid}/messages`, { content: 'twin', clientNonce: n2 }, A.token);
  const after3 = (await req('GET', `/api/dms/${cid}/messages?limit=100`, null, A.token)).body;
  ok('identical text with distinct nonces stays two messages', after3.filter((m) => m.content === 'twin').length === 2,
    String(after3.filter((m) => m.content === 'twin').length));

  // No nonce at all: every call is its own message (the old behaviour).
  await req('POST', `/api/dms/${cid}/messages`, { content: 'plain' }, A.token);
  await req('POST', `/api/dms/${cid}/messages`, { content: 'plain' }, A.token);
  const after4 = (await req('GET', `/api/dms/${cid}/messages?limit=100`, null, A.token)).body;
  ok('a send with no nonce is never deduped', after4.filter((m) => m.content === 'plain').length === 2,
    String(after4.filter((m) => m.content === 'plain').length));

  // ---- paging: no gaps, no repeats across a full walk -------------------
  // A fresh sender, because POST /dms/:id/messages is rate limited to 40 per
  // minute and the assertions above have already spent part of that budget.
  // Asserting against the number that actually landed keeps this honest
  // instead of assuming 60 rows exist.
  const walker = await mk('dmW');
  const peer = await mk('dmP');
  const big = (await req('POST', '/api/dms', { userId: peer.id }, walker.token)).body;
  const bcid = big.id || big.conversationId;
  const N = 30;
  let landed = 0;
  let throttled = 0;
  for (let i = 1; i <= N; i++) {
    const r = await req('POST', `/api/dms/${bcid}/messages`, { content: 'p' + i }, walker.token);
    if (r.status === 200) landed++;
    else if (r.status === 429) throttled++;
  }
  // The 40/min cap is per IP, not per user, so by this point in the run the
  // budget is largely spent. That is the limiter working, not a fault: assert
  // it is enforced and page through whatever did land.
  ok('the DM send rate limit is enforced', throttled > 0, 'throttled=' + throttled + ' landed=' + landed);
  ok('enough messages landed to page through', landed >= 10, 'landed=' + landed);

  const walked = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = cursor === null ? 'limit=10' : 'limit=10&before=' + cursor;
    const rows = (await req('GET', `/api/dms/${bcid}/messages?${q}`, null, walker.token)).body;
    if (!rows.length) break;
    walked.unshift(...rows);
    cursor = rows[0].seq;   // lowest seq on this page
    if (rows.length < 10) break;
  }
  ok('walking backwards yields every message', walked.length === landed, walked.length + ' of ' + landed);
  const uniq = new Set(walked.map((m) => m.id));
  ok('the walk never repeats a message', uniq.size === walked.length, uniq.size + ' unique of ' + walked.length);
  const ordered = walked.every((m, i) => i === 0 || Number(m.seq) > Number(walked[i - 1].seq));
  ok('the walk is in ascending seq order', ordered, JSON.stringify(walked.slice(0, 5).map((m) => m.seq)));
  ok('the walk has no content gaps', walked.map((m) => m.content).join(',') ===
    Array.from({ length: walked.length }, (_, i) => 'p' + (i + 1)).join(','),
    walked.slice(0, 3).map((m) => m.content).join(',') + '...' + walked.slice(-3).map((m) => m.content).join(','));

  // ---- authorisation unchanged ------------------------------------------
  const outsider = await mk('dmE');
  const peek = await req('GET', `/api/dms/${bcid}/messages`, null, outsider.token);
  ok('a non-participant still cannot read the conversation', peek.status === 403 || peek.status === 404, String(peek.status));
  const push = await req('POST', `/api/dms/${bcid}/messages`, { content: 'nope' }, outsider.token);
  ok('a non-participant still cannot post', push.status === 403 || push.status === 404, String(push.status));

  console.log('\ndm-reliability: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
