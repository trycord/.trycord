#!/usr/bin/env node
'use strict';

// Dump the live database. Read-only: every statement it issues is a SELECT or a SHOW.
//
// This is the terminal face of the same service the administration page uses
// (src/services/backup.js), so a dump taken from a shell and a dump taken from
// the console are the same dump, verified the same way.
//
// The service it calls refuses to run unless DB_CLIENT is resolved explicitly
// and reported, prints the target it connected to before it reads anything,
// opens the connection read-only where the driver supports it, and verifies the
// dump afterwards instead of trusting that it wrote one.
//
// Usage:
//   node scripts/db-backup.js [--out <dir>]
//
// The password never reaches argv - it is read from the environment or from .env by this
// process, so `ps` cannot see it and a shell history cannot leak it.

const path = require('path');
const backup = require('../src/services/backup');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

(async () => {
  const t = backup.target();
  const outDir = argValue('--out') || process.env.TRYCORD_BACKUP_DIR || backup.backupDirectory();

  console.log(`\n  target   ${t.user}@${t.host}:${t.port}/${t.name}`);
  console.log(`  writing  ${outDir}`);

  let out;
  try {
    out = await backup.create({ outDir });
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    if (e.result) {
      console.error('  A partial file may exist. Check it before relying on it.\n');
    }
    process.exit(1);
  }

  console.log(`  tables   ${out.tables}`);
  console.log(`  rows     ${out.rows}`);
  console.log(`  size     ${(out.bytes / 1048576).toFixed(1)}M raw, ${(out.gzippedBytes / 1048576).toFixed(1)}M gzipped`);
  console.log(`  file     ${out.path}`);
  console.log('  verified. Keep both files; the .gz is the copy to move off this machine.\n');
})();
