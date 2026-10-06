// Minimal CDP driver.
//
// Everything this project asserts about the client has to be asserted in a real
// browser, because the failures worth catching are a document that loads but
// cannot draw, a route that resolves to the wrong view, a control that throws.
// None of that shows up in a fetch.
//
// Speaks the DevTools protocol over the browser's own WebSocket rather than
// pulling in a driver library: one file, no install step, and it does not care
// which Chromium is on the machine.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  throw new Error('no chromium found; set CHROME_BIN');
}

async function httpJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(2000),
  });
  return res.json();
}

export async function launch({ width = 1440, height = 900, port = 9333, url } = {}) {
  const bin = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'tc-chrome-'));
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--hide-scrollbars',
    url || 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // Wait for the debugging endpoint, then for a usable page target.
  //
  // Chromium often exposes more than one 'page' target, and the first one
  // listed can still be the initial about:blank with no web origin. Attaching
  // to that and calling Page.navigate makes navigation hang and every fetch
  // inside the page fail to resolve a URL - which reads like the application
  // or the server is broken, and is not. Pick the tab that already has an http
  // origin, and only fall back to about:blank if that is genuinely all there is.
  let target = null;
  let blank = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await httpJson(port, '/json/list');
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      target = pages.find((t) => /^https?:/i.test(t.url || '')) || null;
      if (!target) blank = pages.find((t) => (t.url || '') === 'about:blank') || blank;
    } catch { /* not listening yet */ }
    if (!target) await new Promise((r) => setTimeout(r, 250));
  }
  // When a startup url was given and only about:blank exists, the navigation
    // has not committed yet; give it a moment rather than attaching to a
    // context with no origin, which cannot resolve any relative URL.
  if (!target && url) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const pages = (await httpJson(port, '/json/list'))
          .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        target = pages.find((t) => /^https?:/i.test(t.url || '')) || null;
        if (target) break;
      } catch { /* keep waiting */ }
    }
  }
  if (!target) target = blank;
  if (!target) {
    proc.kill('SIGKILL');
    throw new Error(
      'no usable page target. Chromium is running but exposed no page with a ' +
      'webSocketDebuggerUrl within 20s. That is a cold or contended runner, not ' +
      'a fault in the client or the server - retry the job.'
    );
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
      else resolve(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + ' timed out'));
    }, method === 'Page.navigate' ? 60000 : 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  // Chromium refuses to commit a navigation on some machines - it opens the
  // tab, issues the request, and leaves the execution context on about:blank.
  // A raw protocol timeout says nothing useful about that, so say it here
  // instead, once, rather than leaving every suite to fail the same opaque way.
  let firstNav = true;
  const navigate = async (url) => {
    try {
      await send('Page.navigate', { url });
    } catch (e) {
      if (firstNav && /timed out/i.test(e.message)) {
        throw new Error(
          'chromium accepted the tab but never navigated to ' + url + '.\n' +
          'This machine\'s chromium cannot fetch http URLs - a data: URL renders,\n' +
          'every http request comes back empty. It is not a fault in the client\n' +
          'or the server. See scripts/browser/README.md.'
        );
      }
      throw e;
    }
    firstNav = false;
  };

  const api = {
    async goto(url, { waitMs = 1400 } = {}) {
      if (!url || typeof url !== 'string') throw new Error('goto called with ' + url);
      await navigate(url);
      await new Promise((r) => setTimeout(r, waitMs));
      return api;
    },

    async setViewport(w, h) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
    },

    // The expression runs in the page, so it has to be a function body.
    async eval(expr, { awaitPromise = true } = {}) {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`,
        awaitPromise,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        const e = r.exceptionDetails;
        throw new Error('page threw: ' + (e.exception?.description || e.text));
      }
      return r.result?.value;
    },

    async waitFor(exprSrc, { timeout = 12000, every = 250 } = {}) {
      const started = Date.now();
      for (;;) {
        try {
          const v = await api.eval(`return (${exprSrc});`);
          if (v) return v;
        } catch { /* the page may still be booting */ }
        if (Date.now() - started > timeout) return null;
        await new Promise((r) => setTimeout(r, every));
      }
    },

    async click(selector, { timeout = 12000 } = {}) {
      const ok = await api.waitFor(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`,
        { timeout },
      );
      if (!ok) throw new Error('no element for ' + selector);
      await new Promise((r) => setTimeout(r, 400));
      return api;
    },

    // Sets the value through the native setter so frameworks that watch the
    // property actually see the change, rather than the assignment being
    // swallowed because the setter is overridden.
    async type(selector, value) {
      const done = await api.eval(`
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return false;
        e.focus();
        const proto = e.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                    : e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
                    : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(e, ${JSON.stringify(value)});
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `);
      if (!done) throw new Error('no field for ' + selector);
      return api;
    },

    async text(selector) {
      return api.eval(`
        const e = document.querySelector(${JSON.stringify(selector)});
        return e ? e.innerText : null;`);
    },

    async shot(file, { full = false } = {}) {
      const params = { format: 'png' };
      if (full) params.captureBeyondViewport = true;
      const r = await send('Page.captureScreenshot', params);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },

    resetErrors() { events.length = 0; },

    // Errors only. Console warnings are noise here: a 401 while signed out is
    // the right answer, not a fault.
    async errors() {
      const out = [];
      for (const e of events) {
        if (e.method === 'Runtime.exceptionThrown') {
          const d = e.params.exceptionDetails;
          out.push('EXCEPTION ' + (d.exception?.description || d.text || '').split('\n')[0]);
        } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
          out.push(e.params.entry.text);
        }
      }
      return out;
    },

    async close() {
      try { ws.close(); } catch { /* already gone */ }
      proc.kill('SIGKILL');
    },
  };

  return api;
}

