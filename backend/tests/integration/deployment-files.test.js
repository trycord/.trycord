// The image and the compose file.
//
// A self-hoster runs the container, not the repository. The image is the only
// thing that has to be right for a deployment to work, and nothing here can
// build it: this machine has no Docker socket. So the files are read the way
// the build reads them.
//
// The check is in the tests because a deployment file that is wrong is a
// deployment that does not start, and the person who finds out is somebody
// who wanted to run an instance rather than somebody who shipped one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');

test('the image and the compose file are whole', () => {
  let output = '';
  let failed = false;
  try {
    output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'backend', 'scripts', 'check-deployment.mjs')],
      { encoding: 'utf8', cwd: path.join(ROOT, 'backend') }
    );
  } catch (error) {
    failed = true;
    output = String(error.stdout || '') + String(error.stderr || '');
  }
  assert.equal(failed, false, 'the deployment files are not as they should be:\n' + output);
});
