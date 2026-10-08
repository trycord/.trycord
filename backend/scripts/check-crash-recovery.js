// Does the crash surface recover by itself from a half-updated module graph?
//
// The failure this covers: a tab holds public.js from one build and config.js from
// another, the import names a thing that no longer exists, and the whole application is
// dead with an error message and nothing to do about it.
//
// runScripts must be 'dangerously' - with 'outside-only' the document's own scripts do
// not execute at all, which is how the first two attempts at this harness tested nothing.
const { JSDOM } = require('jsdom');
// Both of these were absolute paths into one machine's working copy: the jsdom import
// and the crash.js it mounts. On CI neither resolved, so the check was asserting that a
// file it could not read was fine.
const fs = require('fs');
const path = require('path');

const STALE = "Uncaught SyntaxError: The requested module '../config.js' does not"
  + " provide an export named 'BACKEND_URL'";

function mount() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'http://x/app/settings',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  const store = {};
  // crash.js asks the server what it actually said about a file the browser would not load,
  // because the browser throws that away. Stubbed here so each status can be checked; left
  // to jsdom it would be a different answer on a different day and the check would drift.
  const net = { status: 404, type: 'text/javascript; charset=utf-8', reject: false, calls: 0 };
  Object.defineProperty(w, 'fetch', {
    configurable: true,
    value: (url, opts) => {
      net.calls++;
      net.url = url;
      net.cache = opts && opts.cache;
      if (net.reject) return Promise.reject(new Error('Failed to fetch'));
      const type = net.type;
      return Promise.resolve({
        status: net.status,
        headers: {
          get: (k) => (String(k).toLowerCase() === 'content-type' ? type : null),
        },
      });
    },
  });
  Object.defineProperty(w, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  });
  const el = w.document.createElement('script');
  // Resolved from this file rather than written out, like every other check in this
  // directory. It was an absolute path into one developer's working copy, which means it
  // read a stale crash.js - or found nothing at all - on every other machine, including
  // CI, where it would have been asserting nothing about anything.
  el.textContent = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'crash.js'), 'utf8');
  w.document.body.appendChild(el);
  return { w, store, net };
}

// The same failure, told apart by what the server actually answered. 404 is a bug in the
// repository and 521 is an origin that is not running; before this, both said "the server
// did not send it", which sends a reader to the wrong place entirely - one to edit a file,
// one to go and restart a machine.
const statuses = (async () => {
  // The failure a reader actually sees, after the status probe has answered.
  {
    const { w, store } = mount();
    const script = w.document.createElement('script');
    script.src = '/js/does-not-exist.js';
    w.document.body.appendChild(script);
    const fire = () => script.dispatchEvent(new w.Event('error'));
    fire();
    fire();
    await new Promise((r) => setTimeout(r, 0));
    check('a file the server did not send says so',
      !!w.document.getElementById('trycord-crash'),
      'no #trycord-crash was painted, so the page went dark with nothing on it');
  }

  const say = async (status, reject, type) => {
    const { w, store, net } = mount();
    net.status = status;
    net.reject = !!reject;
    if (type !== undefined) net.type = type;
    const script = w.document.createElement('script');
    script.src = '/js/app.js';
    w.document.body.appendChild(script);
    const fire = () => script.dispatchEvent(new w.Event('error'));
    fire();
    fire();
    await new Promise((r) => setTimeout(r, 0));
    return { text: w.document.getElementById('trycord-crash').textContent || '', net };
  };

  const missing = await say(404);
  check('a 404 says the server does not have the file',
    /404/.test(missing.text) && /does not have/.test(missing.text), missing.text.slice(0, 100));

  const jsOk = await say(200, false, 'text/javascript; charset=utf-8');

  const down = await say(521);
  check('a 521 says the origin refused the connection',
    /521/.test(down.text) && /refused the connection/.test(down.text), down.text.slice(0, 100));

  const unreachable = await say(0, true);
  check('an unreachable server says so in its own words',
    /could not be reached/.test(unreachable.text), unreachable.text.slice(0, 100));

  // A 200 whose body is not a script. This is the desktop window's old answer to every
  // unresolved request - the application shell - and it is why the failure looked like a
  // healthy server: the status said 200, so the screen said "HTTP 200", which says nothing
  // about why the browser refused to run it.
  const shell = await say(200, false, 'text/html; charset=utf-8');
  check('a 200 that is not a script says so',
    /200/.test(shell.text) && /text\/html/.test(shell.text) && /rather than a script/.test(shell.text),
    shell.text.slice(0, 110));
  check('and a 200 that is a script is reported as such',
    /200/.test(jsOk.text) && !/rather than a script/.test(jsOk.text), jsOk.text.slice(0, 110));

  check('the status is asked for fresh, not from cache',
    down.net.cache === 'no-store', 'cache was ' + down.net.cache);
  check('and the file that failed is the one asked about',
    /app\.js$/.test(down.net.url || ''), down.net.url);
})();

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

