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
  return { w, store };
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

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

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? '  <- ' + r.detail : ''}`);
}
console.log(bad
  ? `\n  crash recovery FAILED - ${bad} of ${results.length} assertions\n`
  : `\n  crash recovery passed - ${results.length} assertions\n`);
process.exit(bad ? 1 : 0);