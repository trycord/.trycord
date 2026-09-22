/* Presentation State — the single source of truth for which layout state
   Trycord renders: MOBILE or DESKTOP.

   Sets <html data-presentation="mobile|desktop"> (and <body> once it exists)
   and fires `trycord:presentation` on changes.

   Rules:
   - All layout-dependent JS asks TrycordPresentation.isMobile()/isDesktop().
     Never sniff a private width inside a feature file.
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
})();