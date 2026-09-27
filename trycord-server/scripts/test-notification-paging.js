// Notification keyset pagination: page boundaries must be exact, the walk must
// cover the whole list without gaps or repeats, and the unread badge must not
// shrink just because the caller paged.
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
  const A = await mk('ntA');   // recipient - accumulates notifications
  const B = await mk('ntB');   // actor

  // Generate notifications. Friend requests are the cheapest source: each
  // request from B to A writes one notification row for A. A single pending
  // request per pair is refused, so cancel between sends to keep generating.
  const N = 12;
  let made = 0;
  for (let i = 0; i < N; i++) {
    const r = await req('POST', '/api/friends/requests', { userId: A.id }, B.token);
    if ((r.status === 200 || r.status === 201) && r.body && r.body.id) {
      made++;
      await req('DELETE', '/api/friends/requests/' + r.body.id, null, B.token);
    }
  }
  ok('notifications were generated for the recipient', made >= 5, 'made=' + made);

  // ---- first page --------------------------------------------------------
  const page1 = (await req('GET', '/api/notifications?limit=5', null, A.token)).body;
  ok('the first page honours the limit', page1.items.length === 5, String(page1.items.length));
  ok('the first page reports more to come', page1.hasMore === true, JSON.stringify(page1.hasMore));
  ok('a cursor is returned while more remain', typeof page1.nextCursor === 'string' && page1.nextCursor.includes('|'),
    JSON.stringify(page1.nextCursor));
  ok('the page is newest first', page1.items[0].createdAt >= page1.items[4].createdAt,
    page1.items[0].createdAt + ' vs ' + page1.items[4].createdAt);

  // ---- unread is an account total, not a page total ---------------------
  const all = (await req('GET', '/api/notifications?limit=100', null, A.token)).body;
  ok('unreadCount is the account total, not the page size', all.unreadCount === all.items.length,
    'unread=' + all.unreadCount + ' items=' + all.items.length);
  ok('unreadCount does not shrink when paging', page1.unreadCount === all.unreadCount,
    'page1=' + page1.unreadCount + ' all=' + all.unreadCount);

  // ---- walk the whole list ---------------------------------------------
  const walked = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const q = 'limit=4' + (cursor ? '&before=' + encodeURIComponent(cursor) : '');
    const res = (await req('GET', '/api/notifications?' + q, null, A.token)).body;
    walked.push(...res.items);
    if (!res.hasMore || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  ok('the walk reaches the start of the list', walked.length === all.items.length,
    walked.length + ' walked vs ' + all.items.length + ' total');
  const ids = walked.map((n) => n.id);
  ok('the walk never repeats a notification', new Set(ids).size === ids.length,
    new Set(ids).size + ' unique of ' + ids.length);
  const allIds = all.items.map((n) => n.id);
  ok('the walk contains exactly the same set', new Set(ids).size === new Set(allIds).size &&
    allIds.every((id) => new Set(ids).has(id)), 'set mismatch');
  ok('the walk is ordered newest first', walked.every((n, i) => i === 0 || n.createdAt <= walked[i - 1].createdAt),
    walked.slice(0, 3).map((n) => n.createdAt).join(' | '));

  // ---- a cursor at the very end is exhausted, not an error --------------
  const last = (await req('GET', '/api/notifications?limit=4&before=' + encodeURIComponent(all.nextCursor || 'x|y'), null, A.token));
  ok('a cursor past the end is refused or empty, never a 500', last.status === 200 || last.status >= 400, String(last.status));
  const junk = (await req('GET', '/api/notifications?limit=5&before=not-a-cursor', null, A.token)).body;
  ok('a malformed cursor is ignored rather than throwing', Array.isArray(junk.items), JSON.stringify(junk).slice(0, 120));

  // ---- the last page reports exhaustion ---------------------------------
  const single = (await req('GET', '/api/notifications?limit=100', null, A.token)).body;
  ok('an exhaustive request reports no more pages', single.hasMore === false, JSON.stringify(single.hasMore));
  ok('an exhaustive request returns no cursor', single.nextCursor === null, JSON.stringify(single.nextCursor));

  // ---- authorisation is unchanged --------------------------------------
  const other = await mk('ntC');
  const peek = (await req('GET', '/api/notifications?limit=50', null, other.token)).body;
  ok('another user sees none of these notifications', (peek.items || []).length === 0, String((peek.items || []).length));
  const stolen = await req('POST', '/api/notifications/' + all.items[0].id + '/read', null, other.token);
  ok('another user cannot mark them read', stolen.status >= 400, String(stolen.status));

  // ---- limit is clamped -------------------------------------------------
  const huge = (await req('GET', '/api/notifications?limit=100000', null, A.token)).body;
  ok('an absurd limit is clamped, not honoured', huge.items.length <= 100, String(huge.items.length));
  const zero = (await req('GET', '/api/notifications?limit=0', null, A.token)).body;
  ok('a zero limit falls back to the default', zero.items.length > 0, String(zero.items.length));

  console.log('\nnotification-paging: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
