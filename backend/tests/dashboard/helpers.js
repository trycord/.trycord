'use strict';

// Starting the separate dashboard service to measure.
//
// The service is a process of its own, so it is started as one: a child
// process, with its own environment, started directly and stopped directly.
// No supervisor, no daemon, nothing left behind.
//
// The environment it is given is deliberately explicit, and deliberately
// unusable as a database configuration: the point of the separate dashboard
// is that it has no database, so it is started with a database configuration
// that could not possibly work. If it still serves, that is the proof.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort } = require('../helpers/instance');

const SERVICE = path.join(__dirname, '..', '..', 'src', 'dashboard', 'separate.js');

/**
 * Start the separate dashboard service.
 *
 * @param {object}  [options]
 * @param {string}  [options.apiUrl]        the main API the dashboard talks to (required)
 * @param {number}  [options.port]          the port to listen on
 * @param {string[]} [options.allowedOrigins] the origins allowed to load the dashboard
 * @param {string}  [options.publicUrl]     the dashboard's own public address
 * @returns {Promise<object>} the running service
 */
async function startDashboardService(options = {}) {
  if (!options.apiUrl) throw new Error('startDashboardService needs the API address');
  const port = options.port || await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-dashboard-'));

  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, [
    'DASHBOARD_MODE=separate',
    'DASHBOARD_PORT=' + port,
    'DASHBOARD_HOST=127.0.0.1',
    'DASHBOARD_API_URL=' + options.apiUrl,
    'DASHBOARD_ORIGIN=' + (options.allowedOrigins || [origin]).join(','),
    'DASHBOARD_URL=' + (options.publicUrl || origin),
    // A database configuration that could not work if the service tried to
    // use it, and a job worker that is switched off. The service has to be
    // perfectly happy without either.
    'DB_CLIENT=mysql',
    'DB_HOST=127.0.0.1',
    'DB_PORT=1',
    'DB_NAME=trycord',
    'DB_USER=nobody',
    'DB_PASSWORD=nothing',
    'DB_FILE=' + path.join(dir, 'never-created.db'),
    'JOBS_WORKERS=0',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [SERVICE], {
    // Only what is listed is in force. The test process runs with an
    // instance's environment, and that environment names a real database.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      DOTENV_CONFIG_PATH: envFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  let text = '';
  await new Promise((resolve, reject) => {
    const collect = (chunk) => {
      const part = chunk.toString();
      output.push(part);
      text += part;
      if (text.includes('listening on')) resolve();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error('the separate dashboard service exited with code ' + code + ':\n' + text));
    });
  });

  return {
    child,
    port,
    origin,
    url: origin,
    envFile,
    /** Everything the service has written to stdout and stderr. */
    output: () => text,
    /** Stop the service and remove its files. */
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * The modules a file pulls in, as a child process sees them.
 *
 * The separate dashboard must not reach the database, the job worker or the
 * websocket gateway. Asking the process what it loaded is a stronger answer
 * than reading its source: it is what actually happened.
 */
function loadedModules(file) {
  const { spawnSync } = require('node:child_process');
  const script = 'require(' + JSON.stringify(file) + ');'
    + 'process.stdout.write(JSON.stringify(Object.keys(require.cache)));';
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error('could not inspect the module graph: ' + (res.stderr || res.stdout));
  }
  return JSON.parse(res.stdout);
}

module.exports = { startDashboardService, loadedModules, SERVICE };
