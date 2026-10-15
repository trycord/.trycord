#!/usr/bin/env node
'use strict';

// The crash reporter, and where it sits on the screen.
//
// This file used to guard `recoverFromStaleGraph`: a tab holding public.js from one build
// and config.js from another would be silently reloaded once before the reader saw
// anything. The rewrite removed that behaviour on purpose - the reporter reports, it does
// not try to repair the graph behind the reader - so what is checked here is the surface a
// reader actually gets now.
//
// The first four assertions are the mobile bug, which is the reason this is worth a check
// at all. The report was laid out inside the mount point, and the mount point is a full
// viewport tall, so a report that is also a viewport tall overflows it and the document
// scrolls: on a phone the message sat below the fold and the reader had to scroll to find
// it. It is fixed to the viewport now, out of the page flow entirely, and `overflow:auto`
// keeps a genuinely over-long report reachable without moving the page behind it.
//
// The rest is the same distinction the old check drew, kept because it is still the thing
// that sends a reader to the wrong place: a resource that failed to load is not a module
// that threw, and a cancelled request is neither.
//
// runScripts must be 'dangerously' - with 'outside-only' the document's own scripts do not
// execute at all, and the harness tests nothing.
//
//   node scripts/check-crash-screen.js

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const CRASH = path.join(__dirname, '..', '..', 'frontend', 'packages', 'crash.js');

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

function mount(html) {
  const dom = new JSDOM(html || '<!doctype html><body><div id="app" class="app-root"></div></body>', {
    url: 'http://x/app/settings',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  const el = w.document.createElement('script');
  el.textContent = fs.readFileSync(CRASH, 'utf8');
  w.document.body.appendChild(el);
  return w;
}

const report = (w) => w.document.getElementById('app').querySelector('[role="alert"]');
const textOf = (w) => {
  const node = report(w);
  return node ? node.textContent : '';
};

// A resource error, dispatched the way the browser fires one: on the element, with no
// message and not bubbling. The listener has to be on window in the capture phase to see
// it, which is the half of this the check exists to keep.
function resourceError(w, tag, url) {
  const node = w.document.createElement(tag);
  if (tag === 'link') node.href = url; else node.src = url;
  // Attached, or the event has no path to window and nothing sees it.
  w.document.body.appendChild(node);
  const event = new w.Event('error');
  node.dispatchEvent(event);
}

// -- it covers the screen, including on a phone -------------------------------

{
  const w = mount();
  resourceError(w, 'script', '/js/does-not-exist.js');
  const alert = report(w);
  ok('a file that will not load paints the report', !!alert, 'no [role=alert] was painted');
  if (alert) {
    ok('the report leaves the page flow, so it cannot sit below the fold',
      alert.style.position === 'fixed', 'position was ' + alert.style.position);
    ok('and is pinned to all four edges of the viewport',
      /inset:\s*0/.test(alert.style.cssText), alert.style.cssText.slice(0, 60));
    ok('and scrolls internally if the report is over-long',
      alert.style.overflow === 'auto', 'overflow was ' + alert.style.overflow);
  } else {
    ok('the report leaves the page flow, so it cannot sit below the fold', false);
    ok('and is pinned to all four edges of the viewport', false);
    ok('and scrolls internally if the report is over-long', false);
  }
  ok('and names the file that failed',
    /does-not-exist\.js/.test(textOf(w)), textOf(w).slice(0, 90));
  ok('and says a required file failed to load',
    /failed to load/i.test(textOf(w)), textOf(w).slice(0, 90));
}

// -- the reader can act on it -------------------------------------------------

{
  const w = mount();
  resourceError(w, 'script', '/js/app.js');
  const alert = report(w);
  const buttons = alert ? [...alert.querySelectorAll('button')] : [];
  ok('there is a reload and a way to see the detail',
    buttons.length === 2 && /reload/i.test(buttons[0].textContent)
      && /details/i.test(buttons[1].textContent),
    buttons.length ? buttons.map((b) => b.textContent).join(', ') : 'no buttons');
  const pre = alert && alert.querySelector('pre');
  ok('the detail starts hidden', !!pre && pre.style.display === 'none');
  if (buttons[1] && pre) {
    buttons[1].click();
    ok('and the toggle reveals it', pre.style.display === 'block', 'display was ' + pre.style.display);
  } else {
    ok('and the toggle reveals it', false, 'no toggle button or detail element');
  }
}

// -- resource, fault and cancellation are told apart --------------------------

{
  const w = mount();
  resourceError(w, 'link', '/js/app.css');
  ok('a stylesheet that will not load is reported too',
    /app\.css/.test(textOf(w)) && /failed to load/i.test(textOf(w)), textOf(w).slice(0, 90));
}

{
  const w = mount();
  resourceError(w, 'img', '/img/avatar.png');
  ok('an image that will not load is not a crash', !report(w),
    'the report was painted for a missing image');
}

{
  const w = mount();
  w.dispatchEvent(new w.ErrorEvent('error', {
    message: 'TypeError: avatar is not a function',
    filename: 'http://x/js/shell.js',
    lineno: 42,
  }));
  ok('a module that threw reports what it threw',
    /avatar is not a function/.test(textOf(w)), textOf(w).slice(0, 90));
  ok('and names where it happened', /shell\.js/.test(textOf(w)), textOf(w).slice(0, 90));
}

{
  const w = mount();
  const event = new w.Event('unhandledrejection');
  event.reason = new Error('boom');
  w.dispatchEvent(event);
  ok('an unhandled rejection is reported',
    /handling a response/i.test(textOf(w)), textOf(w).slice(0, 90));
}

{
  const w = mount();
  const event = new w.Event('unhandledrejection');
  const aborted = new Error('The user aborted a request.');
  aborted.name = 'AbortError';
  event.reason = aborted;
  w.dispatchEvent(event);
  ok('a cancelled request is not a crash', !report(w), 'the report was painted for an AbortError');
}

// -- one report, standing in for whatever the mount held ----------------------

{
  const w = mount('<!doctype html><body><div id="app" class="app-root">'
    + '<div id="shell">the application</div></div></body>');
  w.dispatchEvent(new w.ErrorEvent('error', { message: 'the first failure' }));
  ok('the report replaces whatever the mount held',
    !w.document.getElementById('shell'), 'the old mount content is still there');
  w.dispatchEvent(new w.ErrorEvent('error', { message: 'the second failure' }));
  const reports = w.document.getElementById('app').querySelectorAll('[role="alert"]');
  ok('a later failure replaces the earlier one rather than stacking',
    reports.length === 1 && /the second failure/.test(textOf(w)),
    reports.length + ' report(s): ' + textOf(w).slice(0, 60));
}

console.log(failures
  ? `\n  crash screen FAILED - ${failures} assertion(s)\n`
  : '\n  crash screen passed - the report covers the viewport and says what failed\n');
process.exit(failures ? 1 : 0);
