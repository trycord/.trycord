#!/usr/bin/env node
'use strict';

// The layout, measured in a real browser.
//
// The environment this runs in cannot reach the network from the browser - the
// navigation to any http:// address hangs - so the application cannot be
// driven against a live instance here. What *can* be driven is the layout
// system: the page is loaded from disk, the application's own stylesheet is
// applied, and the structures are built with the application's own element
// helper.
//
// So this measures the things a screenshot would show:
//
//   the overlap    does the heading sit on top of the text?
//   the clipping   is a button outside the card, or half drawn?
//   the overflow   does the page scroll sideways?
//   the proportion is the list a panel, or half the screen?
//
// It is a real browser, real CSS, real pixels. It is not the application
// running against a live instance, and the report says so.
//
//   node scripts/browser-layout.mjs
//   node scripts/browser-layout.mjs --shots /tmp/shots

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..');
const HARNESS = path.join(CLIENT, 'tests', 'browser', 'layout.html');
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const PORT = Number(process.env.BROWSER_DEBUG_PORT || 9335);

const WIDTHS = [320, 375, 390, 768, 1024, 1280, 1440, 1920];
const HEIGHT = 900;

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const SHOTS = arg('shots', '');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* not yet */ }
    await wait(150);
  }
  throw new Error('timed out waiting for ' + (label || 'something'));
}

// The measurements, taken in the page.
const MEASURE = `
  var root = document.documentElement;
  var out = { width: root.clientWidth, overflow: root.scrollWidth - root.clientWidth, problems: [] };

  // A control that is drawn outside the viewport.
  var outside = [];
  document.querySelectorAll('.btn, button, a[href]').forEach(function (node) {
    var box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      if (box.right > root.clientWidth + 1 || box.left < -1) {
        outside.push((node.textContent || '').trim().slice(0, 30));
      }
    }
  });
  if (outside.length) out.problems.push('these are outside the viewport: ' + outside.join(', '));

  // The card head: the title, the note and the tools must not be on top of
  // each other, and the tools must be inside the card.
  var head = document.querySelector('.cardhead');
  if (head) {
    var card = head.closest('.card');
    var cardBox = card ? card.getBoundingClientRect() : null;
    var label = head.querySelector('.cardhead-label');
    var note = head.querySelector('.cardhead-note');
    var tools = head.querySelector('.cardhead-tools');
    var boxes = {
      label: label ? label.getBoundingClientRect() : null,
      note: note ? note.getBoundingClientRect() : null,
      tools: tools ? tools.getBoundingClientRect() : null,
    };
    // A DOMRect does not survive being sent back as a value - it has no
    // enumerable properties of its own, so every number in it came back as
    // undefined and every comparison with it was false. The check was
    // passing because it could not see anything.
    var plain = function (b) {
      if (!b) return null;
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
        width: b.width, height: b.height };
    };
    out.head = { label: plain(boxes.label), note: plain(boxes.note), tools: plain(boxes.tools) };
    if (boxes.label && boxes.note) {
      var overlap = boxes.label.right > boxes.note.left + 1
        && boxes.label.left < boxes.note.right - 1
        && boxes.label.bottom > boxes.note.top + 1
        && boxes.label.top < boxes.note.bottom - 1;
      if (overlap) out.problems.push('the title and the note are on top of each other');
    }
    if (boxes.label && boxes.tools) {
      var clash = boxes.label.right > boxes.tools.left + 1
        && boxes.label.left < boxes.tools.right - 1
        && boxes.label.bottom > boxes.tools.top + 1
        && boxes.label.top < boxes.tools.bottom - 1;
      if (clash) out.problems.push('the title and the tools are on top of each other');
    }
    // The title truncates; it does not wrap into a column.
    //
    // A card head is one line high. A title that wraps instead of truncating
    // makes the head two hundred pixels tall in a narrow column, and the
    // things beside it are dragged down with it - which is how a heading ends
    // up drawn on top of the text under it.
    if (boxes.label && boxes.label.height > 60) {
      out.problems.push('the title in the card head wraps to '
        + Math.round(boxes.label.height) + ' pixels instead of truncating');
    }
    if (cardBox && boxes.tools) {
      if (boxes.tools.right > cardBox.right + 1) {
        out.problems.push('the tools are outside the card, which clips its overflow');
      }
    }
  }

  // The page head: the title, the lede and the actions.
  var pagehead = document.querySelector('.pagehead');
  if (pagehead) {
    var title = pagehead.querySelector('.pagehead-title');
    var lede = pagehead.querySelector('.pagehead-lede');
    var actions = pagehead.querySelector('.pagehead-actions');
    if (title && lede) {
      var t = title.getBoundingClientRect();
      var l = lede.getBoundingClientRect();
      if (t.bottom > l.top + 1 && t.right > l.left + 1 && t.left < l.right - 1) {
        out.problems.push('the heading and the description are on top of each other');
      }
    }
    if (actions) {
      var a = actions.getBoundingClientRect();
      if (a.right > root.clientWidth + 1) {
        out.problems.push('the actions are outside the viewport');
      }
    }
  }

  // The proportions: the list is a panel, the editor takes the rest.
  var list = document.querySelector('.collection-list');
  var detail = document.querySelector('.collection-detail');
  if (list && detail) {
    var l = list.getBoundingClientRect();
    var d = detail.getBoundingClientRect();
    out.list = Math.round(l.width);
    out.detail = Math.round(d.width);
    if (out.width >= 1280 && l.width > out.width * 0.35) {
      out.problems.push('the list takes ' + Math.round((l.width / out.width) * 100)
        + '% of the screen, which is a list of titles in half the window');
    }
  }

  // The reading column stays narrow.
  var reading = document.querySelector('.fold:not(.fold--wide)');
  if (reading) {
    out.reading = Math.round(reading.getBoundingClientRect().width);
    if (out.width >= 1280 && out.reading > 1200) {
      out.problems.push('the reading column is ' + out.reading + ' pixels wide');
    }
  }

  // The working surface uses the width it is given.
  var wide = document.querySelector('.fold--wide');
  if (wide && list && detail) {
    out.wide = Math.round(wide.getBoundingClientRect().width);
    if (out.width >= 1440 && out.wide < out.width * 0.4) {
      out.problems.push('the working surface is only ' + out.wide
        + ' pixels of a ' + out.width + ' pixel window');
    }
  }

  return out;
`;

