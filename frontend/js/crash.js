(function () {
  function paintError(msg) {
    if (document.getElementById('trycord-crash')) return;
    var e = document.createElement('div');
    e.id = 'trycord-crash';
    e.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:var(--t-base,rgba(10,10,12,.96));color:var(--t-txt,#fff);font-family:inherit;';
    var box = document.createElement('div');
    box.style.cssText = 'text-align:center;padding:24px;max-width:460px;';
    var t = document.createElement('div');
    t.style.cssText = 'font-weight:700;font-size:1.05rem;margin-bottom:8px;';
    t.textContent = 'Trycord could not start';
    var p = document.createElement('p');
    p.style.cssText = 'opacity:.75;font-size:.9rem;margin:0 0 16px;';
    p.textContent = msg || 'A page script failed to load.';
    var b = document.createElement('button');
    b.style.cssText =
      'border:1px solid var(--t-line,rgba(255,255,255,.2));background:var(--t-accent,#ff914d);' +
      'color:var(--t-on-accent,#111);border-radius:8px;padding:8px 18px;font:inherit;cursor:pointer;';
    b.textContent = 'Reload';
    // Clears the one-shot stale-graph flag, so pressing this always gets the full
    // automatic recovery back rather than one refetch short of it.
    b.addEventListener('click', function () {
      try { sessionStorage.removeItem('trycord.staleReload'); } catch (e) { /* private mode */ }
      location.reload();
    });
    box.appendChild(t);
    box.appendChild(p);
    box.appendChild(b);
    e.appendChild(box);
    document.body.appendChild(e);
  }
  // First application frame of a stack, which is the only part that belongs to
  // this codebase. The runtime's own frames sit above it.
  function faultOrigin(err) {
    if (!err || typeof err.stack !== 'string' || !err.stack) return null;
    var lines = err.stack.split('\n').slice(1);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      if (/^(at )?(eval|<anonymous>|native)/.test(l)) continue;
      return l.replace(/^at\s+/, '');
    }
    return null;
  }

  // A module graph that disagrees with itself. Two halves of the application were
  // written at different times and one of them imports a name the other no longer
  // exports. It is not a fault in any single file, it is a page holding half of one
  // build and half of another, and the only thing that resolves it is refetching the
  // graph.
  //
  //   does not provide an export named X   - this file is older than its importer
  //   Failed to fetch dynamically imported module - this file is newer than the
  //                                         document that asked for it
  //
  // Reload once, automatically. The server sends Cache-Control: no-cache with an ETag, so
  // a reload revalidates every module and the graph is coherent again.
  var STALE_RELOADED = 'trycord.staleReload';
  function looksLikeStaleGraph(text) {
    return /does not provide an export named/i.test(text)
      || /(?:failed|error) (?:to )?(?:load|fetch)(?:ing)? (?:dynamically imported )?module/i.test(text)
      || /module\s+script\s+.*(?:failed|error)/i.test(text)
      || /importing a module script failed/i.test(text);
  }
  function recoverFromStaleGraph(text) {
    if (!looksLikeStaleGraph(text)) return false;
    var already = false;
    try { already = sessionStorage.getItem(STALE_RELOADED) === '1'; } catch (e) { /* private mode */ }
    if (already) return false; // Already refetched once. Let the caller show the message.
    try { sessionStorage.setItem(STALE_RELOADED, '1'); } catch (e) { /* private mode */ }
    // Replace rather than reload so this attempt is not in the history: if it works the
    // reader should land where they were, with no back button pointing at a dead page.
    location.replace(location.pathname + location.search + location.hash);
    return true;
  }

  // What the server actually said about a file the browser would not load. The browser
  // discards this, which leaves "did not send" covering a file that does not exist (a bug
  // in the repository) and an origin that is not answering (nothing to do with the
  // repository) - and those send a reader to completely different places.
  var STATUS = {
    404: 'the server does not have this file',
    403: 'the server refused this file',
    410: 'the server has retired this file',
    429: 'the server is rate limiting this file',
    500: 'the server failed handling this file',
    502: 'the origin did not answer',
    503: 'the origin is unavailable',
    504: 'the origin timed out',
    521: 'the origin refused the connection',
    522: 'the origin did not reply in time',
    524: 'the origin took too long to reply'
  };
  function probe(src, tag, short) {
    function say(detail) {
      paintError('Could not load ' + tag + ' ' + short + ' - ' + detail
        + '. Reload to retry.');
    }
    if (!src || typeof fetch !== 'function') {
      say('the server did not send it');
      return;
    }
    // `no-store` because the answer we want is what the origin is doing right now, and a
    // cached copy would be the previous good one - which is exactly what is on screen.
    fetch(src, { method: 'GET', cache: 'no-store' }).then(function (res) {
      say(STATUS[res.status] ? res.status + ' - ' + STATUS[res.status] : 'HTTP ' + res.status);
    }, function (err) {
      say('the server could not be reached'
        + (err && err.message ? ' (' + String(err.message).slice(0, 60) + ')' : ''));
    });
  }

  window.addEventListener('error', function (ev) {
    // A file the server did not answer. This arrives as an `error` event on the element
    // that failed to load, it does not bubble, and it carries no message - so without the
    // capture flag below it is never seen here at all and the result is a black screen
    // with nothing on it and nothing in the console to act on. That is not hypothetical:
    // `ui/usercard.js` imported `./components.js` when the module is one level up, and the
    // whole application went dark without a word from this file.
    if (ev && ev.target && ev.target !== window && ev.target.tagName) {
      var src = ev.target.src || ev.target.href || '';
      var tag = String(ev.target.tagName).toLowerCase();
      var short = src ? src.split('/').pop().split('?')[0] : '(unknown file)';
      if (recoverFromStaleGraph('failed to load module script ' + src)) return;
      // A resource error carries no status, so "did not send" was ambiguous between a file
      // that does not exist and an origin that is not answering - which are different
      // problems in different places, and the difference was invisible. Ask for the file
      // once and report what came back.
      probe(src, tag, short);
      return;
    }
    // file:line:column, not just the filename. A filename alone left three
    // separate crashes ambiguous because several modules load from the same
    // place, and the only alternative was devtools - which a desktop user may
    // not have open and a phone user certainly does not.
    var where = '';
    if (ev && ev.filename) {
      var f;
      try { f = decodeURIComponent(ev.filename).split('/').pop(); } catch (e) { f = ev.filename; }
      where = ' in ' + f;
      if (typeof ev.lineno === 'number' && ev.lineno) where += ':' + ev.lineno + (ev.colno ? ':' + ev.colno : '');
    }
    var msg = (ev && ev.message) ? String(ev.message).slice(0, 200) : 'Unknown script error';
    if (recoverFromStaleGraph(msg)) return;
    paintError('A script error occurred' + where + ': ' + msg);
    // Capture, because a module that fails to load fires an error event that does not
    // bubble, and this listener is the only thing standing between that and a blank page.
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev && ev.reason;
    if (reason && reason.name === 'TypeError' && /(?:loading.*chunk|module\s+script|imported)\s+/i.test(String(reason.message))) {
      if (recoverFromStaleGraph(String(reason.message))) return;
      paintError('The app files changed while this window was open. Reload to pick up the latest build.');
      return;
    }
    if (recoverFromStaleGraph(reason && reason.message ? String(reason.message) : '')) return;
    // Everything else was silently discarded before, so a boot that failed on a
    // rejected promise looked like a blank page with nothing to go on.
    var origin = faultOrigin(reason);
    var msg = reason && reason.message ? String(reason.message).slice(0, 200) : String(reason).slice(0, 200);
    paintError('Background task failed' + (origin ? ' (' + origin + ')' : '') + ': ' + msg);
  });
  // position-fixed layer mounted straight on <body>, deliberately outside the
  function hasRendered() {
    try {
      return !!document.querySelector(
        '#view-root > *, body > .auth-page, body > .popover'
      );
    } catch (e) {
      return false;
    }
  }

  setTimeout(function () {
    if (!hasRendered() &&
        !document.getElementById('trycord-crash') &&
        document.readyState === 'complete') {
      paintError('The page loaded but rendered nothing. Reload to retry.');
    }
  }, 9000);
  // (slow boot, rate-limited boot, long debug session), remove the false
  function heal() {
    try {
      if (hasRendered()) {
        var e = document.getElementById('trycord-crash');
        if (e && e.parentNode) e.parentNode.removeChild(e);
      }
    } catch (err) { /* never break the page from the guard itself */ }
  }
  if (typeof MutationObserver !== 'undefined') {
    try {
      new MutationObserver(heal).observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) { /* observer unavailable: watchdog still works one-way */ }
  }
}());
