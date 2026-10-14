#!/usr/bin/env node
'use strict';

// The database configuration control plane.
//
// This is the one setting whose store cannot be the database it configures, which
// makes it the one setting that can appear to work while doing nothing at all. A
// saved value in the wrong place, precedence applied in the wrong order, a failed
// connection that clobbers a working one, a password written to disk in the clear -
// every one of those looks identical to a correct configuration until the process
// restarts.
//
// What is measured here:
//
//   - with only the environment set, the environment decides
//   - a saved configuration takes precedence over the environment
//   - the saved configuration is readable before any connection is opened (the
//     bootstrap requirement: no query may be needed to find out where to connect)
//   - it survives a reload and is not displaced by the environment
//   - connecting uses the saved configuration, not the environment
//   - switching connections takes effect
//   - an unreachable saved configuration falls back to the previous one at boot
//   - a refused write leaves the working configuration untouched
//   - rollback restores the previous configuration
//   - a password never appears in a masked view or in the file itself
//   - the file is 0600 inside a 0700 directory

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-dbconfig-'));
const configFile = path.join(tmp, 'instance', 'database.json');
const stamp = Date.now();
const envFile = path.join(tmp, 'env-' + stamp + '.sqlite');
const savedFile = path.join(tmp, 'saved-' + stamp + '.sqlite');
const secondFile = path.join(tmp, 'second-' + stamp + '.sqlite');

process.env.JWT_SECRET = 'database-config-check-secret-0123456789';
process.env.TRYCOD_DB_CONFIG_FILE = configFile;
delete process.env.TRYCOD_DB_ENV_ONLY;
// Only the database type and file are set, so the environment describes one
// configuration and nothing else.
process.env.DB_CLIENT = 'sqlite';
process.env.DB_FILE = envFile;
delete process.env.DB_HOST;
delete process.env.DB_PORT;
delete process.env.DB_NAME;
delete process.env.DB_USER;
delete process.env.DB_PASSWORD;
delete process.env.ALLOW_REMOTE_DB;

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

const readFile = () => (fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '');
const modeOf = (p) => (fs.statSync(p).mode & 0o777).toString(8);

