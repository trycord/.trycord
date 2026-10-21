#!/usr/bin/env node
'use strict';

// Set the password of an account.
//
// The operator's way in when somebody cannot sign in: the account is there,
// it is not locked, and the password is not what they have.
//
// It goes through the same policy and the same hashing as every other
// password, so the account is not left in a state the product cannot read.
//
//   node scripts/set-password.js <username> <password>
//   node scripts/set-password.js <username>            # asks for one
//
// The password is read from the argument or asked for on the terminal, so it
// does not have to be typed into a shell that keeps a history.

const path = require('node:path');
const readline = require('node:readline');
const bcrypt = require('bcrypt');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../src/db');
const { checkPassword, BCRYPT_COST } = require('../src/auth/passwords');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || ''));
    });
  });
}

(async () => {
  const username = String(process.argv[2] || '').trim();
  if (!username) {
    console.error('which account? node scripts/set-password.js <username> [password]');
    process.exit(2);
  }
  let password = process.argv[3];
  if (!password) {
    process.stdout.write('the new password: ');
    password = await ask('');
  }
  const problem = checkPassword(password);
  if (problem) {
    console.error('that password will not be accepted: ' + problem);
    process.exit(2);
  }

  await db.connect();
  const user = await db.get('SELECT id, username, email FROM users WHERE username = ?', [username]);
  if (!user) {
    console.error('there is no account called ' + username);
    process.exit(1);
  }
  const hash = await bcrypt.hash(String(password), BCRYPT_COST);
  await db.run(
    'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
    [hash, new Date().toISOString(), user.id]
  );
  // A locked account stays locked: the password is not the lock, and
  // unlocking it would be a decision the operator did not ask for.
  console.log('the password of ' + user.username + ' is set.');
  process.exit(0);
})().catch((error) => {
  console.error('the password was not set: ' + ((error && error.message) || error));
  process.exit(1);
});
