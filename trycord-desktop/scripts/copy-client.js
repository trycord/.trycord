// Copy ../trycord-client into ./client so dev + packaged builds
// always ship the same single source of truth. ./client is gitignored.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'trycord-client');
const dest = path.join(__dirname, '..', 'client');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('trycord-client not found at ' + src);
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log('client copied to trycord-desktop/client/');

// electron-builder resolves build/icon.{png,ico} by those exact names, so the
// paths in package.json are fixed. Rather than commit a second copy of each
// icon, they are staged from the one canonical source every time a build runs,
// the same way ./client is. build/ stays gitignored.
const build = path.join(__dirname, '..', 'build');
fs.mkdirSync(build, { recursive: true });
for (const [from, to] of [
  ['trycord-logo.png', 'icon.png'],
  ['trycord-logo.ico', 'icon.ico'],
]) {
  const source = path.join(src, 'assets', from);
  if (!fs.existsSync(source)) {
    console.error('missing icon source: ' + source);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(build, to));
}
console.log('icons staged to trycord-desktop/build/');
