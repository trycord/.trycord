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

// The tag must name the version being built.
//
// This check exists because its absence did: a v1.6.4 tag was pushed while
// package.json still said 1.6.3, so the build produced Trycord-1.6.3.AppImage
// and the release published under a tag claiming 1.6.4. Every other check in
// this file passed, because the artifacts were internally consistent - they
// were simply the wrong version. An updater comparing against those would see
// a downgrade, and a person reading the tag would be misled.
//
// Only enforced when running under Actions, so a local dry-run is not made to
// care about which ref it happens to be on.
if (process.env.GITHUB_REF && /^refs\/tags\/v/.test(process.env.GITHUB_REF)) {
  const tag = process.env.GITHUB_REF.replace('refs/tags/v', '');
  if (tag !== pkgVersion) {
    fail('tag ' + process.env.GITHUB_REF + ' does not match package.json version '
      + pkgVersion + '. Bump package.json to ' + tag + ' before tagging, or tag v'
      + pkgVersion + ' instead - a release must not publish one version under another\'s name.');
  }
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

// Backend-config coherence (Checkpoint D): the production pin must be
// identical everywhere, or the shipped client and the desktop default
// silently point at different backends. backend.json wins over the
// config.js default at runtime, so drift here is a live misroute.
(function checkBackendPin() {
  const clientDir = path.join(root, '..', 'frontend');
  const backendJson = path.join(clientDir, 'backend.json');
  const configJs = path.join(clientDir, 'js', 'config.js');
  if (!fs.existsSync(backendJson)) fail('missing frontend/backend.json (production backend pin)');
  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(backendJson, 'utf8')).backendUrl;
  } catch (e) {
    fail('frontend/backend.json is not valid JSON: ' + (e && e.message ? e.message : e));
  }
  if (!/^https:\/\//i.test(String(pin || '').trim())) {
    fail('frontend/backend.json backendUrl must be an https URL, got: ' + pin);
  }
  let configSrc = '';
  try {
    configSrc = fs.readFileSync(configJs, 'utf8');
  } catch (e) {
    fail('cannot read frontend/js/config.js: ' + (e && e.message ? e.message : e));
  }
  const m = configSrc.match(/DEFAULT_BACKEND_URL\s*=\s*'([^']+)'/);
  if (!m) fail('DEFAULT_BACKEND_URL not found in frontend/js/config.js');
  const norm = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();
  if (norm(pin) !== norm(m[1])) {
    fail(`backend pin drift: backend.json (${pin}) != config.js default (${m[1]})`);
  }
  // The bundled copy the exe actually reads must match the source pin.
  const bundled = path.join(root, 'client', 'backend.json');
  if (fs.existsSync(bundled)) {
    try {
      const bPin = JSON.parse(fs.readFileSync(bundled, 'utf8')).backendUrl;
      if (norm(bPin) !== norm(pin)) {
        fail(`bundled client/backend.json (${bPin}) is stale vs source pin (${pin}) — rerun copy-client`);
      }
    } catch (e) {
      fail('bundled client/backend.json is not valid JSON');
    }
  }
  console.log(`backend pin coherent: ${pin}`);
})();

console.log(`release validation passed: Trycord.exe + TrycordPTB.exe + latest.yml + blockmap, versions agree`);
