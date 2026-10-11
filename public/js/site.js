// Public site behaviour. Loaded as an external file (the server CSP forbids
// inline scripts), so everything here is an enhancement: the page is complete
// and readable without it.

(function () {
  'use strict';

  /* ---- the header knows when there is content behind it ------------------
     The rule only appears once the page has moved, so the header is unmarked at
     the top of a document and marked the moment there is anything behind it.
     One scroll listener, in the passive phase, doing one attribute write. */
  var header = document.querySelector('.site-header');
  if (header) {
    var setScrolled = function () {
      header.setAttribute('data-scrolled', window.scrollY > 8 ? 'true' : 'false');
    };
    setScrolled();
    window.addEventListener('scroll', setScrolled, { passive: true });
  }

  /* ---- the navigation toggle ---------------------------------------------
     The visual state is the aria-expanded attribute the stylesheet reads, so
     there is exactly one source of truth for whether the menu is open. The old
     version also toggled a class that nothing read. */
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    // Close after choosing a destination, when tapping outside, or on Escape.
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') setOpen(false);
    });
    document.addEventListener('click', function (e) {
      var inside = toggle.contains(e.target) || nav.contains(e.target);
      if (!inside && toggle.getAttribute('aria-expanded') === 'true') setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /* ---- the current section in the nav ------------------------------------
     A page knows which link is itself, rather than the server being asked to
     stamp it on every document. */
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

  /* ---- the table of contents ---------------------------------------------
     Generated from the page's own headings, so it cannot drift from the
     document. A hand-written TOC is a list that goes stale the first time a
     heading is renamed.

     It lives outside the page:begin/page:end markers on purpose: an
     administrator publishing replaces the marked region, and the contents list
     is generated after the browser has it, so publishing cannot lose it. */
  var toc = document.querySelector('.toc');
  var prose = document.querySelector('.prose');
  if (toc && prose) {
    var heads = prose.querySelectorAll('h2, h3');
    if (heads.length) {
      var list = document.createElement('ul');
      var sub = null;
      heads.forEach(function (h) {
        if (!h.id) {
          h.id = String(h.textContent || '').trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
        }
        var item = document.createElement('li');
        if (h.tagName === 'H3') {
          // Third-level headings nest under the last second-level one, so the
          // list stays two levels rather than becoming flat.
          if (!sub) {
            sub = document.createElement('ul');
            sub.className = 'toc-sub';
            (list.lastElementChild || list).appendChild(sub);
          }
        } else {
          sub = null;
        }
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent;
        item.appendChild(a);
        (h.tagName === 'H3' && sub ? sub : list).appendChild(item);
      });
      toc.appendChild(list);

      // Which section is being read. An IntersectionObserver rather than a
      // scroll handler, so the cost is one callback per crossing rather than one
      // per frame.
      var links = {};
      toc.querySelectorAll('a').forEach(function (a) {
        links[a.getAttribute('href').slice(1)] = a;
      });
      if ('IntersectionObserver' in window) {
        var seen = new Set();
        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) seen.add(entry.target.id);
            else seen.delete(entry.target.id);
          });
          var active = null;
          // The first heading still on screen is the one being read.
          heads.forEach(function (h) { if (seen.has(h.id) && !active) active = h.id; });
          toc.querySelectorAll('a').forEach(function (a) {
            a.classList.toggle('is-active', a.getAttribute('href') === '#' + active);
          });
        }, { rootMargin: '-80px 0px -70% 0px' });
        heads.forEach(function (h) { observer.observe(h); });
      }
    }
  }

  var yearEl = document.querySelector('[data-year]');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
