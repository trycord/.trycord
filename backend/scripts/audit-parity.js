// Audit parity between backend HTTP routes and frontend client methods.
// Run: node backend/scripts/audit-parity.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const mounts = [
  { base: '/api/auth', file: 'auth' },
  { base: '/api/users', file: 'users' },
  { base: '/api/servers/:serverId/channels', file: 'channels' },
  { base: '/api/servers/:serverId/categories', file: 'categories' },
  { base: '/api/servers/:serverId/roles', file: 'roles' },
  { base: '/api/servers/:serverId/invites', file: 'invites', exportName: 'managed' },
  { base: '/api/servers/:serverId/communityMemory', file: 'communityMemory' },
  { base: '/api/channels/:channelId/messages', file: 'messages' },
  { base: '/api', file: 'attachments' },
  { base: '/api/servers', file: 'servers' },
  { base: '/api/servers/:serverId', file: 'integrations' },
  { base: '/api/invites', file: 'invites', exportName: 'byCode' },
  { base: '/api/discover', file: 'discover' },
  { base: '/api/activity', file: 'activity' },
  { base: '/api/dms', file: 'dms' },
  { base: '/api/bot', file: 'bot' },
  { base: '/api/friends', file: 'friends' },
  { base: '/api/notifications', file: 'notifications' },
  { base: '/api/search', file: 'search' },
  { base: '/api/reports', file: 'reports' },
  { base: '/api/appeals', file: 'appeals' },
  { base: '/api/account', file: 'accountDeletion' },
  { base: '/api/admin', file: 'admin' },
  { base: '/api/admin/pages', file: 'adminPages' },
  { base: '/api/admin/settings', file: 'settings' },
  { base: '/api/admin/database', file: 'database' },
  { base: '/api/admin/mail', file: 'mail' },
  { base: '/api/me', file: 'privacy' },
  { base: '/api/me', file: 'export' },
  { base: '/api/mutes', file: 'mutes' },
  { base: '/api/voice', file: 'voice' },
  { base: '/api/announcements', file: 'announcements' },
];

function norm(p) {
  return p.replace(/:[A-Za-z_]+/g, ':p').replace(/\$\{[^}]+\}/g, ':p').replace(/\/+$/, '') || '/';
}

const endpoints = new Set();
function addEndpoint(method, url) {
  endpoints.add(method.toUpperCase() + ' ' + norm(url));
}

const serverSrc = fs.readFileSync(path.join(ROOT, 'backend/src/server.js'), 'utf8');
for (const m of serverSrc.matchAll(/app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
  addEndpoint(m[1], m[2]);
}

function walkRouter(router, base, seen) {
  if (!router || !router.stack || seen.has(router)) return;
  seen.add(router);
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        const rp = layer.route.path;
        const url = base + (rp === '/' ? '' : rp);
        addEndpoint(method, url);
      }
    } else if (layer.handle && layer.handle.stack) {
      let subBase = base;
      if (typeof layer.path === 'string') subBase = base + layer.path;
      walkRouter(layer.handle, subBase, seen);
    }
  }
}

for (const mt of mounts) {
  const mod = require(path.join(ROOT, 'backend/src/routes', mt.file));
  const router = mt.exportName ? mod[mt.exportName] : (mod.router || mod.default || mod);
  walkRouter(router, mt.base, new Set());
}

const contMod = require(path.join(ROOT, 'backend/src/routes/continuum'));
const contRouter = contMod.router || contMod.default || contMod;
walkRouter(contRouter, '', new Set());
{
  const src = fs.readFileSync(path.join(ROOT, 'backend/src/routes/continuum.js'), 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    addEndpoint(m[1], m[2]);
  }
}

// Client parse
const apiSrc = fs.readFileSync(path.join(ROOT, 'frontend/packages/api.js'), 'utf8');
const clientMethods = new Map();
const alines = apiSrc.split('\n');
let currentKey = null;
for (const line of alines) {
  const km = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:\(|[^=]*=>)/);
  if (km) currentKey = km[1];
  const req = line.match(/request\(\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")/);
  if (req && currentKey) {
    const url = req[2] || req[3] || req[4];
    const sig = req[1] + ' ' + norm(url.split('?')[0]);
    if (!clientMethods.has(currentKey)) clientMethods.set(currentKey, sig);
  }
}

function splitSig(sig) { const i = sig.indexOf(' '); return [sig.slice(0,i), sig.slice(i+1)]; }
function clientCoversBackend(clientSig, backendSig) {
  const [cm, cu] = splitSig(clientSig);
  const [bm, bu] = splitSig(backendSig);
  if (cm !== bm) return false;
  const c = cu.replace(/\/+$/, '');
  if (c === bu) return true;
  return bu.startsWith(c + '/');
}
const backendArr = [...endpoints];
const clientArr = [...new Set(clientMethods.values())];

const backendWithoutClient = backendArr.filter((b) => !clientArr.some((c) => clientCoversBackend(c, b))).sort();
const clientWithoutBackend = clientArr.filter((c) => !backendArr.some((b) => clientCoversBackend(c, b))).sort();

const report = {
  backendEndpointCount: backendArr.length,
  clientMethodCount: clientMethods.size,
  clientUniqueSignatures: clientArr.length,
  backendWithoutClientCount: backendWithoutClient.length,
  clientWithoutBackendCount: clientWithoutBackend.length,
  backendWithoutClient,
  clientWithoutBackend,
  clientMethods: Object.fromEntries(clientMethods),
};

const outDir = '/tmp/opencode';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'parity-report.json'), JSON.stringify(report, null, 2));

let md = '# Backend ↔ Frontend parity report\n\n';
md += '- Backend endpoints: ' + report.backendEndpointCount + '\n';
md += '- Client methods (unique signatures): ' + report.clientUniqueSignatures + ' (' + clientMethods.size + ' named)\n';
md += '- Backend endpoints with no client consumer: ' + report.backendWithoutClientCount + '\n';
md += '- Client signatures with no backend endpoint (dead calls): ' + report.clientWithoutBackendCount + '\n\n';
md += '## Client signatures with no matching backend endpoint (dead/wrong)\n';
for (const e of clientWithoutBackend) md += '- ' + e + '\n';
md += '\n## Backend endpoints with no client consumer (UI gaps / internal)\n';
for (const e of backendWithoutClient) md += '- ' + e + '\n';
fs.writeFileSync(path.join(outDir, 'parity-report.md'), md);
console.log('backend endpoints:', report.backendEndpointCount);
console.log('client methods:', clientMethods.size, 'unique sigs:', clientArr.length);
console.log('backend w/o client:', report.backendWithoutClientCount);
console.log('client w/o backend:', report.clientWithoutBackendCount);
console.log('--- dead client signatures ---');
console.log(clientWithoutBackend.join('\n'));
console.log('--- backend gaps (first 40) ---');
console.log(backendWithoutClient.slice(0, 40).join('\n'));
process.exit(0);
