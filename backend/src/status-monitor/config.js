'use strict';

// Configuration for the standalone status monitor.
//
// Everything is configurable, and the precedence is deliberate: built-in defaults,
// then an optional JSON file (STATUS_MONITOR_CONFIG), then environment variables.
// The environment wins so a container can be re-pointed without editing a file, and
// the file carries the part that is awkward as an env var - the target list.
//
// The monitor is its own process on its own port (default 9972) and shares nothing
// with the API. That independence is the point: a monitor that dies with the service
// it watches cannot tell you that the service died.

const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 9972;
const DEFAULT_APP_PORT = 9971;

function toInt(value, fallback) {
  const n = parseInt(String(value == null ? '' : value).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function stripSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

// The default targets are the components the API actually exposes. Every URL below
// is a real route from src/server.js; nothing here is invented.
function defaultTargets() {
  return [
    {
      id: 'website',
      name: 'Public website',
      description: 'The website this instance serves over HTTP.',
      type: 'http',
      url: '/',
      expect: { status: [200] },
    },
    {
      id: 'api',
      name: 'Application API',
      description: 'The process that answers API requests.',
      type: 'http',
      url: '/health',
      expect: { status: [200], json: { ok: true } },
    },
    {
      id: 'database',
      name: 'Database',
      description: 'Answers one read for the API.',
      type: 'http',
      url: '/api/health',
      expect: { status: [200], json: { db: 'ok' } },
    },
  ];
}

// Resolve a target's URL against the configured base. A relative path is the common
// case, so a target list can be copied between instances that differ only by host.
function resolveTargetUrl(target, baseUrl) {
  const u = String(target.url || '/');
  if (/^https?:\/\//i.test(u)) return u;
  return stripSlash(baseUrl) + (u.startsWith('/') ? u : '/' + u);
}

function normalizeTarget(raw, index) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const type = t.type === 'tcp' ? 'tcp' : 'http';
  const id = String(t.id || t.name || 'target-' + (index + 1))
    .trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  const out = {
    id: id || 'target-' + (index + 1),
    name: String(t.name || id),
    description: t.description ? String(t.description) : '',
    type,
    enabled: t.enabled === undefined ? true : !!t.enabled,
  };
  const timeoutMs = toInt(t.timeoutMs, 0);
  const slowMs = toInt(t.slowMs, 0);
  if (timeoutMs > 0) out.timeoutMs = timeoutMs;
  if (slowMs > 0) out.slowMs = slowMs;

  if (type === 'http') {
    out.url = String(t.url || '/');
    out.method = String(t.method || 'GET').toUpperCase();
    if (t.headers && typeof t.headers === 'object') out.headers = t.headers;
    if (t.insecure === true) out.insecure = true;
    const e = t.expect && typeof t.expect === 'object' ? t.expect : {};
    out.expect = {};
    if (Array.isArray(e.status)) out.expect.status = e.status.map((n) => toInt(n, 200));
    else if (e.status !== undefined) out.expect.status = [toInt(e.status, 200)];
    else out.expect.status = [200];
    if (e.contains !== undefined) out.expect.contains = String(e.contains);
    if (e.json && typeof e.json === 'object') out.expect.json = e.json;
  } else {
    out.host = String(t.host || '127.0.0.1');
    out.port = toInt(t.port, 0);
  }
  return out;
}

function validate(config) {
  if (!(config.port > 0 && config.port < 65536)) {
    throw new Error('STATUS_MONITOR_PORT must be a port between 1 and 65535, got ' + config.port);
  }
  const seen = new Set();
  for (const t of config.targets) {
    if (seen.has(t.id)) throw new Error('two status targets share the id "' + t.id + '"');
    seen.add(t.id);
    if (t.type === 'tcp' && !(t.port > 0 && t.port < 65536)) {
      throw new Error('target "' + t.id + '" is a tcp check without a valid port');
    }
    if (t.type === 'http' && !t.url) {
      throw new Error('target "' + t.id + '" is an http check without a url');
    }
  }
  if (!config.targets.length) throw new Error('at least one status target is required');
}

// env defaults to process.env; opts.cwd decides where a relative config file resolves.
function loadConfig(env, opts) {
  const e = env || process.env;
  const cwd = (opts && opts.cwd) || process.cwd();

  let fileConfig = {};
  let resolvedFile = '';
  const filePath = String(e.STATUS_MONITOR_CONFIG || '').trim();
  if (filePath) {
    resolvedFile = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    if (!fs.existsSync(resolvedFile)) {
      throw new Error('STATUS_MONITOR_CONFIG points at a file that does not exist: ' + resolvedFile);
    }
    try {
      fileConfig = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'));
    } catch (err) {
      throw new Error('STATUS_MONITOR_CONFIG is not valid JSON (' + resolvedFile + '): ' + err.message);
    }
    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) {
      throw new Error('STATUS_MONITOR_CONFIG must contain a JSON object');
    }
  }

  // env beats file beats default. An empty env var counts as unset, so setting a
  // variable to nothing cannot silently blank a value.
  const pick = (key, envKey, fallback) => {
    const envValue = e[envKey];
    if (envValue !== undefined && String(envValue).trim() !== '') return envValue;
    if (fileConfig[key] !== undefined && fileConfig[key] !== null) return fileConfig[key];
    return fallback;
  };

  const appPort = toInt(e.PORT, DEFAULT_APP_PORT);
  const baseUrl = stripSlash(String(pick('baseUrl', 'STATUS_MONITOR_BASE_URL',
    'http://127.0.0.1:' + appPort)).trim()) || 'http://127.0.0.1:' + appPort;

  let rawTargets = null;
  const envTargets = e.STATUS_MONITOR_TARGETS;
  if (envTargets !== undefined && String(envTargets).trim() !== '') {
    try {
      rawTargets = JSON.parse(envTargets);
    } catch (err) {
      throw new Error('STATUS_MONITOR_TARGETS is not valid JSON: ' + err.message);
    }
  } else if (Array.isArray(fileConfig.targets)) {
    rawTargets = fileConfig.targets;
  }
  if (rawTargets !== null && !Array.isArray(rawTargets)) {
    throw new Error('status targets must be a JSON array');
  }

  const config = {
    host: String(pick('host', 'STATUS_MONITOR_HOST', '127.0.0.1')).trim() || '127.0.0.1',
    port: toInt(pick('port', 'STATUS_MONITOR_PORT', DEFAULT_PORT), DEFAULT_PORT),
    intervalMs: Math.max(1000, toInt(pick('intervalMs', 'STATUS_MONITOR_INTERVAL_MS', 30000), 30000)),
    timeoutMs: Math.max(100, toInt(pick('timeoutMs', 'STATUS_MONITOR_TIMEOUT_MS', 5000), 5000)),
    failureThreshold: Math.max(1, toInt(pick('failureThreshold', 'STATUS_MONITOR_FAILURE_THRESHOLD', 2), 2)),
    recoveryThreshold: Math.max(1, toInt(pick('recoveryThreshold', 'STATUS_MONITOR_RECOVERY_THRESHOLD', 1), 1)),
    slowMs: Math.max(1, toInt(pick('slowMs', 'STATUS_MONITOR_SLOW_MS', 1500), 1500)),
    history: Math.max(1, toInt(pick('history', 'STATUS_MONITOR_HISTORY', 180), 180)),
    title: String(pick('title', 'STATUS_MONITOR_TITLE', 'Trycord status')).trim() || 'Trycord status',
    instance: String(pick('instance', 'STATUS_MONITOR_INSTANCE', e.TRYCORD_INSTANCE_ID || 'local')).trim() || 'local',
    publicUrl: stripSlash(String(pick('publicUrl', 'STATUS_MONITOR_PUBLIC_URL', '')).trim()),
    refreshSeconds: Math.max(0, toInt(pick('refreshSeconds', 'STATUS_MONITOR_REFRESH_SECONDS', 15), 15)),
    corsOrigins: String(pick('corsOrigins', 'STATUS_MONITOR_CORS_ORIGINS', '*')).trim(),
    baseUrl,
    configFile: resolvedFile,
  };

  const list = rawTargets === null ? defaultTargets() : rawTargets;
  config.targets = list.map((t, i) => normalizeTarget(t, i));
  validate(config);
  return config;
}

module.exports = {
  loadConfig,
  normalizeTarget,
  resolveTargetUrl,
  defaultTargets,
  DEFAULT_PORT,
};
