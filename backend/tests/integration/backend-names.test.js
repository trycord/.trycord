// The backend uses no name it does not have.
//
// The voice service had this fault and nobody knew: the encoder that writes a
// mapped address used a constant that was never defined, the packet handler
// caught the error and threw it away, and every message type in the switch
// was an identifier that did not exist. The service bound its port, received
// every request and answered nothing - and the diagnostics reported the port
// as open, which is exactly what a firewall problem looks like.
//
// A name that is not declared throws the moment the line runs, and only if
// that line runs. A handler nobody calls, a branch only one kind of account
// reaches, a field only set in one of two ways: none of them is reached by
// a test that draws the screen and looks at it.
//
// So the check is a static one over every module: resolve every name that is
// read, and report the ones that resolve to nothing.
//
// The scanner is the one the build runs, so there is one implementation and
// not two.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('node:child_process');

const SCANNER = path.join(__dirname, '..', '..', 'scripts', 'check-backend-names.mjs');

test('the backend uses no name it does not have', () => {
  const result = spawnSync(process.execPath, [SCANNER], {
    encoding: 'utf8',
    timeout: 180000,
  });

  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, 0,
    'the backend names something it does not have:\n' + output);
  assert.match(output, /no name it does not have/,
    'the scanner did not say what it was asked:\n' + output);
});
