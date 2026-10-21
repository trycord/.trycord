#!/usr/bin/env node
'use strict';

// The public website, measured in a real browser.
//
// The application's sweep walks the routes of the client. The public website
// is a different set of pages - the homepage, the documentation, the legal
// pages - and nothing was walking them, so a broken masthead or a page that
// scrolled sideways would have shipped.
//
// What is checked, on every page, at a desk width and a phone width:
//
//   the page draws   the masthead, the content and the footer are there
//   it fits          nothing scrolls sideways
//   it reads         the text is not cut short
//   it works         the menu opens on a phone, and closes again
//   it is quiet      nothing logged an error
//
//   node scripts/browser-site.mjs
//   node scripts/browser-site.mjs --shots /tmp/shots

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { harness, wait, freePort, cleanupHarness } from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', '..', 'public');
const PORT = Number(process.env.BROWSER_SITE_PORT || 9381);

// The site is checked off disk, the way the application's sweep checks it.
//
// The browser in this environment cannot make a network request - not even to
// the loopback - so the pages are read off the disk. Their stylesheets and
// their scripts are asked for by an absolute path (`/css/site.css`,
// `/js/site.js`), because that is where they live on a real instance, and off
// the disk those paths point at the root of the filesystem. So the pages are
// copied into a scratch directory with the paths made relative, and the browser
// reads the copy.
//
// The copy is what a reader sees: the same markup, the same stylesheet, the
// same script. Only the addresses of the files differ.
const SCRATCH = path.join(os.tmpdir(), 'trycord-site-check');

function stagePages() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const name of fs.readdirSync(PUBLIC)) {
    const source = path.join(PUBLIC, name);
    if (fs.statSync(source).isDirectory()) {
      fs.cpSync(source, path.join(SCRATCH, name), { recursive: true });
      continue;
    }
    if (!name.endsWith('.html')) {
      fs.copyFileSync(source, path.join(SCRATCH, name));
      continue;
    }
    let html = fs.readFileSync(source, 'utf8');
    html = html.replace(/(href|src)="\/(?!\/)([^"]*)"/g, '$1="./$2"');
    fs.writeFileSync(path.join(SCRATCH, name), html);
  }
  return SCRATCH;
}

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const SHOTS = arg('shots', '');
const WIDTHS = String(arg('widths', '1280,390')).split(',').map((n) => Number(n.trim())).filter(Boolean);

// The pages the site is made of.
const pages = fs.readdirSync(PUBLIC)
  .filter((name) => name.endsWith('.html'))
  .sort();

// The measurement, in the page, because that is where the truth is.
const measure = `
  var problems = [];
  var root = document.body;

  if (document.documentElement.scrollWidth - document.documentElement.clientWidth > 2) {
    problems.push('the page scrolls sideways by '
      + (document.documentElement.scrollWidth - document.documentElement.clientWidth) + ' pixels');
  }
  if (!document.querySelector('.site-header')) problems.push('there is no masthead');
  if (!document.querySelector('.site-footer')) problems.push('there is no footer');
  if (!document.querySelector('#main')) problems.push('there is no main region');

  // Text that is cut short without saying it continues.
  var texts = root.querySelectorAll('span, p, h1, h2, h3, h4, a, button, strong, em, label, li');
  for (var i = 0; i < texts.length && problems.length < 12; i++) {
    var node = texts[i];
    if (node.children.length) continue;
    var style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.overflow !== 'hidden' && style.overflowX !== 'hidden') continue;
    if (node.clientWidth <= 0) continue;
    if (node.scrollWidth <= node.clientWidth + 2) continue;
    if (style.textOverflow === 'ellipsis') continue;
    var text = String(node.textContent || '').trim();
    if (!text) continue;
    problems.push('"' + text.slice(0, 40) + '" is cut short');
  }

  // A control the device in hand cannot hit.
  var MIN_TARGET = ${'${MIN_TARGET}'};
  var controls = root.querySelectorAll('button, a[href], input, select, textarea');
  for (var i = 0; i < controls.length && problems.length < 12; i++) {
    var node = controls[i];
    var style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (node.closest('[hidden]')) continue;
    var rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (rect.height + 1 < MIN_TARGET && node.tagName !== 'A') {
      problems.push('a ' + node.tagName.toLowerCase() + ' is ' + Math.round(rect.height)
        + ' pixels tall (.' + String(node.className || '').split(' ')[0] + ')');
    }
  }

  // An attribute written outside its tag is text on the page.
  //
  // It happened: the pager's attribute sat after the tag it belonged to, so
  // the reader saw "data-next=1" at the top of eight pages and the pager
  // never appeared. A page must not show anything that looks like markup.
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  var text;
  while ((text = walker.nextNode())) {
    var value = String(text.nodeValue || '');
    if (/^\s*[a-zA-Z-]+="[^"]*"\s*$/.test(value)) {
      problems.push('the page shows "' + value.trim() + '" as text');
      break;
    }
  }

  // A page that asks for the pager gets one.
  var main = document.querySelector('#main');
  if (main && main.getAttribute('data-next')) {
    var pager = document.querySelector('.pager');
    if (!pager) {
      problems.push('the page asked for a pager and did not get one');
    } else if (!pager.querySelector('a[href]')) {
      problems.push('the pager has no link in it');
    }
  }

  return { problems: problems, height: document.body.scrollHeight };
`;

