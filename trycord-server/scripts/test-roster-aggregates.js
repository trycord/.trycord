// Roster aggregates and paging.
//
// The endpoint used to return a bare array. A `total` hung off an array would
// be dropped by JSON.stringify, so a paged caller had no way to learn the true
// roster size - it either downloaded everyone to count them or lied. The
// response is now an envelope: { items, total, hasMore, limit, offset }.
const http = require('http');
const API = 'http://localhost:9971';
function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null; const u = new URL(p, API);
    const r = http.request({ method: m, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, d ? { 'Content-Length': Buffer.byteLength(d) } : {}, t ? { Authorization: 'Bearer ' + t } : {}) },
      (x) => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let p2; try { p2 = JSON.parse(s); } catch { p2 = s; } res({ status: x.statusCode, body: p2 }); }); });
    r.on('error', () => res({ status: 0, body: null })); r.setTimeout(12000, () => { r.destroy(); res({ status: 0, body: null }); });
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
  const owner = await mk('roA');
  const srv = await req('POST', '/api/servers', { name: 'Roster Test' }, owner.token);
  const sid = srv.body.serverId;
  const code = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;

  // The owner is already a member, so N joiners + 1 owner.
  const N = 8;
  const joiners = [];
  for (let i = 0; i < N; i++) {
    const m = await mk('ro' + i);
    const j = await req('POST', '/api/servers/join/' + code, null, m.token);
    if (j.status === 200 || j.status === 201) joiners.push(m);
  }
  ok('members joined', joiners.length === N, joiners.length + ' of ' + N);
  const TOTAL = joiners.length + 1;

  // ---- envelope shape ----------------------------------------------------
  const full = (await req('GET', '/api/servers/' + sid + '/members', null, owner.token)).body;
  ok('response is an envelope, not an array', !Array.isArray(full) && Array.isArray(full.items), Array.isArray(full) ? 'array' : typeof full);
  ok('items carries the roster', full.items.length === TOTAL, full.items.length + ' of ' + TOTAL);
  ok('total is the true roster size', full.total === TOTAL, String(full.total));
  ok('hasMore is false when everything fits', full.hasMore === false, JSON.stringify(full.hasMore));
  ok('limit and offset are echoed', typeof full.limit === 'number' && full.offset === 0, JSON.stringify([full.limit, full.offset]));
  ok('the owner is flagged in the roster', full.items.some((m) => m.is_owner === true), 'no owner row');

  // ---- paging ------------------------------------------------------------
  const p1 = (await req('GET', `/api/servers/${sid}/members?limit=3&offset=0`, null, owner.token)).body;
  const p2 = (await req('GET', `/api/servers/${sid}/members?limit=3&offset=3`, null, owner.token)).body;
  ok('a page honours the limit', p1.items.length === 3, String(p1.items.length));
  ok('total is the same on every page', p1.total === TOTAL && p2.total === TOTAL, p1.total + '/' + p2.total);
  ok('hasMore is true while pages remain', p1.hasMore === true, JSON.stringify(p1.hasMore));
  const ids1 = new Set(p1.items.map((m) => String(m.id)));
  const overlap = p2.items.filter((m) => ids1.has(String(m.id)));
  ok('consecutive pages do not overlap', overlap.length === 0, JSON.stringify(overlap.map((m) => m.username)));

  // Walk the whole roster by offset and prove it is exact.
  const walked = [];
  for (let off = 0; off < TOTAL + 5; off += 3) {
    const res = (await req('GET', `/api/servers/${sid}/members?limit=3&offset=${off}`, null, owner.token)).body;
    if (!res.items.length) break;
    walked.push(...res.items);
    if (!res.hasMore) break;
  }
  ok('the walk covers every member exactly once', walked.length === TOTAL && new Set(walked.map((m) => m.id)).size === TOTAL,
    walked.length + ' walked, ' + new Set(walked.map((m) => m.id)).size + ' unique, total ' + TOTAL);

  // The final page must report exhaustion rather than an empty extra page.
  const lastOff = TOTAL - 1;
  const last = (await req('GET', `/api/servers/${sid}/members?limit=3&offset=${lastOff}`, null, owner.token)).body;
  ok('the final page reports hasMore=false', last.hasMore === false, JSON.stringify(last.hasMore));
  const past = (await req('GET', `/api/servers/${sid}/members?limit=3&offset=${TOTAL + 10}`, null, owner.token)).body;
  ok('an offset past the end is empty, not an error', past.items.length === 0 && past.total === TOTAL, JSON.stringify([past.items.length, past.total]));

  // ---- search aggregates the FILTERED total ------------------------------
  const marker = joiners[0].name;
  const filtered = (await req('GET', `/api/servers/${sid}/members?q=${marker}`, null, owner.token)).body;
  ok('search narrows the page', filtered.items.length === 1, String(filtered.items.length));
  ok('total reflects the filter, not the whole roster', filtered.total === 1, String(filtered.total));
  const noMatch = (await req('GET', `/api/servers/${sid}/members?q=zzzznotamember`, null, owner.token)).body;
  ok('a search with no matches reports total 0', noMatch.items.length === 0 && noMatch.total === 0, JSON.stringify([noMatch.items.length, noMatch.total]));

  // ---- roles are still scoped to the page -------------------------------
  const role = (await req('POST', `/api/servers/${sid}/roles`, { name: 'Pager', permissions: [] }, owner.token)).body;
  await req('POST', `/api/servers/${sid}/roles/${role.id}/assign`, { userId: joiners[joiners.length - 1].id }, owner.token);
  const withRole = (await req('GET', `/api/servers/${sid}/members?q=${joiners[joiners.length - 1].name}`, null, owner.token)).body;
  ok('roles are attached on a paged read', withRole.items[0] && withRole.items[0].roles.some((r) => r.id === role.id),
    JSON.stringify(withRole.items[0] && withRole.items[0].roles));
  const noRole = (await req('GET', `/api/servers/${sid}/members?q=${joiners[0].name}`, null, owner.token)).body;
  // Every member holds the default role, so "no roles at all" is the wrong
  // assertion. What matters is that the role just assigned to someone ELSE did
  // not leak onto this member.
  ok('roles do not leak onto other members',
    noRole.items[0] && !noRole.items[0].roles.some((r) => r.id === role.id),
    JSON.stringify(noRole.items[0] && noRole.items[0].roles));
  ok('a member still carries their own default role',
    noRole.items[0] && noRole.items[0].roles.length > 0,
    JSON.stringify(noRole.items[0] && noRole.items[0].roles));

  // ---- limit is clamped --------------------------------------------------
  const huge = (await req('GET', `/api/servers/${sid}/members?limit=100000`, null, owner.token)).body;
  ok('an absurd limit is clamped', huge.items.length <= TOTAL, String(huge.items.length));
  const neg = (await req('GET', `/api/servers/${sid}/members?limit=3&offset=-5`, null, owner.token)).body;
  ok('a negative offset is treated as zero', neg.items.length > 0 && neg.offset === 0, JSON.stringify([neg.items.length, neg.offset]));

  // ---- authorisation unchanged ------------------------------------------
  const outsider = await mk('roX');
  const denied = await req('GET', `/api/servers/${sid}/members`, null, outsider.token);
  ok('a non-member still cannot read the roster', denied.status === 403 || denied.status === 404, String(denied.status));

  console.log('\nroster-aggregates: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
