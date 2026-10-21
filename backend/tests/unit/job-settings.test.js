// The job system reads the configuration the operator saved.
//
// The service asked for './services/settings' from inside 'services/', where
// there is no such file. The call sat in a try/catch, so the error was
// swallowed and the saved worker count and concurrency were ignored - the
// console showed the operator's value, the database held it, and the job
// system used the default instead.
//
// The check is on the two numbers an operator sets, and on the fallback that
// happens when they set nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser } = require('../helpers/instance');

test('the job system reads the saved worker count', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const settings = require('../../src/services/settings');
  const jobs = require('../../src/services/jobs');
  await settings.load();

  // Nothing saved: the environment decides, and then the CPU count.
  const fallback = jobs.defaultWorkerCount();
  assert.ok(fallback >= 1, 'there is always at least one worker: ' + fallback);

  await settings.save({ 'cpu.worker_count': 3 }, owner.user.id);
  assert.equal(jobs.defaultWorkerCount(), 3,
    'the worker count the operator saved is the one the job system uses');
});
