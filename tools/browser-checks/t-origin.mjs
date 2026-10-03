// The backend origin has to be able to bootstrap the whole client.
//
// This is the architectural property rather than a feature: one client, served
// from any origin an operator controls, with the API staying an API. A
// self-hoster who can only reach their server's API cannot run Trycord, and a
// catch-all sendFile that swallows /api/* is worse than not serving at all.
//
// Lost with /tmp once and worth having back: it caught a deep-link 404 and a
// document that kept the hosted mount on an origin-root deployment.

import { launch, waitForServer } from './cdp.mjs';

const B = process.env.TC_ORIGIN || 'http://127.0.0.1:9975';
let pass = 0, fail = 0; const bad = [];
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; bad.push(n); console.log('  FAIL  ' + n + (x !== undefined ? '  <<< ' + JSON.stringify(x).slice(0, 260) : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await waitForServer(B + '/api/health');

// Every client route the router knows about, as addresses someone would type.
const ROUTES = [
  '/', '/home', '/menu', '/dms', '/friends', '/notifications', '/discover',
  '/settings', '/settings/privacy', '/settings/security', '/settings/appearance',
  '/account', '/account/sessions', '/admin', '/servers/new',
  '/invite/6J23FFH4', '/users/someone', '/legal', '/support',
  '/c/some-community', '/server/some-community',
  '/c/some-community/channel/some-token',
  '/c/some-community/settings/analytics',
  '/login', '/register', '/forgot', '/reset-password', '/verify-email',
];

console.log('\n=== every client route is served the shell ===');
for (const route of ROUTES) {
  const res = await fetch(B + route, { redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  const isShell = /text\/html/.test(type) && /<base href=/.test(body);
  ok('GET ' + route + ' serves the client shell', res.status === 200 && isShell,
    { status: res.status, type });
}

console.log('\n=== the API is still an API ===');
for (const route of ['/api/health', '/api/instance', '/api/me', '/api/servers']) {
  const res = await fetch(B + route);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  ok('GET ' + route + ' is JSON, not the client',
    /application\/json/.test(type) && !/<base href/.test(body), { status: res.status, type });
}
{
  const res = await fetch(B + '/api/definitely-not-here');
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  ok('an unknown API path is a JSON 404, never the client',
    res.status === 404 && /application\/json/.test(type) && !/<base href/.test(body),
    { status: res.status, type });
}
{
  const res = await fetch(B + '/api/me', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  ok('a bad API call is refused by the API', res.status >= 400 && res.status < 500, res.status);
}

console.log('\n=== assets resolve from any entry point ===');
// The document uses a relative base, so a deep entry must not ask the browser
// for /settings/js/app.js. That was a whole blank-page bug once.
for (const entry of ['/', '/settings/privacy', '/c/x/settings/analytics']) {
  const doc = await (await fetch(B + entry)).text();
  const base = (doc.match(/<base href="([^"]*)">/) || [])[1];
  ok(entry + ' declares a base of /', base === '/', base);
  for (const asset of ['css/app.css', 'js/app.js', 'js/routes.js']) {
    const res = await fetch(new URL(asset, B + base));
    const okType = asset.endsWith('.css')
      ? /text\/css/.test(res.headers.get('content-type') || '')
      : /javascript/.test(res.headers.get('content-type') || '');
    ok(entry + ' -> ' + asset, res.status === 200 && okType, res.status);
  }
}
{
  const missing = await fetch(B + '/js/definitely-missing.js');
  ok('a missing asset is 404 and never a document', !/<base href/.test(await missing.text()));
}

console.log('\n=== the client talks to the origin that served it ===');
{
  const cfg = await (await fetch(B + '/backend.json')).json();
  ok('backend.json names the serving origin', cfg.backendUrl === B, cfg);
  ok('a self-hosted client is not pointed at another instance',
    !/api\.trycord\.dev/.test(String(cfg.backendUrl || '')), cfg.backendUrl);
}
{
  // Behind a proxy the host header is the one the browser used, which is the
  // origin the client is really talking to. fetch() cannot set Host, so this
  // needs a raw request.
  const http = await import('node:http');
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(B + '/backend.json', {
      headers: { Host: 'chat.example.org', 'X-Forwarded-Proto': 'https' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
  const cfg = JSON.parse(raw);
  ok('behind a proxy it uses the forwarded host', cfg.backendUrl === 'https://chat.example.org', cfg);
}

console.log('\n=== it boots in a browser, from this origin ===');
const page = await launch({ width: 1440, height: 940 });
try {
  await page.goto(B + '/', { waitMs: 1200 });
  await page.eval(`localStorage.clear(); return 1;`);
  ok('the shell boots', !!(await page.waitFor(
    `!!document.querySelector('.skip-link') && document.body.innerText.trim().length > 10`,
    { timeout: 20000 })));
  const styled = await page.eval(`
    const cs = getComputedStyle(document.body);
    return { bg: cs.backgroundColor, fam: cs.fontFamily.slice(0, 20) };`);
  ok('the stylesheet applied', styled.bg !== 'rgba(0, 0, 0, 0)', styled);
  // A 401 while signed out is the auth probe being answered correctly.
  const errs = (await page.errors()).filter((e) => !/favicon|DevTools|status of 40[14]/.test(e));
  ok('no faults while booting', errs.length === 0, errs.slice(0, 3));

  console.log('\n=== a deep link boots the right route ===');
  for (const route of ['/login', '/register', '/forgot', '/settings/privacy', '/dms']) {
    await page.goto(B + route, { waitMs: 2000 });
    const landed = await page.eval(`
      return { path: location.pathname,
               text: document.body.innerText.trim().slice(0, 80).replace(/\\s+/g, ' ') };`);
    ok('deep link ' + route + ' painted a screen', landed.text.length > 10, landed);
    ok('deep link ' + route + ' did not hit a view error',
      !/Unable to load this view/.test(landed.text), landed);
  }

  console.log('\n=== auth states never leave a blank page ===');
  await page.goto(B + '/login', { waitMs: 1800 });
  await page.type('#login-username', 'nobody' + Math.random().toString(36).slice(2, 8));
  await page.type('#login-password', 'wrongpassword');
  await page.click('.auth-form button[type="submit"]');
  await wait(1600);
  ok('a wrong password shows an error, not a blank page', !!(await page.eval(`
    const e = [...document.querySelectorAll('.form-error')].find(x => !x.hidden);
    return e && e.textContent.trim();`)));

  for (const [name, token] of [
    ['garbage', 'garbage.not.a.jwt'],
    ['expired', 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImRlYWRiZWVmIiwiZXhwIjoxfQ.sig'],
  ]) {
    await page.eval(`localStorage.setItem('trycord.token', ${JSON.stringify(token)}); return 1;`);
    await page.goto(B + '/home', { waitMs: 2200 });
    ok('a ' + name + ' token does not blank the app',
      (await page.eval(`return document.body.innerText.trim().length;`)) > 10);
  }

  console.log('\n=== a legacy fragment URL still arrives ===');
  // The fragment never reaches the server, so the client upgrades it on arrival.
  // This is a one-time conversion rather than a second router, and it must not
  // become a dependency: the pathname is what the app actually routes on.
  await page.goto(B + '/#/invite/6J23FFH4', { waitMs: 2200 });
  const upgraded = await page.eval(`return { path: location.pathname, hash: location.hash };`);
  ok('a legacy #/ URL is upgraded to a path', upgraded.path === '/invite/6J23FFH4', upgraded);
  ok('the fragment is cleared so it cannot come back', !upgraded.hash, upgraded);
} finally {
  await page.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (bad.length) console.log('failed: ' + bad.join(' | '));
process.exit(fail ? 1 : 0);