/* Presentation State — the single source of truth for which layout state
   Trycord renders: MOBILE or DESKTOP.

   Sets <html data-presentation="mobile|desktop"> (and <body> once it exists)
   and fires `trycord:presentation` on changes.

   Two DELIBERATE shells, never a merged layout:
   - #shell-app      → MobileShell (preserved current UI)
   - #shell-desktop  → DesktopShell (separate DOM, built from zero)
   Business logic/state is shared; the shell DOM and presentation are not.

   Rules:
   - All layout-dependent JS asks TrycordPresentation.isMobile()/isDesktop().
     Never sniff a private width inside a feature file.
   - Chrome lookups go through TrycordShell.el(id) / .root() / .qsa() so they
     resolve into whichever shell is active. Page renderers receive their
     content root as a parameter and stay shell-agnostic.
   - Overlay/business roots (#menu-root, #modal-root, #toasts, #ctx-root,
     #palette-root, #offline-banner) stay global — they are not shell chrome.
   - Visual responsiveness remains in CSS. This module only mirrors the
     decisive breakpoint (max-width: 900px) into the app as self-knowledge.
   - Never re-render the view from the change handler: that would wipe
     composer drafts.
*/
(function () {
  var BREAKPOINT = '(max-width: 900px)';
  var mq = null;
  try {
    mq = window.matchMedia(BREAKPOINT);
  } catch (e) { /* very old browsers: desktop */ }

  function current() {
    return mq && mq.matches ? 'mobile' : 'desktop';
  }

  function apply() {
    var p = current();
    document.documentElement.setAttribute('data-presentation', p);
    if (document.body) document.body.setAttribute('data-presentation', p);
    return p;
  }

  function fire() {
    apply();
    try {
      document.dispatchEvent(new CustomEvent('trycord:presentation', {
        detail: { presentation: current() },
      }));
    } catch (e) { /* old browsers */ }
  }

  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', fire);
    else if (mq.addListener) mq.addListener(fire);
  }
  apply();

  window.TrycordPresentation = {
    isMobile: function () { return current() === 'mobile'; },
    isDesktop: function () { return current() === 'desktop'; },
    mode: current,
  };

  // Shell resolution. Desktop uses desk-* ids to avoid clashing with the
  // preserved MobileShell; everything maps here.
  var DESK_PREFIX = 'desk-';
  window.TrycordShell = {
    active: function () { return TrycordPresentation.isDesktop() ? 'desktop' : 'mobile'; },
    root: function () {
      return document.getElementById(TrycordPresentation.isDesktop() ? 'shell-desktop' : 'shell-app');
    },
    // Logical id → element in the ACTIVE shell. Business roots stay unprefixed.
    el: function (id) {
      if (id === 'mobilebar' && TrycordPresentation.isDesktop()) return null;
      if (id === 'menu-root' || id === 'modal-root' || id === 'toasts' ||
          id === 'ctx-root' || id === 'palette-root' || id === 'offline-banner') {
        return document.getElementById(id);
      }
      return document.getElementById(TrycordPresentation.isDesktop() ? DESK_PREFIX + id : id);
    },
    q: function (sel) {
      var root = this.root();
      return root ? root.querySelector(sel) : null;
    },
    qsa: function (sel) {
      var root = this.root();
      return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
    },
  };
})();