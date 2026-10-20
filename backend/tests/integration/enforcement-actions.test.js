// The enforcement actions on an account.
//
// The account console offered three actions - suspend for a day, suspend
// indefinitely, and ban - and **every one of them was refused**.
//
// The console sent its own shorthand, `{ kind, duration, reason }`, and the
// server reads `actionType`, `reason`, `expiresInHours` and `confirm`. So the
// answer was "invalid action type for user target" and the menu items did
// nothing at all.
//
// The phone had the same fault differently: it sent `USER_BAN` and
// `USER_SUSPENSION`, which are not the names the server knows, and it sent
// the length of a suspension in minutes where the server reads hours.
//
// So the check is not "the body has the right keys" - it is that the server
// **applies** the action, and that a forged one is refused.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('the enforcement actions on an account', async (t) => {
  // The account console belongs to a platform administrator, so the instance
  // is started with one. The promotion happens at registration, which is when
  // the account exists at all.
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'admin' } });
  t.after(() => instance.stop());

  const admin = await registerUser(instance, 'admin');
  const member = await registerUser(instance, 'member');
  const other = await registerUser(instance, 'other');

  await t.test('a warning is applied', async () => {
    const res = await admin.post('/api/admin/users/' + member.user.id + '/enforce', {
      actionType: 'WARNING',
      reason: 'A warning from an administrator',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.actionType, 'WARNING');
  });

  await t.test('a suspension for a day is applied', async () => {
    const res = await admin.post('/api/admin/users/' + member.user.id + '/enforce', {
      actionType: 'SUSPENSION',
      reason: 'Suspended for a day',
      expiresInHours: 24,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.actionType, 'SUSPENSION');
    assert.ok(res.data.expiresAt, 'the suspension has no end');
  });

  await t.test('an account ban is applied, and the refusal says why when it is not confirmed', async () => {
    const unconfirmed = await admin.post('/api/admin/users/' + other.user.id + '/enforce', {
      actionType: 'ACCOUNT_BAN',
      reason: 'Banned by an administrator',
    });
    assert.equal(unconfirmed.status, 400,
      'a ban was applied without the confirmation the server asks for: '
      + JSON.stringify(unconfirmed.data));

    const confirmed = await admin.post('/api/admin/users/' + other.user.id + '/enforce', {
      actionType: 'ACCOUNT_BAN',
      reason: 'Banned by an administrator',
      confirm: true,
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.actionType, 'ACCOUNT_BAN');
  });

  await t.test('an action the server does not know is refused, and says so', async () => {
    const res = await admin.post('/api/admin/users/' + member.user.id + '/enforce', {
      // The name the console used to send.
      kind: 'suspend',
      reason: 'Suspended by an administrator',
    });
    assert.equal(res.status, 400, 'an action with no type was accepted');
    assert.match(String(res.data.error && res.data.error.message),
      /invalid action type/i,
      'the refusal does not say what was wrong');
  });

  await t.test('the names the console sends are the names the server knows', () => {
    // The console and the phone send the server's own vocabulary. A copy of
    // the vocabulary in the client is a copy that drifts, and it did.
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', '..');

    const server = fs.readFileSync(
      path.join(root, 'src', 'services', 'enforcement.js'), 'utf8');
    const known = new Set(
      [...server.matchAll(/new Set\(\[([^\]]+)\]/g)]
        .flatMap((match) => match[1].split(','))
        .map((name) => name.trim().replace(/^'|'$/g, ''))
        .filter(Boolean),
    );
    assert.ok(known.has('WARNING'), 'the server does not know WARNING');
    assert.ok(known.has('SUSPENSION'), 'the server does not know SUSPENSION');
    assert.ok(known.has('ACCOUNT_BAN'), 'the server does not know ACCOUNT_BAN');

    for (const file of [
      path.join(root, '..', 'frontend', 'js', 'features', 'adminSurfaces.js'),
      path.join(root, '..', 'frontend', 'mobile', 'js', 'views', 'admin.js'),
    ]) {
      const source = fs.readFileSync(file, 'utf8');
      // Every action type the client names must be one the server knows.
      for (const match of source.matchAll(/actionType:\s*'([A-Z_]+)'/g)) {
        assert.ok(known.has(match[1]),
          path.basename(file) + ' sends the action type ' + match[1]
          + ', which the server does not know');
      }
      for (const match of source.matchAll(/promptEnforce\([^,]+,\s*'([A-Z_]+)'\)/g)) {
        assert.ok(known.has(match[1]),
          path.basename(file) + ' sends the action type ' + match[1]
          + ', which the server does not know');
      }
      // And it must not send the names the server does not know, whatever
      // they are called.
      for (const match of source.matchAll(/'?(USER_BAN|USER_SUSPENSION|USER_WARNING)'?/g)) {
        assert.fail(
          path.basename(file) + ' still names ' + match[1]
          + ', which the server does not know: '
          + 'the client and the server must share one vocabulary',
        );
      }
    }
  });
});
