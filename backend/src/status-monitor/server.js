'use strict';

// The monitor's HTTP surface: a JSON report for machines, an HTML dashboard for a
// person, a liveness endpoint, and Prometheus metrics.
//
// It depends on nothing but Node's http module, so the monitor can be dropped next
// to any deployment and run without installing anything. Every response is read
// from the monitor's own samples; nothing is fabricated.

const http = require('http');

const STATE_LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };
const STATE_CLASS = { up: 'ok', degraded: 'warn', down: 'bad', unknown: 'unknown' };

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeProm(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

// Cross-origin read access. The public site lives on a different origin from the
// monitor, so this is what lets the /status page read the JSON. '*' is the default
// because a status report is public, read-only information; an operator can pin it
// to a list of origins instead.
function corsHeaders(req, config) {
  const allow = String(config.corsOrigins || '').trim();
  if (!allow) return {};
  const headers = {
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (allow === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }
  const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && list.indexOf(origin) !== -1) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function ageSeconds(isoTime) {
  if (!isoTime) return null;
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function humanAge(seconds) {
  if (seconds == null) return 'never';
  if (seconds < 60) return seconds + 's ago';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function prometheus(report) {
  const lines = [];
  lines.push('# HELP trycord_status_up 1 when the last check succeeded, 0 otherwise.');
  lines.push('# TYPE trycord_status_up gauge');
  for (const c of report.components) {
    lines.push('trycord_status_up{target="' + escapeProm(c.id) + '"} '
      + (c.lastCheck && c.lastCheck.ok ? 1 : 0));
  }
  lines.push('# HELP trycord_status_latency_ms Latency of the most recent check, in milliseconds.');
  lines.push('# TYPE trycord_status_latency_ms gauge');
  for (const c of report.components) {
    if (c.latencyMs != null) lines.push('trycord_status_latency_ms{target="' + escapeProm(c.id) + '"} ' + c.latencyMs);
  }
  lines.push('# HELP trycord_status_check_age_seconds Seconds since the most recent check of a target.');
  lines.push('# TYPE trycord_status_check_age_seconds gauge');
  for (const c of report.components) {
    const age = ageSeconds(c.lastCheck && c.lastCheck.at);
    if (age != null) lines.push('trycord_status_check_age_seconds{target="' + escapeProm(c.id) + '"} ' + age);
  }
  lines.push('# HELP trycord_status_availability_ratio Successful checks over the retained sample window (0 to 1).');
  lines.push('# TYPE trycord_status_availability_ratio gauge');
  for (const c of report.components) {
    if (c.window.availability != null) {
      lines.push('trycord_status_availability_ratio{target="' + escapeProm(c.id) + '"} ' + c.window.availability);
    }
  }
  return lines.join('\n') + '\n';
}

function renderHtml(report, config) {
  const rows = report.components.map((c) => {
    const state = STATE_CLASS[c.state] || 'unknown';
    const label = STATE_LABEL[c.state] || 'Unknown';
    const latency = c.latencyMs == null ? '' : c.latencyMs + ' ms';
    const age = humanAge(ageSeconds(c.lastCheck && c.lastCheck.at));
    const details = c.lastError
      ? '\n      <tr class="detail"><td colspan="4">' + escapeHtml(c.lastError) + '</td></tr>'
      : '';
    return '      <tr>\n'
      + '        <th scope="row">' + escapeHtml(c.name) + '</th>\n'
      + '        <td><span class="state state--' + state + '">' + label + '</span></td>\n'
      + '        <td>' + escapeHtml(latency) + '</td>\n'
      + '        <td>' + escapeHtml(age) + '</td>\n'
      + '      </tr>' + details;
  }).join('\n');

  const css = [
    ':root{--bg:#fff;--fg:#1a1a1a;--muted:#5b5b5b;--line:rgba(0,0,0,.12);',
    '--ok-bg:#d9f2df;--ok-fg:#12662a;--warn-bg:#f3e2bd;--warn-fg:#6b4900;',
    '--bad-bg:#f6d3d0;--bad-fg:#8f1e18;--unknown-bg:#ececec;--unknown-fg:#565656}',
    '@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ededed;--muted:#a8a8a8;',
    '--line:rgba(255,255,255,.14);--ok-bg:#14351f;--ok-fg:#7ee2a0;--warn-bg:#3a2f10;',
    '--warn-fg:#f0cf7a;--bad-bg:#3d1b18;--bad-fg:#f2a29b;--unknown-bg:#2b2b2b;--unknown-fg:#c2c2c2}}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);',
    'font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    'main{max-width:780px;margin:0 auto}',
    'h1{font-size:1.4rem;margin:0 0 .25rem}',
    '.sub{margin:0 0 1.5rem;color:var(--muted)}',
    'table{width:100%;border-collapse:collapse}',
    'th,td{text-align:left;padding:.65rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}',
    'thead th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}',
    'tbody th{font-weight:600}',
    'tr.detail td{padding-top:0;font-size:.85rem;color:var(--bad-fg)}',
    '.state{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.75rem;',
    'font-weight:700;text-transform:uppercase;letter-spacing:.04em}',
    '.state--ok{background:var(--ok-bg);color:var(--ok-fg)}',
    '.state--warn{background:var(--warn-bg);color:var(--warn-fg)}',
    '.state--bad{background:var(--bad-bg);color:var(--bad-fg)}',
    '.state--unknown{background:var(--unknown-bg);color:var(--unknown-fg)}',
    '.note{margin-top:1.25rem;color:var(--muted);font-size:.85rem}',
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
  ].join('');

  // A refresh is a meta refresh, not script, so the page works with JavaScript off.
  const refreshMeta = config.refreshSeconds > 0
    ? '\n  <meta http-equiv="refresh" content="' + config.refreshSeconds + '">'
    : '';

  return '<!doctype html>\n'
    + '<html lang="en">\n<head>\n'
    + '  <meta charset="utf-8">\n'
    + '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '  <title>' + escapeHtml(report.title) + '</title>' + refreshMeta + '\n'
    + '  <style>' + css + '</style>\n'
    + '</head>\n<body>\n  <main>\n'
    + '    <h1>' + escapeHtml(report.title) + '</h1>\n'
    + '    <p class="sub">' + escapeHtml(report.instance) + ' &middot; checked every '
    + Math.round(report.intervalMs / 1000) + 's &middot; '
    + '<span class="state state--' + (STATE_CLASS[report.overall] || 'unknown') + '">'
    + (STATE_LABEL[report.overall] || 'Unknown') + '</span></p>\n'
    + '    <table>\n      <thead>\n        <tr><th scope="col">Component</th>'
    + '<th scope="col">State</th><th scope="col">Latency</th><th scope="col">Last check</th></tr>\n'
    + '      </thead>\n      <tbody>\n' + rows + '\n      </tbody>\n    </table>\n'
    + '    <p class="note">Generated ' + escapeHtml(humanAge(ageSeconds(report.generatedAt)))
    + '. Availability is measured over the retained window only, so it describes the last '
    + 'few checks, not a lifetime guarantee. Machine-readable: <code>/status.json</code>.</p>\n'
    + '  </main>\n</body>\n</html>\n';
}

function send(res, status, type, body, headOnly) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': type.indexOf('text/html') === 0 ? 'no-cache' : 'no-store',
  });
  res.end(headOnly ? undefined : body);
}

function createServer(config, monitor) {
  return http.createServer((req, res) => {
    const headers = corsHeaders(req, config);
    for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const headOnly = req.method === 'HEAD';
    if (req.method !== 'GET' && !headOnly) {
      return send(res, 405, 'application/json; charset=utf-8',
        JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } }) + '\n', false);
    }

    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (err) { pathname = '/'; }

    if (pathname === '/health') {
      const started = monitor.startedAt();
      const uptimeSeconds = started ? Math.round((Date.now() - started) / 1000) : 0;
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ ok: true, uptimeSeconds }) + '\n', headOnly);
    }
    if (pathname === '/ready') {
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ ok: true, targets: config.targets.length, startedAt: monitor.report().startedAt }) + '\n',
        headOnly);
    }
    if (pathname === '/status.json') {
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify(monitor.report(), null, 2) + '\n', headOnly);
    }
    if (pathname === '/metrics') {
      return send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', prometheus(monitor.report()), headOnly);
    }
    if (pathname === '/' || pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', renderHtml(monitor.report(), config), headOnly);
    }
    return send(res, 404, 'application/json; charset=utf-8',
      JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No such resource' } }) + '\n', headOnly);
  });
}

module.exports = { createServer, prometheus, renderHtml };
