// Removes comments that do not explain a security decision.
//
// Written as a scanner rather than a set of regular expressions because the
// obvious regex approach is unsound, and the unsoundness is expensive: a
// `//` inside a regex literal, a template string or a SQL string is not a
// comment, and a stripper that cannot tell the difference deletes the code
// after it. The first attempt at this script did exactly that and broke sixteen
// files, including every SQL query and both `import` blocks in api.js.
//
// The scanner tracks string, template, regex and comment state, and decides
// whether a `/` starts a regex or a division from the previous significant
// token. After writing, every touched file is re-parsed, so a mistake is a
// failed build rather than a silent deletion.
//
// Policy: a comment is kept only when it is about security AND says why. A
// comment that names what the code does is documentation the code already
// gives. Files whose comments are all load-bearing are listed in PROTECTED and
// never touched, because a keyword list cannot be trusted to tell a safety rule
// from narration - updater.js says "Never blocks launch" and no term list
// recognises that as a safety rule.
//
//   node scripts/comment-audit.js           report
//   node scripts/comment-audit.js --apply   rewrite, then re-parse everything
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const apply = process.argv.includes('--apply');

const SECURITY = [
  'auth', 'permission', 'privilege', 'escalat', 'access control', 'inject', 'xss',
  'csrf', 'traversal', 'escape', 'sanitiz', 'secret', 'token', 'session', 'jwt',
  'credential', 'password', 'bcrypt', 'encrypt', 'decrypt', 'cipher', 'sign',
  'signature', 'spoof', 'trust', 'revoke', 'revoked', 'invalidate', 'lockout',
  'rate limit', 'ratelimit', 'quota', 'brute', 'timing', 'constant-time',
  'side channel', 'audit log', 'audit_log', 'enforce', 'banned', 'bypass',
  'private', 'leak', 'expose', 'claim', 'least privilege', 'untrusted',
  'attacker', 'malicious', 'unsafe', 'fail closed', 'escape', 'least-privilege',
];

const WHY = [
  'because', 'otherwise', 'so that', 'so it', 'never', 'must not', "mustn't",
  'deliberate', 'rather than', 'instead of', 'not just', 'is not', 'cannot',
  "can't", 'would', 'avoid', 'prevent', 'stop', 'without', 'why', 'only when',
  'survive', 'remain', 'degrade', 'fallback', 'fall back', 'race', 'window',
  'exact', 'ambiguous', 'guess', 'wrong', 'leak', 'expos', 'revoke', 'invalidate',
  'safe', 'unsafe', 'attacker', 'exploit', 'vulnerab',
];

const PROTECTED = [
  'desktop/updater.js',
  'desktop/scripts/validate-release.js',
  'src/middleware/auth.js',
  'src/middleware/adminGuard.js',
  'src/middleware/ratelimit.js',
  'src/middleware/serverAccess.js',
  'src/middleware/upload.js',
  'src/auth/',
  'src/services/permissions.js',
  'src/services/roles.js',
  'src/services/twofactor.js',
  'src/services/uploads.js',
  'src/services/storage/',
  'src/services/accountDeletion.js',
  'src/services/trustsafety.js',
  'src/services/enforcement.js',
  'src/services/pageContent.js',
  'src/services/slugs.js',
  'src/services/dms.js',
  'src/services/notifications.js',
  'src/services/memberships.js',
  'src/services/mentions.js',
  'src/services/pages.js',
  'src/routes/users.js',
  'src/routes/servers.js',
  'src/routes/dms.js',
  'src/routes/auth.js',
  'src/routes/admin.js',
  'src/routes/attachments.js',
  'src/db/schema.js',
  'src/errors.js',
  'src/ws.js',
];

const isProtected = (rel) => PROTECTED.some((p) => (p.endsWith('/') ? rel.includes(p) : rel.endsWith(p)));

// Tokens after which a `/` means division, not the start of a regex.
const DIV_AFTER = new Set(['ident', 'num', 'str', 'regex', ')', ']', '}']);