// A file the server does not answer. The browser fires a non-bubbling `error` on the
// element that failed, with no message, so a listener without the capture flag never
// sees it and the application goes dark without a word. `ui/usercard.js` imported
// './components.js' when the module is one level up and that is exactly what happened.
{
  const { w, store } = mount();
  const crashed = () => !!w.document.getElementById('trycord-crash');
  const script = w.document.createElement('script');
  script.src = '/js/does-not-exist.js';
  // Attached, or the event has no path to window and nothing sees it - which is the other
  // half of why this failure was invisible.
  w.document.body.appendChild(script);
  // A resource error carries no message and does not bubble; dispatch it on the element
  // the way the browser does, and let the listener find it or not.
  const fire = () => {
    const ev = new w.Event('error');
    ev.target = script;
    script.dispatchEvent(ev);
  };
  // The first one is spent on the stale-graph reload, because a file that was cached and
  // is gone now looks exactly like a file that was never there. The second is the one a
  // reader sees, and it has to be a message rather than a black screen.
  fire();
  check('a missing file is treated as a stale graph once', !crashed() && store['trycord.staleReload'] === '1',
    'reload flag is ' + store['trycord.staleReload']);
  // The second failure no longer paints synchronously: it asks the server what it said
  // before saying anything, so that a missing file and an unreachable origin are not the
  // same sentence. The painted-message assertions moved into the async block below.
}

// 1. The exact failure the tab hit: recover silently, do not apologise.
{
  const { w, store } = mount();
  if (!w.document.getElementById('trycord-crash') && !store.ran) { /* no marker */ }
  w.dispatchEvent(new w.ErrorEvent('error', {
    message: STALE, filename: 'http://x/app/js/public/public.js', lineno: 6, colno: 25,
  }));
  check('stale graph arms the one-shot reload', store['trycord.staleReload'] === '1');
  check('stale graph does not show the crash screen',
    !w.document.getElementById('trycord-crash'));
}

// 2. Same failure again after the refetch: surface it rather than loop forever.
{
  const { w, store } = mount();
  w.dispatchEvent(new w.ErrorEvent('error', { message: STALE }));
  w.dispatchEvent(new w.ErrorEvent('error', { message: STALE }));
  check('a second failure is surfaced, not retried forever',
    !!w.document.getElementById('trycord-crash'), 'no crash screen on the second failure');
}

// 3. An ordinary fault must not reload - that would hide a real bug behind a refetch.
{
  const { w, store } = mount();
  w.dispatchEvent(new w.ErrorEvent('error', {
    message: 'TypeError: avatar is not a function',
    filename: 'http://x/app/js/shell.js', lineno: 42,
  }));
  check('an unrelated error does not trigger a reload', !('trycord.staleReload' in store));
  check('an unrelated error shows the crash screen',
    !!w.document.getElementById('trycord-crash'));
}

// 4. Pressing Reload clears the flag, so a later failure can recover again.
{
  const { w, store } = mount();
  w.dispatchEvent(new w.ErrorEvent('error', { message: STALE }));
  w.dispatchEvent(new w.ErrorEvent('error', { message: STALE }));
  const btn = w.document.getElementById('trycord-crash').querySelector('button');
  btn.click();
  check('the Reload button clears the one-shot flag', !('trycord.staleReload' in store));
}

statuses.then(() => {
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? '  <- ' + r.detail : ''}`);
}
console.log(bad
  ? `\n  crash recovery FAILED - ${bad} of ${results.length} assertions\n`
  : `\n  crash recovery passed - ${results.length} assertions\n`);
// exitCode, not exit(): process.exit() drops buffered stdout when it is a pipe.
process.exitCode = bad ? 1 : 0;
});