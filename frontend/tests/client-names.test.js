// The client uses no name it does not have.
//
// A module that names something it does not have throws a ReferenceError the
// moment that line runs - and only if that line runs. A click handler that
// nobody clicks, a branch that only one kind of account reaches, a field that
// is only set in one of two ways: none of them is reached by a test that
// draws the screen and looks at it.
//
// Three were, at the time this was written:
//
//   - the poll editor named a `poll` that was not in scope, so every click
//     on "New poll" threw and the whole poll surface was unreachable;
//   - the account settings called a `reload` that was not in scope, so
//     removing your own avatar threw after the picture was already gone;
//   - the phone's poll list read a `tally` that was declared in a block
//     above it, so every poll with a voter threw;
//   - and the phone's poll editor used a list of scorings it had not
//     imported, so opening it threw.
//
// So the check is a static one, over every module in the client: resolve
// every name that is read, and report the ones that resolve to nothing.
//
// The scanner is the one the build runs, so there is one implementation and
// not two.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.join(HERE, '..', 'scripts', 'check-client-names.mjs');

test('the client uses no name it does not have', () => {
  const result = spawnSync(process.execPath, [SCANNER], {
    encoding: 'utf8',
    timeout: 120000,
  });

  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, 0,
    'the client names something it does not have:\n' + output);
  assert.match(output, /no name it does not have/,
    'the scanner did not say what it was asked:\n' + output);
});