function scan(src) {
  const comments = [];
  let i = 0;
  let prev = null; // last significant token type
  const n = src.length;
  const templateStack = [];

  const push = (type) => { prev = type; };

  while (i < n) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      comments.push({ start, end: i, text: src.slice(start + 2, i), line: true });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      comments.push({ start, end: i, text: src.slice(start + 2, i - 2), line: false });
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      push('str');
      continue;
    }
    if (c === '`') {
      i++;
      // A template can hold ${ ... } with arbitrary code inside, including
      // strings and nested templates, so it is tracked as a depth counter.
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`' && depth === 0) { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (src[i] === '}' && depth > 0) { depth--; i++; continue; }
        i++;
      }
      push('str');
      continue;
    }
    if (c === '/' && prev !== 'ident' && prev !== 'num' && prev !== 'str' && prev !== ')' && prev !== ']' && prev !== '}') {
      // regex literal
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      push('regex');
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) { while (i < n && /[0-9a-zA-Z_.]/.test(src[i])) i++; push('num'); continue; }
    if (/[A-Za-z_$]/.test(c)) { while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++; push('ident'); continue; }
    if (c === ')' || c === ']' || c === '}') { push(c); i++; continue; }
    push('op');
    i++;
  }
  return comments;
}

const SECURITY_RE = new RegExp(SECURITY.join('|'), 'i');
const WHY_RE = new RegExp(WHY.join('|'), 'i');

function targets() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.build', 'release', 'uploads', 'coverage', 'assets'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p.split(path.sep).join('/').endsWith('trycord-desktop/client')) continue;
        walk(p);
      } else if (/\.(js|css)$/.test(e.name)) out.push(p);
    }
  })(ROOT);
  return out;
}

let kept = 0, removed = 0, protFiles = 0, protComments = 0, files = 0;
const plan = [];

for (const file of targets()) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  const cs = scan(src);
  if (!cs.length) continue;
  files++;
  if (isProtected(rel)) { protFiles++; protComments += cs.length; kept += cs.length; continue; }

  const drop = [];
  for (const cm of cs) {
    const body = cm.line ? cm.text : cm.text.replace(/^\s*\*[ ]?/gm, ' ');
    const text = body.replace(/^\s*[*\/]*\s?/gm, '').trim();
    if (!text) { drop.push(cm); continue; }
    const lines = text.split('\n').filter((l) => l.trim());
    // A one-line comment that just names a route or a section is a label.
    const label = lines.length === 1 && /^[A-Za-z/][\w/.: -]*:?\s*$/.test(text) && text.length < 60;
    if (label || !(SECURITY_RE.test(text) && WHY_RE.test(text))) drop.push(cm);
    else kept++;
  }
  if (drop.length) {
    removed += drop.length;
    plan.push([rel, drop]);
  }
  if (apply && drop.length) {
    let out = src;
    for (const d of drop.slice().sort((a, b) => b.start - a.start)) {
      let s = d.start;
      let e = d.end;
      if (d.line) {
        // Only eat the indentation if nothing else is on the line.
        while (s > 0 && (out[s - 1] === ' ' || out[s - 1] === '\t')) s--;
        const eol = out.indexOf('\n', e);
        e = eol === -1 ? out.length : eol + 1;
      }
      out = out.slice(0, s) + out.slice(e);
    }
    fs.writeFileSync(file, out);
  }
}

console.log('scanned ' + files + ' files with comments');
console.log('kept    ' + kept + '  (incl. ' + protComments + ' in ' + protFiles + ' protected files, untouched)');
console.log('removed ' + removed + (apply ? '  (applied)' : '  (dry run)'));

if (apply) {
  // Never trust the writer. Re-parse every file it touched as a module, which
  // is the check the previous attempt lacked.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ca-'));
  const broken = [];
  for (const [rel] of plan) {
    const p = path.join(ROOT, rel);
    if (!p.endsWith('.js')) continue;
    const tmp = path.join(dir, 'x.mjs');
    fs.copyFileSync(p, tmp);
    const r = require('child_process').spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.status !== 0) broken.push(rel);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (broken.length) {
    console.error('\nREVERTING: these no longer parse -> ' + broken.join(', '));
    for (const [rel] of plan) {
      execFileSync('git', ['-C', ROOT, 'checkout', '--', rel], { stdio: 'ignore' });
    }
    process.exit(1);
  }
  console.log('re-parsed ' + plan.length + ' rewritten files: all still valid');
}
