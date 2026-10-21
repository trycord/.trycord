#!/usr/bin/env node
'use strict';

// The sidebar, at both widths.
//
// At a narrow width the place column is drawn over the page with a scrim
// behind it, and the scrim is there to close the column when the reader taps
// outside it. If the scrim is drawn over the column instead of behind it, the
// column cannot be touched at all: it appears, and every one of its links
// does nothing.
//
// So this measures the thing that matters: is the column above the scrim, and
// does a tap on one of its links land on the link?
//
// And it measures the other thing that matters: the column glides. It opens
// and it closes by moving, not by appearing and vanishing between one frame
// and the next - a column that snaps reads as a fault rather than as a
// choice. The check reads the width twice while the transition is running and
// refuses a column that went from open to shut in one step.

import { harness, wait, writeHarnessDocument } from './browser-harness.mjs';

const PORT = Number(process.env.BROWSER_APP_PORT || 9401);
const WIDTH = 390;
const DESK = 1280;

const run = await harness(await (await import('./browser-harness.mjs')).freePort(PORT));

let failures = 0;
const ok = (condition, message) => {
  console.log((condition ? '  ok    ' : '  FAIL  ') + message);
  if (!condition) failures += 1;
};

// The width of the column, and whether it is on its way somewhere.
const measure = () => run.page.evaluate(`
  var column = document.querySelector('.context');
  var root = document.querySelector('.ws');
  if (!column) return { error: 'there is no column' };
  var box = column.getBoundingClientRect();
  return {
    nav: String((root || {}).dataset?.nav || 'none'),
    width: Math.round(box.width),
    opacity: Number(getComputedStyle(column).opacity),
    transition: getComputedStyle(column).transitionDuration,
  };
`);

