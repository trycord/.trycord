// Release gate: verifies the local electron-builder output is a coherent,
// publishable update set BEFORE anything is published. Version numbers are
// deliberately absent from public artifact names (the product is Trycord; the
// internal version only lives in update metadata).
//
// Windows (win32):
//   - Windows NSIS installer exists:  release/Trycord.exe
//   - public test build exists:        release/TrycordPTB.exe
//   - update metadata exists:          release/latest.yml
//   - blockmap exists:                 release/Trycord.exe.blockmap
//   - latest.yml version matches package.json
//   - latest.yml references an installer file that actually exists
// Linux:
//   - AppImage exists + latest-linux.yml exists and versions agree.
//
// Exit 0 = publishable. Exit 1 = do NOT publish.
const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error('release validation FAILED: ' + msg);
  process.exit(1);
}

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');

let pkgVersion;
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  pkgVersion = require(path.join(root, 'package.json')).version;
} catch (e) {
  fail('cannot read package.json version: ' + (e && e.message ? e.message : e));
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(pkgVersion))) {
  fail('package.json version is not semver: ' + pkgVersion);
}

const installerName = 'Trycord.exe';
const installerPath = path.join(releaseDir, installerName);
  const ptbName = 'TrycordPTB.exe';
const ptbPath = path.join(releaseDir, ptbName);
const metaName = process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml';

function checkWin() {
  if (!fs.existsSync(installerPath)) {
    fail('missing installer: release/' + installerName);
  }
  if (!fs.existsSync(ptbPath)) {
    fail('missing public test build: release/' + ptbName);
  }
}

function checkLinux() {
  const matches = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter((f) => f.endsWith('.AppImage'))
    : [];
  if (!matches.length) fail('missing AppImage in release/');
  return matches;
}
const metaPath = path.join(releaseDir, metaName);
if (process.platform === 'linux') {
  checkLinux();
} else {
  checkWin();
}
if (!fs.existsSync(metaPath)) {
  fail('missing update metadata: release/' + metaName + ' (do not publish without it)');
}

if (process.platform !== 'linux') {
  const blockmapPath = installerPath + '.blockmap';
  if (!fs.existsSync(blockmapPath)) {
    fail('missing blockmap: release/' + installerName + '.blockmap');
  }
}

// Minimal latest.yml parse (flat keys + files list). electron-builder writes:
//   version: 1.5.0
//   files:
//     - url: Trycord.exe
//       sha512: ...
//       size: 123
//   path: Trycord.exe
//   sha512: ...
const meta = fs.readFileSync(metaPath, 'utf8');
function field(name) {
  const m = meta.match(new RegExp('^' + name + ':\\s*(.+?)\\s*$', 'm'));
  return m ? m[1] : null;
}
const metaVersion = field('version');
if (metaVersion !== String(pkgVersion)) {
  fail(`${metaName} version (${metaVersion}) does not match package.json (${pkgVersion})`);
}
const metaPath_ = field('path');
if (!metaPath_) fail(metaName + ' has no path field');
if (!field('sha512')) fail(metaName + ' has no sha512 field');
if (process.platform === 'linux') {
  const appImages = checkLinux();
  if (!appImages.some((f) => f.replace(/ /g, '-') === metaPath_ || f === metaPath_)) {
    fail(`${metaName} path (${metaPath_}) does not reference a built AppImage (${appImages.join(', ')})`);
  }
  console.log(`release validation passed: ${appImages.join(', ')} + ${metaName}, versions agree`);
  return;
}
// electron-builder keeps the versionless artifact name in the metadata path.
const expectedPath = installerName;
if (metaPath_ !== expectedPath) {
  fail(`latest.yml path (${metaPath_}) does not reference the installer (${expectedPath})`);
}

console.log(`release validation passed: Trycord.exe + TrycordPTB.exe + latest.yml + blockmap, versions agree`);
