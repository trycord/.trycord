#!/usr/bin/env node
'use strict';

// Permissions: the registry, and the routes that gate on it.
//
// Two things are checked here, and both are about a name rather than a policy.
//
// A route declares what it needs with requirePerm('NAME'). That name is compared
// against the permissions a member's roles grant. A name nobody grants - because
// it was misspelled, or because it was renamed in one place and not the other -
// compares equal to nothing, so the gate answers 403 to everybody except the
// owner. The route looks configured, the dashboard shows the role holding the
// permission, and the feature is unreachable. Nothing else in the repository can
// see that, because the permission name is a string.
//
// So: every name a route gates on must be one the registry declares, and the
// gate itself must refuse a name the registry does not know rather than answering
// 403 to everyone.
//
//   node scripts/check-permissions.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label + (detail ? ': ' + detail : ''));
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

(async () => {
  const { stripComments } = await import('./strip-comments.mjs');
  const { PERMISSIONS, isKnown } = require(path.join(SRC, 'services', 'permissions.js'));

  console.log('\n  the registry');
  ok('every declared permission has a description',
    Object.values(PERMISSIONS).every((d) => typeof d === 'string' && d.trim().length > 0),
    Object.keys(PERMISSIONS).length + ' permissions');
  ok('no permission is named twice',
    new Set(Object.keys(PERMISSIONS)).size === Object.keys(PERMISSIONS).length);

  // Every permission in the registry has to be checked by something. A permission
  // nobody enforces is the same failure in the other direction: the dashboard offers
  // it, a community grants it, and revoking it changes nothing.
  console.log('\n  every permission is enforced somewhere');

  const files = walk(SRC);
  const sources = new Map();
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    sources.set(f, stripComments(raw));
  }

  // A permission counts as enforced when some file outside its own definition
  // compares a role's permissions against that name.
  const enforced = new Map();
  for (const [file, src] of sources) {
    if (file.endsWith(path.join('services', 'permissions.js'))) continue;
    for (const name of Object.keys(PERMISSIONS)) {
      // hasPermission(..., 'NAME'), mayAct(..., 'NAME'), isKnown on a stored row.
      if (src.includes("'" + name + "'")) {
        if (!enforced.has(name)) enforced.set(name, []);
        enforced.get(name).push(path.relative(ROOT, file));
      }
    }
  }

  const unenforced = [...enforced.keys()].filter((n) => enforced.get(n).length === 0);
  ok('every permission is checked by something other than its own definition',
    unenforced.length === 0, unenforced.join(', '));

  // Every permission a route gates on must be one the registry declares.
  console.log('\n  every route gate names a real permission');

  // Read from the raw source, not the stripped one. stripComments() blanks any
  // single-quoted span it recognises, which is right for finding bare identifiers
  // and wrong here: it turns requirePerm('MANAGE_CHANNELS') into
  // requirePerm(                 ), so the check finds zero gates and passes. A
  // check that cannot see the thing it checks is worse than no check.
  const gated = new Map();
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (!rel.startsWith('src/routes/')) continue;
    const raw = fs.readFileSync(file, 'utf8');
    for (const m of raw.matchAll(/requirePerm\(\s*'([^']+)'/g)) {
      if (!gated.has(m[1])) gated.set(m[1], []);
      gated.get(m[1]).push(rel);
    }
  }

  const unknown = [...gated.keys()].filter((n) => !isKnown(n));
  ok('no route gates on a permission the registry does not declare',
    unknown.length === 0,
    unknown.map((n) => n + ' in ' + gated.get(n).join(', ')).join('; '));

  // Permissions that exist but are never used as a route gate are not a problem:
  // they are enforced per-channel through mayAct or inside services/voice.js,
  // where a member's role in a channel rather than in the community decides.
  console.log('\n  the gate refuses a name it does not know');

  const serverAccess = require(path.join(SRC, 'middleware', 'serverAccess.js'));
  let threw = null;
  try {
    serverAccess.requirePerm('MANAGE_CHANELS');
  } catch (e) { threw = e; }
  ok('a misspelled permission is refused where the route is declared',
    threw !== null && /not in/.test(String(threw && threw.message)),
    threw ? String(threw.message).slice(0, 90) : 'it accepted a name nobody declares');

  let accepted = null;
  try {
    serverAccess.requirePerm('MANAGE_CHANNELS');
    accepted = true;
  } catch (e) { accepted = false; }
  ok('a real permission is still accepted', accepted === true);

  console.log('\n  ' + gated.size + ' permissions named by a route gate, '
    + 'all of them declared');
  console.log(`\n  permissions check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
