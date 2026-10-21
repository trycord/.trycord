#!/usr/bin/env node
'use strict';

// The client, driven in a real browser.
//
// The browser in this environment cannot complete an http request: a
// navigation to any address hangs, and the renderer's network service never
// answers. So the application cannot be loaded from the instance.
//
// What it *can* do is run a document from disk, and the client's own modules
// load from disk with it. What it cannot do is talk to the instance.
//
// So the harness answers the instance's questions itself. The fetch is
// replaced before the application's first line runs, and the answers are the
// shapes the instance really returns. The application then boots exactly as
// it does in production - the same modules, the same router, the same shell -
// and the harness measures what it drew.
//
// This is not a mock of the client. It is a stand-in for the *server*, and
// the client is the real one.
//
//   node scripts/browser-app.mjs --base http://127.0.0.1:9971
//   node scripts/browser-app.mjs --widths 320,768,1440 --shots /tmp/shots
//
// It exits non-zero when a page printed an error, so it can be a check.

import fs from 'node:fs';
import path from 'node:path';

import { matchRoute } from '../packages/registry.js';
import {
  harness, wait, freePort, writeHarnessDocument, writeMobileHarnessDocument,
} from './browser-harness.mjs';

const CLIENT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const BASE = String(arg('base', '')).replace(/\/+$/, '');
const WIDTHS = String(arg('widths', '390,768,1280,1920')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const ROUTES = String(arg('routes', '/home,/dms,/search,/settings,/menu')).split(',').map((r) => r.trim()).filter(Boolean);
// The Mobile module is a shell of its own, so it is driven separately.
const MOBILE = arg('mobile', 'yes') !== 'no';
const MOBILE_WIDTHS = String(arg('mobile-widths', '320,390,430')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const MOBILE_ROUTES = String(arg('mobile-routes', '/home,/dms,/search,/settings,/menu')).split(',').map((r) => r.trim()).filter(Boolean);
const SHOTS = arg('shots', '');
const PORT = Number(process.env.BROWSER_APP_PORT || 9377);


// The layout a route is drawn in, or null when the route is not one.
//
// The registry is the same one the client routes with, so the harness and
// the application agree about which pages have a place column.
function layoutOf(route) {
  try {
    const matched = matchRoute(route);
    return matched && matched.page ? String(matched.page.layout || '') : null;
  } catch {
    return null;
  }
}

// ---- the run ----------------------------------------------------------------

const report = [];
let failures = 0;

// The gates are only seen by a reader with no session.
const SIGNED_OUT = arg('signed-out', 'no') !== 'no';

const run = await harness(await freePort(PORT), { signedOut: SIGNED_OUT });
const { page, nameRoute } = run;

try {
  const document = writeHarnessDocument();

  for (const width of WIDTHS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    for (const route of ROUTES) {
      await nameRoute(route);
      await page.send('Page.navigate', { url: 'file://' + document });
      // The client reads its configuration, asks the instance, and draws.
      // Give it the time it needs rather than a fixed guess.
      for (let i = 0; i < 60; i++) {
        const ready = await page.evaluate(
          'return !!(document.querySelector(".ws") || document.querySelector(".auth-page"));',
        ).catch(() => false);
        if (ready) break;
        await wait(120);
      }
      await wait(400);

      const measured = await page.evaluate(`
        var root = document.querySelector('.ws');
        var rail = document.querySelector('.rail');
        var column = document.querySelector('.context');
        var stage = document.querySelector('.stage');
        function box(node) {
          if (!node) return null;
          var r = node.getBoundingClientRect();
          var style = getComputedStyle(node);
          return {
            x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
            shown: style.display !== 'none' && style.visibility !== 'hidden',
          };
        }
        var errors = (window.__trycordErrors || []).slice();
        window.__trycordErrors = [];
        return {
          regions: root ? root.getAttribute('data-regions') : null,
          column: root ? root.getAttribute('data-column') : null,
          nav: root ? root.getAttribute('data-nav') : null,
          rail: box(rail), columnBox: box(column), stage: box(stage),
          hasContext: !!column,
          contextText: column ? (column.textContent || '').trim().slice(0, 80) : null,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          errors: errors,
          bodyClass: document.body ? document.body.className : null,
          appChildren: (document.getElementById('app') || {}).childNodes ? document.getElementById('app').childNodes.length : -1,
          appHtml: (document.getElementById('app') || {}).innerHTML ? document.getElementById('app').innerHTML.slice(0, 200) : null,
          scripts: Array.from(document.querySelectorAll('script')).map(function (n) { return n.src || '(inline)'; }),
          calls: (window.__calls || []).slice(0, 40),
          title: String(document.title || ''),
          probe: String(window.__probe || '(no probe)'),
          stubRan: typeof window.__trycordErrors !== 'undefined',
          storage: (function () {
            try {
              var out = [];
              for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                out.push(k + '=' + String(localStorage.getItem(k)).slice(0, 20));
              }
              return out.join(', ');
            } catch (e) { return 'storage is off: ' + e.message; }
          })(),
        };
      `);

      const entry = { width, route, ...measured };
      report.push(entry);

      if (measured.calls && measured.calls.length) {
      }
      const faults = [];
      for (const error of measured.errors || []) faults.push(error);
      if (measured.overflow > 2) {
        faults.push('the page scrolls sideways by ' + measured.overflow + ' pixels');
      }
      // The place column belongs to the pages that have one. A page with a
      // layout of its own - the profile, the settings, the sign-in - draws
      // what it draws, and asking it for a column it does not have is asking
      // for a fault that is not one.
      const layout = layoutOf(route);
      const hasColumn = ['plain', 'profile', 'settings'].indexOf(layout) === -1;
      if (width >= 1024 && hasColumn && measured.hasContext && measured.columnBox && !measured.columnBox.shown) {
        faults.push('the place column is not shown at ' + width + ' pixels');
      }
      if (width >= 1024 && hasColumn && measured.hasContext && measured.columnBox && measured.columnBox.w < 160) {
        faults.push('the place column is ' + measured.columnBox.w + ' pixels wide');
      }
      if (width >= 1024 && hasColumn && measured.hasContext && measured.rail && !measured.rail.shown) {
        faults.push('the communities rail is not shown at ' + width + ' pixels');
      }

      if (process.env.BROWSER_APP_VERBOSE) {
        console.log('        body:', JSON.stringify(measured).slice(0, 700));
      }
      if (faults.length) {
        failures += faults.length;
        console.log('  FAIL  ' + width + 'px ' + route);
        for (const fault of faults) console.log('          ' + fault);
      } else {
        if (measured.calls && measured.calls.length) {
          }
        console.log('  ok    ' + width + 'px ' + route
          + '  regions=' + measured.regions
          + ' column=' + (measured.columnBox ? measured.columnBox.w + 'px' : 'none')
          + ' rail=' + (measured.rail ? measured.rail.w + 'px' : 'none'));
      }

      if (SHOTS) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(
          path.join(SHOTS, 'app-' + width + '-' + route.replace(/[^a-z0-9]+/gi, '-') + '.png'),
          Buffer.from(shot.data, 'base64'),
        );
      }
    }
  }
// ---- the mobile shell --------------------------------------------------------
//
// The Mobile module is a second shell over the same packages, with its own
// entry document, its own stylesheet and its own router. It is driven here
// as its own document, at the widths a phone is, and what is measured is
// what a thumb has to reach: every control is at least a touch target, and
// nothing is drawn outside the width of the screen.
//
// The limit of this is the same as the limit of the desktop pass: the
// browser here cannot reach the network, so the instance's answers are
// stubbed and the module is measured against those. It is a real browser,
// real CSS and real pixels; it is not a real phone.

if (MOBILE) {
  console.log('\n--- the mobile shell ---');
  const mobileDocument = writeMobileHarnessDocument();

  for (const width of MOBILE_WIDTHS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: true,
    });

    for (const route of MOBILE_ROUTES) {
      await nameRoute(route);
      await page.send('Page.navigate', { url: 'file://' + mobileDocument });
      for (let i = 0; i < 60; i++) {
        const ready = await page.evaluate(
          'return !!(document.querySelector(".m-app") || document.querySelector(".auth-page")'
          + ' || (document.getElementById("app") && document.getElementById("app").childNodes.length));',
        ).catch(() => false);
        if (ready) break;
        await wait(120);
      }
      await wait(400);
      const measured = await page.evaluate(`
        // Every control a thumb has to reach.
        var small = [];
        var controls = Array.from(document.querySelectorAll(
          'button, a[href], [role="button"], [role="tab"], input[type="checkbox"], input[type="radio"]'
        ));
        for (var i = 0; i < controls.length; i++) {
          var node = controls[i];
          var rect = node.getBoundingClientRect();
          var style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (rect.width === 0 && rect.height === 0) continue;
          // A link inside a line of text is not a control a thumb presses.
          if (node.tagName === 'A' && node.closest('p, li, .lede, .m-row__sub')) continue;
          // A control whose middle is not on the screen is not one a thumb
          // reaches: the skip link sits off the top until it is focused, and
          // it is a keyboard affordance rather than a touch one.
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          if (cy < 0 || cy > window.innerHeight || cx < 0 || cx > window.innerWidth) continue;
          if (rect.width < 44 || rect.height < 44) {
            small.push({
              tag: node.tagName,
              cls: String(node.className || '').slice(0, 40),
              label: String(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40),
              w: Math.round(rect.width), h: Math.round(rect.height),
            });
          }
        }
        var errors = (window.__trycordErrors || []).slice();
        window.__trycordErrors = [];
        return {
          small: small,
          errors: errors,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          controls: controls.length,
          text: String(document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
          calls: (window.__calls || []).slice(0, 40),
          appChildren: (document.getElementById('app') || {}).childNodes
            ? document.getElementById('app').childNodes.length : -1,
        };
      `);

      if (measured.calls && measured.calls.length) {
      }
      const faults = [];
      for (const error of measured.errors || []) faults.push(error);
      if (measured.overflow > 2) {
        faults.push('the page scrolls sideways by ' + measured.overflow + ' pixels');
      }
      for (const control of measured.small || []) {
        faults.push('a control is ' + control.w + 'x' + control.h
          + ' (' + control.cls + (control.label ? ' "' + control.label + '"' : '') + ')');
      }
      if (measured.appChildren <= 0) faults.push('the module drew nothing');

      if (faults.length) {
        failures += faults.length;
        for (const fault of faults) console.log('        ' + fault);
      }
      console.log('  ' + (faults.length ? 'FAIL' : 'ok ') + '    ' + width + 'px ' + route
        + ' controls=' + measured.controls
        + ' small=' + (measured.small || []).length
        + ' | ' + (measured.text || ''));
      if (measured.calls && measured.calls.length) {
      }
    }
  }
}

} catch (error) {
  console.log('the run failed: ' + (error && error.message));
  console.log(run.chromeErrors().slice(0, 600));
  failures += 1;
} finally {
  await run.shutdown();
}

console.log('\n' + report.length + ' page(s) at ' + WIDTHS.length + ' width(s); '
  + failures + ' fault(s).');
process.exit(failures ? 1 : 0);