/**
 * Wait for a server rather than assuming a fixed delay was enough. On a cold
 * database the first boot applies every migration before it listens, so a sleep
 * produces ERR_CONNECTION_REFUSED and then 404s from the client's early session
 * calls - a failure that looks exactly like a product fault.
 */
export async function waitForServer(url, ms = 40000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).status) return;
    } catch { /* not listening yet */ }
    if (Date.now() > until) throw new Error('server never came up at ' + url);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Register, sign in, and return a page already sitting inside the application.
 *
 * Every suite needs a signed-in user with a community, and doing that by hand in
 * each file is how suites end up asserting against a half-built instance.
 */
export async function signedIn(page, origin, { seedCommunity = false } = {}) {
  const uniq = Math.random().toString(36).slice(2, 8);
  await page.goto(origin + '/');
  await page.eval(`localStorage.clear(); localStorage.setItem('trycord.backendUrl', ${JSON.stringify(origin)}); return 1;`);
  await page.goto(origin + '/register', { waitMs: 900 });
  await page.waitFor(`!!document.querySelector('.auth-form #reg-username')`, { timeout: 20000 });
  await page.type('#reg-username', 'u' + uniq);
  await page.type('#reg-password', 'correcthorse1');
  await page.click('.auth-form button[type="submit"]');
  await page.waitFor(`!!localStorage.getItem('trycord.token')`, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 1500));

  if (!seedCommunity) return { username: 'u' + uniq, serverId: null };

  const seed = await page.eval(`
    const t = localStorage.getItem('trycord.token');
    const j = async (m, p, b) => {
      const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const s = await j('POST', '/api/servers', { name: 'The Foundry', description: 'Where the thing gets built.' });
    if (s.status >= 300) return { error: s.status };
    const id = s.body.serverId;
    // Creating a community already makes a category and a #general channel. Adding
    // another channel also called general here produced two rows with the same name
    // in the sidebar, which reads as a duplicate-navigation bug and is not one.
    const layout = await j('GET', '/api/servers/' + id + '/channels');
    const general = (layout.body.channels || [])[0];
    if (!general) return { error: 'the new community has no channel', id };
    const cid = (c) => c.channelId || c.id;
    const lines = [
      'Morning all - pushed the routing rewrite last night, direct links work now.',
      'One thing I noticed: the sidebar still collapses at 1280 and I think it should not.',
      'Agreed. The breakpoint is set for the three-column case, not this one.',
      'I can take that after standup.',
      'The preview cards are working nicely now by the way.',
      'Do they still respect the per-message opt-out?',
      'They do, it is enforced on the server not just hidden in the client.',
    ];
    for (const line of lines) await j('POST', '/api/channels/' + cid(general) + '/messages', { content: line });
    return { id, channelId: cid(general) };`);
  return { username: 'u' + uniq, serverId: seed.id || null, seed };
}

export default { launch, waitForServer, signedIn };