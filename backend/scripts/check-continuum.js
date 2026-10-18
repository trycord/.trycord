#!/usr/bin/env node
'use strict';

// Community Continuum end to end: two real backends, real HTTP, real signatures.
//
// The check boots two throwaway instances (A and B), turns federation on at
// runtime through the administration settings like an operator would, has each
// side probe and add the other, and posts a message whose signed event must
// cross the wire. It also verifies the one thing that makes restarts harmless:
// the signing identity of an instance survives a full process restart.
//
//   node scripts/check-continuum.js

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

async function freePort() {
  const probe = require('net').createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (probe.address()).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const realFetch = globalThis.fetch;
async function call(method, url, token, body) {
  const res = await realFetch(url, {
    method,
    headers: Object.assign(
      { 'content-type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

let failures = 0;
const ok = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label + (detail ? ': ' + detail : ''));
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

/** Boot one throwaway instance. Returns { base, token, child, stop } */
async function bootInstance(name, port, dir) {
  const env = {
    ...process.env,
    DB_CLIENT: 'sqlite',
    TRYCOD_DB_ENV_ONLY: '1',
    DB_FILE: path.join(dir, name + '.db'),
    PORT: String(port),
    HOST: '127.0.0.1',
    UPLOAD_DIR: path.join(dir, 'uploads-' + name),
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    ALLOW_REMOTE_DB: 'true',
    CONTINUUM_ALLOW_LOCALHOST: 'true',
    JWT_SECRET: 'check-continuum-secret-0123456789abcdef',
    ADMIN_USERNAMES: name.toLowerCase(),
    TRYCORD_INSTANCE_ID: name.toLowerCase(),
    TRYCORD_NAME: name,
  };
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (/startup failed|EADDRINUSE/i.test(log)) break;
    if (child.exitCode !== null) break;
    try {
      const res = await realFetch(base + 'api/health', { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.json()).ok) return { child, log, base, env, dir };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(name + ' did not start. Log: ' + log.slice(-800));
}

async function runOne(instance, label) {
  // A platform administrator: the username the boot promoted from the
  // deployment's list signs in with a password and is an admin at once.
  const username = label.toLowerCase();
  let res = await call('POST', instance.base + 'api/auth/register', null, {
    username,
    email: username + '@check.trycord',
    password: 'continuum-check-passphrase',
    displayName: label + ' Admin',
    termsVersion: '1.0',
    privacyVersion: '1.0',
  });
  if (res.status !== 200 || !(res.json && res.json.token)) {
    res = await call('POST', instance.base + 'api/auth/login', null, {
      username, password: 'continuum-check-passphrase',
    });
  }
  const token = res.json && res.json.token;
  if (!token) throw new Error(label + ' could not sign in: ' + JSON.stringify(res.json).slice(0, 200));
  await call('POST', instance.base + 'api/test/self-verify', token);
  return token;
}

async function makeCommunity(token, base, name) {
  const server = await call('POST', base + 'api/servers', token, { name });
  if (!(server.json && server.json.serverId)) {
    throw new Error('community could not be created: ' + JSON.stringify(server.json).slice(0, 200));
  }
  const cid = server.json.serverId;
  const channels = await call('GET', base + 'api/servers/' + cid + '/channels', token);
  const created = channels.json || [];
  const first = Array.isArray(created) ? created.find((c) => c && c.id) : null;
  let channelId = first ? first.id : null;
  if (!channelId) {
    const channel = await call('POST', base + 'api/servers/' + cid + '/channels', token, { name: 'general', type: 'text' });
    channelId = channel.json && channel.json.id;
  }
  return { serverId: cid, channelId };
}

async function waitUntil(fn, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

(async () => {
  const workDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'check-continuum-'));
  const portA = await freePort();
  const portB = await freePort();

  const live = [];
  const stopAll = async () => {
    for (const child of live) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 600));
    for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  process.on('exit', () => { for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });

  try {
    const A = await bootInstance('FedA', portA, workDir);
    live.push(A.child);
    const B = await bootInstance('FedB', portB, workDir);
    live.push(B.child);
    console.log('  booted FedA on ' + portA + ' and FedB on ' + portB);

    const tokenA = await runOne(A, 'FedA');
    const tokenB = await runOne(B, 'FedB');

    // -- 1. the master switch, flipped at runtime -------------------------------
    let put = await call('PUT', A.base + 'api/admin/settings', tokenA,
      { 'continuum.enabled': true, __confirm: true });
    ok('federation can be turned on from the settings store at runtime', put.status === 200 || put.status === 201,
      'HTTP ' + put.status);
    put = await call('PUT', B.base + 'api/admin/settings', tokenB,
      { 'continuum.enabled': true, __confirm: true });
    ok('the second instance turns federation on too', put.status === 200 || put.status === 201,
      'HTTP ' + put.status);

    const docA = await call('GET', A.base + '.well-known/trycord', null);
    const docB = await call('GET', B.base + '.well-known/trycord', null);
    ok('the discovery document is public and enabled', docA.status === 200 && docB.status === 200
      && docA.json.enabled === true && docB.json.enabled === true,
      docA.json && docA.json.enabled === true ? 'A answers' : JSON.stringify(docA).slice(0, 120));
    ok('the two instances have distinct identities',
      docA.json.instance_id && docB.json.instance_id && docA.json.instance_id !== docB.json.instance_id,
      docA.json.instance_id + ' / ' + docB.json.instance_id);
    ok('each publishes an Ed25519 public key',
      /BEGIN PUBLIC KEY/.test(docA.json.public_key || '') && /BEGIN PUBLIC KEY/.test(docB.json.public_key || ''));

    // -- 2. the probe, including the keep-out list ------------------------------
    let probe = await call('GET', A.base + 'api/continuum/probe?origin=' + encodeURIComponent('http://127.0.0.1:' + portB), tokenA);
    ok('the probe of the remote answers with its discovery document',
      probe.status === 200 && probe.json && probe.json.discovery && probe.json.discovery.instance_id === docB.json.instance_id,
      probe.status === 200 ? 'ok' : JSON.stringify(probe.json || probe.status).slice(0, 140));

    const rejected = await call('GET', A.base + 'api/continuum/probe?origin=' + encodeURIComponent('http://10.1.2.3/x'), tokenA);
    ok('the probe refuses a private-range origin (the transport guard applies)',
      rejected.status === 400,
      'HTTP ' + rejected.status + ' ' + ((rejected.json && rejected.json.error && rejected.json.error.message) || '').slice(0, 80));

    const anonProbe = await call('GET', A.base + 'api/continuum/probe?origin=' + encodeURIComponent('http://127.0.0.1:' + portB), null);
    ok('the probe is an administrative route', anonProbe.status === 401 || anonProbe.status === 403,
      'HTTP ' + anonProbe.status);

    // -- 3. bidirectional pairing with trust ------------------------------------
    let add = await call('POST', A.base + 'api/continuum/instances', tokenA, {
      id: docB.json.instance_id, name: 'FedB', origin: 'http://127.0.0.1:' + portB, public_key: docB.json.public_key,
    });
    ok('A stores B', add.status === 201 && add.json && add.json.trust_status === 'pending',
      add.status === 201 ? 'pending' : JSON.stringify(add.json || {}).slice(0, 120));
    add = await call('POST', B.base + 'api/continuum/instances', tokenB, {
      id: docA.json.instance_id, name: 'FedA', origin: 'http://127.0.0.1:' + portA, public_key: docA.json.public_key,
    });
    ok('B stores A (federation is bidirectional)', add.status === 201 && add.json && add.json.trust_status === 'pending');

    let trust = await call('PATCH', B.base + 'api/continuum/instances/' + encodeURIComponent(docA.json.instance_id) + '/trust', tokenB, { trust_status: 'trusted' });
    ok('B trusts A', trust.status === 200 && trust.json && trust.json.trust_status === 'trusted');
    trust = await call('PATCH', A.base + 'api/continuum/instances/' + encodeURIComponent(docB.json.instance_id) + '/trust', tokenA, { trust_status: 'trusted' });
    ok('A trusts B', trust.status === 200);

    // -- 4. an event crosses the wire -------------------------------------------
    const world = await makeCommunity(tokenA, A.base, 'FedA community');
    ok('A seeded a community and a channel', !!(world && world.channelId),
      world && world.channelId ? world.channelId.slice(0, 8) : 'missing');

    const posted = await call('POST', world.base_url || (A.base + 'api/channels/' + world.channelId + '/messages'), tokenA, { content: 'hello from FedA' });
    ok('the message posts locally', posted.status === 200 || posted.status === 201,
      'HTTP ' + posted.status);

    const received = await waitUntil(async () => {
      const box = await call('GET', B.base + 'api/continuum/inbox', tokenB);
      const rows = Array.isArray(box.json) ? box.json : [];
      // processed=1 is the inbound processor's own verdict: the signature was
      // verified against the recorded key on the way in, and the event left
      // 'held' only when its kind is one the processor does not know.
      return rows.find((r) => r.kind === 'message.posted' && r.instance_id === docA.json.instance_id && r.processed === 1);
    }, 15000);
    ok('the signed event arrives in the remote inbox', !!received,
      received ? received.kind + ' from ' + received.instance_id : 'nothing arrived');
    ok('the arrival is processed (signature verified, deduplicated on the way in)',
      received && received.processed === 1);

    const outbox = await call('GET', A.base + 'api/continuum/events', tokenA);
    const delivered = (Array.isArray(outbox.json) ? outbox.json : []).find((e) => e.status === 'delivered');
    ok('the outbox records the delivery', !!delivered,
      delivered ? delivered.kind : JSON.stringify(outbox.json || []).slice(0, 120));

    // -- 5. replay and identity-continuity across a restart ----------------------
    const keyBefore = docA.json.public_key;
    A.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    live.pop();
    // Rebind the same sqlite database: the persisted identity must come back.
    const A2 = await bootInstance('FedA', portA, workDir);
    live.push(A2.child);
    const tokenA2 = await runOne(A2, 'FedA');
    const docA2 = await call('GET', A2.base + '.well-known/trycord', null);
    ok('the signing identity survives a full process restart',
      docA2.status === 200 && docA2.json.public_key === keyBefore,
      docA2.json.public_key === keyBefore ? 'the same key is republished' : 'the key changed across the restart');

    // The resumed instance still talks to the peer whose row survived the restart.
    const secondWorld = await makeCommunity(tokenA2, A2.base, 'FedA second');
    await call('POST', A2.base + 'api/channels/' + secondWorld.channelId + '/messages', tokenA2, { content: 'hello again' });
    const second = await waitUntil(async () => {
      const box = await call('GET', B.base + 'api/continuum/inbox', tokenB);
      const rows = Array.isArray(box.json) ? box.json : [];
      return rows.filter((r) => r.kind === 'message.posted' && r.instance_id === docA.json.instance_id && r.processed === 1).length >= 2;
    }, 15000);
    ok('after the restart the peer relationship still verifies signatures', !!second,
      second ? 'second event arrived and verified' : 'verification broke after the restart');

    const events2 = await call('GET', A2.base + 'api/continuum/events', tokenA2);
    const delivered2 = (Array.isArray(events2.json) ? events2.json : []).filter((e) => e.status === 'delivered');
    ok('the outbox reflects both deliveries across the restart', delivered2.length >= 2,
      String(delivered2.length) + ' delivered event(s)');
  } finally {
    await stopAll();
  }

  console.log('\n  continuum check ' + (failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'));
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('  the check threw:', e.message);
  console.error(e.stack);
  process.exit(1);
});
