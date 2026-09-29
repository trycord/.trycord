// Removes comments that do not record a security constraint or a non-obvious
// external/dialect quirk. Everything else goes: narration, section banners,
// "this function does X" and restated code.
//
// The house rule: a comment earns its place only when the code cannot say it
// itself, and it must be about safety, a provider's behaviour, a database
// dialect's behaviour, or a deliberate trade-off. This is the mechanical
// half of that rule; the surviving comments are still worth reading by hand.
//
// Only whole-line comments are touched. A trailing comment after code, and
// anything inside a string, a template literal or a regular expression, is left
// exactly as it is, because a line-oriented pass cannot tell those apart.
//
// Usage:
//   node scripts/strip-comments.js           report
//   node scripts/strip-comments.js --apply   rewrite
//   node scripts/strip-comments.js --files a.js b.css
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');

// A comment survives if it is about one of these. The words are deliberately
// narrow: a comment has to be arguing about a risk or an external system's
// behaviour to be worth the bytes.
const KEEP = [
  'security', 'xss', 'csrf', 'ssrf', 'injection', 'inject', 'escape', 'escaped',
  'sanitiz', 'sanitis', 'traversal', 'unauthenticated', 'unauthorised',
  'unauthorized', 'authenticated', 'authorisation', 'authorization',
  'permission', 'privilege', 'escalat', 'credential', 'secret', 'token',
  'bcrypt', 'hash', 'session', 'revok', 'invalidat', 'quota', 'rate limit',
  'rate-limit', 'ratelimit', 'csp', 'content-security', 'cors', 'origin',
  'private', 'public bucket', 'sigv4', 'signature', 'foreign key', 'innodb',
  'sqlite', 'mysql', 'mariadb', 'dialect', 'migration', 'compatib',
  'deprecated', 'workaround', 'gotcha', 'caveat', 'careful', 'deliberate',
  'must not', 'never', 'do not', "don't", 'bypass', 'leak', 'expose',
  'attack', 'vulnerab', 'exploit', 'unsafe', 'trust', 'ownership', 'owner',
  'capability', 'sandbox', 'isolation', 'boundary',
];

function survives(text) {
  const t = text.toLowerCase();
  return KEEP.some((k) => t.includes(k));
}

const fileArg = process.argv.indexOf('--files');
let files;
if (fileArg !== -1) {
  files = process.argv.slice(fileArg + 1).filter((a) => !a.startsWith('--'));
} else {
  files = [];
  for (const dir of ['trycord-client/js', 'trycord-client/css', 'public/css', 'public/js']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/\.(js|css)$/.test(f)) files.push(path.join(abs, f));
    }
  }
}

let removedLines = 0;
let keptComments = 0;
let removedComments = 0;
const survivors = new Map();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const out = [];
  let inBlock = false;
  let block = [];
  let blockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inBlock) {
      block.push(line);
      if (line.includes('*/')) {
        inBlock = false;
        const body = block.join('\n').replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '');
        if (survives(body)) {
          out.push(...block);
          keptComments++;
          survivors.set(file, (survivors.get(file) || 0) + 1);
        } else {
          removedComments++;
          removedLines += block.length;
        }
        block = [];
      }
      continue;
    }

    const t = line.trimStart();
    const indented = line.length - t.length;

    // A block comment that opens and is only followed by its own close.
    if (t.startsWith('/*') && !t.slice(2).includes('*/')) {
      inBlock = true;
      block = [line];
      blockStart = i;
      continue;
    }
    if (t.startsWith('/*') && t.includes('*/')) {
      const body = t.slice(2, t.lastIndexOf('*/'));
      if (survives(body)) {
        out.push(line);
        keptComments++;
        survivors.set(file, (survivors.get(file) || 0) + 1);
      } else {
        removedComments++;
        removedLines += 1;
      }
      continue;
    }
    if (t.startsWith('//')) {
      const body = t.replace(/^\/+\s*/, '');
      if (survives(body)) {
        out.push(line);
        keptComments++;
        survivors.set(file, (survivors.get(file) || 0) + 1);
      } else {
        removedComments++;
        removedLines += 1;
      }
      continue;
    }
    out.push(line);
  }

  if (APPLY) {
    // Collapse the blank-line runs a removal leaves behind, keeping at most one.
    let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
    if (!text.endsWith('\n')) text += '\n';
    if (text !== src) fs.writeFileSync(file, text, 'utf8');
  }
}

console.log(`${files.length} file(s) scanned`);
console.log(`comments removed: ${removedComments} (${removedLines} lines)`);
console.log(`comments kept:    ${keptComments}`);
console.log('\nkept per file:');
for (const [f, n] of [...survivors].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${path.relative(ROOT, f)}`);
}
if (!APPLY) console.log('\nnothing written. Re-run with --apply to rewrite.');
