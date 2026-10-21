// The migration ledger.
//
// A migration that runs twice can lose data; a migration that runs over a
// half-applied earlier one can lose more. These tests are about the ledger
// that prevents both, and about the checks that notice when a migration
// claimed success and did not do its work.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migrations = require('../../src/db/migrations');
const { tableNames } = require('../../src/db/schema');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-mig-'));
  return { dir, file: path.join(dir, 'mig.db') };
}

// A connection to a temporary SQLite database, with the baseline schema
// applied. The baseline owns the tables; the ledger owns what happens to a
// database that already has them. These tests are about the ledger, so the
// baseline is set up first, the same way the server sets it up.
async function connect(file) {
  const conn = await require('../../src/db/sqlite').connect(file);
  await require('../../src/db/schema').applySchema(conn);
  return conn;
}

test('the migration ledger', async (t) => {
  await t.test('the ledger table is created and a fresh database records the migrations', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      const result = await migrations.run(conn);
      assert.ok(result.applied.length >= 1, 'the baseline migration is applied');
      assert.deepEqual(result.skipped, []);

      const ledger = await migrations.readLedger(conn);
      assert.equal(ledger.length, result.applied.length);
      for (const row of ledger) {
        assert.equal(row.status, 'applied');
        assert.ok(row.appliedAt, 'a migration records when it was applied');
        assert.ok(row.durationMs >= 0);
      }
    } finally {
      await conn.close();
    }
  });

  await t.test('running again applies nothing and changes nothing', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      await migrations.run(conn);
      const before = await migrations.readLedger(conn);

      const second = await migrations.run(conn);
      assert.equal(second.applied.length, 0, 'a migration is never applied twice');
      assert.deepEqual(second.skipped, before.map((r) => r.version));

      const after = await migrations.readLedger(conn);
      assert.equal(after.length, before.length, 'the ledger does not grow on a repeat run');
    } finally {
      await conn.close();
    }
  });

  await t.test('legacy applications receive separate bot identities without losing their owners', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      await migrations.run(conn);
      const now = new Date().toISOString();
      await conn.run(
        'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
        ['owner-1', 'owner_one', 'hash', now]
      );
      await conn.run(
        'INSERT INTO servers (id, name, owner_id, join_code, created_at) VALUES (?, ?, ?, ?, ?)',
        ['community-1', 'Garden', 'owner-1', 'invite-1', now]
      );
      await conn.run(
        'INSERT INTO roles (id, server_id, name, position, permissions, is_default) VALUES (?, ?, ?, ?, ?, ?)',
        ['role-1', 'community-1', '@everyone', 1, '["SEND_MESSAGES"]', 1]
      );
      await conn.run(
        'INSERT INTO bot_applications (id, owner_user_id, server_id, name, status, token_hash, created_at, updated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['app-1', 'owner-1', 'community-1', 'helper', 'active', 'hash', now, now]
      );
      await conn.run('DELETE FROM schema_migrations WHERE `version` = ?', [7]);

      const migrated = await migrations.run(conn);
      assert.equal(migrated.applied.some((entry) => entry.version === 7), true);
      const application = await conn.get('SELECT owner_user_id, bot_user_id, token_hash FROM bot_applications WHERE id = ?', ['app-1']);
      assert.ok(application.bot_user_id);
      assert.notEqual(application.bot_user_id, application.owner_user_id);
      assert.equal(application.token_hash, 'hash', 'the existing credential stays untouched');
      const account = await conn.get('SELECT is_bot FROM users WHERE id = ?', [application.bot_user_id]);
      assert.equal(Number(account.is_bot), 1);
      assert.ok(await conn.get(
        'SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_id = ?',
        ['community-1', application.bot_user_id]
      ));
      assert.ok(await conn.get('SELECT id FROM users WHERE id = ?', ['owner-1']), 'the developer account remains');
    } finally {
      await conn.close();
    }
  });

  await t.test('a database a newer build wrote to is refused', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      await conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations ('
        + ' version INTEGER PRIMARY KEY, name VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL,'
        + ' applied_at VARCHAR(64) NOT NULL, duration_ms INTEGER NOT NULL, detail TEXT)');
      await conn.run(
        'INSERT INTO schema_migrations (version, name, status, applied_at, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?)',
        [migrations.LATEST_VERSION + 5, 'from the future', 'applied', new Date().toISOString(), 1, null],
      );

      await assert.rejects(
        () => migrations.run(conn),
        /newer than this build knows about/,
        'running an older build against a newer schema must be refused, not silently accepted',
      );
    } finally {
      await conn.close();
    }
  });

  await t.test('a failed migration blocks the ones after it until it is retried', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    const original = migrations.MIGRATIONS.slice();

    // A migration that fails the first time and succeeds once the cause is
    // fixed, standing in for one that hit a real problem: a column that
    // could not be converted, a table that could not be locked.
    let broken = true;
    const failing = {
      version: 9001,
      name: 'deliberately failing migration',
      transactional: false,
      async up() {
        if (broken) throw new Error('the data is not in a state this migration can handle');
      },
    };
    const after = {
      version: 9002,
      name: 'the migration after it',
      transactional: false,
      async up() { /* would run if the failure did not block it */ },
    };
    migrations.MIGRATIONS.push(failing, after);
    try {
      await assert.rejects(() => migrations.run(conn), /deliberately failing migration|not in a state/);

      // The failure is recorded, so an operator can see what happened.
      const ledger = await migrations.readLedger(conn);
      const failed = ledger.find((r) => r.version === 9001);
      assert.ok(failed, 'the failed migration is recorded');
      assert.equal(failed.status, 'failed');
      assert.match(failed.detail, /not in a state/);

      // And the migration after it did not run.
      const ranAfter = ledger.find((r) => r.version === 9002);
      assert.equal(ranAfter, undefined, 'a migration after a failed one must not run');

      // And a plain re-run refuses rather than skipping past the failure.
      await assert.rejects(() => migrations.run(conn), /failed and has not been resolved/);

      // With --retry the operator says they fixed the cause; the migration
      // runs again and the one after it is unblocked.
      broken = false;
      const retried = await migrations.run(conn, { force: true });
      assert.ok(retried.applied.some((m) => m.version === 9001));
      assert.ok(retried.applied.some((m) => m.version === 9002));
    } finally {
      migrations.MIGRATIONS.length = 0;
      migrations.MIGRATIONS.push(...original);
      await conn.close();
    }
  });

  await t.test('a migration whose verification fails is recorded as failed', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    const original = migrations.MIGRATIONS.slice();

    // A migration that "succeeds" but does not have the effect it promised.
    // This is the failure a ledger exists to catch: the work reported success
    // and the database is not what the build expects.
    const lying = {
      version: 9010,
      name: 'a migration that does not do what it says',
      transactional: false,
      async up() { /* writes nothing */ },
      async verify() { throw new Error('the expected table is not there'); },
    };
    migrations.MIGRATIONS.push(lying);
    try {
      await assert.rejects(() => migrations.run(conn), /the expected table is not there/);
      const ledger = await migrations.readLedger(conn);
      const failed = ledger.find((r) => r.version === 9010);
      assert.equal(failed.status, 'failed');
    } finally {
      migrations.MIGRATIONS.length = 0;
      migrations.MIGRATIONS.push(...original);
      await conn.close();
    }
  });

  await t.test('a precondition that does not hold stops the migration before it runs', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    const original = migrations.MIGRATIONS.slice();

    let ran = false;
    const guarded = {
      version: 9020,
      name: 'a migration with a precondition',
      transactional: false,
      async precheck() { throw new Error('this database is not the one this migration is for'); },
      async up() { ran = true; },
    };
    migrations.MIGRATIONS.push(guarded);
    try {
      await assert.rejects(() => migrations.run(conn), /not the one this migration is for/);
      assert.equal(ran, false, 'the migration body did not run');
    } finally {
      migrations.MIGRATIONS.length = 0;
      migrations.MIGRATIONS.push(...original);
      await conn.close();
    }
  });

  await t.test('the status report says what is applied and what is pending', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      await migrations.run(conn);
      const status = await migrations.status(conn);
      assert.equal(status.latestKnown, migrations.LATEST_VERSION);
      assert.deepEqual(status.pending, []);
      assert.ok(status.applied.length >= 1);
      assert.equal(status.failed.length, 0);
    } finally {
      await conn.close();
    }
  });

  await t.test('the schema check names a table that is missing', async () => {
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      await conn.exec('CREATE TABLE probe (id VARCHAR(64) PRIMARY KEY)');
      await conn.exec('DROP TABLE probe');
      await assert.rejects(
        () => migrations.assertTablesExist(conn, ['probe']),
        /probe/,
        'the check names what is missing',
      );
    } finally {
      await conn.close();
    }
  });

  await t.test('every table the schema declares is one the ledger knows about', async () => {
    // The fingerprint migration records the table list. If the schema grows
    // and the fingerprint does not, the fingerprint stops meaning anything,
    // and the check that compares them is the thing that notices.
    const { file } = tempDb();
    const conn = await connect(file);
    try {
      await migrations.run(conn);
      const row = await conn.get('SELECT tables FROM schema_fingerprint WHERE id = ?', [1]);
      assert.ok(row, 'the fingerprint was written');
      const recorded = String(row.tables).split(',').filter(Boolean).sort();
      assert.deepEqual(recorded, tableNames().slice().sort());
    } finally {
      await conn.close();
    }
  });
});
