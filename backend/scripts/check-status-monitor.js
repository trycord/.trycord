'use strict';

// The status monitor is a second process, on its own port, whose whole job is to
// report on the first one. That makes it easy to get subtly wrong in ways nothing
// else notices: a state machine that calls one dropped packet an outage, a config
// file that silently wins over the environment, a report full of numbers that were
// never measured.
//
// This drives the real modules - the config loader against real files and real env
// objects, the state machine against injected checks and a frozen clock, and the
// HTTP surface against a stub upstream that is made to fail on demand - and then
// checks that the public status page is wired to the monitor rather than merely
// documenting one.
//
// Run: node scripts/check-status-monitor.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const { loadConfig, resolveTargetUrl, DEFAULT_PORT } = require('../src/status-monitor/config');
const { createMonitor } = require('../src/status-monitor/monitor');
const { createServer } = require('../src/status-monitor/server');
const { runCheck } = require('../src/status-monitor/checks');

const backendDir = path.join(__dirname, '..');
const repoDir = path.join(backendDir, '..');

let passed = 0;
const failures = [];

const same = (a, b) => (a && typeof b === 'object')
  ? JSON.stringify(a) === JSON.stringify(b)
  : a === b;

function ok(label, actual, expected) {
  if (same(actual, expected)) {
    passed++;
    console.log('    ok   ' + label);
  } else {
    failures.push(label + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
    console.log('    FAIL ' + label + '  <- got ' + JSON.stringify(actual)
      + ', expected ' + JSON.stringify(expected));
  }
}

function throws(label, fn) {
  try {
    fn();
    failures.push(label + ': did not throw');
    console.log('    FAIL ' + label + '  <- did not throw');
  } catch (err) {
    passed++;
    console.log('    ok   ' + label);
  }
}

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

function request(port, targetPath, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: targetPath, method: method || 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- configuration -------------------------------------------------------
function configuration() {
  console.log('\n  configuration defaults');
  const base = loadConfig({}, { cwd: backendDir });
  ok('the default port is the monitor port', DEFAULT_PORT, 9972);
  ok('the default host is not loopback-only', base.host, '0.0.0.0');
  ok('the default interval is 30s', base.intervalMs, 30000);
  ok('the default timeout is 5s', base.timeoutMs, 5000);
  ok('one failure is not enough to call it down', base.failureThreshold, 2);
  ok('the slow threshold is 1500ms', base.slowMs, 1500);
  ok('the history keeps 180 samples', base.history, 180);
  ok('the default targets are the real health routes',
    base.targets.map((t) => t.url), ['/', '/health', '/api/health']);
  ok('the api target expects ok:true', base.targets[1].expect.json, { ok: true });
  ok('the database target expects db:ok', base.targets[2].expect.json, { db: 'ok' });

  console.log('\n  configuration from the environment');
  const envCfg = loadConfig({
    STATUS_MONITOR_PORT: '1234',
    STATUS_MONITOR_HOST: '127.0.0.1',
    STATUS_MONITOR_INTERVAL_MS: '5000',
    STATUS_MONITOR_TITLE: 'Custom status',
    STATUS_MONITOR_BASE_URL: 'http://example.test:9000/',
  }, { cwd: backendDir });
  ok('the port comes from the environment', envCfg.port, 1234);
  ok('the host comes from the environment', envCfg.host, '127.0.0.1');
  ok('the interval comes from the environment', envCfg.intervalMs, 5000);
  ok('the title comes from the environment', envCfg.title, 'Custom status');
  ok('a trailing slash on the base is stripped', envCfg.baseUrl, 'http://example.test:9000');
  ok('a relative target resolves against the base',
    resolveTargetUrl(envCfg.targets[1], envCfg.baseUrl), 'http://example.test:9000/health');
  ok('an empty environment value falls back rather than blanking',
    loadConfig({ STATUS_MONITOR_TITLE: '' }, { cwd: backendDir }).title, 'Trycord status');

  const inlineCfg = loadConfig({
    STATUS_MONITOR_TARGETS: JSON.stringify([
      { id: 'one', name: 'One', url: '/one', expect: { status: [204] } },
      { id: 'two', name: 'Two', type: 'tcp', host: '127.0.0.1', port: 3306 },
    ]),
  }, { cwd: backendDir });
  ok('an inline target list replaces the defaults', inlineCfg.targets.map((t) => t.id), ['one', 'two']);
  ok('the http target keeps its expectation', inlineCfg.targets[0].expect.status, [204]);
  ok('the tcp target keeps its port', inlineCfg.targets[1].port, 3306);

  console.log('\n  configuration from a JSON file');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-status-'));
  const fileCfgPath = path.join(tmp, 'status.json');
  fs.writeFileSync(fileCfgPath, JSON.stringify({
    port: 4444,
    title: 'From file',
    targets: [{ id: 'one', name: 'One', url: '/one', expect: { status: [204] } }],
  }));
  const fromFile = loadConfig({ STATUS_MONITOR_CONFIG: fileCfgPath }, { cwd: backendDir });
  ok('the file sets the port', fromFile.port, 4444);
  ok('the file replaces the default target list', fromFile.targets.map((t) => t.id), ['one']);
  ok('the file target keeps its expectation', fromFile.targets[0].expect.status, [204]);
  const envWins = loadConfig({
    STATUS_MONITOR_CONFIG: fileCfgPath,
    STATUS_MONITOR_PORT: '5555',
    STATUS_MONITOR_TITLE: 'From env',
  }, { cwd: backendDir });
  ok('the environment wins over the file for a scalar', [envWins.port, envWins.title], [5555, 'From env']);

  console.log('\n  a configuration that cannot be honoured is refused, not guessed');
  throws('a missing config file is refused',
    () => loadConfig({ STATUS_MONITOR_CONFIG: path.join(tmp, 'nope.json') }, { cwd: backendDir }));
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json');
  throws('a malformed JSON config file is refused',
    () => loadConfig({ STATUS_MONITOR_CONFIG: path.join(tmp, 'broken.json') }, { cwd: backendDir }));
  throws('duplicate target ids are refused',
    () => loadConfig({ STATUS_MONITOR_TARGETS: JSON.stringify([{ id: 'x', url: '/a' }, { id: 'x', url: '/b' }]) }, { cwd: backendDir }));
  throws('a tcp target without a port is refused',
    () => loadConfig({ STATUS_MONITOR_TARGETS: JSON.stringify([{ id: 'x', type: 'tcp', host: '127.0.0.1' }]) }, { cwd: backendDir }));
  throws('a port out of range is refused',
    () => loadConfig({ STATUS_MONITOR_PORT: '70000' }, { cwd: backendDir }));
  throws('an empty target list is refused',
    () => loadConfig({ STATUS_MONITOR_TARGETS: '[]' }, { cwd: backendDir }));

  return tmp;
}

// ---- the state machine ---------------------------------------------------
async function stateMachine() {
  console.log('\n  the state machine, with injected checks and a frozen clock');
  const cfg = loadConfig({
    STATUS_MONITOR_TARGETS: JSON.stringify([{ id: 't', name: 'T', url: '/health' }]),
  }, { cwd: backendDir });
  cfg.failureThreshold = 2;
  cfg.recoveryThreshold = 1;
  cfg.slowMs = 100;
  cfg.history = 3;

  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  let result = { ok: true, ms: 10 };
  const monitor = createMonitor(cfg, {
    runCheck: () => Promise.resolve(result),
    now: () => clock,
  });

  await monitor.tick();
  ok('a first success is up', monitor.targets[0].state, 'up');
  ok('overall is up', monitor.report().overall, 'up');
  ok('the component url is resolved', monitor.report().components[0].url,
    'http://127.0.0.1:9971/health');

  result = { ok: false, ms: 5, error: 'HTTP 500, wanted 200' };
  clock += 1000;
  await monitor.tick();
  ok('one failure below the threshold is degraded', monitor.targets[0].state, 'degraded');
  ok('the report keeps the reason', monitor.report().components[0].lastError, 'HTTP 500, wanted 200');

  clock += 1000;
  await monitor.tick();
  ok('the second consecutive failure is down', monitor.targets[0].state, 'down');
  ok('overall is down', monitor.report().overall, 'down');
  ok('since marks the moment of the change',
    monitor.report().components[0].since, new Date(clock).toISOString());

  result = { ok: true, ms: 10 };
  clock += 1000;
  await monitor.tick();
  ok('one success recovers it', monitor.targets[0].state, 'up');

  result = { ok: true, ms: 5000 };
  clock += 1000;
  await monitor.tick();
  ok('a slow success is degraded, not up', monitor.targets[0].state, 'degraded');
  ok('latency is reported as measured', monitor.report().components[0].latencyMs, 5000);

  ok('history is capped at the configured length', monitor.targets[0].history.length, 3);
  const win = monitor.report().components[0].window;
  ok('the window counts its samples', win.samples, 3);
  ok('the window reports the exact pass count', win.passed, 2);
  ok('availability is the real fraction of the window', win.availability, 2 / 3);
  monitor.stop();
}

// ---- the check types -----------------------------------------------------
async function checkTypes() {
  console.log('\n  the tcp check against a real socket');
  const tcpServer = net.createServer(() => {});
  const port = await new Promise((resolve) => {
    tcpServer.listen(0, '127.0.0.1', () => resolve(tcpServer.address().port));
  });
  const open = await runCheck({ type: 'tcp', host: '127.0.0.1', port }, { timeoutMs: 1000, baseUrl: '' });
  ok('a connect to a listening port succeeds', open.ok, true);
  await new Promise((resolve) => tcpServer.close(resolve));
  const closed = await runCheck({ type: 'tcp', host: '127.0.0.1', port }, { timeoutMs: 1000, baseUrl: '' });
  ok('a connect to a closed port fails', closed.ok, false);
  ok('a failed check still carries a message', typeof closed.error, 'string');
}

// ---- the HTTP surface ----------------------------------------------------
async function httpSurface() {
  console.log('\n  the HTTP surface, against a stub upstream');
  let failMode = false;
  const upstream = http.createServer((req, res) => {
    if (failMode) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('nope');
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, db: 'ok', instanceId: 'i', client: true }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>site</body></html>');
  });
  const upstreamPort = await listen(upstream);
  const upstreamUrl = 'http://127.0.0.1:' + upstreamPort;

  const cfg = loadConfig({
    STATUS_MONITOR_BASE_URL: upstreamUrl,
    STATUS_MONITOR_INTERVAL_MS: '60000',
    STATUS_MONITOR_FAILURE_THRESHOLD: '1',
  }, { cwd: backendDir });
  cfg.port = 0; // ephemeral; the port validator is covered above

  const monitor = createMonitor(cfg);
  const server = createServer(cfg, monitor);
  const port = await listen(server);
  monitor.start();
  await monitor.tick();

  const status = await request(port, '/status.json');
  const report = JSON.parse(status.body);
  ok('/status.json answers 200', status.status, 200);
  ok('/status.json is cross-origin readable by default',
    status.headers['access-control-allow-origin'], '*');
  ok('the report names its overall state', report.overall, 'up');
  ok('the report lists every target', report.components.length, 3);
  ok('every component is up', report.components.map((c) => c.state), ['up', 'up', 'up']);
  ok('the api component resolves to the real route',
    report.components[1].url, upstreamUrl + '/health');
  ok('the report carries a generation time', typeof report.generatedAt, 'string');

  const health = await request(port, '/health');
  ok('/health answers 200', health.status, 200);
  ok('/health says the monitor is up', JSON.parse(health.body).ok, true);

  const ready = await request(port, '/ready');
  const readyBody = JSON.parse(ready.body);
  ok('/ready answers 200', ready.status, 200);
  ok('/ready counts the targets', readyBody.targets, 3);
  ok('/ready carries the start time', typeof readyBody.startedAt, 'string');

  const metrics = await request(port, '/metrics');
  ok('/metrics is plain text', metrics.headers['content-type'].indexOf('text/plain'), 0);
  ok('/metrics reports each target up',
    metrics.body.includes('trycord_status_up{target="api"} 1'), true);
  ok('/metrics reports a measured latency',
    /trycord_status_latency_ms\{target="api"\} \d+/.test(metrics.body), true);

  const html = await request(port, '/');
  ok('the dashboard answers 200', html.status, 200);
  ok('the dashboard is HTML', html.headers['content-type'].indexOf('text/html'), 0);
  ok('the dashboard has a table', html.body.includes('<table>'), true);
  ok('the dashboard shows the state', html.body.includes('state--ok'), true);

  const missing = await request(port, '/nope');
  ok('an unknown path is 404', missing.status, 404);
  const wrongMethod = await request(port, '/status.json', 'POST');
  ok('a non-GET is refused', wrongMethod.status, 405);
  const preflight = await request(port, '/status.json', 'OPTIONS');
  ok('a preflight is answered', preflight.status, 204);

  const mismatch = await runCheck(
    { type: 'http', url: '/api/health', expect: { status: [200], json: { db: 'no' } } },
    { timeoutMs: 1000, baseUrl: upstreamUrl });
  ok('a JSON field that does not match fails the check', mismatch.ok, false);
  const contains = await runCheck(
    { type: 'http', url: '/', expect: { status: [200], contains: '</html>' } },
    { timeoutMs: 1000, baseUrl: upstreamUrl });
  ok('a contains expectation is honoured', contains.ok, true);

  failMode = true;
  await monitor.tick();
  const down = JSON.parse((await request(port, '/status.json')).body);
  ok('a failing upstream turns the instance down', down.overall, 'down');
  ok('the failure explains itself', typeof down.components[1].lastError, 'string');

  failMode = false;
  await monitor.tick();
  const recovered = JSON.parse((await request(port, '/status.json')).body);
  ok('recovery is reported', recovered.overall, 'up');

  monitor.stop();
  server.close();
  upstream.close();
}

// ---- the public page is actually wired -----------------------------------
function wiring() {
  console.log('\n  the public status page is wired to the monitor');
  const serveClient = fs.readFileSync(path.join(backendDir, 'src', 'serve-client.js'), 'utf8');
  const statusHtml = fs.readFileSync(path.join(repoDir, 'public', 'status.html'), 'utf8');
  const statusJs = fs.readFileSync(path.join(repoDir, 'public', 'js', 'status.js'), 'utf8');
  const env = fs.readFileSync(path.join(backendDir, '.env.example'), 'utf8');

  ok('the server reads the configured monitor URL',
    serveClient.includes('STATUS_MONITOR_PUBLIC_URL'), true);
  ok('the server emits it as page metadata',
    serveClient.includes('name="status-monitor"'), true);
  ok('the page reads a monitor report',
    statusJs.includes('status.json') && statusJs.includes('status-monitor'), true);
  ok('the page still probes the real routes itself',
    statusJs.includes("'/health'") && statusJs.includes("'/api/health'"), true);
  ok('the static fallback rows survive', statusHtml.includes('data-state-cell="api"'), true);
  ok('the page no longer claims there is no monitor at all',
    /runs no uptime monitor|no status backend/i.test(statusHtml), false);
  ok('.env.example documents the monitor port', env.includes('STATUS_MONITOR_PORT'), true);
  ok('.env.example documents the page wiring', env.includes('STATUS_MONITOR_PUBLIC_URL'), true);
}

(async () => {
  const tmp = configuration();
  await stateMachine();
  await checkTypes();
  await httpSurface();
  wiring();

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n  status monitor check '
    + (failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed')
    + ' - ' + passed + ' assertions\n');
  process.exit(failures.length ? 1 : 0);
})();