const staged = stagePages();
const run = await harness(await freePort(PORT));
let failures = 0;
const report = [];

try {
  for (const width of WIDTHS) {
    console.log('\n--- ' + width + 'px ---');
    await run.page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 700,
    });

    for (const name of pages) {
      const file = path.join(staged, name);
      const started = Date.now();
      process.stdout.write('      ' + name + '...');

      await run.page.send('Page.navigate', { url: 'file://' + file });
      await wait(350);

      const faults = [];
      try {
        const measured = await run.page.evaluate(
          measure.replace('${MIN_TARGET}', String(width < 700 ? 40 : 24)),
        );
        for (const problem of measured.problems) faults.push(problem);
        if (measured.height < 200) faults.push('the page drew almost nothing');
      } catch (error) {
        faults.push('the page would not hold still long enough to be measured (' + ((error && error.message) || error) + ')');
      }

      // The menu, on a narrow screen: it opens, and it closes again.
      if (width < 700) {
        try {
          const state = await run.page.evaluate(`
            var toggle = document.querySelector('[data-menu-toggle]');
            var header = document.querySelector('.site-header');
            if (!toggle || !header) return 'no menu';
            toggle.click();
            var open = header.getAttribute('data-menu-open');
            toggle.click();
            var closed = header.getAttribute('data-menu-open');
            return open + '/' + closed;
          `);
          if (state !== 'true/false') faults.push('the menu did not open and close (' + state + ')');
        } catch (error) {
          faults.push('the menu could not be checked');
        }
      }

      // A code block has a copy button, and it copies.
      const copies = await run.page.evaluate(`
        var blocks = document.querySelectorAll('.prose pre');
        return blocks.length + ':' + document.querySelectorAll('.prose pre .copy-button').length;
      `).catch(() => '0:0');
      if (copies && copies.indexOf(':') !== -1) {
        const [blocks, buttons] = copies.split(':').map(Number);
        if (blocks > 0 && buttons !== blocks) {
          faults.push(blocks + ' code block(s) and ' + buttons + ' copy button(s)');
        }
      }

      const errors = await run.page.evaluate('return (window.__trycordErrors || []).slice();')
        .catch(() => []);
      for (const error of errors) faults.push('the page logged: ' + error);

      process.stdout.write(' ' + Math.round((Date.now() - started) / 1000) + 's\n');
      if (faults.length) {
        failures += faults.length;
        console.log('  FAIL  ' + width + 'px ' + name);
        for (const fault of faults) console.log('          ' + fault);
      } else {
        console.log('  ok    ' + width + 'px ' + name);
      }
      report.push({ width, name, faults });

      if (SHOTS) {
        const shot = await run.page.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(
          path.join(SHOTS, name.replace(/\.html$/, '') + '-' + width + '.png'),
          Buffer.from(shot.data, 'base64'),
        );
      }
    }
  }
} finally {
  await run.shutdown();
  fs.rmSync(staged, { recursive: true, force: true });
}

console.log('\n' + report.length + ' page(s) at ' + WIDTHS.length + ' width(s); '
  + failures + ' fault(s).');
process.exit(failures ? 1 : 0);
