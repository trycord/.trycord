'use strict';

// Entry point for the standalone status monitor.
//
//   node src/status-monitor/index.js        (or: npm run status-monitor)
//
// It reads backend/.env (dotenv, same as the API), builds a monitor from the
// configuration, starts the scheduler, and serves the report on its own port.
// Nothing here imports the API, the database, or Express: the whole point is that
// this process can still answer when the API cannot.

require('dotenv').config();

const { loadConfig } = require('./config');
const { createMonitor } = require('./monitor');
const { createServer } = require('./server');

// Build the monitor and server and start listening. Resolves with the handles so a
// caller (a test, or a supervising process) can drive and stop them.
function startServer(config) {
  const monitor = createMonitor(config);
  const server = createServer(config, monitor);
  monitor.start();

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      monitor.stop();
      reject(err);
    });
    server.listen(config.port, config.host, () => {
      const describe = (target) => (target.type === 'tcp'
        ? target.id + ' tcp://' + target.host + ':' + target.port
        : target.id + ' ' + (target.url || '/'));
      console.log('[info] status monitor on http://' + config.host + ':' + config.port
        + ' (' + config.targets.length + ' target(s) every ' + Math.round(config.intervalMs / 1000) + 's)');
      for (const target of config.targets) {
        if (target.enabled !== false) console.log('[info]   ' + describe(target));
      }
      resolve({ monitor, server });
    });
  });
}

async function main() {
  const config = loadConfig();
  let handles;
  try {
    handles = await startServer(config);
  } catch (err) {
    console.error('[error] status monitor could not start: ' + err.message);
    process.exit(1);
  }
  const { monitor, server } = handles;

  const shutdown = () => {
    monitor.stop();
    server.close(() => process.exit(0));
    // A hung connection must not stop the process from exiting on a restart.
    const forced = setTimeout(() => process.exit(0), 5000);
    if (forced.unref) forced.unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { main, startServer, loadConfig };
