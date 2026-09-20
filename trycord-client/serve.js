// Trycord web access point: serves the static client files. That's ALL it does.
// No database, no API routes, no auth, no WebSocket gateway, no server state.
// The browser talks to a configured Trycord instance (see runtime config below).
//
//   HOST=0.0.0.0 PORT=13331 npm run serve
//
// Runtime configuration for the served client (all optional):
//   TRYCORD_API_URL      backend instance, e.g. https://trycord.wispbyte.app
//   TRYCORD_INSTANCE_ID  e.g. official (used to scope per-instance browser data)
//   TRYCORD_GLOBAL_URL   optional global service, e.g. https://trycord.wispbyte.app
// Served as /runtime-config.js and merged into window.TRYCORD_CONFIG.
// Only keys that are actually set are exposed; nothing secret ever goes here.
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '13331', 10);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function runtimeConfigJs() {
  const cfg = {};
  if (process.env.TRYCORD_API_URL) cfg.API_URL = process.env.TRYCORD_API_URL;
  if (process.env.TRYCORD_INSTANCE_ID) cfg.instanceId = process.env.TRYCORD_INSTANCE_ID;
  if (process.env.GLOBAL_TRYCORD_URL !== undefined && process.env.GLOBAL_TRYCORD_URL !== '') {
    cfg.globalUrl = process.env.GLOBAL_TRYCORD_URL;
  }
  return 'window.TRYCORD_CONFIG = Object.assign(window.TRYCORD_CONFIG || {}, ' +
    JSON.stringify(cfg) + ');';
}

function send(res, status, type, body, cache) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache || 'no-cache' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/health') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, accessPoint: 'trycord-client' }));
  }
  if (pathname === '/runtime-config.js') {
    return send(res, 200, 'application/javascript; charset=utf-8', runtimeConfigJs());
  }

  // Static files only. Block path traversal; fall back to index.html for
  // unknown non-API paths (client uses hash routing, so this rarely triggers).
  const safe = path.normalize(pathname).replace(/^([/\\])+/, '');
  let file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) return send(res, 403, 'text/plain', 'forbidden');
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    if (!pathname.startsWith('/api/')) file = path.join(ROOT, 'index.html');
    else return send(res, 404, 'text/plain', 'not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'not found');
    // Entry points are never cached; hashed-agnostic assets revalidate.
    // A stale index.html paired with mismatched JS/CSS renders a blank page.
    const entry = /(^|[\\/])(index\.html|config\.js)$/i.test(file);
    send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', data, entry ? 'no-store' : 'no-cache');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`trycord-client access point at http://${HOST}:${PORT}`);
  console.log('(static files only — configure TRYCORD_API_URL to point at a Trycord instance)');
});
