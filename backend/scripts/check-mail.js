#!/usr/bin/env node
'use strict';

// Mail mode, against a real database and a real HTTP server.
//
// This exists because the mail subsystem used to be one file with one transport, and
// the ways it could be wrong were invisible from the outside: a mode that quietly
// fell back to logging, a disabled mode that reported success for mail nobody sent, a
// credential returned by the settings endpoint, a provider that sent an empty body.
//
// What is exercised here, each against something that can fail on its own:
//
//   the registry      rejects a mode nobody registered instead of guessing
//   disabled mode     never reports delivery, and touches no network
//   secret storage    encrypts at rest, never returns the value, needs a write to change
//   the API adapter   builds the request the operator described, nested paths included
//   the API adapter   reports a provider refusal as a failure with its own reason
//   precedence        an environment value outranks a stored one, as everywhere else
//   test sends        a real request reaches a real listener and comes back accepted
//
// The HTTP half stands up a local server and points the adapter at it. That proves
// the adapter's own request and response handling. It says nothing about any vendor's
// API, and nothing here claims it does: which vendor an operator reaches is their
// endpoint and their field mapping.
//
// node scripts/check-mail.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-mail-' + Date.now();
process.env.DB_CLIENT = 'sqlite';
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-mail-')), 'check.db');
// The stored precedence must be observed in this test, so the deployment variables it
// would otherwise read are cleared. They are restored afterwards.
const ENV_KEYS = ['MAIL_MODE', 'SMTP_HOST', 'SMTP_PASSWORD', 'MAIL_API_KEY', 'MAIL_API_ENDPOINT'];
const savedEnv = {};
for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) { passed += 1; console.log('    ok   ' + label + (detail ? ': ' + detail : '')); }
  else { failed += 1; failures.push(label); console.log('    FAIL ' + label + (detail ? ': ' + detail : '')); }
}

