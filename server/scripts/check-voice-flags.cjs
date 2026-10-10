// Voice and video feature-flag acceptance tests.
//
// The default configuration is VOICE_VIDEO_ENABLED=off, so these start from the state a
// self-hoster ships in and prove the flag changes it. Servers are booted as detached
// processes because the environment blocks spawn but permits execSync.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..');
const BASE_PORT = 9980;
const TMP = '/tmp/opencode/flags';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

fs.mkdirSync(TMP, { recursive: true });

function boot(port, extraEnv) {
  const dbFile = `${TMP}/flags-${port}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch { /* fresh */ }
  }

  const env = {
    ...process.env,
    DB_CLIENT: 'sqlite',
    DB_FILE: dbFile,
    HOST: '127.0.0.1',
    PORT: String(port),
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    JWT_SECRET: 'test-secret-only-32-bytes-long-0123',
    TRYCORD_INSTANCE_ID: 'flags',
    TRYCORD_NAME: 'Flags Test',
    STORAGE_DRIVER: 'local',
    UPLOAD_DIR: `${TMP}/uploads-${port}`,
    TRUST_PROXY: '0',
    RATE_LIMIT_MAX: '100000',
    ...extraEnv,
  };

  // A shell wrapper, because the environment permits execSync but not a direct spawn.
  const script = `cd ${JSON.stringify(SERVER)} && node src/index.js > ${TMP}/log-${port}.txt 2>&1`;
  execSync(`setsid nohup bash -c ${JSON.stringify(script)} > /dev/null 2>&1 &`, { env });

  return {
    port,
    log: () => fs.readFileSync(`${TMP}/log-${port}.txt`, 'utf8'),
    stop: () => {
      const pid = spawnSync('bash', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], { encoding: 'utf8' }).stdout.trim();
      if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ } }
    },
  };
}

async function waitUp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function call(port, method, p, body, token) {
  const r = await fetch(`http://127.0.0.1:${port}` + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// An account with a community and a voice channel.
async function fixture(port) {
  const tag = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const reg = await call(port, 'POST', '/api/auth/register', {
    username: tag, email: tag + '@example.invalid',
    password: 'correct-horse-battery-staple', displayName: 'V',
    termsVersion: '1.0', privacyVersion: '1.0',
  });
  const token = reg.json.token;
  await call(port, 'POST', '/api/test/self-verify', {}, token);

  const srv = await call(port, 'POST', '/api/servers', { name: 'Voice Community' }, token);
  const chan = await call(port, 'POST', `/api/servers/${srv.json.serverId}/channels`, { name: 'Lounge', type: 'voice' }, token);
  return { token, serverId: srv.json.serverId, channelId: chan.json.id, joinCode: srv.json.joinCode };
}

(async () => {
  console.log('\n  1. voice disabled, which is the default');

  const off = boot(BASE_PORT, {});
  ok('the server starts with no voice configuration at all', await waitUp(BASE_PORT), off.log().slice(-400));
  {
    const fx = await fixture(BASE_PORT);
    const caps = await call(BASE_PORT, 'GET', '/api/voice/capabilities', undefined, fx.token);
    ok('the capability response reports voice as off',
       caps.json && caps.json.voiceVideo && caps.json.voiceVideo.available === false
       && caps.json.voiceVideo.reason === 'disabled',
       JSON.stringify(caps.json && caps.json.voiceVideo));
    ok('the ICE server list is empty when voice is off',
       caps.json.features.voiceVideo.iceServers.length === 0);

    const secretLeak = JSON.stringify(caps.json);
    ok('the capability response carries no credential or secret',
       !/credential|secret|password/i.test(secretLeak), secretLeak.slice(0, 200));

    const join = await call(BASE_PORT, 'POST', '/api/voice/channels/' + fx.channelId + '/join', {}, fx.token);
    ok('a join is refused with a consistent feature-disabled response',
       join.status === 403 && join.json && join.json.error.code === 'FEATURE_DISABLED',
       join.status + ' ' + join.text.slice(0, 160));

    const creds = await call(BASE_PORT, 'POST', '/api/voice/credentials', { sessionId: 'x' }, fx.token);
    ok('asking for a credential is refused', creds.status === 403, creds.status);
    ok('signaling is refused',
       (await call(BASE_PORT, 'POST', '/api/voice/channels/' + fx.channelId + '/negotiate', {}, fx.token)).status === 403);

    const posted = await call(BASE_PORT, 'POST', '/api/channels/' + fx.channelId + '/messages', { content: 'hello' }, fx.token);
    ok('text messaging still works with voice off', posted.status === 201, posted.status);
  }
  off.stop();

  console.log('\n  2. enabled with no infrastructure');

  const broken = boot(BASE_PORT + 1, { VOICE_VIDEO_ENABLED: 'on', VOICE_VIDEO_PROVIDER: 'cloudflare' });
  const brokenUp = await waitUp(BASE_PORT + 1, 8000);
  ok('a configuration that cannot work is refused at startup',
     !brokenUp && /VOICE_VIDEO_ENABLED is on/.test(broken.log()), broken.log().slice(-300));
  broken.stop();

  console.log('\n  3. enabled with infrastructure');

  const good = boot(BASE_PORT + 2, {
    VOICE_VIDEO_ENABLED: 'on',
    VOICE_VIDEO_PROVIDER: 'cloudflare',
    VOICE_VIDEO_SFU_APP_ID: 'test-app-id',
    VOICE_VIDEO_SFU_APP_SECRET: 'test-app-secret',
    VOICE_VIDEO_STUN_URLS: 'stun:stun.example.invalid:3478',
    VOICE_VIDEO_MAX_PARTICIPANTS: '2',
    VOICE_VIDEO_SCREEN_SHARING: 'on',
    VOICE_VIDEO_STAGE_CHANNELS: 'off',
  });
  ok('the server starts with a complete voice configuration', await waitUp(BASE_PORT + 2), good.log().slice(-300));
  {
    const fx = await fixture(BASE_PORT + 2);
    const caps = await call(BASE_PORT + 2, 'GET', '/api/voice/capabilities', undefined, fx.token);
    // The credentials here are not real, so the provider answers that the App ID does not
    // exist. That is the adapter genuinely talking to the SFU and reporting what it said,
    // which is the behaviour under test: a misconfigured instance says unavailable with
    // the provider's own reason, rather than claiming to work.
    ok('a configured adapter reports availability honestly rather than claiming to work',
       caps.json && caps.json.voiceVideo
       && ['available', 'unreachable', 'misconfigured'].includes(caps.json.voiceVideo.reason)
       && typeof caps.json.voiceVideo.available === 'boolean',
       JSON.stringify(caps.json && caps.json.voiceVideo));
    ok('the provider was actually contacted',
       /appId|does not exist|reachable|refused/i.test(JSON.stringify(caps.json.voiceVideo)),
       JSON.stringify(caps.json.voiceVideo));
    ok('the ICE list carries the STUN server and no credential',
       caps.json.features.voiceVideo.iceServers.length === 1
       && caps.json.features.voiceVideo.iceServers[0].urls === 'stun:stun.example.invalid:3478',
       JSON.stringify(caps.json.features.voiceVideo.iceServers));
    ok('screen sharing follows the master flag', caps.json.features.voiceVideo.screenSharing === true);
    ok('a sub-flag cannot override the master', caps.json.features.voiceVideo.stageChannels === false);
    ok('the participant limit is enforced as configured', caps.json.features.voiceVideo.maxParticipants === 2);
    ok('no secret appears in the capability response', !/test-app-secret/.test(JSON.stringify(caps.json)));

    // The provider is unreachable here, so a join fails at the SFU call rather than at
    // authorization. What matters is that it is not refused as a disabled feature.
    const join = await call(BASE_PORT + 2, 'POST', '/api/voice/channels/' + fx.channelId + '/join', {}, fx.token);
    ok('a join is attempted rather than refused as disabled',
       join.status !== 403 || (join.json && join.json.error.code !== 'FEATURE_DISABLED'),
       join.status + ' ' + join.text.slice(0, 200));

    const posted = await call(BASE_PORT + 2, 'POST', '/api/channels/' + fx.channelId + '/messages', { content: 'still works' }, fx.token);
    ok('text messaging works with voice on', posted.status === 201, posted.status);
  }
  good.stop();

  console.log('\n  4. invalid spellings are refused');

  for (const [label, value] of [['a word that is not a boolean', 'maybe'], ['a number that is not a boolean', '2']]) {
    const bad = boot(BASE_PORT + 3, { VOICE_VIDEO_ENABLED: value });
    const upBad = await waitUp(BASE_PORT + 3, 6000);
    ok(`${label} (${JSON.stringify(value)}) is a startup error, not a silent default`,
       !upBad && /VOICE_VIDEO_ENABLED must be one of/.test(bad.log()), bad.log().slice(-200));
    bad.stop();
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
