// The client, the SDK and the server agree on the paths.
//
// The two halves of the product are written by different hands: the client has
// an address for every call it makes, and the server has a route for every
// call it answers. Nothing checked that the two agreed, so a call could name
// a route that was never registered and the reader saw a 404 that reads like
// a permission problem.
//
// The SDK had that fault: `client.commands()` asked for
// `/applications/:id/commands`, which is not a route.
//
// The check reads the server's own source for the routes it registers and the
// client's own API module for the paths it asks for. It is the script in
// `backend/scripts/check-api-contract.mjs`, run as a test so it runs with the
// rest.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');

test('every path the client and the SDK ask for is served', () => {
  let output = '';
  let failed = false;
  try {
    output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'backend', 'scripts', 'check-api-contract.mjs')],
      { encoding: 'utf8', cwd: path.join(ROOT, 'backend') }
    );
  } catch (error) {
    failed = true;
    output = String(error.stdout || '') + String(error.stderr || '');
  }
  assert.equal(failed, false, 'the client and the SDK ask for paths the server does not serve:\n' + output);
  assert.match(output, /every path the client and the SDK ask for is served/);
});
