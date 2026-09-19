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
