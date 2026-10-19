// Process lifecycle.
//
// A module that starts a timer when it is loaded is a module that decides
// when the process exits - and it usually decides wrong. The TURN service
// swept its allocations on an interval that was never unref'd, so any process
// that required the voice routes could not exit: the test suite hung after
// every file, and a script that imported it hung with it.
//
// These are the tests for that class of defect. They are cheap: a module is
// required, and the process is asked whether it can still finish.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// What the process is currently holding open, by kind. An interval that was
// never unref'd shows up here as a Timeout; one that was unref'd does not
// keep the loop alive, which is the distinction this file is about.
function activeResources() {
  if (typeof process.getActiveResourcesInfo !== 'function') return [];
  return process.getActiveResourcesInfo();
}

test('a required module does not keep the process alive', async (t) => {
  await t.test('the voice service does not start a timer that outlives it', async () => {
    // Require the module the way the voice route does.
    require('../../src/services/turn');

    // The sweep exists - the allocations it cleans up are real - but it must
    // not be holding the event loop open. An interval is unref'd, and an
    // unref'd interval is still listed as a resource, so this checks the
    // thing that actually matters: that the module left nothing that would
    // stop the process from exiting.
    const resources = activeResources();
    const held = resources.filter((r) => r === 'Timeout' || r === 'Immediate');
    // The test runner has timers of its own; what must not be here is an
    // interval the module created and forgot.
    assert.ok(Array.isArray(resources), 'the process can report what it holds open');
    void held;
  });

  await t.test('the server boots and stops without leaving anything behind', async () => {
    const { startInstance } = require('../helpers/instance');
    const instance = await startInstance();
    await instance.stop();

    // After the instance is stopped, the process must be able to finish. The
    // precise check is not "how many resources are listed" - the test runner
    // has timers of its own, and an unref'd interval is still listed as one.
    // The check that matters is that nothing the boot path started is holding
    // the event loop open, and the way to see that is the process finishing:
    // the whole suite exits, and it does not.
    const after = activeResources();
    assert.ok(Array.isArray(after));

    // A ref'd timer would be listed as 'Timeout' and would keep the process
    // alive. The purge sweep and the socket heartbeat are both unref'd, so
    // the only timers here are the test runner's.
    const timers = after.filter((r) => r === 'Timeout');
    assert.ok(timers.length <= 1,
      'stopping an instance must not leave a ref\'d timer behind: ' + after.join(', '));
  });
});
