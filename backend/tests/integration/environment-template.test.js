// The environment template.
//
// The template is the only document an operator reads before they start an
// instance, so a variable the code reads and the template does not mention is
// a setting they cannot find. The reverse is worse: a variable the template
// documents and the code does not read is a control that does nothing.
//
// Both directions are checked here, so the template and the code cannot drift
// apart.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..', '..');
const TEMPLATE = path.join(BACKEND, '.env.example');

// The variables a supervisor sets, or that exist for a verification run
// rather than for an operator. They are deliberately not in the template:
// documenting them would invite somebody to set one in production.
const NOT_OPERATOR_FACING = new Set([
  'NODE_APP_INSTANCE',
  'PM2_INSTANCE_ID',
  'TRYCOD_DB_ENV_ONLY',
  'TRYCORD_MIGRATION_LOG',
  // The older name for the job concurrency. It is still read, so a deployment
  // that set it keeps its value, but the template names the consistent one.
  'TRYCORD_CONCURRENT_JOBS',
]);

/** Every environment variable the source reads. */
function variablesRead() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
        let m;
        while ((m = re.exec(source)) !== null) found.add(m[1]);
      }
    }
  };
  walk(path.join(BACKEND, 'src'));
  return found;
}

/** The variable names the template mentions, commented or not. */
function variablesDocumented() {
  const source = fs.readFileSync(TEMPLATE, 'utf8');
  const found = new Set();
  const re = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/gm;
  let m;
  while ((m = re.exec(source)) !== null) found.add(m[1]);
  return found;
}

test('the environment template', async (t) => {
  await t.test('every variable the code reads is in the template', () => {
    const read = variablesRead();
    const documented = variablesDocumented();
    const missing = [...read]
      .filter((name) => !documented.has(name) && !NOT_OPERATOR_FACING.has(name))
      .sort();
    assert.deepEqual(missing, [],
      'these variables are read by the code and are not in .env.example: ' + missing.join(', '));
  });

  await t.test('every setting the catalogue bridges is in the template', () => {
    const settings = require('../../src/services/settings');
    const documented = variablesDocumented();
    const missing = settings.SCHEMA
      .map((entry) => entry.env)
      .filter(Boolean)
      .filter((name) => !documented.has(name))
      .sort();
    assert.deepEqual(missing, [],
      'these settings bridge to an environment variable the template does not name: ' + missing.join(', '));
  });

  await t.test('the template does not document a variable nothing mentions', () => {
    const documented = variablesDocumented();
    // A variable the template names must appear somewhere in the source. Not
    // necessarily as `process.env.NAME` - the dashboard service and the status
    // monitor read theirs through a helper or a destructured alias - but it
    // has to be a name the code knows.
    const source = fs.readdirSync(path.join(BACKEND, 'src'), { recursive: true })
      .filter((name) => String(name).endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(BACKEND, 'src', name), 'utf8'))
      .join('\n');

    const invented = [...documented]
      .filter((name) => !source.includes(name))
      .sort();
    assert.deepEqual(invented, [],
      'these variables are in .env.example and the source never mentions them: ' + invented.join(', '));
  });

  await t.test('the dangerous ones say so', () => {
    const source = fs.readFileSync(TEMPLATE, 'utf8');
    // A variable that bypasses a security control has to say what it does and
    // what it costs.
    for (const [name, warning] of [
      ['ALLOW_TEST_HOOKS', /never set it on a public instance/i],
      ['CONTINUUM_ALLOW_LOCALHOST', /never set it in production/i],
    ]) {
      assert.ok(source.includes(name + '='), 'the template names ' + name);
      assert.ok(warning.test(source), 'the template warns about ' + name);
    }
  });

  await t.test('the deployment choices an operator has to make are all there', () => {
    const source = fs.readFileSync(TEMPLATE, 'utf8');
    for (const name of [
      'JWT_SECRET',
      'SERVER_HOST_TYPE',
      'DB_CLIENT',
      'MAIL_MODE',
      'DASHBOARD_MODE',
      'TRYCORD_CLIENT_DIR',
      'PORT',
      'HOST',
    ]) {
      assert.ok(source.includes(name + '='), 'the template names ' + name);
    }
  });
});
