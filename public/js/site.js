// Trycord public website — small enhancement script.
// Loaded as an external file (the server CSP forbids inline scripts).
// No dependencies. Handles: mobile navigation, current page marker,
// and the footer year.

(function () {
  'use strict';

  // --- mobile nav toggle ---
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Close after choosing a destination, when tapping outside, or on Escape.
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('click', function (e) {
      var inside = toggle.contains(e.target) || nav.contains(e.target);
      if (!inside && nav.classList.contains('open')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // --- current page marker ---
  var here = window.location.pathname.replace(/\/(index\.html)?$/, '/');
  document.querySelectorAll('.site-nav a').forEach(function (link) {
    var href = link.getAttribute('href') || '';
    var route = href.replace(/\/(index\.html)?$/, '/');
    if (route === here && here !== '/') {
      link.setAttribute('aria-current', 'page');
    }
  });

  // --- footer year ---
  var yearEl = document.querySelector('[data-year]');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();