#!/usr/bin/env node
'use strict';

// The layout check.
//
// jsdom computes no geometry, so for as long as the frontend existed nothing in
// the harness could say whether the shell still worked at a desk, at a laptop
// width, or with the column overlaying the stage. scripts/layout-engine.js
// closes that: it is a real CSS-subset engine that reads the built stylesheet
// (frontend/css/app.css) and answers engine.boxOf(element) -> {x, y, w, h} for
// every node.
//
// This check mounts the actual shell module into a plain document, paints it
// through that engine at three desk sizes, and asserts the geometry a browser
// must agree on:
//
//   - the shell's regions are exact: the command bar's height, the rail's
//     width, the column's width, and the stage taking everything that remains;
//   - the inspector drawer floats: it takes width from the viewport's right
//     edge without reflowing the stage beneath it;
//   - the command palette is centred with the top offset the sheet promises;
//   - below 1080px (the same line shell.js reads) the column leaves the grid
//     and overlays the stage, the backdrop covers the screen and the resize
//     grip disappears; collapse its nav state and the column hides itself;
//   - nothing the engine paints lands outside the viewport horizontally.
//
// The metric values come from the token layer through the engine itself, so
// the check verifies coupled facts (regions add up) rather than a screenshot.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(REPO, 'frontend', 'css', 'app.css'), 'utf8');
const { createEngine, evalLength } = require('./layout-engine.js');

let checks = 0;
let failures = 0;
const ok = (good, label, detail) => {
  checks++;
  if (good) {
    console.log('    ok  ' + label);
    return true;
  }
  failures++;
  console.log('    FAIL ' + label + (detail ? ' <- ' + detail : ''));
  return false;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.75 : tol);

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost:9971/home',
  pretendToBeVisual: true,
});
const window = dom.window;
const document = window.document;

