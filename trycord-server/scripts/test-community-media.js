// Community identity media: an icon and a banner per community, gated on
// MANAGE_SERVER, served from the authenticated media route, and replaceable and
// removable without leaking the superseded file.
const http = require('http');
const API = 'http://localhost:9971';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null; const u = new URL(p, API);
    const r = http.request({ method: m, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, d ? { 'Content-Length': Buffer.byteLength(d) } : {}, t ? { Authorization: 'Bearer ' + t } : {}), },
      (x) => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let p2; try { p2 = JSON.parse(s); } catch { p2 = s; } res({ status: x.statusCode, body: p2, headers: x.headers }); }); });
    r.on('error', () => res({ status: 0, body: null, headers: {} })); r.setTimeout(12000, () => { r.destroy(); res({ status: 0, body: null, headers: {} }); });
    if (d) r.write(d); r.end();
  });
}
function upload(t, path, buf, type) {
  const b = '----tc' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: ${type}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${b}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buf, tail]);
  return new Promise((res) => {
    const u = new URL(API + path, API);
    const r = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + b, 'Content-Length': body.length, Authorization: 'Bearer ' + t } },
      (x) => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let p; try { p = JSON.parse(s); } catch { p = s; } res({ status: x.statusCode, body: p }); }); });
    r.on('error', () => res({ status: 0, body: null })); r.setTimeout(12000, () => { r.destroy(); res({ status: 0, body: null }); });
    r.write(body); r.end();
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
  const owner = await mk('cmA');
  const plain = await mk('cmB');
  const outsider = await mk('cmC');

  const srv = await req('POST', '/api/servers', { name: 'Media Test' }, owner.token);
  const sid = srv.body.serverId;
  const code = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;
  await req('POST', '/api/servers/join/' + code, null, plain.token);

  // ---- defaults ----------------------------------------------------------
  const before = (await req('GET', '/api/servers/' + sid, null, owner.token)).body;
  ok('a new community has no icon', before.icon_url === null || before.icon_url === undefined, JSON.stringify(before.icon_url));
  ok('a new community has no banner', before.banner_url === null || before.banner_url === undefined, JSON.stringify(before.banner_url));

  // ---- upload ------------------------------------------------------------
  const icon = await upload(owner.token, `/api/servers/${sid}/icon`, PNG, 'image/png');
  ok('owner can upload an icon', icon.status === 201 && typeof icon.body.url === 'string', icon.status + ' ' + JSON.stringify(icon.body).slice(0, 140));
  ok('the media url is an sv- path', /^\/api\/servers\/media\/sv-/.test(icon.body.url || ''), JSON.stringify(icon.body.url));

  const banner = await upload(owner.token, `/api/servers/${sid}/banner`, PNG, 'image/png');
  ok('owner can upload a banner', banner.status === 201 && typeof banner.body.url === 'string', banner.status + ' ' + JSON.stringify(banner.body).slice(0, 140));

  const after = (await req('GET', '/api/servers/' + sid, null, owner.token)).body;
  ok('the community detail exposes icon_url', after.icon_url === icon.body.url, JSON.stringify([after.icon_url, icon.body.url]));
  ok('the community detail exposes banner_url', after.banner_url === banner.body.url, JSON.stringify([after.banner_url, banner.body.url]));

  // ---- serving -----------------------------------------------------------
  const iconRes = await req('GET', icon.body.url, null, plain.token);
  ok('a member can load the icon bytes', iconRes.status === 200, String(iconRes.status));
  ok('the icon is served as an image', /^image\//.test(iconRes.headers['content-type'] || ''), JSON.stringify(iconRes.headers['content-type']));
  ok('the response is nosniff-protected', iconRes.headers['x-content-type-options'] === 'nosniff', JSON.stringify(iconRes.headers['x-content-type-options']));
  const anon = await req('GET', icon.body.url);
  ok('an unauthenticated load is refused', anon.status === 401 || anon.status === 403, String(anon.status));
  const bogus = await req('GET', '/api/servers/media/sv-does-not-exist', null, owner.token);
  ok('an unknown media id is a clean 404', bogus.status === 404, String(bogus.status));
  // The route must not be able to serve a message attachment.
  const escapeAttempt = await req('GET', '/api/servers/media/..%2F..%2Fetc', null, owner.token);
  ok('a traversal attempt does not resolve', escapeAttempt.status === 404 || escapeAttempt.status === 400, String(escapeAttempt.status));

  // ---- authorisation -----------------------------------------------------
  const byMember = await upload(plain.token, `/api/servers/${sid}/icon`, PNG, 'image/png');
  ok('a plain member cannot upload an icon', byMember.status === 403, String(byMember.status));
  const byOutsider = await upload(outsider.token, `/api/servers/${sid}/icon`, PNG, 'image/png');
  ok('a non-member cannot upload an icon', byOutsider.status === 403 || byOutsider.status === 404, String(byOutsider.status));
  const delByMember = await req('DELETE', `/api/servers/${sid}/icon`, null, plain.token);
  ok('a plain member cannot delete the icon', delByMember.status === 403, String(delByMember.status));

  // ---- validation --------------------------------------------------------
  const notImage = await upload(owner.token, `/api/servers/${sid}/icon`, Buffer.from('<?php echo 1;'), 'application/x-php');
  ok('a non-image upload is refused', notImage.status === 400, notImage.status + ' ' + JSON.stringify(notImage.body).slice(0, 120));
  const empty = await upload(owner.token, `/api/servers/${sid}/icon`, Buffer.alloc(0), 'image/png');
  ok('an empty upload is refused', empty.status === 400, String(empty.status));
  const stillThere = (await req('GET', '/api/servers/' + sid, null, owner.token)).body;
  ok('a refused upload left the existing icon intact', stillThere.icon_url === icon.body.url, JSON.stringify(stillThere.icon_url));

  // ---- replacement frees the old file ------------------------------------
  const icon2 = await upload(owner.token, `/api/servers/${sid}/icon`, PNG, 'image/png');
  ok('a replacement upload succeeds', icon2.status === 201, String(icon2.status));
  ok('the replacement has a different path', icon2.body.url !== icon.body.url, icon2.body.url);
  const oldGone = await req('GET', icon.body.url, null, owner.token);
  ok('the superseded file is no longer served', oldGone.status === 404, String(oldGone.status));

  // ---- removal -----------------------------------------------------------
  const del = await req('DELETE', `/api/servers/${sid}/banner`, null, owner.token);
  ok('owner can remove the banner', del.status === 200, String(del.status));
  const afterDel = (await req('GET', '/api/servers/' + sid, null, owner.token)).body;
  ok('banner_url is null after removal', afterDel.banner_url === null, JSON.stringify(afterDel.banner_url));
  ok('the icon survived the banner removal', afterDel.icon_url === icon2.body.url, JSON.stringify(afterDel.icon_url));
  const goneFile = await req('GET', banner.body.url, null, owner.token);
  ok('the removed banner file is gone', goneFile.status === 404, String(goneFile.status));

  // ---- discovery shows identity -----------------------------------------
  await req('PATCH', '/api/servers/' + sid, { isPublic: true, isDiscoverable: true }, owner.token);
  const disc = (await req('GET', '/api/discover/servers?q=Media Test')).body;
  const row = (disc.items || []).find((s) => s.id === sid);
  ok('the discover feed carries icon_url', row && row.icon_url === icon2.body.url, JSON.stringify(row && row.icon_url));
  const prev = (await req('GET', '/api/discover/servers/' + sid)).body;
  ok('the discovery preview carries icon_url', prev && prev.icon_url === icon2.body.url, JSON.stringify(prev && prev.icon_url));

  // ---- the community list carries identity ------------------------------
  const mine = (await req('GET', '/api/servers', null, owner.token)).body;
  const mineRow = (mine || []).find((s) => s.id === sid);
  ok('the community list carries icon_url', mineRow && mineRow.icon_url === icon2.body.url, JSON.stringify(mineRow && mineRow.icon_url));

  console.log('\ncommunity-media: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
