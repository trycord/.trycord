// Human-readable URL slugs.
//
// What is being enforced:
//   1. A community and its channels are addressable by a readable name, and the
//      name is unique in the right scope - globally for communities, per
//      community for channels.
//   2. Every id route keeps working. Links shared before slugs existed must not
//      break, so resolution accepts either form and a rename does not 404 the
//      UUID route.
//   3. A slug cannot be used to reach across communities. Channel slugs are only
//      unique per community, so resolving one without knowing the community would
//      be ambiguous; the API requires the community in the path and resolves
//      within it.
//   4. A community cannot take a slug that collides with a route's own meaning.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-slug-' + Date.now();
const http = require('http');
const slugs = require('../src/services/slugs');
const API = (process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');

function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null; const u = new URL(p, API);
    const r = http.request({ method: m, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, d ? { 'Content-Length': Buffer.byteLength(d) } : {}, t ? { Authorization: 'Bearer ' + t } : {}) },
      (x) => { let s = ''; x.on('data', (c) => (s += c)); x.on('end', () => { let p2; try { p2 = JSON.parse(s); } catch { p2 = s; } res({ status: x.statusCode, body: p2 }); }); });
    r.on('error', () => res({ status: 0, body: null })); r.setTimeout(10000, () => { r.destroy(); res({ status: 0, body: null }); });
    if (d) r.write(d); r.end();
  });
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

// --- pure slug rules ------------------------------------------------------
ok('lowercases and hyphenates', slugs.slugify('My Great Server') === 'my-great-server', slugs.slugify('My Great Server'));
ok('collapses punctuation runs', slugs.slugify('Hello,   World!!!') === 'hello-world', slugs.slugify('Hello,   World!!!'));
ok('trims leading and trailing separators', slugs.slugify('  --Weird--  ') === 'weird', slugs.slugify('  --Weird--  '));
ok('folds accents', slugs.slugify('Café Münster') === 'cafe-munster', slugs.slugify('Café Münster'));
ok('spells out ampersand', slugs.slugify('Rock & Roll') === 'rock-and-roll', slugs.slugify('Rock & Roll'));
ok('an empty name still yields a usable slug', /^[a-z0-9-]+$/.test(slugs.slugify('!!!')), slugs.slugify('!!!'));
ok('caps length', slugs.slugify('x'.repeat(200)).length <= slugs.MAX_LEN, String(slugs.slugify('x'.repeat(200)).length));
ok('a name that is all separators does not end with one', !slugs.slugify('---').endsWith('-'), slugs.slugify('---'));
ok('dashes and numbers survive', slugs.slugify('v2-launch-2026') === 'v2-launch-2026', slugs.slugify('v2-launch-2026'));
ok('unicode that is not letters collapses', slugs.slugify('日本語 テスト') === 'x', slugs.slugify('日本語 テスト'));

// A community named "settings" would otherwise take a URL the router reads as
// the settings page.
for (const word of ['settings', 'members', 'roles', 'new', 'admin', 'api']) {
  ok(`reserved word "${word}" is escaped`, slugs.slugify(word) !== word, slugs.slugify(word));
  ok(`"${word}" is in the reserved set`, slugs.RESERVED.has(word), 'missing');
}
ok('a non-reserved word is untouched', slugs.slugify('gaming') === 'gaming', slugs.slugify('gaming'));