async function main() {
  const dbConfig = require('../src/db/config');
  const db = require('../src/db');

  // -- 1. the environment decides when nobody has saved anything --------------------
  console.log('\n  with only the environment set');
  let candidates = dbConfig.candidates();
  ok('the environment is the only candidate',
    candidates.length === 1 && candidates[0].source === 'environment',
    JSON.stringify(candidates.map((c) => c.source)));
  await db.connect();
  ok('connecting uses the environment', db.status().source === 'environment', db.status().source);
  ok('the dialect is the one asked for', db.dialect === 'sqlite', db.dialect);
  ok('the database file is the configured one', fs.existsSync(envFile));

  // -- 2. a saved configuration takes precedence ------------------------------------
  console.log('\n  a saved configuration');
  dbConfig.saveSaved({ client: 'sqlite', file: savedFile });
  candidates = dbConfig.candidates();
  ok('it comes first', candidates[0].source === 'instance', candidates[0] && candidates[0].source);
  ok('it is the saved file, not the environment file',
    candidates[0].config.file === savedFile, candidates[0].config.file);
  ok('the environment is still listed behind it',
    candidates.some((c) => c.source === 'environment'));

  // -- 3. bootstrap: no connection is needed to find the saved configuration --------
  console.log('\n  bootstrap');
  await db.close();
  ok('the saved configuration is readable with no connection open',
    !!dbConfig.loadSaved().config && dbConfig.loadSaved().config.file === savedFile);
  ok('and candidates can be built with no connection open',
    dbConfig.candidates().length > 0);

  // -- 4. it survives a reload and is what connects ---------------------------------
  console.log('\n  after a reload');
  ok('a second read returns the same file', dbConfig.loadSaved().config.file === savedFile);
  await db.connect();
  ok('connecting uses the saved configuration, not the environment',
    db.status().source === 'instance', db.status().source);
  ok('the live connection is the saved file',
    db.liveConfig().file === savedFile, String(db.liveConfig().file));

  // -- 5. switching connections ------------------------------------------------------
  console.log('\n  switching');
  dbConfig.saveSaved({ client: 'sqlite', file: secondFile });
  const swap = await db.reconnect();
  ok('the live apply reports success', swap.ok === true, JSON.stringify(swap));
  ok('the connection is now the second file',
    db.liveConfig().file === secondFile, String(db.liveConfig().file));
  ok('the saved value is no longer pending a restart',
    dbConfig.same(dbConfig.loadSaved().config, db.liveConfig()));

  // -- 6. a password never reaches the interface or the file -------------------------
  console.log('\n  secrets');
  dbConfig.saveSaved({
    client: 'mysql', host: '127.0.0.1', port: 3306, name: 'trycord',
    user: 'app', password: 'super-secret-db-password', connectionLimit: 5,
  });
  const masked = dbConfig.mask(dbConfig.loadSaved().config);
  ok('the stored password round-trips',
    dbConfig.loadSaved().config.password === 'super-secret-db-password');
  ok('a masked view carries no password value',
    JSON.stringify(masked).indexOf('super-secret-db-password') === -1, JSON.stringify(masked));
  ok('a masked view says only that a password is set', masked.passwordSet === true);
  ok('the file itself holds no plaintext password',
    readFile().indexOf('super-secret-db-password') === -1);
  ok('the file is mode 0600', modeOf(configFile) === '600', modeOf(configFile));
  ok('its directory is mode 0700',
    modeOf(path.dirname(configFile)) === '700', modeOf(path.dirname(configFile)));

  // -- 7. a refused write leaves the working configuration alone ---------------------
  console.log('\n  a refused write');
  const before = readFile();
  let threw = false;
  try {
    dbConfig.saveSaved({ client: 'mysql', host: '', name: '', user: '', port: 99999 });
  } catch { threw = true; }
  ok('an invalid configuration is refused', threw === true);
  ok('the stored configuration is untouched', readFile() === before);

  // -- 8. an unreachable server is reported, not assumed -----------------------------
  console.log('\n  an unreachable server');
  const refused = await dbConfig.probe({
    client: 'mysql', host: '127.0.0.1', port: 1, name: 'nope', user: 'nope', password: 'nope',
  });
  ok('a probe against a closed port fails', refused.ok === false, JSON.stringify(refused));
  ok('and the reason is human-readable',
    typeof refused.error === 'string' && refused.error.length > 0, refused.error);

  // -- 9. rollback restores the previous configuration -------------------------------
  console.log('\n  rollback');
  const rolled = dbConfig.rollbackSaved();
  const current = dbConfig.loadSaved().config;
  ok('rollback reports success', rolled.ok === true, JSON.stringify(rolled));
  ok('the previous configuration is back in charge',
    current.client === 'sqlite' && current.file === secondFile, JSON.stringify(current));
  ok('the configuration that was replaced is now the rollback target',
    dbConfig.loadSaved().previous && dbConfig.loadSaved().previous.client === 'mysql');

  // -- 10. an unreachable saved configuration falls back at boot ---------------------
  console.log('\n  falling back when the saved configuration cannot be reached');
  await db.close();
  dbConfig.saveSaved({ client: 'sqlite', file: path.join(tmp, 'missing-dir', 'x.sqlite') });
  // A path whose parent cannot be created: /dev/null is a file, so nothing can be
  // created underneath it, which is an unreachable database however it is read.
  dbConfig.saveSaved({ client: 'sqlite', file: '/dev/null/impossible.sqlite' });
  await db.connect();
  ok('boot falls back rather than failing',
    db.status().source === 'previous', db.status().source);
  ok('and reports what the saved configuration did',
    db.status().failures.some((f) => f.source === 'instance'),
    JSON.stringify(db.status().failures));

  await db.close();
  console.log('\n  database configuration check ' + (failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
