#!/usr/bin/env node
'use strict';

// Clear the second factor of an account.
//
// Somebody who has lost the phone their authenticator was on cannot get in:
// the second factor is the way in, and the only way to turn it off is
// through the second factor. This is the administrator's way out.
//
// It writes an audit row, the same one the administration route writes, so
// that what was done is written down.
//
//   node scripts/clear-second-factor.js <username>

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/db');

(async () => {
  const username = String(process.argv[2] || '').trim();
  if (!username) {
    console.error('which account? node scripts/clear-second-factor.js <username>');
    process.exit(2);
  }
  await db.connect();
  const user = await db.get(
    'SELECT id, username, totp_enabled_at FROM users WHERE username = ?',
    [username]
  );
  if (!user) {
    console.error('there is no account called ' + username);
    process.exit(1);
  }
  if (!user.totp_enabled_at) {
    console.log(user.username + ' has no second factor.');
    process.exit(0);
  }
  await db.transaction(async (t) => {
    await t.run(
      'UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL WHERE id = ?',
      [user.id]
    );
    await t.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', [user.id]);
  });
  try {
    const { uuid, now } = require('../src/util');
    await db.run(
      'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), null, 'two_factor_cleared', 'user', user.id,
        'the account holder lost the authenticator', now()]
    );
  } catch { /* the audit is best-effort */ }
  console.log('the second factor of ' + user.username + ' is cleared. The password is not changed.');
  process.exit(0);
})().catch((error) => {
  console.error('the second factor was not cleared: ' + ((error && error.message) || error));
  process.exit(1);
});
