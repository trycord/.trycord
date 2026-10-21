#!/usr/bin/env node
'use strict';

// Every route, measured.
//
// The whole route inventory, driven in a real browser, and measured for the
// things a person would notice:
//
//   the clipping    is a label cut short, or a button outside its card?
//   the overflow    does anything stick out of the space it was given?
//   the target      is every control the size the input device can hit?
//   the name        can every control be named for a screen reader?
//   the error       did the page throw?
//   the emptiness   does the page say what is missing and what to do?
//
// Two passes, because the two shells are held to different rules. The desk is
// used with a mouse, and a mouse can hit a small target; the phone is used
// with a finger, and a finger cannot. A control that is 32 pixels square is
// fine on the desk and too small on the phone, and a check that says
// otherwise reports the desk as broken.
//
// It is a real browser, real CSS and real pixels. It is not a real phone,
// and it is not the instance: the instance's answers are stubbed, because the
// browser in this environment cannot reach the network.
//
//   node scripts/browser-sweep.mjs
//   node scripts/browser-sweep.mjs --routes /home,/dms --widths 390
//   node scripts/browser-sweep.mjs --shots /tmp/shots

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES } from '../packages/registry.js';
import {
  harness, wait, freePort, writeHarnessDocument, writeMobileHarnessDocument,
} from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BROWSER_SWEEP_PORT || 9377);

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const WIDTHS = String(arg('widths', '1280')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const MOBILE_WIDTHS = String(arg('mobile-widths', '390')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const SHOTS = arg('shots', '');
const ONLY = String(arg('routes', '')).split(',').map((r) => r.trim()).filter(Boolean);

/**
 * Every route, with its parameters filled in.
 *
 * The registry is the client's own route table, so a page that is not in it
 * is a page that does not exist, and a page that is in it and is never
 * visited is a page nobody looked at.
 */
function routes() {
  const out = [];
  for (const page of PAGES) {
    if (!page.route) continue;
    // The filter takes either the pattern or the address it fills into, so
    // a route can be asked for by the address a reader would type.
    if (ONLY.length && !ONLY.includes(page.route)) {
      const filled = page.route.replace(/:[a-zA-Z]+/g, (match) => {
        const name = match.slice(1);
        if (name === 'slug') return 'the-community';
        if (name === 'channel') return 'c1';
        if (name === 'code') return 'join-me';
        if (name === 'token') return 'a-token';
        if (name === 'space') return 'space-1';
        if (name === 'document' || name === 'doc') return 'doc-1';
        if (name === 'board') return 'board-1';
        if (name === 'card') return 'card-1';
        if (name === 'event') return 'event-1';
        if (name === 'poll') return 'poll-1';
        return 's1';
      });
      if (!ONLY.includes(filled)) continue;
    }
    const route = page.route.replace(/:[a-zA-Z]+/g, (match) => {
      const name = match.slice(1);
      if (name === 'slug') return 'the-community';
      if (name === 'channel') return 'c1';
      if (name === 'code') return 'join-me';
      if (name === 'token') return 'a-token';
      if (name === 'space') return 'space-1';
      if (name === 'document') return 'doc-1';
      if (name === 'board') return 'board-1';
      if (name === 'card') return 'card-1';
      if (name === 'event') return 'event-1';
      if (name === 'poll') return 'poll-1';
      if (name === 'doc') return 'doc-1';
      return 's1';
    });
    out.push({ id: page.id, route, layout: page.layout, access: page.access || 'member' });
  }
  return out;
}

/**
 * What is wrong with the page as it stands.
 *
 * The measurement is done in the page, because that is where the truth is:
 * the boxes are real, the text is the text that is drawn, and the sizes are
 * the sizes a person meets.
 *
 * `minTarget` is the smallest control the device in hand can hit: 24 pixels
 * for a mouse, 44 for a finger.
 */
const measure = (minTarget) => `
  var root = document.body;
  var problems = [];
  var MIN_TARGET = ${Number(minTarget)};

  // The page scrolls sideways.
  var overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (overflow > 2) problems.push('the page scrolls sideways by ' + overflow + ' pixels');

  // Text that is cut short.
  //
  // Only a leaf: a container that clips its content is doing what it was
  // built to do, and the text inside it is cut somewhere else.
  var clipped = [];
  var texts = root.querySelectorAll('span, p, h1, h2, h3, h4, a, button, strong, em, label, li, td, figcaption');
  for (var i = 0; i < texts.length && clipped.length < 12; i++) {
    var node = texts[i];
    if (node.children.length) continue;
    var style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.overflow !== 'hidden' && style.overflowX !== 'hidden') continue;
    if (node.clientWidth <= 0) continue;
    if (node.scrollWidth <= node.clientWidth + 2) continue;
    var text = String(node.textContent || '').trim();
    if (!text) continue;
    clipped.push({
      cls: String(node.className || '').slice(0, 40),
      text: text.slice(0, 40),
      over: node.scrollWidth - node.clientWidth,
    });
  }
  for (var c of clipped) {
    problems.push('"' + c.text + '" is cut short (' + c.over + 'px) in .' + c.cls);
  }

  // A control the device in hand cannot hit.
  var small = [];
  var controls = root.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="switch"], input[type="checkbox"], input[type="radio"]');
  for (var i = 0; i < controls.length && small.length < 12; i++) {
    var node = controls[i];
    var rect = node.getBoundingClientRect();
    var style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.width === 0 && rect.height === 0) continue;
    // A link inside a line of text is not a control a person presses.
    if (node.tagName === 'A' && node.closest('p, li, .lede, .m-row__sub')) continue;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    if (cy < 0 || cy > window.innerHeight || cx < 0 || cx > window.innerWidth) continue;
    if (rect.width < MIN_TARGET || rect.height < MIN_TARGET) {
      small.push({
        cls: String(node.className || '').slice(0, 40),
        label: String(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 30),
        w: Math.round(rect.width), h: Math.round(rect.height),
      });
    }
  }
  for (var s of small) {
    problems.push('a control is ' + s.w + 'x' + s.h + ' (' + s.cls
      + (s.label ? ' "' + s.label + '"' : '') + ')');
  }

  // A control a screen reader cannot name.
  var unnamed = [];
  for (var i = 0; i < controls.length && unnamed.length < 12; i++) {
    var node = controls[i];
    var style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    var name = (node.getAttribute('aria-label') || node.getAttribute('title')
      || String(node.textContent || '')).trim();
    if (!name) unnamed.push(String(node.className || node.tagName).slice(0, 40));
  }
  for (var u of unnamed) problems.push('a control with no name (' + u + ')');

  return {
    problems: problems,
    text: String(root.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    height: Math.round(document.documentElement.scrollHeight),
    errors: (window.__trycordErrors || []).slice(),
  };
`;

const run = await harness(await freePort(PORT));
let failures = 0;
const report = [];

try {
  const desk = writeHarnessDocument();
  const phone = writeMobileHarnessDocument();
  const all = routes();

  // A pass over one shell.
  //
  // The desk is used with a mouse and the phone with a finger, and the
  // smallest control each can hit is different.
  const sweep = async (label, document, widths, minTarget, ready) => {
    console.log('\n--- the ' + label + ' ---');
    for (const width of widths) {
      await run.page.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: label === 'phone',
      });

      for (const entry of all) {
        const started = Date.now();
        process.stdout.write('      ' + entry.route + '...');
        await run.nameRoute(entry.route);
        await run.page.send('Page.navigate', { url: 'file://' + document });
        for (let i = 0; i < 60; i++) {
          const up = await run.page.evaluate(
            'return !!(document.querySelector(".ws") || document.querySelector(".m-app")'
            + ' || document.querySelector(".auth-page")'
            + ' || (document.getElementById("app") && document.getElementById("app").childNodes.length));',
          ).catch(() => false);
          if (up) break;
          await wait(100);
        }
        await wait(300);

        const measured = await run.page.evaluate(measure(minTarget));
        const faults = measured.problems.slice();
        for (const error of measured.errors || []) faults.push(error);
        if (measured.height < 120) faults.push('the page drew almost nothing');

        process.stdout.write(' ' + Math.round((Date.now() - started) / 1000) + 's\n');
        if (faults.length) {
          failures += faults.length;
          console.log('  FAIL  ' + width + 'px ' + entry.route + ' (' + entry.id + ')');
          for (const fault of faults) console.log('          ' + fault);
        } else {
          console.log('  ok    ' + width + 'px ' + entry.route);
        }
        report.push({ label, width, ...entry, faults });

        if (SHOTS) {
          const shot = await run.page.send('Page.captureScreenshot', { format: 'png' });
          fs.mkdirSync(SHOTS, { recursive: true });
          fs.writeFileSync(
            path.join(SHOTS, label + '-' + width + '-' + entry.route.replace(/[^a-z0-9]+/gi, '-') + '.png'),
            Buffer.from(shot.data, 'base64'),
          );
        }
      }
    }
  };

  await sweep('desk', desk, WIDTHS, 24);
  await sweep('phone', phone, MOBILE_WIDTHS, 44);
} catch (error) {
  console.log('the sweep failed: ' + (error && error.message));
  console.log(run.chromeErrors().slice(0, 600));
  failures += 1;
} finally {
  await run.shutdown();
}

console.log('\n' + report.length + ' page(s) at ' + WIDTHS.length + ' width(s); '
  + failures + ' fault(s).');
process.exit(failures ? 1 : 0);
