// Loaded as an external file (the server CSP forbids inline scripts).

(function () {
  'use strict';

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

  function toRoute(pathname) {
    var p = String(pathname || '').split('?')[0].split('#')[0];
    p = p.replace(/\.html$/i, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }

  var here = toRoute(window.location.pathname);
  document.querySelectorAll('.site-nav a').forEach(function (link) {
    if (toRoute(link.getAttribute('href')) === here) {
      link.setAttribute('aria-current', 'page');
    }
  });

  var yearEl = document.querySelector('[data-year]');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
