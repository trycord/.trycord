#!/usr/bin/env node
'use strict';

// Start a throwaway backend, photograph the application, stop it.
//
// shots.mjs expects a server to already be listening, because it is also usable against
// a staging instance you started yourself. This wrapper is what makes
// `npm run check:shots` a one-liner, and it exists so nobody has to remember the
// environment that keeps it off the live database.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function health(origin) {
  return new Promise((resolve) => {
    const req = http.get(origin + '/api/health', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  const port = Number(process.env.TC_PORT) || (await freePort());
  const origin = `http://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-shots-'));
  const env = Object.assign({}, process.env, {
    // DB_CLIENT as well as DB_FILE, always. The repository's .env sets DB_CLIENT twice
    // and the last one wins, so a DB_FILE on its own resolves to the live remote
    // MySQL rather than anything local.
    DB_CLIENT: 'sqlite',
    DB_FILE: path.join(dir, 'shots.db'),
    PORT: String(port),
    HOST: '127.0.0.1',
    UPLOAD_DIR: path.join(dir, 'uploads'),
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    JWT_SECRET: 'shots-check-secret-0123456789ab',
    TC_ORIGIN: origin,
    TC_SHOTS: path.join(ROOT, 'shots'),
  });

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    if (/startup failed|EADDRINUSE/i.test(log) || server.exitCode !== null) break;
    if (await health(origin)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    server.kill('SIGKILL');
    console.error('the screenshot check could not start a backend on ' + origin + '\n' + log.slice(-1200));
    process.exit(1);
  }
  console.log('  throwaway backend on ' + origin + ' (sqlite, disposable)');

  try {
    const shots = spawn(process.execPath, [path.join(__dirname, 'shots.mjs')], {
      stdio: 'inherit', env,
    });
    const code = await new Promise((resolve) => shots.once('exit', resolve));
    process.exitCode = code === null ? 1 : code;
  } finally {
    server.kill('SIGTERM');
  }
})();