async function main() {
  const db = require('../src/db');
  // db.connect() reads DB_CLIENT/DB_PATH from the environment, applies the schema and
  // leaves the facade wired to that connection, which is the same path the server takes.
  await db.connect();

  const settings = require('../src/services/settings');
  const registry = require('../src/services/mail/registry');
  const mail = require('../src/services/mail');
  const secrets = require('../src/services/secrets');
  const { now, uuid } = require('../src/util');

  // Every settings save writes an audit row naming who made the change, and the column
  // is not nullable. A real administrator is created rather than a null passed in, so
  // the check exercises the same path the dashboard does.
  const adminId = uuid();
  await db.run(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (?, ?, 'not-a-real-hash', ?)`,
    [adminId, 'mail-check-admin', now()]
  );
  await db.run('INSERT INTO admins (user_id, created_at) VALUES (?, ?)', [adminId, now()]);

  console.log('\n  registry');
  ok('exactly three modes are offered', JSON.stringify(registry.MODES) === JSON.stringify(['smtp', 'api', 'disabled']),
    registry.MODES.join(', '));
  ok('every mode resolves to a registered provider',
    registry.MODES.every((m) => !!registry.providerFor(m)));
  ok('an unregistered mode resolves to nothing rather than a guess',
    registry.providerFor('sendgrid') === null && registry.providerFor('smtpp') === null);
  ok('the catalogue carries no vendor name',
    !/deomail|sendgrid|mailgun|postmark|ses\b/i.test(JSON.stringify(registry.catalogue())));
  ok('each provider declares the keys it reads',
    registry.catalogue().every((p) => Array.isArray(p.settings) && p.settings.length >= 0));

  console.log('\n  disabled mode');
  await settings.load(true);
  ok('an instance that never configured mail is disabled, not logging',
    mail.mode() === 'disabled', mail.mode());

  let delivered = null;
  let threw = null;
  try {
    delivered = await mail.send({ to: 'nobody@example.com', subject: 'x', text: 'y' });
  } catch (e) { threw = e; }
  ok('disabled mode throws rather than reporting a delivery', threw !== null);
  ok('the message names the reason in plain words',
    threw && /disabled/i.test(threw.message), threw && threw.message);
  ok('nothing came back claiming to have been delivered', delivered === null);

  console.log('\n  secrets');
  const ciphertext = secrets.encrypt('mail:mail.apiKey', 'super-secret-value');
  ok('a secret is not stored as what was given', !ciphertext.includes('super-secret-value'));
  ok('it decrypts back to the original', secrets.decrypt('mail:mail.apiKey', ciphertext) === 'super-secret-value');
  ok('a secret encrypted for another purpose does not decrypt',
    (() => { try { secrets.decrypt('mail:mail.smtpPassword', ciphertext); return false; } catch { return true; } })());
  ok('a tampered row is rejected rather than decrypted',
    (() => {
      const parts = ciphertext.split('.');
      parts[3] = parts[3].slice(0, -4) + 'AAAA';
      try { secrets.decrypt('mail:mail.apiKey', parts.join('.')); return false; } catch { return true; }
    })());

  console.log('\n  saving a secret');
  let threw2 = null;
  try {
    await settings.save({ 'mail.apiKey': 'stored-key-value' }, adminId);
  } catch (e) { threw2 = e; }
  ok('a secret can be stored', threw2 === null, threw2 && threw2.message);
  const row = await db.get('SELECT value FROM instance_settings WHERE `key` = ?', ['mail.apiKey']);
  ok('the stored row is ciphertext, not the credential',
    !!row && !row.value.includes('stored-key-value'));
  ok('reading it back yields the original', settings.secretValue('mail.apiKey') === 'stored-key-value');

  let refused = null;
  try { settings.get('mail.apiKey'); refused = false; } catch { refused = true; }
  ok('the ordinary getter refuses to return a secret', refused);

  const catalogueJson = JSON.stringify(settings.catalogue());
  ok('the catalogue reports a secret as set without its value',
    catalogueJson.includes('"set":true') && !catalogueJson.includes('stored-key-value'));

  await settings.save({ 'mail.apiKey': '' }, adminId);
  ok('a blank write leaves the stored secret alone',
    settings.secretValue('mail.apiKey') === 'stored-key-value');

  await settings.save({ 'mail.apiKey': 'rotated-key-value' }, adminId);
  ok('writing a new value rotates it',
    settings.secretValue('mail.apiKey') === 'rotated-key-value');

  console.log('\n  the api adapter against a real listener');
  const received = [];
  let nextStatus = 202;
  let nextBody = { id: 'msg_123' };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/send';

  await settings.save({
    'mail.mode': 'api',
    'mail.from': 'Trycord <hello@trycord.dev>',
    'mail.apiEndpoint': endpoint,
    'mail.apiKey': 'rotated-key-value',
    'mail.apiToField': 'personalization.to',
    'mail.apiSubjectField': 'subject',
    'mail.apiTextField': 'content.text',
    'mail.apiHtmlField': 'content.html',
  }, adminId);

  ok('the mode is api', mail.mode() === 'api', mail.mode());
  ok('it validates', mail.validateCurrent().ok,
    mail.validateCurrent().problems.join('; '));

  const out = await mail.send({
    to: 'person@example.com',
    subject: 'Confirm your email',
    text: 'the plain version',
    html: '<p>the html version</p>',
    kind: 'verification',
  });
  ok('the provider accepted the message', out.delivered === true);
  ok('the identifier from the response comes back', out.id === 'msg_123', String(out.id));
  ok('one request reached the listener', received.length === 1);

  const body = JSON.parse(received[0].raw);
  ok('the recipient is where the operator said to put it',
    body.personalization && body.personalization.to === 'person@example.com',
    JSON.stringify(body.personalization));
  ok('the subject is at the mapped path', body.subject === 'Confirm your email');
  ok('the plain text is at the nested mapped path',
    body.content && body.content.text === 'the plain version');
  ok('the html is at its nested mapped path',
    body.content && body.content.html === '<p>the html version</p>');
  ok('the sender is included', body.from === 'Trycord <hello@trycord.dev>', body.from);
  ok('the credential is sent in the named header',
    received[0].headers.authorization === 'Bearer rotated-key-value');

  console.log('\n  a provider that refuses');
  nextStatus = 422;
  nextBody = { message: 'the from address is not verified' };
  let refused2 = null;
  try {
    await mail.send({ to: 'person@example.com', subject: 'x', text: 'y' });
  } catch (e) { refused2 = e; }
  ok('a 4xx is reported as a failure', refused2 !== null);
  ok('the provider\'s own reason is carried through',
    refused2 && /not verified/i.test(refused2.message), refused2 && refused2.message);

  console.log('\n  an endpoint that cannot be reached');
  await settings.save({ 'mail.apiEndpoint': 'https://127.0.0.1:1/v1/send' }, adminId);
  let refused3 = null;
  try {
    await mail.send({ to: 'person@example.com', subject: 'x', text: 'y' });
  } catch (e) { refused3 = e; }
  ok('an unreachable endpoint is a failure, not a silent success', refused3 !== null);
  ok('the failure does not leak the request', refused3 && !refused3.message.includes('rotated-key-value'));

  console.log('\n  endpoint safety');
  await settings.save({ 'mail.apiEndpoint': 'http://mail.example.com/v1/send' }, adminId);
  const v = mail.validateCurrent();
  ok('a cleartext endpoint to a remote host is refused',
    !v.ok && v.problems.some((p) => /https/.test(p)), v.problems.join('; '));

  await settings.save({ 'mail.apiEndpoint': endpoint }, adminId);
  ok('a cleartext endpoint to localhost is allowed', mail.validateCurrent().ok,
    mail.validateCurrent().problems.join('; '));

  console.log('\n  precedence');
  process.env.MAIL_API_KEY = 'key-from-the-environment';
  await settings.load(true);
  ok('an environment secret outranks the stored one',
    settings.secretValue('mail.apiKey') === 'key-from-the-environment');
  ok('the catalogue says where it came from',
    settings.source('mail.apiKey') === 'environment', settings.source('mail.apiKey'));
  delete process.env.MAIL_API_KEY;
  await settings.load(true);
  ok('removing it restores the stored one',
    settings.secretValue('mail.apiKey') === 'rotated-key-value');

  process.env.MAIL_MODE = 'smtp';
  await settings.load(true);
  ok('MAIL_MODE=smtp still selects smtp, as an existing install expects', mail.mode() === 'smtp');
  delete process.env.MAIL_MODE;
  await settings.load(true);

  console.log('\n  smtp validates without touching the network');
  await settings.save({ 'mail.mode': 'smtp' }, adminId);
  const sv = mail.validateCurrent();
  ok('an smtp install with no host is refused with a readable reason',
    !sv.ok && sv.problems.some((p) => /host/i.test(p)), sv.problems.join('; '));
  await settings.save({ 'mail.smtpHost': 'smtp.example.com', 'mail.smtpUser': 'apikey' }, adminId);
  const sv2 = mail.validateCurrent();
  ok('a username with no stored password is refused',
    !sv2.ok && sv2.problems.some((p) => /password/i.test(p)), sv2.problems.join('; '));
  await settings.save({ 'mail.smtpPassword': 'relay-secret' }, adminId);
  ok('with a password it validates', mail.validateCurrent().ok,
    mail.validateCurrent().problems.join('; '));

  console.log('\n  a test send is a real send');
  await settings.save({ 'mail.mode': 'api', 'mail.apiEndpoint': endpoint }, adminId);
  nextStatus = 202;
  nextBody = { id: 'msg_test' };
  const before = received.length;
  const testOut = await mail.test('someone@example.com');
  ok('a test send reports what happened', testOut.ok === true, JSON.stringify(testOut));
  ok('it actually reached the provider', received.length === before + 1);

  const badAddress = await mail.test('not-an-address');
  ok('a malformed address is refused before anything is sent',
    badAddress.ok === false && /address/i.test(badAddress.error), badAddress.error);

  await settings.save({ 'mail.mode': 'disabled' }, adminId);
  const disabledTest = await mail.test('someone@example.com');
  ok('a test send in disabled mode does not claim delivery',
    disabledTest.ok === false || disabledTest.delivered === false,
    JSON.stringify(disabledTest));

  await new Promise((resolve) => server.close(resolve));

  console.log(failed
    ? '\n  mail check FAILED - ' + failed + ' of ' + (passed + failed) + ' assertions failed\n'
    : '\n  mail check passed - ' + passed + ' assertions\n');
  return failed ? 1 : 0;
}

main()
  .then((code) => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.exit(code);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