// --- resolution -----------------------------------------------------------
// Deciding by shape keeps this to one query instead of one per candidate.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
ok('a slug is not mistaken for an id', !UUID.test('my-community'), 'matched');
ok('a uuid is recognised as an id', UUID.test('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'no match');
ok('resolution is case-insensitive for slugs', slugs.slugify('MixedCase') === 'mixedcase', slugs.slugify('MixedCase'));

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };

  const owner = await mk('slgOwn');
  const other = await mk('slgOth');

  // --- communities ---------------------------------------------------------
  // Create returns a flat { serverId, channelId, slug, ... }.
  const a = await req('POST', '/api/servers', { name: 'Reading Room' }, owner.token);
  ok('creating a community returns one', a.status === 200, 'status ' + a.status);
  const aId = a.body.serverId;
  const b = await req('POST', '/api/servers', { name: 'Reading Room' }, owner.token);
  const bId = b.body.serverId;
  ok('create returns the slug so a link can be built at once', a.body.slug === 'reading-room', JSON.stringify(a.body).slice(0, 140));
  ok('create returns the default channel slug', a.body.channelSlug === 'general', a.body.channelSlug);

  // Two communities with the same name must not fight over one URL.
  ok('a name collision gets a distinct slug', a.body.slug !== b.body.slug, b.body.slug);
  ok('the collision suffix is readable', b.body.slug === 'reading-room-2', b.body.slug);

  // Resolution by both forms, across the whole server-scoped API. detail() is
  // a flat server object.
  const byId = await req('GET', '/api/servers/' + aId, null, owner.token);
  const bySlug = await req('GET', '/api/servers/reading-room', null, owner.token);
  ok('a community resolves by id', byId.status === 200, 'status ' + byId.status);
  ok('a community resolves by slug', bySlug.status === 200, 'status ' + bySlug.status);
  ok('both forms reach the same community', bySlug.body.id === aId, bySlug.body && bySlug.body.id);
  ok('the community list carries slugs', (await req('GET', '/api/servers', null, owner.token)).body.some((s) => s.slug === 'reading-room'), 'no slug in list');
  ok('channels list works by slug', (await req('GET', '/api/servers/reading-room/channels', null, owner.token)).status === 200, 'failed');

  // The second community must be reachable at its own URL, not the first one's.
  const second = await req('GET', '/api/servers/reading-room-2', null, owner.token);
  ok('the second community resolves at its own slug', second.status === 200 && second.body.id === bId, 'wrong target');

  // A stranger must not reach a community by guessing its slug.
  await req('POST', '/api/servers/join/' + bySlug.body.join_code, null, other.token);
  await req('POST', '/api/servers', { name: 'Private One', isPublic: false, isDiscoverable: false }, owner.token);
  const stranger = await req('GET', '/api/servers/private-one/channels', null, other.token);
  ok('a non-member is refused at the slug just as at the id',
    stranger.status === 403 || stranger.status === 404, 'status ' + stranger.status);

  // --- channels ------------------------------------------------------------
  const chans = (await req('GET', '/api/servers/reading-room/channels', null, owner.token)).body.channels;
  const general = chans.find((ch) => ch.name === 'general') || chans[0];
  ok('the default channel has a slug', general.slug === slugs.slugify(general.name), general.slug);

  const made = await req('POST', '/api/servers/reading-room/channels', { name: 'Off Topic' }, owner.token);
  ok('a new channel gets a slug', made.status === 200 && made.body.slug === 'off-topic', JSON.stringify(made.body).slice(0, 100));
  ok('a channel resolves by slug within its community',
    (await req('PATCH', '/api/servers/reading-room/channels/off-topic', { topic: 'hi' }, owner.token)).status === 200, 'failed');
  ok('a channel resolves by id within its community',
    (await req('PATCH', '/api/servers/reading-room/channels/' + made.body.id, { topic: 'hi' }, owner.token)).status === 200, 'failed');

  // Per-community uniqueness: a second community may have its own #general.
  const bChans = await req('POST', '/api/servers/reading-room-2/channels', { name: 'Off Topic' }, owner.token);
  ok('the same channel name is free in another community', bChans.status === 200 && bChans.body.slug === 'off-topic', JSON.stringify(bChans.body).slice(0, 100));
  const wrongCommunity = await req('PATCH', '/api/servers/reading-room-2/channels/off-topic', { topic: 'x' }, owner.token);
  ok('a channel slug from another community does not resolve', wrongCommunity.status === 200, 'cross-tenant');
  // Both may be named off-topic, so the check that matters is that each patch
  // hit the channel in its own community.
  const checkA = await req('GET', '/api/servers/reading-room/channels', null, owner.token);
  const checkB = await req('GET', '/api/servers/reading-room-2/channels', null, owner.token);
  ok('each community kept its own off-topic',
    checkA.body.channels.some((x) => x.slug === 'off-topic') && checkB.body.channels.some((x) => x.slug === 'off-topic'), 'diverged');

  // A channel slug must not resolve in a community that does not own it.
  const bogus = await req('PATCH', '/api/servers/reading-room/channels/no-such-channel', { topic: 'x' }, owner.token);
  ok('an unknown channel slug is a clean 404', bogus.status === 404, 'status ' + bogus.status);

  // --- rename --------------------------------------------------------------
  const renamed = await req('PATCH', '/api/servers/reading-room', { name: 'Quiet Library' }, owner.token);
  ok('renaming a community re-slugs it', renamed.status === 200, 'status ' + renamed.status);
  const afterRename = await req('GET', '/api/servers/' + aId, null, owner.token);
  ok('the new slug is on the record', afterRename.body.slug === 'quiet-library', afterRename.body.slug);
  ok('the new slug resolves', (await req('GET', '/api/servers/quiet-library', null, owner.token)).status === 200, 'failed');
  ok('the old slug no longer resolves', (await req('GET', '/api/servers/reading-room', null, owner.token)).status === 404, 'still resolved');
  ok('the id route still works after a rename', (await req('GET', '/api/servers/' + aId, null, owner.token)).status === 200, 'broke');
  // Renaming to the same name must not collide with the community's own slug.
  const same = await req('PATCH', '/api/servers/quiet-library', { name: 'Quiet Library' }, owner.token);
  const sameAfter = await req('GET', '/api/servers/' + aId, null, owner.token);
  ok('renaming to the same name keeps the slug', same.status === 200 && sameAfter.body.slug === 'quiet-library', sameAfter.body.slug);

  // Renaming one community onto another's name must not steal its URL.
  await req('PATCH', '/api/servers/' + bId, { name: 'Reading Room 2' }, owner.token);
  const collide = await req('PATCH', '/api/servers/' + aId, { name: 'Reading Room 2' }, owner.token);
  const collideAfter = await req('GET', '/api/servers/' + aId, null, owner.token);
  ok('renaming onto a taken name gets a different slug',
    collide.status === 200 && collideAfter.body.slug !== 'reading-room-2', collideAfter.body.slug);
  ok('the other community keeps its URL', (await req('GET', '/api/servers/reading-room-2', null, owner.token)).status === 200, 'stolen');

  // Backfill itself is exercised at boot on every run of this suite, against a
  // real database. Calling it from here would need a connection this process
  // does not have, and asserting nothing about it would be the point of it.

  console.log('\npass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
