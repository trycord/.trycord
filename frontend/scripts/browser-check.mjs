#!/usr/bin/env node
'use strict';

// The client, driven in a real browser.
//
// A browser is the only thing that can say what a page actually looks like
// and what it actually throws. The checks here are about three things the
// source cannot tell you:
//
//   the console   what the page printed while it ran - an error in a click
//                 handler, a warning, a failed request;
//   the layout    where things actually are, in pixels, at a given width;
//   the crash     a page that throws on the way in.
//
// It is a small driver rather than a framework: the DevTools protocol over a
// websocket, and the browser is Chromium.
//
//   node scripts/browser-check.mjs --base http://127.0.0.1:9971
//   node scripts/browser-check.mjs --widths 320,768,1440 --paths /app/home
//
// It exits non-zero when a page printed an error or threw, so it can be a
// build step.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const DEBUG_PORT = Number(process.env.BROWSER_DEBUG_PORT || 9333);

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const BASE = String(arg('base', 'http://127.0.0.1:9971')).replace(/\/+$/, '');
const WIDTHS = String(arg('widths', '390,768,1280,1920')).split(',').map((n) => Number(n.trim())).filter(Boolean);
const PATHS = String(arg('paths', '/app/home,/app/menu,/app/search,/app/settings,/admin')).split(',').map((p) => p.trim()).filter(Boolean);
const SHOTS = arg('shots', '');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await wait(150);
  }
  throw new Error('timed out waiting for ' + (label || 'something') + (last ? ': ' + last.message : ''));
}

// ---- the browser ------------------------------------------------------------

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-browser-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (data) => { chromeErrors += data.toString(); });

async function shutdown() {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* already gone */ }
}

// ---- a page -----------------------------------------------------------------

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
      const text = (detail.exception && detail.exception.description) || detail.text;
      throw new Error('the page threw: ' + text);
    }
    return answer && answer.result ? answer.result.value : undefined;
  }

  // The console and the exceptions, since the last time they were read.
  problems() {
    const out = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        out.push({
          kind: 'console.error',
          text: (event.params.args || []).map((arg) => arg.value || arg.description || arg.type).join(' '),
        });
      }
      if (event.method === 'Runtime.exceptionThrown') {
        const detail = event.params.exceptionDetails || {};
        out.push({
          kind: 'exception',
          text: (detail.exception && detail.exception.description) || detail.text || 'an exception',
        });
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

async function openPage() {
  // Any page will do: the browser opens with a blank one and it is
  // navigated afterwards. Waiting for a page that already has an address
  // would wait for ever, because nothing has asked it for one yet.
  const target = await until(async () => {
    const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
    const page = list.find((entry) => entry.type === 'page');
    return page || null;
  }, 25000, 'the browser');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('the browser refused the connection'));
  });
  const page = new Page(socket);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  if (process.env.BROWSER_CHECK_VERBOSE) {
    console.log('  the page target is ' + target.url);
  }
  return page;
}

async function setWidth(page, width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
}

// ---- the run ----------------------------------------------------------------

const report = [];
let failures = 0;

try {
  await until(async () => {
    const answer = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
    return answer.ok ? true : null;
  }, 25000, 'the browser to start');

  for (const width of WIDTHS) {
    const page = await openPage();
    try {
      for (const route of PATHS) {
        const url = BASE + route;
        await page.send('Page.navigate', { url });
        // The client boots, reads its configuration and draws. Give it the
        // time it needs rather than a fixed guess.
        await until(async () => {
          const ready = await page.evaluate(
            'return { ready: document.readyState, app: !!document.getElementById("app"),'
            + ' body: (document.body && document.body.innerText || "").slice(0, 200) };',
          );
          return ready && (ready.ready === 'complete') ? ready : null;
        }, 15000, route).catch(() => null);
        await wait(600);

        const problems = page.problems();
        const measured = await page.evaluate(`
          var root = document.documentElement;
          var overflow = root.scrollWidth - root.clientWidth;
          var head = document.querySelector('.pagehead, .cardhead');
          var headBox = head ? head.getBoundingClientRect() : null;
          var clipped = [];
          document.querySelectorAll('.btn, button, a[href]').forEach(function (node) {
            var box = node.getBoundingClientRect();
            if (box.width > 0 && box.height > 0 && (box.right > root.clientWidth + 1 || box.left < -1)) {
              clipped.push((node.textContent || '').trim().slice(0, 40));
            }
          });
          return {
            overflow: overflow,
            head: headBox ? { top: headBox.top, height: headBox.height, width: headBox.width } : null,
            clipped: clipped.slice(0, 5),
            title: document.title,
            text: (document.body ? document.body.innerText : '').slice(0, 120)
          };
        `);

        const entry = {
          width, route, url,
          problems,
          overflow: measured ? measured.overflow : null,
          clipped: measured ? measured.clipped : [],
          head: measured ? measured.head : null,
          title: measured ? measured.title : '',
        };
        report.push(entry);

        const faults = [];
        for (const problem of problems) faults.push(problem.kind + ': ' + problem.text);
        if (entry.overflow > 2) {
          faults.push('the page scrolls sideways by ' + entry.overflow + ' pixels');
        }
        if (entry.clipped && entry.clipped.length) {
          faults.push('these are outside the viewport: ' + entry.clipped.join(', '));
        }
        if (faults.length) {
          failures += faults.length;
          console.log('  FAIL  ' + width + 'px ' + route);
          for (const fault of faults) console.log('          ' + fault);
        } else {
          console.log('  ok    ' + width + 'px ' + route);
        }

        if (SHOTS) {
          const shot = await page.send('Page.captureScreenshot', { format: 'png' });
          const file = path.join(SHOTS, route.replace(/[^a-z0-9]+/gi, '-') + '-' + width + '.png');
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        }
      }
    } finally {
      try { page.socket.close(); } catch { /* already closed */ }
    }
  }
} catch (error) {
  console.log('the browser run failed: ' + (error && error.message));
  console.log(chromeErrors.slice(0, 800));
  failures += 1;
} finally {
  await shutdown();
}

console.log('\n' + report.length + ' page(s) at ' + WIDTHS.length + ' width(s); '
  + failures + ' fault(s).');
process.exit(failures ? 1 : 0);
