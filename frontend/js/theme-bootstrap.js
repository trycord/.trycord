// The theme, decided before the first paint.
//
// This lived inline in the entry documents, where a strict Content-Security-
// Policy refused it: the browser logged two blocked-inline-script errors and
// painted the default theme until the module graph caught up. The policy is
// right to refuse inline script; the fix is to put the same decision in a file
// the policy already permits.
//
// It runs as a classic script, before the application modules, so the stored
// theme is on the root element when the first stylesheet is applied. The key
// and the fallback are the same in the desktop and Mobile documents: a reader
// who chose a theme in one keeps it in the other.

(function () {
  'use strict';

  var root = document.documentElement;
  var theme = null;
  try { theme = window.localStorage.getItem('trycord.theme'); } catch (e) { theme = null; }
  if (!theme) {
    theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'trycord';
  }
  root.setAttribute('data-theme', theme);
})();
