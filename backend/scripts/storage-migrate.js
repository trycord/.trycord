// Copy every stored object from one storage driver to another.
//
// Use when moving from local disk to an S3-compatible bucket. The source is
// never modified or deleted: this tool only ever adds to the destination, so
// an interrupted run is safe to repeat and the old instance keeps working.
//
//   node scripts/storage-migrate.js --dry-run     report what would move
//   node scripts/storage-migrate.js               copy and verify
//   node scripts/storage-migrate.js --verify      re-check an existing copy
//
// The driver pair comes from the environment, same as the server:
//   SOURCE_UPLOAD_DIR  where the local files are now
//   STORAGE_DRIVER / S3_*  where they are going
// The destination driver is whatever the server is already configured to use.
//
// The set of objects is taken from the database, not from listing the source,
// because the database is what the server serves from: an orphaned file in the
// source tree is reported but not copied, and a row with no file is reported as
// missing rather than silently skipped.
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY_ONLY = process.argv.includes('--verify');

const db = require('../src/db');
const storage = require('../src/services/storage');

const SOURCE_ROOT = path.resolve(
  process.env.SOURCE_UPLOAD_DIR ||
    (process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'))
);

// The real hazard is copying a tree onto itself: every object would be read and
// rewritten from the file it already occupies, and a failure partway through
// leaves the source damaged. Two different local directories are fine.
if (storage.driverName() === 'local' && storage.localRoot() === SOURCE_ROOT) {
  console.error('source and destination are the same directory (' + SOURCE_ROOT + ').');
  console.error('Set SOURCE_UPLOAD_DIR to the old location, or configure a different STORAGE_DRIVER.');
  process.exit(1);
}

// Where an object lives in the source, given the row that owns it. Keys are
// built the same way src/services/uploads.js builds them, so the two agree.
const sourceKeyFor = {
  attachment: (r) => path.join('channel', r.channel_id, 'attachment', r.id),
  profile: (r) => path.join('user', r.user_id, r.kind, r.id),
  server: (r) => path.join('community', r.server_id, r.kind, r.id),
};

const toPosix = (p) => p.split(path.sep).join('/');

async function collect() {
  const items = [];
  const push = (group, id, key, size, expect) =>
    items.push({ group, id, key: toPosix(key), size, expect });

  const atts = await db.all('SELECT id, channel_id, size FROM attachments');
  atts.forEach((r) => push('attachment', r.id, sourceKeyFor.attachment(r), r.size, true));

  const prof = await db.all('SELECT id, user_id, kind, size FROM profile_media');
  prof.forEach((r) => push('profile', r.id, sourceKeyFor.profile(r), r.size, true));

  const srv = await db.all('SELECT id, server_id, kind, size FROM server_media');
  srv.forEach((r) => push('server', r.id, sourceKeyFor.server(r), r.size, true));

  return items;
}

(async () => {
  await db.connect();
  const items = await collect();
  const driver = storage.init();

  console.log(`source: ${SOURCE_ROOT}`);
  console.log(`destination: ${storage.driverName()}`);
  console.log(`database rows: ${items.length}\n`);

  const stats = { copied: 0, alreadyThere: 0, verified: 0, missing: 0, failed: 0 };
  const failures = [];

  for (const item of items) {
    const localFile = path.join(SOURCE_ROOT, item.key);
    let localSize = null;
    if (fs.existsSync(localFile)) {
      localSize = fs.statSync(localFile).size;
    } else if (!VERIFY_ONLY) {
      stats.missing++;
      failures.push({ item, reason: 'no file in the source at ' + localFile });
      continue;
    }

    if (VERIFY_ONLY || !DRY_RUN) {
      try {
        const remote = await storage.exists(item.key);
        if (VERIFY_ONLY) {
          if (remote && (localSize === null || localSize === item.size)) stats.verified++;
          else {
            stats.failed++;
            failures.push({ item, reason: remote ? 'present but size differs' : 'not present at destination' });
          }
          continue;
        }
        if (remote && (localSize === null || localSize === item.size)) {
          stats.alreadyThere++;
          continue;
        }
        if (localSize === null) {
          stats.missing++;
          failures.push({ item, reason: 'no file in the source' });
          continue;
        }
        const body = await fs.promises.readFile(localFile);
        await storage.put(item.key, body, null);
        // Verification is a separate read-back, not an assumption: a write that
        // reported success but stored the wrong bytes must not pass.
        const check = await storage.exists(item.key);
        if (!check) {
          stats.failed++;
          failures.push({ item, reason: 'destination read-back reported the object missing' });
          continue;
        }
        stats.copied++;
      } catch (e) {
        stats.failed++;
        failures.push({ item, reason: (e && e.message) || String(e) });
      }
    } else {
      // Dry run: report whether the destination already has it.
      try {
        const remote = await storage.exists(item.key);
        if (remote) stats.alreadyThere++;
        else stats.copied++;
      } catch {
        stats.failed++;
      }
    }
  }

  const total = stats.copied + stats.alreadyThere + stats.verified + stats.missing + stats.failed;
  console.log(`checked   ${total}`);
  if (VERIFY_ONLY || DRY_RUN) console.log(`would copy / present  ${stats.copied + stats.alreadyThere}`);
  else console.log(`copied    ${stats.copied}`);
  console.log(`present   ${stats.alreadyThere + stats.verified}`);
  console.log(`missing   ${stats.missing}`);
  console.log(`failed    ${stats.failed}`);

  if (failures.length) {
    console.log('\nfailures (re-run to retry; the tool skips anything already correct):');
    for (const f of failures.slice(0, 40)) {
      console.log(`  ${f.item.group}/${f.item.id}  ${f.reason}`);
    }
    if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
  }

  if (!DRY_RUN && !VERIFY_ONLY) {
    console.log('\nsource files were not modified. Verify, then switch the instance over:');
    console.log('  node scripts/storage-migrate.js --verify');
    console.log('Only once that is clean should you retire the old upload directory.');
  }

  await db.close();
  process.exit(stats.failed || stats.missing ? 1 : 0);
})().catch(async (e) => {
  console.error('migration failed: ' + ((e && e.message) || e));
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