// The client modules read what a browser puts on the global scope. Same wiring
// the render check uses, minus anything a browser would not provide here.
const install = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
  } catch { globalThis[name] = value; }
};
for (const name of Object.getOwnPropertyNames(window)) {
  if (name in globalThis) continue;
  if (/^(webkit|chrome)/.test(name)) continue;
  install(name, window[name]);
}
install('window', window);
install('document', document);
for (const name of ['Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent',
  'KeyboardEvent', 'CustomEvent', 'InputEvent', 'FocusEvent',
  'navigator', 'location', 'localStorage', 'history']) {
  if (name in window) install(name, window[name]);
}
window.matchMedia = (query) => ({
  media: query,
  matches: /max-width:\s*1080px/.test(query),
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
install('matchMedia', window.matchMedia);
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
for (const name of ['getComputedStyle', 'scrollTo']) {
  if (typeof window[name] === 'function') install(name, window[name].bind(window));
}

(async () => {
  const shell = await import(pathToFileURL(path.join(REPO, 'frontend', 'js', 'shell.js')).href);
  const { el } = await import(pathToFileURL(path.join(REPO, 'frontend', 'packages', 'dom.js')).href);
  const palette = await import(pathToFileURL(path.join(REPO, 'frontend', 'js', 'shell', 'palette.js')).href);

  // The real shell, mounted the way a page would. Regions are painted with the
  // platform's own vocabulary so the check sees a truthful stage.
  const root = shell.mountShell();
  document.getElementById('app').appendChild(root);
  shell.setContextPage('home', null, null);
  shell.setStageHead(el('span', { class: 'stage-head-title' }, 'Layout check'));
  shell.setStage(el('div', { class: 'fold' },
    el('header', { class: 'pagehead' }, el('h1', { class: 'pagehead-title' }, 'Layout check')),
    el('section', { class: 'card' }, el('div', { class: 'cardrow' },
      el('span', { class: 'chip' }, 'One')))));
  shell.setDock(null);

  let engine = null;

  // One viewport configuration: the shell's own state facts plus a fresh
  // engine pass over the built stylesheet.
  function configure(width, height, opts = {}) {
    window.innerWidth = width;
    window.innerHeight = height;
    root.dataset.nav = opts.nav || 'expanded';
    root.dataset.column = 'closed';
    root.dataset.context = opts.inspector ? 'open' : 'closed';
    const inspectorEl = document.getElementById('context-panel');
    inspectorEl.hidden = !opts.inspector;
    for (const node of Array.from(document.querySelectorAll('.overlay'))) node.remove();
    if (opts.palette) palette.openPalette();
    engine = createEngine(CSS, document, width, height);
    engine.paint();
    return engine;
  }

  const box = (selector) => {
    const found = engine.visit(selector);
    return found.length ? engine.boxOf(found[0]) : null;
  };
  const painted = () => Array.from(engine.visit('*')).map((node) => engine.boxOf(node));

  console.log('\n  layout check - the shell geometry, engine-computed\n');

  // -- the metric tokens reach the engine -------------------------------------

  configure(1440, 900);
  const tokenRaw = (name) => engine.substituteVars('var(' + name + ')');
  const tokens = {};
  for (const name of ['--rail-w', '--context-w', '--cmdbar-h', '--inspector-w']) {
    tokens[name] = evalLength(tokenRaw(name));
    ok(tokens[name] !== null, 'the engine reads ' + name + ' from the token layer',
      tokenRaw(name));
  }
  const railW = tokens['--rail-w'];
  const ctxW = tokens['--context-w'];
  const cmdH = tokens['--cmdbar-h'];
  const insW = tokens['--inspector-w'];

  // -- the desk: regions add up, nothing overflows ------------------------------

  {
    const ws = box('#shell');
    ok(ws && near(ws.x, 0) && near(ws.y, 0) && near(ws.w, 1440) && near(ws.h, 900),
      'the shell fills the viewport exactly', JSON.stringify(ws));
    const cmd = box('.cmdbar');
    ok(cmd && near(cmd.w, 1440) && near(cmd.h, cmdH),
      'the command bar is the full width and its metric height', JSON.stringify(cmd));
    const rail = box('.rail');
    ok(rail && near(rail.x, 0) && near(rail.w, railW) && near(rail.y, cmdH) && near(rail.h, 900 - cmdH),
      'the rail is the token width and runs to the viewport bottom', JSON.stringify(rail));
    const context = box('.context');
    ok(context && near(context.x, railW) && near(context.w, ctxW) && near(context.y, cmdH),
      'the column stands beside the rail at the token width', JSON.stringify(context));
    const stage = box('.stage');
    ok(stage && near(stage.x, railW + ctxW) && near(stage.x + stage.w, 1440) && near(stage.y, cmdH)
      && near(stage.h, 900 - cmdH),
      'the stage takes everything past the column to the right edge', JSON.stringify(stage));
    const screen = box('.screen');
    ok(screen && near(screen.x, stage.x) && near(screen.w, stage.w) && near(screen.h, stage.h),
      'the screen fills the stage it lives in', JSON.stringify(screen));
    const head = box('.stage-head');
    const body = box('.stage-body');
    ok(head && body && near(body.y, head.y + head.h),
      'the stage body starts where the stage head ends', JSON.stringify({ head, body }));
    ok(near(body.y + body.h, stage.y + stage.h),
      'the stage body runs to the stage bottom', JSON.stringify(body));
    const grip = box('.grip--column');
    ok(grip && near(grip.x + grip.w, context.x + context.w, 6),
      'the resize grip rides the column edge', JSON.stringify(grip));
    const overflows = painted().filter((b) => b.x < -0.5 || b.x + b.w > 1440.5);
    ok(overflows.length === 0,
      'nothing painted lands outside the viewport horizontally',
      JSON.stringify(overflows.slice(0, 4)));
    ok(!engine.visit('.inspector').length && !engine.visit('.dock').length,
      'undocked inspectors and the voice dock are out of flow when closed');
  }

  // -- the inspector drawer floats ----------------------------------------------

  {
    configure(1440, 900, { inspector: true });
    const inspector = box('.inspector');
    ok(inspector && near(inspector.x + inspector.w, 1440) && near(inspector.w, insW),
      'the inspector hangs off the viewport right edge at its token width',
      JSON.stringify(inspector));
    ok(inspector && near(inspector.y, 0) && near(inspector.h, 900),
      'the inspector runs the full viewport height', JSON.stringify(inspector));
    const stage = box('.stage');
    ok(stage && near(stage.x, railW + ctxW) && near(stage.x + stage.w, 1440),
      'opening the drawer does not reflow the stage', JSON.stringify(stage));
    ok(inspector && inspector.x >= box('.stage').x,
      'the drawer overlays the stage instead of taking a grid cell');
    const overflows = painted().filter((b) => b.x < -0.5 || b.x + b.w > 1440.5);
    ok(overflows.length === 0,
      'with the drawer open, nothing lands outside the viewport',
      JSON.stringify(overflows.slice(0, 4)));
  }

  // -- the command palette is centred --------------------------------------------

  {
    configure(1440, 900, { palette: true });
    const overlay = box('.overlay');
    ok(overlay && near(overlay.x, 0) && near(overlay.y, 0) && near(overlay.w, 1440) && near(overlay.h, 900),
      'the palette backdrop covers the viewport', JSON.stringify(overlay));
    const dialog = box('.dialog--palette');
    ok(dialog && dialog.w <= 580.5 && near(dialog.x, (1440 - dialog.w) / 2, 2),
      'the palette dialog is capped at its sheet width and centred', JSON.stringify(dialog));
    ok(dialog && near(dialog.y, 116, 1),
      'the palette sits at the top offset the sheet sets for it', JSON.stringify(dialog));
  }

  // -- below the narrow line: the column overlays the stage ----------------------

  {
    configure(1024, 800, { nav: 'overlay' });
    const context = box('.context');
    ok(context && near(context.x, railW) && near(context.w, Math.min(ctxW, 1024 - railW)),
      'the overlaying column opens at the rail edge at min(column, room)', JSON.stringify(context));
    ok(context && near(context.y, cmdH) && near(context.y + context.h, 800),
      'the overlaying column runs from the command bar to the bottom', JSON.stringify(context));
    const stage = box('.stage');
    ok(stage && near(stage.x, railW) && near(stage.x + stage.w, 1024),
      'the stage spans the desk with no column track beside it', JSON.stringify(stage));
    const scrim = box('.scrim');
    ok(scrim && near(scrim.x, 0) && near(scrim.w, 1024) && near(scrim.h, 800),
      'the backdrop covers the window in overlay mode', JSON.stringify(scrim));
    ok(!engine.visit('.grip--column').length,
      'the column grip is gone on a narrow window');
    const overflows = painted().filter((b) => b.x < -0.5 || b.x + b.w > 1024.5);
    ok(overflows.length === 0,
      'narrow overlay paints inside the viewport', JSON.stringify(overflows.slice(0, 4)));
  }

  // -- the collapsed column hides by its own declaration -------------------------

  {
    configure(1024, 800, { nav: 'expanded' });
    const contextEl = document.querySelector('.context');
    ok(engine.styleOf(contextEl).prop('visibility') === 'hidden',
      'with nav expanded on a narrow window the column hides itself');
    ok(!box('.scrim'),
      'and the backdrop stays dark');
  }

  // -- the smallest desk size keeps the same overlay contract --------------------

  {
    configure(920, 700, { nav: 'overlay' });
    const context = box('.context');
    ok(context && near(context.x, railW) && near(context.w, Math.min(ctxW, 920 - railW))
      && near(context.y + context.h, 700),
      'at 920x700 the overlaying column keeps rail-edge origin and bottom chain',
      JSON.stringify(context));
    const stage = box('.stage');
    ok(stage && near(stage.x + stage.w, 920),
      'the stage still reaches the right edge at 920', JSON.stringify(stage));
    const overflows = painted().filter((b) => b.x < -0.5 || b.x + b.w > 920.5);
    ok(overflows.length === 0,
      '920x700 paints inside the viewport', JSON.stringify(overflows.slice(0, 4)));
  }

  if (failures) {
    console.log('\n  layout check FAILED - ' + failures + ' of ' + checks + ' assertions');
    process.exitCode = 1;
  } else {
    console.log('\n  layout check passed - ' + checks
      + ' assertions of engine-computed geometry against the real stylesheet');
  }
})();
