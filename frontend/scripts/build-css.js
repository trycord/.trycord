#!/usr/bin/env node
'use strict';

// Concatenate the CSS layers into the one stylesheet the document loads, and build
// the public site's token layer from the same library.
//
// @import is serialized by specification, so a dozen imports is a dozen dependent
// round trips before the first paint. One <link> to one committed file has no such
// ordering, and a self-hoster serves a working application without running a build.
//
//   node frontend/scripts/build-css.js
//   npm run css

const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'css');
// The Mobile module owns its presentation entirely, so its stylesheet is built
// separately and is never a layer of the desktop one. It shares only the token
// library, prepended here exactly as it is for the desktop build.
const MOBILE_CSS = path.join(__dirname, '..', 'mobile', 'css');
const PUBLIC_CSS = path.join(__dirname, '..', '..', 'public', 'css');
const PUBLIC_ASSETS = path.join(__dirname, '..', '..', 'public', 'assets');
// The canonical design-token library. It is the first layer rather than a copy,
// so a value changed there reaches the application without being duplicated.
const ASSET_TOKENS = path.join(__dirname, '..', 'assets', 'trycord-assets', 'tokens', 'trycord.css');
// The canonical app icons. The public site serves its own copy of these, staged
// here so the copy cannot drift from the library the way a hand-maintained one
// does. `favicon.svg` keeps the path the pages already ask for; the app icon is
// served as `app-icon.svg`, the touch icon the application itself points at.
const ASSET_APP = path.join(__dirname, '..', 'assets', 'trycord-assets', 'app');

// Dependency order, not alphabetical: the token library, then the application's
// semantic tokens, then the layers that consume them. `mobile.css` is last: it
// is the phone presentation, keyed to the same breakpoint the shell's desk
// composition is, so it must be free to override every desk layer.
const LAYERS = [
  'tokens.css',
  'base.css',
  'components.css',
  'shell.css',
  'messages.css',
  'views.css',
  'views-admin.css',
  'views-community.css',
  'views-messages.css',
  'views-auth.css',
  'views-plain.css',
  'voice.css',
  'mobile.css',
];

// The public website is the same product with the same brand. It carries no palette
// of its own: this layer is the asset library plus the semantic names in
// public/css/tokens.css, so a value changed in the library reaches both the
// application and the marketing pages from one source.
const PUBLIC_TOKEN_SOURCE = path.join(PUBLIC_CSS, 'tokens.css');
const PUBLIC_TOKEN_OUT = path.join(PUBLIC_CSS, 'design-tokens.css');

const header = '/* The application stylesheet. Built from frontend/css by '
  + 'frontend/scripts/build-css.js - edit the layers, not this file. */\n';

function buildApplication(library) {
  const parts = [header, library];
  for (const layer of LAYERS) {
    const file = path.join(CSS, layer);
    if (!fs.existsSync(file)) continue;
    parts.push('\n/* ---- ' + layer + ' ---- */\n');
    parts.push(fs.readFileSync(file, 'utf8'));
  }
  const out = path.join(CSS, 'app.css');
  const css = parts.join('\n');
  if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === css) {
    console.log('app.css is up to date (' + LAYERS.length + ' layers)');
    return;
  }
  fs.writeFileSync(out, css);
  console.log('wrote ' + path.relative(process.cwd(), out) + ' (' + css.length + ' bytes)');
}

function buildPublicTokens(library) {
  const semantic = fs.readFileSync(PUBLIC_TOKEN_SOURCE, 'utf8').trim();
  const lines = [
    '/*',
    ' * The design tokens, on their own. Generated - run npm run css.',
    ' *',
    ' * The public website links this before its own stylesheet. It is the same asset',
    ' * library the application is built from, so the marketing pages and the product',
    ' * share one palette by construction rather than by coincidence.',
    ' */',
    '',
    library,
    '',
    '/* ---- semantic names (public/css/tokens.css) ' + '-'.repeat(22) + ' */',
    '',
    semantic,
    '',
  ].join('\n');
  if (fs.existsSync(PUBLIC_TOKEN_OUT) && fs.readFileSync(PUBLIC_TOKEN_OUT, 'utf8') === lines) {
    console.log('public tokens are up to date');
    return;
  }
  fs.writeFileSync(PUBLIC_TOKEN_OUT, lines);
  console.log('wrote ' + path.relative(process.cwd(), PUBLIC_TOKEN_OUT) + ' (' + lines.length + ' bytes)');
}

// Stage the canonical app icons into the public site. Written only when they
// differ, so a normal build leaves the working tree quiet.
function buildPublicIcons() {
  fs.mkdirSync(PUBLIC_ASSETS, { recursive: true });
  for (const [from, to] of [['favicon.svg', 'favicon.svg'], ['trycord-app-icon.svg', 'app-icon.svg']]) {
    const source = path.join(ASSET_APP, from);
    const out = path.join(PUBLIC_ASSETS, to);
    const content = fs.readFileSync(source);
    if (fs.existsSync(out) && fs.readFileSync(out).equals(content)) {
      console.log('public ' + to + ' is up to date');
      continue;
    }
    fs.writeFileSync(out, content);
    console.log('wrote ' + path.relative(process.cwd(), out));
  }
}

// The Mobile presentation: the shared token library, then the module's own
// single layer. No desktop layer is included: cross-module CSS leakage is the
// same fault as a cross-module import.
function buildMobile(library) {
  const source = path.join(MOBILE_CSS, 'mobile.css');
  if (!fs.existsSync(source)) {
    console.log('no mobile stylesheet to build');
    return;
  }
  const header = '/* The Mobile module stylesheet. Built from frontend/mobile/css/mobile.css by '
    + 'frontend/scripts/build-css.js - edit the layer, not this file. */\n';
  const parts = [header, library, '\n/* ---- mobile.css ---- */\n', fs.readFileSync(source, 'utf8')];
  const out = path.join(MOBILE_CSS, 'app.css');
  const built = parts.join('');
  if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === built) {
    console.log('mobile stylesheet is up to date');
    return;
  }
  fs.writeFileSync(out, built);
  console.log('wrote ' + path.relative(process.cwd(), out));
}

const library = fs.readFileSync(ASSET_TOKENS, 'utf8').trim();
buildApplication(library);
buildMobile(library);
buildPublicTokens(library);
buildPublicIcons();
