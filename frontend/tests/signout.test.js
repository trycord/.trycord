// Signing out is a menu press, and a menu press is easy to make by accident.
// Both clients ask before they end the session, and the question says what
// ends (this session) and what does not (the account).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { MODULES, read } from './helpers/source.js';

test('the desktop asks before it signs out', () => {
  const shell = read(path.join(MODULES.desktop, 'shell.js'));
  assert.match(shell, /confirmDialog\(\{[\s\S]*?title: 'Sign out of Trycord\?'/,
    'the desktop sign-out has no confirmation');
  assert.match(shell, /if \(yes\) signOutHandler\(\)/,
    'the desktop ignores the answer to the confirmation');
});

test('the phone asks before it signs out', () => {
  const you = read(path.join(MODULES.mobile, 'views', 'you.js'));
  assert.match(you, /await confirm\(\{[\s\S]*?title: 'Sign out\?'/,
    'the phone sign-out has no confirmation');
  assert.match(you, /if \(!\(await confirm/,
    'the phone ignores the answer to the confirmation');
});
