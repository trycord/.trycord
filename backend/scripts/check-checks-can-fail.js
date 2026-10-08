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
    break: (f) => append(f, '\nexport function __probe() { return renderPrivacySocial; }\n'),
    word: 'renderPrivacySocial' },

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
  'tar -cf - --exclude=backend/node_modules -C "$1" backend frontend | tar -xf - -C "$2"',
  'sh', REPO, work], { stdio: 'inherit' });
fs.symlinkSync(path.join(REPO, 'backend', 'node_modules'), path.join(work, 'backend', 'node_modules'));

const cases = CASES.filter((c) => !ONLY.length || ONLY.some((n) => c.script.includes(n)));
if (!cases.length) {
  console.error('  no check matches ' + ONLY.join(' '));
  process.exit(2);
}
console.log(`\n  ${cases.length} check(s), against a copy at ${work}\n`);

for (const c of cases) {
  const target = path.join(work, c.file);
  if (!fs.existsSync(target)) {
    ok(c.script + ': the file it breaks exists', false, c.file);
    continue;
  }
  const saved = fs.readFileSync(target, 'utf8');

  const clean = run(work, c.script);
  ok(`${c.script}: passes on the tree as committed`, clean.code === 0,
    'exit ' + clean.code + '  ' + tail(clean.out));

  try {
    c.break(target);
    const broken = run(work, c.script);
    ok(`${c.script}: fails when there is ${c.guards}`, broken.code !== 0,
      'still exit 0, so it is not looking at ' + c.file);
    ok(`${c.script}: and names it, mentioning ${c.word}`,
      broken.out.toLowerCase().includes(c.word.toLowerCase()),
      'failed without saying why:\n      ' + tail(broken.out, 3));
  } finally {
    fs.writeFileSync(target, saved, 'utf8');
  }

  const after = run(work, c.script);
  ok(`${c.script}: green again once the breakage is reverted`, after.code === 0,
    'exit ' + after.code + '  ' + tail(after.out));
}

console.log(failures
  ? `\n  checks-can-fail FAILED - ${failures} assertion(s)\n`
  : '\n  checks-can-fail passed - every check here fails when the thing it guards is broken\n');
process.exit(failures ? 1 : 0);

function append(f, text) { fs.appendFileSync(f, text, 'utf8'); }
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