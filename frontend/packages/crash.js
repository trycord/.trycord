// The crash reporter.
//
// Loaded before the application, and as a plain script rather than a module: it
// has to be able to report a module graph that failed to load, so it cannot
// depend on that graph. It swaps the mount point for a message a reader can act
// on, and it can be shown more than once (a later failure replaces an earlier
// one) because the first report is not always the informative one.

(function () {
  'use strict';

  // What went wrong, for a harness to read.
  //
  // The report a reader is shown is a picture of the failure, and it is
  // replaced by the next one. A harness needs the list, not the picture: it
  // drives the application in a browser and has to be able to say "this page
  // threw" rather than "this page looks fine".
  //
  // The list is on the window because that is the only thing both the
  // reporter and a driver can reach. It is harmless in a served document.
  window.__trycordErrors = window.__trycordErrors || [];

  function record(message, reason) {
    window.__trycordErrors.push(String(message || 'The application stopped.')
      + (reason ? ' — ' + String(reason) : ''));
  }

  function render(message, reason) {
    var root = document.getElementById('app');
    if (!root) {
      root = document.createElement('div');
      root.id = 'app';
      document.body.appendChild(root);
    }
    root.textContent = '';

    var wrap = document.createElement('div');
    wrap.setAttribute('role', 'alert');
    // Fixed to the viewport rather than laid out inside #app. The mount point is a
    // full viewport tall, so a child that is also a viewport tall overflows it and
    // the document scrolls - which is what put the message below the fold on a
    // phone and made the reader scroll to find it. Out of flow, it covers the
    // screen wherever the page happened to be. overflow:auto keeps a genuinely
    // over-long report reachable without moving the page behind it.
    //
    // The colours are the trycord-assets token library, read through the same
    // custom properties the application uses, so a change in the library reaches
    // the crash screen too. Each one carries the library's value as a fallback,
    // because this screen exists for the case where the stylesheet did not load.
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;'
      + 'justify-content:center;padding:max(24px,env(safe-area-inset-top),env(safe-area-inset-bottom));'
      + 'overflow:auto;font-family:var(--tc-font-sans,system-ui,sans-serif);'
      + 'background:var(--tc-bg-deep,#121317);color:var(--tc-text,#F4F5F7);';

    var box = document.createElement('div');
    // margin:auto centres the report and, unlike align-items alone, keeps the top
    // of an over-long one visible instead of clipping it above the scroll area.
    box.style.cssText = 'max-width:480px;width:100%;margin:auto;'
      + 'display:flex;flex-direction:column;gap:14px;';

    var brand = document.createElement('div');
    brand.style.cssText = 'display:flex;align-items:center;gap:10px;'
      + 'color:var(--tc-brand,#FF4D24);font-weight:800;font-size:1.1rem;';
    brand.textContent = 'Trycord';
    box.appendChild(brand);

    var title = document.createElement('div');
    title.style.cssText = 'font-size:1.3rem;font-weight:800;';
    title.textContent = 'The application could not start';
    box.appendChild(title);

    var body = document.createElement('div');
    body.style.cssText = 'color:var(--tc-text-muted,#A4A7B0);font-size:.95rem;line-height:1.55;';
    body.textContent = 'Something failed while loading the interface. Reloading usually '
      + 'fixes a stale or partial download. If it keeps happening, the details below are '
      + 'safe to share.';
    box.appendChild(body);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';

    var reload = document.createElement('button');
    reload.textContent = 'Reload';
    reload.style.cssText = 'height:44px;padding:0 20px;border:0;border-radius:var(--tc-radius-md,8px);'
      + 'background:var(--tc-brand,#FF4D24);color:var(--tc-text-on-brand,#fff);font-weight:600;'
      + 'cursor:pointer;font-size:.95rem;';
    reload.onclick = function () { window.location.reload(); };
    actions.appendChild(reload);

    var detail = document.createElement('pre');
    detail.style.cssText = 'display:none;white-space:pre-wrap;word-break:break-word;'
      + 'background:var(--tc-surface,#22242A);border:1px solid var(--tc-border,#30323A);'
      + 'border-radius:var(--tc-radius-md,8px);padding:12px;font-size:.78rem;'
      + 'color:var(--tc-text-muted,#A4A7B0);font-family:var(--tc-font-mono,ui-monospace,monospace);'
      + 'max-height:240px;overflow:auto;';
    detail.textContent = String(message || 'The application stopped.') + (reason ? '\n\n' + reason : '');

    var toggle = document.createElement('button');
    toggle.textContent = 'Show details';
    toggle.style.cssText = 'height:44px;padding:0 20px;border:1px solid var(--tc-border,#30323A);'
      + 'border-radius:var(--tc-radius-md,8px);background:transparent;color:var(--tc-text,#F4F5F7);'
      + 'font-weight:600;cursor:pointer;font-size:.95rem;';
    toggle.onclick = function () {
      var open = detail.style.display === 'block';
      detail.style.display = open ? 'none' : 'block';
      toggle.textContent = open ? 'Show details' : 'Hide details';
    };
    actions.appendChild(toggle);

    box.appendChild(actions);
    box.appendChild(detail);
    wrap.appendChild(box);
    root.appendChild(wrap);
  }

  window.addEventListener('error', function (event) {
    // A resource failing to load (an <img> or a script) has no .message; the
    // meaningful part is which resource. A script that failed is fatal to boot,
    // so those are reported even before the app renders.
    var target = event && event.target;
    if (target && target !== window && (target.src || target.href)) {
      var tag = target.tagName ? target.tagName.toLowerCase() : 'resource';
      if (tag === 'script' || tag === 'link') {
        record('A required file failed to load.',
          tag + ': ' + String(target.src || target.href));
        render('A required file failed to load.',
          tag + ': ' + String(target.src || target.href));
      }
      return;
    }
    record(event && event.message ? event.message : 'The interface stopped.',
      event && event.filename ? event.filename + ':' + event.lineno : '');
    render(event && event.message ? event.message : 'The interface stopped.',
      event && event.filename ? event.filename + ':' + event.lineno : '');
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    // A cancelled fetch is routine during navigation and is not a crash.
    if (reason && (reason.name === 'AbortError' || reason.code === 'ABORTED')) return;
    record('A background request failed.',
      reason && reason.stack ? reason.stack : String(reason || ''));
    render('A background request failed.',
      reason && reason.stack ? reason.stack : String(reason || ''));
  });
})();