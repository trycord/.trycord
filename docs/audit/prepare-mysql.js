// Apply the schema to a MySQL database in an order MySQL accepts.
//
// The schema's own order has forward foreign-key references, and MySQL
// checks a referenced table at the moment the referencing table is created.
// This script applies the same DDL, in dependency order, so a database can
// be prepared for a measurement. It is a measurement aid, not a migration:
// the application applies the schema itself.
//
//   node docs/audit/prepare-mysql.js <host> <port> <user> <password> <database>

'use strict';

const path = require('path');
const mysql = require(path.join(__dirname, '..', '..', 'backend', 'node_modules', 'mysql2', 'promise'));

const ORDER = [
  'identity', 'e2ee', 'communities', 'messaging', 'social', 'moderation',
  'instance', 'continuum', 'developer', 'extensions', 'workspace',
];

function referencedTables(statement) {
  return [...statement.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)].map((m) => m[1]);
}

function tableName(statement) {
  const m = /CREATE TABLE IF NOT EXISTS\s+(\w+)/.exec(statement);
  return m ? m[1] : null;
}

(async () => {
  const [host, port, user, password, database] = process.argv.slice(2);
  const statements = [];
  for (const group of ORDER) {
    const module = require(path.join(__dirname, '..', '..', 'backend', 'src', 'db', 'tables', group));
    for (const statement of module(' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')) {
      statements.push(statement);
    }
  }

  // Apply in dependency order: a table goes after everything it points at.
  const remaining = statements.slice();
  const applied = new Set();
  const order = [];
  while (remaining.length) {
    const ready = remaining.filter((s) => referencedTables(s).every((r) => applied.has(r)));
    if (!ready.length) {
      throw new Error('circular reference: ' + remaining.map(tableName).join(', '));
    }
    for (const statement of ready) {
      order.push(statement);
      applied.add(tableName(statement));
      remaining.splice(remaining.indexOf(statement), 1);
    }
  }

  const conn = await mysql.createConnection({ host, port, user, password, database });
  for (const statement of order) {
    await conn.query(statement);
  }
  console.log('applied ' + order.length + ' tables in dependency order');
  await conn.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
