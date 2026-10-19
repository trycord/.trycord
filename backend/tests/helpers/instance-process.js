// One instance, in its own process.
//
// The verification suite needs more than one instance at a time: federation
// needs two instances with separate databases and separate keys, the dashboard
// needs one the dashboard service can talk to, and the instance switching
// tests need two that do not know each other.
//
// Running them in one process meant sharing one database module, and a module
// whose connection was closed by the instance that stopped would leave the
// next one holding a dead connection. An instance is a server. A server is a
// process. So an instance in a test is a process.
//
// This file is that process. It boots the application the way the application
// boots, says on stdout which port it got, and then stays up until it is
// told to stop.

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

async function main() {
  const { boot } = require(path.join(ROOT, 'src', 'server.js'));
  const instance = await boot({
    port: process.env.TRYCORD_TEST_PORT ? Number(process.env.TRYCORD_TEST_PORT) : 0,
    host: '127.0.0.1',
    jobs: process.env.TRYCORD_TEST_JOBS === '1',
    client: process.env.TRYCORD_TEST_CLIENT !== '0',
    publicSite: process.env.TRYCORD_TEST_PUBLIC_SITE !== '0',
  });

  // The line the parent waits for. It is on stdout and nothing else is, so
  // the parent can read it without parsing the boot log.
  process.stdout.write('__TRYCORD_INSTANCE__ ' + JSON.stringify({
    port: instance.port,
    baseUrl: 'http://127.0.0.1:' + instance.port,
    instanceId: instance.instanceId,
    version: instance.version,
  }) + '\n');

  // The same shutdown the server does on SIGTERM, so a test that stops an
  // instance exercises the real path rather than a shortcut.
  const shutdown = () => {
    instance.close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  process.stderr.write('instance failed to start: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
