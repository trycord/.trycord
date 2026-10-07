// Render the application in a real Chromium without letting the browser touch the
// network.
//
// The problem this exists to solve: some sandboxes have a Chromium that starts, attaches
// over CDP and evaluates JavaScript happily, and then never completes an http request.
// The page sits on about:blank forever and every screenshot is a rectangle of nothing.
// That is a fact about the browser's network service in that environment, not about the
// application.
//
// The way around it is to stop asking the browser to do the network. Load about:blank,
// which does work, then hand the document to it from the outside:
//
//   - the real stylesheet is read off disk and adopted, so layout, cascade, custom
//     properties and media queries are the browser's own
//   - window.fetch is replaced with a bridge that sends the request over CDP to Node,
//     which performs it with Node's http client, and the answer is delivered back
//
// Nothing the browser is being asked for requires its network stack, which is the only
// part that hangs. What comes out is genuine Chromium layout - real boxes, real computed
// colours, real media query evaluation - which is the thing jsdom cannot give us and the
// thing the render check most wants to assert about.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

function findChromium() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

// Node 22 has a WebSocket built in, so this needs no dependency and no install step.
function webSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
}

export class Browser {
  constructor(proc, ws, userDataDir) {
    this.proc = proc;
    this.ws = ws;
    this.userDataDir = userDataDir;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null) {
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
        return;
      }
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) fn(msg.params);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP timed out: ' + method));
      }, 30000);
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }

  // Evaluate an expression in the page and return its value, awaiting promises.
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlocklistedAPI: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('page threw: ' + (d.exception?.description || d.text));
    }
    return res.result?.value;
  }

  async close() {
    try { this.ws.close(); } catch { /* already gone */ }
    try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export async function launch({ port = 0, userDataDir } = {}) {
  const bin = findChromium();
  if (!bin) return null;

  const devPort = port || 9500 + Math.floor(Math.random() * 400);
  const dir = userDataDir || ('/tmp/opencode/cdp-profile-' + process.pid + '-' + devPort);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    // The two that get a sandboxed Chromium to actually finish starting.
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + devPort,
    '--user-data-dir=' + dir,
    'about:blank',
  ];

  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for the debugging endpoint rather than guessing at a sleep.
  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:' + devPort + '/json/version', (res) => {
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => resolve(out));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy());
      });
      version = JSON.parse(body);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!version) {
    proc.kill('SIGKILL');
    throw new Error('chromium never opened its debugging port.\n' + stderr.slice(-800));
  }

  // Attach to a *page* target, not the browser endpoint. The browser endpoint answers
  // /json/version and is where you find the browser's own capabilities - Page, Runtime
  // and DOM are per-target, and asking the browser endpoint for them gets an error whose
  // message is the whole story: "'Page.enable' wasn't found".
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const raw = await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:' + devPort + '/json/list', (res) => {
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => resolve(out));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy());
      });
      const pages = JSON.parse(raw).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      target = pages[0] || null;
    } catch { /* not up yet */ }
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) {
    proc.kill('SIGKILL');
    throw new Error('chromium opened its port but published no page target.');
  }

  const ws = await webSocket(target.webSocketDebuggerUrl);
  const b = new Browser(proc, ws, dir);
  await b.send('Page.enable');
  await b.send('Runtime.enable');
  await b.send('DOM.enable');
  return b;
}

// --- the network bridge -------------------------------------------------------

// Node performs the request, so the browser's broken network service is never involved.
function nodeFetch(url, method, headers, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const u = new URL(url, 'http://bridge.invalid');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: headers || {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          body: buf.toString('utf8'),
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, statusText: String(e.message), headers: {}, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, statusText: 'timeout', headers: {}, body: '' }); });
    if (body != null && body !== '') req.write(body);
    req.end();
  });
}

// The page side. Injected by string, so it cannot close over anything in this file.
const PAGE_BRIDGE = `
(() => {
  const pending = new Map();
  let seq = 0;
  window.__bridgeResolve = (payload) => {
    const slot = pending.get(payload.id);
    if (!slot) return;
    pending.delete(payload.id);
    clearTimeout(slot.timer);
    if (payload.networkError) {
      slot.reject(new TypeError(payload.networkError));
      return;
    }
    slot.resolve({
      ok: payload.ok,
      status: payload.status,
      statusText: payload.statusText,
      headers: payload.headers,
      body: payload.body,
      url: payload.url,
      json: () => (payload.body ? Promise.resolve(JSON.parse(payload.body)) : Promise.resolve(null)),
      text: () => Promise.resolve(payload.body),
      clone() { return this; },
    });
  };
  window.fetch = (input, init) => new Promise((resolve, reject) => {
    const o = init || {};
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new TypeError('bridge timeout'));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    let body = o.body;
    if (body && typeof body !== 'string') body = '[binary]';
    window.__nodeCall(JSON.stringify({
      id, url,
      method: o.method || (typeof input === 'object' && input && input.method) || 'GET',
      headers: o.headers || {},
      body: body == null ? null : String(body),
    }));
  });
  return true;
})()
`;

// Node side of the same bridge: receives the request, performs it, delivers the answer.
export function installBridge(browser, { origin, onRequest } = {}) {
  browser.on('Runtime.bindingCalled', async (params) => {
    if (params.name !== '__nodeCall') return;
    let msg;
    try { msg = JSON.parse(params.payload); } catch { return; }
    let answer;
    if (onRequest) {
      const handled = await onRequest(msg);
      if (handled) { answer = handled; }
    }
    if (!answer) {
      const abs = msg.url.startsWith('http') ? msg.url : (origin || '') + msg.url;
      answer = await nodeFetch(abs, msg.method, msg.headers, msg.body);
    }
    await browser.eval('window.__bridgeResolve(' + JSON.stringify({
      id: msg.id,
      ok: answer.ok,
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers || {},
      body: answer.body,
      url: answer.url || msg.url,
      networkError: answer.networkError,
    }) + ');');
  });
  return browser.send('Runtime.addBinding', { name: '__nodeCall' })
    .then(() => browser.eval(PAGE_BRIDGE));
}

export { nodeFetch, findChromium, once };
