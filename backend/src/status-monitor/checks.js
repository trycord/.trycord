'use strict';

// One check, executed.
//
// Two kinds are supported, and they are deliberately the two that cover the real
// topology: an HTTP request (the API and its database are both observable only
// through HTTP routes) and a TCP connect (for a port that should accept a socket).
//
// A check never throws. A network failure is a result with ok:false, not an
// exception, so the scheduler handles one shape and a dead target cannot take the
// monitor down with it.

const http = require('http');
const https = require('https');
const net = require('net');
const { resolveTargetUrl } = require('./config');

const MAX_BODY = 256 * 1024;

// Read a dotted path out of a parsed JSON body: "db" or "a.b.c".
function deepGet(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// null when every expectation holds, or a human-readable reason when one does not.
function jsonMismatch(parsed, expectJson) {
  for (const key of Object.keys(expectJson)) {
    const want = expectJson[key];
    const got = deepGet(parsed, key);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return 'expected ' + key + ' to be ' + JSON.stringify(want) + ', got ' + JSON.stringify(got);
    }
  }
  return null;
}

function httpCheck(target, url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const expect = target.expect || {};
    const acceptable = Array.isArray(expect.status) ? expect.status : [200];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ok: false, ms: Date.now() - started }, result));
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve({ ok: false, ms: 0, error: 'Invalid URL: ' + url });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const requestOptions = { method: target.method || 'GET', headers: target.headers || {} };
    // A self-signed internal endpoint is a real deployment; only an operator who
    // asks for it gets the relaxed TLS check.
    if (parsed.protocol === 'https:' && target.insecure === true) {
      requestOptions.rejectUnauthorized = false;
    }

    const req = lib.request(parsed, requestOptions, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        // Bound the body: a health endpoint is small, and a target that streams
        // forever must not become the monitor's memory problem.
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode;
        if (acceptable.indexOf(status) === -1) {
          return finish({ ok: false, status, error: 'HTTP ' + status + ', wanted ' + acceptable.join(' or ') });
        }
        if (expect.contains !== undefined && body.indexOf(expect.contains) === -1) {
          return finish({ ok: false, status, error: 'Response did not contain ' + JSON.stringify(expect.contains) });
        }
        if (expect.json) {
          let parsedBody;
          try {
            parsedBody = JSON.parse(body);
          } catch (err) {
            return finish({ ok: false, status, error: 'Response was not JSON' });
          }
          const reason = jsonMismatch(parsedBody, expect.json);
          if (reason) return finish({ ok: false, status, error: reason });
        }
        finish({ ok: true, status });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out after ' + timeoutMs + 'ms')));
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.end();
  });
}

function tcpCheck(target, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (socket) { try { socket.destroy(); } catch (err) { /* already gone */ } }
      resolve(Object.assign({ ok: false, ms: Date.now() - started }, result));
    };

    socket = net.connect({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish({ ok: true }));
    socket.on('error', (err) => finish({
      ok: false,
      error: 'Could not reach ' + target.host + ':' + target.port + ': ' + err.message,
    }));
    socket.on('timeout', () => finish({ ok: false, error: 'Timed out after ' + timeoutMs + 'ms' }));
  });
}

// Resolve and run whichever kind of check the target names.
function runCheck(target, opts) {
  const timeoutMs = target.timeoutMs || opts.timeoutMs;
  if (target.type === 'tcp') return tcpCheck(target, timeoutMs);
  return httpCheck(target, resolveTargetUrl(target, opts.baseUrl), timeoutMs);
}

module.exports = { runCheck, httpCheck, tcpCheck, deepGet, jsonMismatch };
