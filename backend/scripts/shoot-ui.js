#!/usr/bin/env node
'use strict';

// A look at the real thing, not a proxy for it.
//
// Boots a throwaway backend that serves the real client, drives headless
// Chromium over CDP (node's own WebSocket - no extra dependencies), signs in,
// and captures PNG screenshots of the application at desk size and phone size.
// The point is to see the layout the way a user does.
//
//   node scripts/shoot-ui.js [outdir]

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'tmp', 'shots');

const realFetch = globalThis.fetch;

async function freePort() {
  const probe = require('net').createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

async function bootInstance(dir, port) {
  const env = {
    ...process.env,
    DB_CLIENT: 'sqlite',
    TRYCOD_DB_ENV_ONLY: '1',
    DB_FILE: path.join(dir, 'shoot.db'),
    PORT: String(port),
    HOST: '127.0.0.1',
    UPLOAD_DIR: path.join(dir, 'uploads'),
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    ALLOW_REMOTE_DB: 'true',
    JWT_SECRET: 'shoot-ui-secret-0123456789abcdef',
    ADMIN_USERNAMES: 'shooter',
    TRYCORD_NAME: 'Shoot',
  };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await realFetch(base + 'api/health', { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { child, base };
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('shoot backend did not start: ' + log.slice(-500));
}

async function seed(base) {
  const call = async (method, p, token, body) => {
    const res = await realFetch(base + p.replace(/^\//, ''), {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = {}; try { json = await res.json(); } catch { /* empty */ }
    return json;
  };
  const creds = { username: 'shooter', email: 'shoot@example.com', password: 'correct-horse-battery-staple', displayName: 'Shooter', termsVersion: '1.0', privacyVersion: '1.0' };
  let reg = await call('POST', 'api/auth/register', null, creds);
  if (!reg.token) reg = await call('POST', 'api/auth/login', null, { username: creds.username, password: creds.password });
  if (!reg.token) throw new Error('no token: ' + JSON.stringify(reg).slice(0, 200));
  await call('POST', 'api/test/self-verify', reg.token);
  // A second account and a friendship, so lists are not empty.
  const other = await call('POST', 'api/auth/register', null, {
    username: 'sealion', email: 'sealion@example.com', password: 'correct-horse-battery-staple',
    displayName: 'Sea Lion', termsVersion: '1.0', privacyVersion: '1.0',
  });
  // A community with two channels and a few messages.
  const server = await call('POST', 'api/servers', reg.token, { name: 'Orbital', description: 'seeded for the screenshot pass' });
  const serverId = server.serverId || server.id;
  const slug = server.slug;
  const channels = await call('GET', `api/servers/${serverId}/channels`, reg.token);
  const list = Array.isArray(channels) ? channels : (channels.channels || []);
  let general = list.find((c) => c && c.id);
  if (!general) {
    const made = await call('POST', `api/servers/${serverId}/channels`, reg.token, { name: 'general', type: 'text' });
    general = { id: made.channelId || made.id };
  }
  await call('POST', `api/servers/${serverId}/channels`, reg.token, { name: 'off-topic', type: 'text' });
  await call('POST', `api/servers/${serverId}/channels`, reg.token, { name: 'hangar', type: 'voice' });
  await call('POST', `api/channels/${general.id}/messages`, reg.token, { content: 'Good morning. The gantry is clear and the countdown holds at ten minutes.' });
  await call('POST', `api/channels/${general.id}/messages`, reg.token, { content: 'Copy that — fuelling team is on the pad.' });
  await call('POST', `api/channels/${general.id}/messages`, reg.token, { content: 'Pinging @sealion about the weather window.' });
  // A DM so the conversations page has a row.
  await call('POST', 'api/dms', reg.token, { userId: other.userId || other.id, content: 'hello from the seeding pass' }).catch(() => {});
  return { token: reg.token, serverId, slug, channelId: general.id };
}

// ---- CDP --------------------------------------------------------------------
// This chromium build (155) stops answering Runtime commands after a main-frame
// navigation, while Page commands keep answering. So the whole driver stays on
// the Page domain: the session token is injected with a new-document script
// (runs in the main world before the app boots), loading is observed through
// load events, and nothing ever evaluates into a live page.
function cdp(port) {
  let ws = null;
  let seq = 0;
  const pending = new Map();
  const events = [];

  async function connect() {
    const list = await (await realFetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'Page.loadEventFired') events.push('load');
      else if (msg.method === 'Page.navigatedWithinDocument') events.push('same-doc');
    };
  }  async function send(method, params, ms = 15000) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, ms);
    });
    if (reply.timeout) throw new Error(method + ' never answered (this build stops answering Runtime after navigation)');
    if (reply.error) throw new Error(method + ': ' + JSON.stringify(reply.error));
    return reply.result;
  }
  // Fire and forget, by design.
  function navigate(url) {
    ws.send(JSON.stringify({ id: ++seq, method: 'Page.navigate', params: { url } }));
  }
  async function takeShot(file, settleMs) {
    // Wait for this navigation's load event, then let the SPA's own fetches
    // finish painting. The load event always arrives; the SPA is given a
    // generous window after it.
    const start = Date.now();
    const before = events.length;
    while (events.filter((x) => x === 'load').length <= before && Date.now() - start < 20000) await sleep(120);
    await sleep(settleMs);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }
  return { connect, send, navigate, takeShot };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(c, name, url, { width, height, mobile } = {}) {
  await c.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: !!mobile,
  });
  c.navigate(url.href);
  // The SPA fetches instance + session + live data after the document loads.
  await c.takeShot(path.join(OUT, name + '.png'), mobile ? 2600 : 2200);
  console.log('  ' + name + '.png  <- ' + url.href);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const workDir = fs.mkdtempSync('/home/ultim/trycord/.trycord/backend/tmp/shoot-');
  const port = await freePort();
  const { child, base } = await bootInstance(workDir, port);
  const world = await seed(base);
  console.log('  seeded ' + base);

  const origin = new URL(base).origin;
  const dbgPort = await freePort();
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--disable-dev-shm-usage',
    `--remote-debugging-port=${dbgPort}`,
    `--user-data-dir=${workDir}/profile`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    // Wait for the devtools endpoint.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await realFetch(`http://127.0.0.1:${dbgPort}/json/version`, { signal: AbortSignal.timeout(800) }); up = true; } catch { await sleep(250); }
    }
    if (!up) throw new Error('chromium devtools did not come up');
    const c = cdp(dbgPort);
    await c.connect();
    await c.send('Page.enable');
    // The session token rides in localStorage. This chromium build stops
    // answering Runtime commands after the first navigation, so the token is
    // planted by a script that runs in the main world of every document the
    // app opens, before the app's own scripts do.
    const inject = await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try { localStorage.setItem('trycord.token', " + JSON.stringify(world.token) + "); } catch (e) {}\n"
        + "try { localStorage.setItem('trycord.who', 'shooter'); } catch (e) {}\n",
    });

    const desk = { width: 1440, height: 900 };
    const phone = { width: 390, height: 844, mobile: true };

    // Desktop, signed in.
    const pages = [
      ['home-desktop', '/home'],
      ['dms-desktop', '/dms'],
      ['notifications-desktop', '/notifications'],
      ['discover-desktop', '/discover'],
      ['friends-desktop', '/friends'],
      ['menu-desktop', '/menu'],
      ['community-desktop', '/c/' + world.slug],
      ['channel-desktop', `/server/${world.serverId}/channel/${world.channelId}`],
      ['settings-desktop', '/settings'],
      ['admin-desktop', '/admin'],
      ['admin-settings-desktop', '/admin/settings'],
      ['admin-continuum-desktop', '/admin/continuum'],
      ['community-settings-desktop', `/server/${world.serverId}/settings`],
    ];
    for (const [name, p] of pages) {
      await shoot(c, name, new URL(origin + p), desk);
    }

    // The phone module.
    const mobilePages = [
      ['home-phone', '/mobile/home'],
      ['dms-phone', '/mobile/dms'],
      ['menu-phone', '/mobile/menu'],
      ['community-phone', '/mobile/c/' + world.slug],
      ['channel-phone', `/mobile/server/${world.serverId}/channel/${world.channelId}`],
      ['settings-phone', '/mobile/settings'],
      ['admin-phone', '/mobile/admin'],
      ['admin-continuum-phone', '/mobile/admin/continuum'],
    ];
    for (const [name, p] of mobilePages) {
      await shoot(c, name, new URL(origin + p), phone);
    }
    // Signed-out front doors: the same chromium carries the injected token,
    // so a fresh profile without the injection is the honest signed-out look.
    const dbgPort2 = await freePort();
    const chrome2 = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--disable-dev-shm-usage',
      `--remote-debugging-port=${dbgPort2}`,
      `--user-data-dir=${workDir}/profile2`,
      'about:blank',
    ], { stdio: 'ignore' });
    let up2 = false;
    for (let i = 0; i < 60 && !up2; i++) {
      try { await realFetch(`http://127.0.0.1:${dbgPort2}/json/version`, { signal: AbortSignal.timeout(800) }); up2 = true; } catch { await sleep(250); }
    }
    if (up2) {
      const c2 = cdp(dbgPort2);
      await c2.connect();
      await c2.send('Page.enable');
      await shoot(c2, 'front-desktop', new URL(origin + '/'), desk);
      await shoot(c2, 'front-phone', new URL(origin + '/mobile/'), phone);
      try { chrome2.kill('SIGTERM'); } catch { /* gone */ }
    } else {
      console.log('  (second chromium did not come up; skipping signed-out shots)');
    }
  } finally {
    try { chrome.kill('SIGTERM'); } catch { /* gone */ }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await sleep(400);
    try { chrome.kill('SIGKILL'); } catch { /* gone */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  console.log('  shots in ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