// ---- the browser ------------------------------------------------------------

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-layout-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--force-device-scale-factor=1',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (data) => { chromeErrors += data.toString(); });

async function shutdown() {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* already gone */ }
}

class Page {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.waiting = new Map();
    this.events = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.waiting.has(message.id)) {
        this.waiting.get(message.id)(message.result);
        this.waiting.delete(message.id);
        return;
      }
      if (message.method) this.events.push(message);
    };
  }

  send(method, params) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('the browser did not answer ' + method));
      }, 30000);
      this.waiting.set(id, (result) => { clearTimeout(timer); resolve(result); });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const answer = await this.send('Runtime.evaluate', {
      expression: '(function () {' + expression + '})()',
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer && answer.exceptionDetails) {
      const detail = answer.exceptionDetails;
      throw new Error('the page threw: '
        + ((detail.exception && detail.exception.description) || detail.text));
    }
    return answer && answer.result ? answer.result.value : undefined;
  }

  problems() {
    const out = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        out.push('console.error: ' + (event.params.args || [])
          .map((arg) => arg.value || arg.description || arg.type).join(' '));
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const detail = event.params.exceptionDetails || {};
        out.push('exception: ' + ((detail.exception && detail.exception.description) || detail.text));
      }
    }
    this.events = this.events.filter((event) => {
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') return false;
      if (event.method === 'Runtime.exceptionThrown') return false;
      return true;
    });
    return out;
  }
}

// ---- the run ----------------------------------------------------------------

let failures = 0;
const summary = [];

try {
  const target = await until(async () => {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    return list.find((entry) => entry.type === 'page') || null;
  }, 25000, 'the browser');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('the browser refused the connection'));
  });
  const page = new Page(socket);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  await page.send('Page.navigate', { url: 'file://' + HARNESS });
  await until(async () => await page.evaluate('return !!window.__harnessReady;'),
    20000, 'the harness to build the page').catch(() => null);
  await wait(300);

  const ready = await page.evaluate('return !!window.__harnessReady;');
  if (!ready) {
    console.log('the harness did not build the page.');
    for (const problem of page.problems()) console.log('  ' + problem);
    console.log(chromeErrors.slice(0, 800));
    failures += 1;
  } else {
    for (const width of WIDTHS) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
      });
      await wait(160);
      const measured = await page.evaluate(MEASURE);
      const problems = page.problems().concat(measured.problems || []);
      summary.push({ width, ...measured, problems });
      if (problems.length) {
        failures += problems.length;
        console.log('  FAIL  ' + width + 'px');
        for (const problem of problems) console.log('          ' + problem);
      } else {
        console.log('  ok    ' + width + 'px  list=' + measured.list
          + ' detail=' + measured.detail + ' reading=' + measured.reading
          + ' working=' + measured.wide);
      }
      if (process.env.BROWSER_LAYOUT_VERBOSE && measured.head) {
        const h = measured.head;
        const box = (b) => (b ? Math.round(b.left) + '..' + Math.round(b.right) + ' h' + Math.round(b.height) : 'none');
        console.log('        head: label ' + box(h.label) + ' note ' + box(h.note) + ' tools ' + box(h.tools));
      }
      if (SHOTS) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'layout-' + width + '.png'),
          Buffer.from(shot.data, 'base64'));
      }
    }
  }
} catch (error) {
  console.log('the layout run failed: ' + (error && error.message));
  console.log(chromeErrors.slice(0, 800));
  failures += 1;
} finally {
  await shutdown();
}

console.log('\n' + WIDTHS.length + ' width(s) measured in a real browser; '
  + failures + ' fault(s).');
process.exit(failures ? 1 : 0);
