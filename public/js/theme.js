// The public site's own theme. It reads the same token layer the app does, but
// never the app's preference: a Midnight or custom palette chosen while signed
// in is a property of the application surface, and applying it to marketing
// pages would turn a reader's first impression into whatever half-applied
// colours the app left behind. This site is built around two states, the
// default dark look and Light, and resolves exactly those.
//
// Loaded without defer, in the head, so it runs before the first paint. A script
// at the end of the body would apply the theme after the dark document had
// already been drawn, which shows as a flash of the wrong colours on every
// navigation. The server's content policy forbids inline scripts, which is why
// this is a file.
(function () {
  'use strict';

  var KEY = 'trycord.publicTheme';

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* storage blocked; use the default */ }

  var name;
  if (saved === 'light') {
    name = 'light';
  } else if (saved === 'system') {
    var dark = false;
    try {
      dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { /* matchMedia unsupported; light is the safe reading */ }
    name = dark ? 'trycord' : 'light';
  } else {
    // Unset, 'trycord', or a value this page does not recognise.
    name = 'trycord';
  }

  document.documentElement.setAttribute('data-theme', name);
})();