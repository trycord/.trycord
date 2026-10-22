// The Trycord mark inside the application has to lead back into the
// application. The route string '/home' is mount-relative: every in-app address
// that sits in an href has to go through path(), which carries the mount
// prefix. A bare '/home' is correct only where the app is served at the root,
// and in the deployed tree - where the app lives under /app - it lands on the
// public site instead.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT, read } from './helpers/source.js';

test('the desktop mark links back into the application, not outside it', () => {
  const frame = read(CLIENT + '/js/shell/frame.js');
  assert.ok(
    !frame.includes("href: '/home'"),
    'frame.js sets a bare /home href, which loses the mount prefix',
  );
  assert.ok(
    frame.includes("path('/home')"),
    'frame.js no longer resolves the mark through path()',
  );
});

test('the mobile mark links back into the application, not outside it', () => {
  const shell = read(CLIENT + '/mobile/js/shell.js');
  assert.ok(
    shell.includes("path('/home')"),
    'the mobile shell does not resolve its mark through path()',
  );
  assert.ok(
    !shell.includes("href: '/home'"),
    'mobile shell sets a bare /home href',
  );
});
