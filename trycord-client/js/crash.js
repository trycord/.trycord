// Crash surface. Runs before the ES-module graph (plain script, no imports)
// so a failed module load paints an actionable panel instead of a blank
// window. Pure defensive UI: no app state, no network.
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
    b.addEventListener('click', function () { location.reload(); });
    box.appendChild(t);
    box.appendChild(p);
    box.appendChild(b);
    e.appendChild(box);
    document.body.appendChild(e);
  }
  window.addEventListener('error', function (ev) {
    var where = '';
    if (ev && ev.filename) {
      try { where = ' in ' + decodeURIComponent(ev.filename).split('/').pop(); } catch (e) { where = ' in ' + ev.filename; }
    }
    if (ev && ev.message) paintError('A script error occurred' + where + ': ' + String(ev.message).slice(0, 160));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    if (ev && ev.reason && ev.reason.name === 'TypeError' && /(?:loading.*chunk|module\s+script|imported)\s+/i.test(String(ev.reason.message))) {
      paintError('The app files changed while this window was open. Reload to pick up the latest build.');
    }
  });
  setTimeout(function () {
    if (!document.querySelector('#view-root > *, #mobile-main > *') &&
        !document.getElementById('trycord-crash') &&
        document.readyState === 'complete') {
      paintError('The page loaded but rendered nothing. Reload to retry.');
    }
  }, 9000);
  // Self-healing: if the app finishes rendering AFTER the watchdog fired
  // (slow boot, rate-limited boot, long debug session), remove the false
  // alarm instead of covering a working app forever. Event-driven via
  // MutationObserver: zero polling cost, lives as long as the page.
  function heal() {
    try {
      if (document.querySelector('#view-root > *, #mobile-main > *')) {
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