// Import records from a SQLite file into the configured database.
// Run:  node scripts/migrate.js --from ./old-server.db
// Works sqlite -> mysql and sqlite -> sqlite. Never touches the source file.
//
// The table list comes from the schema, not from a list maintained here, so a
// table added to the schema is migrated automatically instead of being silently
// dropped. Schema order is foreign-key order.
//
// The whole import runs in one transaction: if a row cannot be inserted the
// target is left exactly as it was, rather than half-populated.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../src/db');
const { tableNames } = require('../src/db/schema');
require('dotenv').config();

function isDuplicate(e) {
  const msg = String((e && e.message) || '');
  return /UNIQUE|unique|ER_DUP_ENTRY/i.test(msg) || e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx !== -1 ? process.argv[fromIdx + 1] : null;
  if (!from || !fs.existsSync(from)) {
    console.error('usage: node scripts/migrate.js --from <sqlite-file>');
    process.exit(1);
  }

  const missing = [];
  const skippedEmpty = [];
  const copied = [];
  const alreadyPresent = [];

  await db.connect(); // applies schema to the TARGET first
  const q = (name) => (db.dialect === 'mysql' ? '`' + name + '`' : '"' + name + '"');
  const src = new Database(path.resolve(from), { readonly: true });

  try {
    await db.transaction(async (t) => {
      for (const table of tableNames()) {
        let rows;
        try {
          rows = src.prepare(`SELECT * FROM "${table}"`).all();
        } catch (e) {
          // The source predates this table. Not an error, but it must be
          // reported: the operator is importing into an older database.
          missing.push(table);
          continue;
        }
        if (!rows.length) {
          skippedEmpty.push(table);
          continue;
        }
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(', ');
        let n = 0;
        let dup = 0;
        for (const row of rows) {
          try {
            await t.run(
              `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${placeholders})`,
              cols.map((c) => (row[c] === undefined ? null : row[c]))
            );
            n++;
          } catch (e) {
            if (isDuplicate(e)) dup++;
            else throw e;
          }
        }
        copied.push([table, n, dup]);
      }
    });
  } finally {
    src.close();
    await db.close();
  }

  for (const [table, n, dup] of copied) {
    console.log(`${table}: ${n} copied, ${dup} skipped (already present)`);
  }
  for (const table of skippedEmpty) console.log(`${table}: 0 rows`);
  for (const table of missing) console.log(`${table}: not present in source`);

  const total = copied.reduce((a, [, n]) => a + n, 0);
  console.log(`\nmigration complete: ${total} rows across ${copied.length} tables`);
  if (missing.length) {
    console.log(`${missing.length} table(s) absent from the source and left empty: ${missing.join(', ')}`);
  }
}

main().catch((e) => {
  console.error('migration failed, target rolled back: ' + (e.message || e));
  process.exit(1);
});
