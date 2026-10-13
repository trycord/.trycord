// Public site behaviour. Loaded as an external file (the server CSP forbids
// and readable without it.
(function () {
  'use strict';

  var groups = Array.prototype.slice.call(document.querySelectorAll('[data-nav-group]'));
  var menuToggle = document.querySelector('[data-menu-toggle]');
  var header = document.querySelector('.site-header');

  function setGroup(group, open) {
    var trigger = group.querySelector('[data-nav-trigger]');
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function closeAllGroups(except) {
    groups.forEach(function (g) { if (g !== except) setGroup(g, false); });
  }

  groups.forEach(function (group) {
    var trigger = group.querySelector('[data-nav-trigger]');
    if (!trigger) return;

    trigger.addEventListener('click', function () {
      var open = trigger.getAttribute('aria-expanded') !== 'true';
      closeAllGroups(group);
      setGroup(group, open);
    });

    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Down') {
        e.preventDefault();
        setGroup(group, true);
        var first = group.querySelector('.nav-menu a');
        if (first) first.focus();
      }
    });

    group.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        setGroup(group, false);
        trigger.focus();
      }
    });

    group.addEventListener('focusout', function (e) {
      if (!group.contains(e.relatedTarget)) setGroup(group, false);
    });

    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      var timer = null;
      group.addEventListener('pointerenter', function (e) {
        if (e.pointerType !== 'mouse') return;
        if (timer) { clearTimeout(timer); timer = null; }
        closeAllGroups(group);
        setGroup(group, true);
      });
      group.addEventListener('pointerleave', function (e) {
        if (e.pointerType !== 'mouse') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { setGroup(group, false); }, 120);
      });
    }
  });

  if (groups.length) {
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('[data-nav-group]')) closeAllGroups();
    });
  }

  if (menuToggle && header) {
    menuToggle.addEventListener('click', function () {
      var open = header.getAttribute('data-menu-open') !== 'true';
      header.setAttribute('data-menu-open', open ? 'true' : 'false');
      menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) closeAllGroups();
    });
    var nav = document.getElementById('site-nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        if (e.target && e.target.tagName === 'A') {
          header.setAttribute('data-menu-open', 'false');
          menuToggle.setAttribute('aria-expanded', 'false');
        }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.getAttribute('data-menu-open') === 'true') {
        header.setAttribute('data-menu-open', 'false');
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.focus();
      }
    });
  }

  /* ---- the theme switch ----------------------------------------------------
     The public site keeps its own preference under its own key, separate from
     the signed-in application's. The app offers a dozen themes including custom
     palettes; this site is built for two, its default dark look and Light.
     Reading the app's key would drag Midnight or a custom palette onto the
     marketing pages, and writing it from here would change how the app looks,
     so a choice on this site must never touch the app or the other way round.

     One file sets data-theme before paint; this only changes it afterwards. */
  var THEME_KEY = 'trycord.publicTheme';
  var themeButton = document.querySelector('[data-theme-toggle]');

  function resolvedIsLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }
  function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    if (themeButton) themeButton.setAttribute('aria-pressed', name === 'light' ? 'true' : 'false');
  }
  if (themeButton) {
    themeButton.hidden = false;
    themeButton.addEventListener('click', function () {
      var name = resolvedIsLight() ? 'trycord' : 'light';
      try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* storage blocked */ }
      applyTheme(name);
    });
  }
  try {
    var savedName = null;
    try { savedName = localStorage.getItem(THEME_KEY); } catch (e) { /* storage blocked */ }
    if (savedName === 'system') {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSystemChange = function (e) { applyTheme(e.matches ? 'trycord' : 'light'); };
      if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
      else if (mq.addListener) mq.addListener(onSystemChange);
    }
  } catch (e) { /* matchMedia unsupported */ }

  function toRoute(pathname) {
    var p = String(pathname || '').split('?')[0].split('#')[0];
    p = p.replace(/\.html$/i, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
  }
  var here = toRoute(window.location.pathname);
  document.querySelectorAll('.site-nav a, .site-footer a').forEach(function (link) {
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) !== '/') return;
    if (toRoute(href) === here) {
      link.setAttribute('aria-current', 'page');
      var group = link.closest ? link.closest('[data-nav-group]') : null;
      if (group) {
        var trigger = group.querySelector('[data-nav-trigger]');
        if (trigger) trigger.classList.add('is-current');
      }
    }
  });

  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if (reveals.length && 'IntersectionObserver' in window) {
    document.documentElement.classList.add('js');
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    reveals.forEach(function (el) { revealObserver.observe(el); });
  }

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
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
