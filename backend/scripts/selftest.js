// Power-On Self Test (POST): one entry point that runs every check in the
// chain and reports a single pass/fail. This file IS the chain's single source
// of truth; `npm run check` and the optional startup hook both invoke it.
//
// Run: node backend/scripts/selftest.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');

const steps = [
  'node scripts/check.js',
  'node scripts/check-routes.js',
  'node scripts/check-schema-parity.js',
  'node scripts/check-mount.js',
  'node scripts/check-settings-wiring.js',
  'node scripts/check-settings-precedence.js',
  'node scripts/check-database-config.js',
  'node scripts/check-moderation.js',
  'node scripts/check-public-site.js',
  'node scripts/check-server-routes.js',
  'node scripts/check-server-bindings.js',
  'node scripts/check-client-modules.js',
  'node scripts/check-frontend-modules.js',
  'node scripts/check-chooser.js',
  'node scripts/check-backend-agnostic.js',
  'node scripts/check-client-bindings.js',
  'node scripts/check-client-load.js',
  'node scripts/check-sibling-bindings.js',
  'node scripts/check-singletons.js',
  'node scripts/check-client-headings.js',
  'node scripts/check-client-registry.js',
  'node scripts/check-origins.js',
  'node scripts/check-contrast.js',
  'node scripts/check-client-styles.js',
  'node scripts/check-brand.js',
  'node scripts/check-workflows.js',
  'node scripts/check-doc-counts.js',
  'node scripts/check-require-aliases.js',
  'node scripts/check-crash-screen.js',
  'node scripts/check-signin.js',
  'node scripts/check-desktop-shell.js',
  'node scripts/check-layout.js',
  'node scripts/check-mobile-layout.js',
  'node scripts/check-mail.js',
  'node scripts/verify-mail-admin.js',
  'node scripts/check-events.js',
  'node scripts/check-permissions.js',
  'node scripts/check-loads.js',
  'node scripts/check-status-monitor.js',
  'node scripts/check-jobs.js',
  'node scripts/check-continuum.js',
];

function parseStep(step) {
  const parts = step.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

console.log('=== Trycord Power-On Self Test ===');
console.log('steps:', steps.length);
console.log('');

let passed = 0;
let failed = 0;
const failures = [];
const start = Date.now();

for (const step of steps) {
  const { cmd, args } = parseStep(step);
  const label = args.join(' ');
  const t0 = Date.now();
  const res = spawnSync(cmd, args, { cwd: BACKEND, encoding: 'utf8', timeout: 300000 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = res.status === 0;
  if (ok) { passed++; console.log('  PASS  ' + label + '  (' + dt + 's)'); }
  else {
    failed++;
    failures.push(label);
    console.log('  FAIL  ' + label + '  (' + dt + 's)');
    if (res.stderr) console.log(res.stderr.split('\n').slice(-12).join('\n'));
    if (res.stdout) console.log(res.stdout.split('\n').slice(-12).join('\n'));
  }
}

const total = ((Date.now() - start) / 1000).toFixed(1);
console.log('');
console.log('=== POST summary ===');
console.log('passed: ' + passed + '/' + steps.length + '   failed: ' + failed + '   time: ' + total + 's');
if (failures.length) {
  console.log('failures:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failed === 0 ? 0 : 1);

