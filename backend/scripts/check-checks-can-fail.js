#!/usr/bin/env node
'use strict';

// Proves each check can fail, by breaking the thing it guards.
//
// A check that passes because it found nothing is indistinguishable from a check that
// passes because it is looking at the wrong file. That is not hypothetical here: an
// unanchored `uploads/` rule in .gitignore kept four of the uploads service's five
// modules out of every clone, and the whole static suite stayed green, because every
// check read the working copy and the working copy had all the files. Nothing in the
// suite could have told me the repository was missing part of the server.
//
// So each check below is run three times against a copy of the tree: once unmodified,
// which must pass; once with one thing broken, which must fail with a message naming the
// breakage; and once more after that is reverted, which must pass again. A check that
// stays green with its guard removed is deleted, not kept - a check nobody can trust is
// worse than no check, because it counts as coverage.
//
// The copy is made under the temp directory and the working copy is never touched, so a
// run that dies mid-way leaves nothing behind to clean up.
//
//   node scripts/check-checks-can-fail.js            # all of them
//   node scripts/check-checks-can-fail.js contrast   # just one, by substring

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const ONLY = process.argv.slice(2);

const NOTIFICATIONS = 'frontend/js/global/notifications.js';

// Each case names the file it edits, so the run can put that file back exactly as it was
// without having to work out afterwards which file a closure happened to have touched.
const CASES = [
  { script: 'check-client-styles', file: NOTIFICATIONS,
    guards: 'a class the client emits and the stylesheet does not style',
    break: (f) => append(f, '\nexport function __probe() { return el("div", { class: \'zzz-no-such-rule\' }); }\n'),
    word: 'zzz-no-such-rule' },

  { script: 'check-client-bindings', file: NOTIFICATIONS,
    guards: 'a borrowed name that was never imported',
    // renderPrivacySocial is exported by exactly one module (account/privacy.js) and
    // notifications.js does not import it, which is the shape the check is for: a name
    // used in a module that neither defines it nor imports it.
    // Two shapes of the same fault, because the check answers two questions. The first
    // borrows a name one module owns; the second calls a name nobody exports at all,
    // which is the case the second rule exists for.
    break: (f) => append(f, '\nexport function __probe() { return renderPrivacySocial; }\n'
      + 'export function __probe2() { return nothingDefinesThis(); }\n'),
    word: 'nothingDefinesThis' },

  { script: 'check-sibling-bindings', file: 'frontend/js/shell/sidebar.js',
    guards: 'a sibling module used through a bare name',
    break: (f) => append(f, '\nexport function __probe() { return WIDTH; }\n'),
    word: 'WIDTH' },

  { script: 'check-require-aliases', file: 'backend/src/services/slugs.js',
    guards: 'a require of a name the module does not export',
    // Single quotes, because that is what every require in this repository uses and what
    // the check's pattern matches. A double-quoted probe is invisible to it, which is
    // how this case passed for two runs before anyone noticed.
    break: (f) => append(f, "\nconst { notAThingAtAll } = require('./roles');\n"),
    word: 'notAThingAtAll' },

  { script: 'check-contrast', file: 'frontend/css/app.css',
    guards: 'a token pair below the contrast floor',
    // Every theme has its own --t-txt and the check walks all of them, so one is not
    // enough: the first declaration alone still leaves six themes passing.
    break: (f) => replaceAll(f, /(--t-txt:\s*)#[0-9a-f]{3,6}/gi, (m, a) => a + '#4a4a4a'),
    word: 'against' },

  { script: 'check-client-headings', file: 'frontend/js/pages/handlers.js',
    guards: 'a surface that emits its own h1 beside the context header',
    break: (f) => append(f,
      "\nexport function __probe(container) {\n  container.appendChild(el('h1', { text: 'Probe' }));\n  renderContextHeader(container, { title: 'Probe' });\n}\n"),
    word: 'h1' },

  { script: 'check-origins', file: 'backend/src/origins.js',
    guards: 'a pattern that would match an origin it should not',
    // The check imports originCovers and asks it questions, so the breakage has to change
    // what that function decides rather than add a constant nothing reads. Re-enabling
    // the bare star is the failure the check calls out by name.
    break: (f) => replaceIn(f, /if \(pattern === '\*'\) return false;/,
      "if (pattern === '*') return true;"),
    word: 'bare star' },

  { script: 'check-client-registry', file: 'frontend/js/pages/registry.js',
    guards: 'a page registered without a route',
    // PAGES is what the check imports, so the probe has to join that array - an exported
    // constant nothing reads would not be seen by anything.
    break: (f) => append(f, "\nPAGES.push({ id: '__probe', scope: 'me', render: () => {} });\n"),
    word: 'route' },

  { script: 'check-server-bindings', file: 'backend/src/services/sessions.js',
    guards: 'a name a server module calls and nothing defines',
    // The exact live bug this rule found: services/sessions.js was split out of
    // services/privacy.js and left calling newRef, which had stayed behind. It threw on
    // every login inside a .catch() that logs and carries on, so sessions silently stopped
    // being recorded and nothing else noticed.
    break: (f) => replaceIn(f, /db\.newRef\('last_seen_at'\)/, "newRef('last_seen_at')"),
    word: 'newRef' },

  { script: 'check-server-bindings', file: 'backend/src/services/slugs.js',
    guards: 'a name used bare that only one module in the tree exports',
    // The check tracks exported names, not module basenames, and skips anything preceded
    // by a dot - so `memberships.isTimedOut` is invisible to it and `clientLink` used
    // bare is exactly what it is looking for. clientLink is exported by auth/mail.js
    // alone, and slugs.js neither defines nor imports it.
    break: (f) => append(f, '\nfunction __probe() { return clientLink; }\n'),
    word: 'clientLink' },

  { script: 'check-singletons', file: 'frontend/js/global/notifications.js',
    guards: 'a capitalised name used as an object with nothing importing it',
    // The check looks for `Name.member` where Name is capitalised and unbound in that
    // file. It is not about `new` - a module cannot reach a service at all if it never
    // imported one, and that is a boot failure, not a second copy.
    break: (f) => append(f, '\nexport function __probe() { return UnimportedThing.state; }\n'),
    word: 'UnimportedThing' },

  { script: 'check-server-routes', file: 'backend/src/routes/mutes.js',
    guards: 'a route registered twice',
    // The pattern matches router.get('/x') with a single-quoted literal, so a duplicate
    // has to be spelled exactly as the live one is or the check never sees it.
    break: (f) => append(f, "\nrouter.get('/', requireVerified, async (req, res) => res.json([]));\n"),
    word: 'duplicate' },

  { script: 'check-routes', file: 'frontend/js/pages/registry.js',
    guards: 'a client route the server would not treat as an application route',
    break: (f) => append(f,
      "\nPAGES.push({ id: '__probe', route: '/app/__probe', scope: 'me', render: () => {} });\n"),
    word: 'route' },

  { script: 'check-client-load', file: 'frontend/js/global/notifications.js',
    guards: 'a module that does not load',
    // Throwing at module scope is the failure it exists for: every source check reads
    // this file and finds it fine, and the application dies on it.
    break: (f) => append(f, '\nthrow new Error("__probe: this module does not load");\n'),
    word: 'load' },

  { script: 'check-workflows', file: '.github/workflows/check.yml',
    guards: 'a workflow job that runs npm without installing first',
    // Exactly the failure that made this check necessary: a job with npm run and no
    // install, which is a red tick every push and reads as a broken product.
    break: (f) => removeStep(f, 'Install server dependencies'),
    word: 'installs' },

  { script: 'check-client-modules', file: 'frontend/js/global/notifications.js',
    guards: 'a client import that does not resolve',
    break: (f) => append(f, "\nimport { nothingHere } from './no-such-module.js';\n"),
    word: 'no-such-module' },

  { script: 'check', file: 'backend/src/db/schema.js',
    guards: 'an index the schema declares but never creates',
    // check.js applies the schema to a throwaway database and then looks for the critical
    // index names, so the two have to disagree for it to see anything.
    break: (f) => replaceIn(f, /'CREATE INDEX idx_messages_channel ON/, "'CREATE INDEX idx__probe ON"),
    word: 'idx_messages_channel' },

  { script: 'check-signin', file: 'backend/src/routes/auth/issued.js',
    guards: 'a sign-in that does not return a token',
    // The shape is Object.assign, not a literal, so the token has to be dropped from the
    // object it is merged into. This is the file whose missing export made every login
    // 500, so it is worth having under test permanently.
    break: (f) => replaceIn(f, /return res\.json\(Object\.assign\(\{\n    token,/,
      'return res.json(Object.assign({\n    token: undefined,'),
    word: 'token' },

  // Reads the committed pre-split file, so it needs the repository and not a copy.
  { script: 'check-split-loses', file: 'frontend/js/theme/registry.js',
    needsHistory: true,
    guards: 'a module-scope declaration that no split file carries',
    // Only a name that was *there* and is now gone counts: the check compares the
    // committed pre-split theme.js against the directory it became, so adding one proves
    // nothing and neither does touching a split the pre-split file never had. It also
    // Deleting the whole line, not just the export keyword: the name is still declared
    // either way, and the remaining two uses of it below are references, not
    // declarations, so only removing it counts as a loss.
    break: (f) => replaceIn(f, /^export const DEFAULT_THEME = .*\n/m, ''),
    word: 'DEFAULT_THEME' },

  { script: 'check-crash-recovery', file: 'frontend/js/crash.js',
    guards: 'a stale module graph with nothing that recovers from it',
    // Dropping the arm is the real defect: without it the one-shot guard can never fire,
    // so a stale graph reloads forever and the reader never sees the crash screen. The
    // check names this exact behaviour in its first assertion.
    // The whole recoverFromStaleGraph body, which is what the six assertions are about.
    break: (f) => replaceIn(f, /function recoverFromStaleGraph\(text\) \{[\s\S]*?\n  \}\n/,
      'function recoverFromStaleGraph(text) {\n    return false;\n  }\n'),
    word: 'one-shot' },
];

function run(dir, script) {
  const r = spawnSync(process.execPath, [path.join('scripts', script + '.js')], {
    cwd: path.join(dir, 'backend'),
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function tail(out, n = 1) {
  return out.trim().split('\n').slice(-n).join(' | ').trim();
}

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-checks-'));
process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* gone */ } });
// node_modules is thousands of files and no check here should be reading it, so it is
// excluded from the copy and a link put back in its place.
spawnSync('sh', ['-c',
  'tar -cf - --exclude=backend/node_modules -C "$1" backend frontend .github | tar -xf - -C "$2"',
  'sh', REPO, work], { stdio: 'inherit' });
fs.symlinkSync(path.join(REPO, 'backend', 'node_modules'), path.join(work, 'backend', 'node_modules'));

const cases = CASES.filter((c) => !ONLY.length || ONLY.some((n) => c.script.includes(n)));
if (!cases.length) {
  console.error('  no check matches ' + ONLY.join(' '));
  process.exit(2);
}
console.log(`\n  ${cases.length} check(s), against a copy at ${work}\n`);

for (const c of cases) {
  // A check that reads git history cannot run against a copy - there is no .git there,
  // which is how check-split-loses came to pass on nothing at all. Those run in the
  // working copy with the file put back afterwards, which is the one thing this harness
  // does that could leave something behind if it were killed mid-run.
  const dir = c.needsHistory ? REPO : work;
  const target = path.join(dir, c.file);
  if (!fs.existsSync(target)) {
    ok(c.script + ': the file it breaks exists', false, c.file);
    continue;
  }
  const saved = fs.readFileSync(target, 'utf8');

  const clean = run(dir, c.script);
  ok(`${c.script}: passes on the tree as committed`, clean.code === 0,
    'exit ' + clean.code + '  ' + tail(clean.out));

  try {
    c.break(target);
    const broken = run(dir, c.script);
    ok(`${c.script}: fails when there is ${c.guards}`, broken.code !== 0,
      'still exit 0, so it is not looking at ' + c.file);
    ok(`${c.script}: and names it, mentioning ${c.word}`,
      broken.out.toLowerCase().includes(c.word.toLowerCase()),
      'failed without saying why:\n      ' + tail(broken.out, 3));
  } finally {
    fs.writeFileSync(target, saved, 'utf8');
  }

  const after = run(dir, c.script);
  ok(`${c.script}: green again once the breakage is reverted`, after.code === 0,
    'exit ' + after.code + '  ' + tail(after.out));
}

console.log(failures
  ? `\n  checks-can-fail FAILED - ${failures} assertion(s)\n`
  : '\n  checks-can-fail passed - every check here fails when the thing it guards is broken\n');
process.exit(failures ? 1 : 0);

function append(f, text) { fs.appendFileSync(f, text, 'utf8'); }
/**
 * Delete one step: everything from the `- name:` line that starts it up to the next
 * `- name:` line. Named by a prefix of the step name, because matching the whole line
 * means renaming a step breaks the harness in a way that looks like the check failing.
 */
function removeStep(f, name) {
  const s = fs.readFileSync(f, 'utf8');
  const start = s.indexOf('      - name: ' + name);
  if (start === -1) throw new Error('no step named ' + name + ' in ' + f);
  const end = s.indexOf('\n      - name: ', start + 1);
  fs.writeFileSync(f, s.slice(0, start) + (end === -1 ? '' : s.slice(end + 1)), 'utf8');
}
function replaceAll(f, re, fn) {
  const s = fs.readFileSync(f, 'utf8');
  const n = (s.match(re) || []).length;
  if (!n) throw new Error('the pattern this case relies on has moved: ' + re);
  fs.writeFileSync(f, s.replace(re, fn), 'utf8');
}
function replaceIn(f, re, fn) {
  const s = fs.readFileSync(f, 'utf8');
  if (!re.test(s)) throw new Error('the pattern this case relies on has moved: ' + re);
  fs.writeFileSync(f, s.replace(re, fn), 'utf8');
}