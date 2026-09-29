// Removes the `/* ===== title ===== */` section banners and the prose that
// belongs to them.
//
// The rule is deliberately blunt: a banner block is a run of comment lines that
// opens or closes with a line of `=` or `-` rules. Everything in that block goes,
// including any prose under it. Those blocks describe the file's own layout, and
// the layout is visible.
//
// Usage: node scripts/strip-banners.js [--apply]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');

const files = [];
for (const dir of ['trycord-client/js', 'trycord-client/css', 'public/css', 'public/js', 'trycord-server/src']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (/\.(js|css)$/.test(f)) files.push(path.join(abs, f));
  }
}

let removed = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const isRule = /^[=*\s-]*[=*][=*\s-]*$/.test(t) || /^\/\*[=*\s-]*[=*]/.test(t);
    if (!isRule) { out.push(lines[i]); continue; }

    // Walk the whole comment block, dropping it entirely.
    const block = [];
    let j = i;
    if (!lines[j].includes('*/')) {
      for (; j < lines.length && !lines[j].includes('*/'); j++) block.push(lines[j]);
      if (j < lines.length) block.push(lines[j]);
    } else {
      block.push(lines[j]);
    }
    const body = block.join('\n');
    // Single-line dividers too: /* ---- title ---- */
    if (!/[=*]{3,}|-{3,}/.test(body)) { out.push(lines[i]); continue; }
    removed++;
    i = j;
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (APPLY && text !== src) fs.writeFileSync(file, text, 'utf8');
}

console.log(`${files.length} file(s) scanned`);
console.log(`section banner(s) removed: ${removed}`);
if (!APPLY) console.log('nothing written. Re-run with --apply to rewrite.');