try {
  const document = writeHarnessDocument();
  await run.page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 844, deviceScaleFactor: 1, mobile: false,
  });

  await run.nameRoute('/server/s1/channel/c1');
  await run.page.send('Page.navigate', { url: 'file://' + document });
  for (let i = 0; i < 60; i++) {
    const up = await run.page.evaluate(
      'return !!(document.querySelector(".ws") || document.querySelector(".auth-page"));',
    ).catch(() => false);
    if (up) break;
    await wait(100);
  }
  // The column is drawn from the community's tree, so it arrives after the
  // shell does. The check waits for it rather than measuring an empty one.
  for (let i = 0; i < 60; i++) {
    const drawn = await run.page.evaluate(
      'return !!(document.querySelector(".context a[href]"));',
    ).catch(() => false);
    if (drawn) break;
    await wait(100);
  }
  await wait(300);

  // Open the column if it is not open already.
  //
  // At a narrow width the column is open by default - it is the only way to
  // reach the channels - so the button closes it first and opens it again.
  const state = () => run.page.evaluate(
    "return String((document.querySelector('.ws') || {}).dataset?.nav || 'none');",
  );
  const clickNav = () => run.page.evaluate(`
    var button = document.querySelector('.cmdbar-nav');
    if (!button) return false;
    button.click();
    return true;
  `);

  let nav = await state();
  if (nav !== 'overlay') {
    ok(await clickNav(), 'the button opens the column');
    await wait(400);
    nav = await state();
  }
  ok(nav === 'overlay', 'the column is open (the state is ' + nav + ')');

  const measured = await run.page.evaluate(`
    var column = document.querySelector('.context');
    var scrim = document.querySelector('.scrim');
    if (!column) return { error: 'there is no column' };
    var nav = document.querySelector('.ws').dataset.nav;
    var link = column.querySelector('a.nav-item, a[href]');
    if (!link) return { error: 'the column has no link in it' };
    var box = link.getBoundingClientRect();
    var cx = box.left + box.width / 2;
    var cy = box.top + box.height / 2;
    var atPoint = document.elementFromPoint(cx, cy);
    var stage = document.querySelector('.stage');
    var columnBox = column.getBoundingClientRect();
    return {
      nav: nav,
      columnVisible: getComputedStyle(column).visibility,
      columnZ: getComputedStyle(column).zIndex,
      columnPosition: getComputedStyle(column).position,
      columnBox: { x: Math.round(columnBox.x), y: Math.round(columnBox.y),
        w: Math.round(columnBox.width), h: Math.round(columnBox.height) },
      stageZ: stage ? getComputedStyle(stage).zIndex : 'none',
      stagePosition: stage ? getComputedStyle(stage).position : 'none',
      scrimZ: scrim ? getComputedStyle(scrim).zIndex : 'none',
      scrimShown: scrim ? getComputedStyle(scrim).display : 'none',
      linkText: String(link.textContent || '').trim().slice(0, 30),
      linkBox: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      // What is actually under the reader's finger.
      under: atPoint ? (atPoint.tagName + '.' + String(atPoint.className || '')) : 'nothing',
      inLink: !!(atPoint && atPoint.closest('a[href]')),
    };
  `);

  ok(!measured.error, 'the column can be measured: ' + (measured.error || ''));
  if (!measured.error) {
    ok(measured.nav === 'overlay' && measured.columnVisible === 'visible',
      'the column is open (state ' + measured.nav + ', ' + measured.columnVisible + ')');
    ok(Number(measured.columnZ) > Number(measured.scrimZ),
      'the column is above the scrim (column ' + measured.columnZ
      + ', scrim ' + measured.scrimZ + ')');
    ok(measured.inLink,
      'a tap on "' + measured.linkText + '" lands on the link (it lands on '
      + measured.under + ')');
    console.log('        the column', JSON.stringify(measured.columnBox),
      'z', measured.columnZ, measured.columnPosition);
    console.log('        the link  ', JSON.stringify(measured.linkBox));
    console.log('        the stage z', measured.stageZ, measured.stagePosition,
      ' the scrim z', measured.scrimZ, measured.scrimShown);
  }

  // -- the layers -------------------------------------------------------------
  //
  // The shell's panels - the place column, the inspector, the voice dock -
  // share one band, and that band is below the menus, the toasts and the
  // dialogs. A panel that sat above all of those would cover the menu the
  // reader just opened, and the answer to what they just did.
  //
  // The backdrop that dims the page sits below the panels: a panel under the
  // backdrop cannot be touched at all, which is how a drawer ends up visible
  // and dead.
  const layers = await run.page.evaluate(`
    var root = document.querySelector('.ws');
    var read = function (selector) {
      var node = document.querySelector(selector);
      if (!node) return null;
      return Number(getComputedStyle(node).zIndex);
    };
    var tokens = getComputedStyle(root);
    return {
      column: read('.context'),
      inspector: read('.inspector'),
      dock: read('.dock'),
      scrim: read('.scrim'),
      panel: Number(tokens.getPropertyValue('--z-panel')),
      scrimBand: Number(tokens.getPropertyValue('--z-scrim')),
      menu: Number(tokens.getPropertyValue('--z-menu')),
      toast: Number(tokens.getPropertyValue('--z-toast')),
      modal: Number(tokens.getPropertyValue('--z-modal')),
    };
  `);

  ok(layers.column !== null && layers.panel !== null,
    'the bands can be read: ' + JSON.stringify(layers));
  if (layers.column !== null && layers.panel !== null) {
    ok(layers.column === layers.panel,
      'the column is in the panels\' band (' + layers.column + ', the band is ' + layers.panel + ')');
    ok(layers.inspector === null || layers.inspector === layers.panel,
      'the inspector is in the same band as the column (' + layers.inspector + ')');
    ok(layers.dock === null || layers.dock === layers.panel,
      'the voice dock is in the same band as the column (' + layers.dock + ')');
    ok(layers.column < layers.menu && layers.column < layers.toast
      && layers.column < layers.modal,
      'the column is below the menus, the toasts and the dialogs ('
      + layers.column + ' against ' + layers.menu + '/' + layers.toast + '/' + layers.modal + ')');
  }

  // -- the glide, on a desk ---------------------------------------------------
  //
  // The column is a column on a desk: it takes its room from the stage, and
  // it takes it back. The check reads the width twice while the transition is
  // running. A column that was open and is shut in one reading has snapped,
  // and a snapping column is what the reader asked to have fixed.
  await run.page.send('Emulation.setDeviceMetricsOverride', {
    width: DESK, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await wait(600);

  const before = await measure();
  ok(!before.error, 'the column can be measured on a desk: ' + (before.error || ''));
  ok(before.width > 100, 'the column is open on a desk (it is ' + before.width + ' wide)');

  // Close it, and read the width while it is still moving.
  await clickNav();
  await wait(60);
  const during = await measure();
  await wait(600);
  const after = await measure();

  ok(after.nav === 'hidden', 'the column is closed (the state is ' + after.nav + ')');
  ok(after.width < 4, 'the column has gone (it is ' + after.width + ' wide)');
  ok(during.width < before.width && during.width > after.width,
    'the column glided rather than snapped ('
    + before.width + ' -> ' + during.width + ' -> ' + after.width + ')');

  // And open it again, the same way.
  await clickNav();
  await wait(60);
  const opening = await measure();
  await wait(600);
  const opened = await measure();

  ok(opened.width > 100, 'the column is open again (it is ' + opened.width + ' wide)');
  ok(opening.width > after.width && opening.width < opened.width,
    'the column glided open rather than appearing ('
    + after.width + ' -> ' + opening.width + ' -> ' + opened.width + ')');
} catch (error) {
  console.log('  FAIL  the run failed: ' + ((error && error.message) || error));
  failures += 1;
} finally {
  await run.shutdown();
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
