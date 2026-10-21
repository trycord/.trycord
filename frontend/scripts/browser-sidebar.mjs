#!/usr/bin/env node
'use strict';

// The sidebar, at the width where it is a drawer.
//
// At a narrow width the place column is drawn over the page with a scrim
// behind it, and the scrim is there to close the column when the reader
// taps outside it. If the scrim is drawn over the column instead of behind
// it, the column cannot be touched at all: it appears, and every one of its
// links does nothing.
//
// So this measures the thing that matters: is the column above the scrim, and
// does a tap on one of its links land on the link?

import { harness, wait, writeHarnessDocument } from './browser-harness.mjs';

const PORT = Number(process.env.BROWSER_APP_PORT || 9401);
const WIDTH = 390;

const run = await harness(await (await import('./browser-harness.mjs')).freePort(PORT));

let failures = 0;
const ok = (condition, message) => {
  console.log((condition ? '  ok    ' : '  FAIL  ') + message);
  if (!condition) failures += 1;
};

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
  await wait(500);

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
} catch (error) {
  console.log('  FAIL  the run failed: ' + ((error && error.message) || error));
  failures += 1;
} finally {
  await run.shutdown();
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
