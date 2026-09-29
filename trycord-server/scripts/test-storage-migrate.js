// Proves scripts/storage-migrate.js and the upload pipeline agree on where an
// object lives. The two derive keys independently on purpose — if they drift,
// a migration silently copies nothing, so the agreement is checked here rather
// than discovered in production.
//
// Uses a second local driver as the "remote" so the tool can be exercised
// without a network or credentials.
//
// Pure: no server, no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

const TMP = path.join(os.tmpdir(), 'trycord-storage-migrate-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const SOURCE = path.join(TMP, 'source');
const DEST = path.join(TMP, 'dest');
fs.mkdirSync(SOURCE, { recursive: true });
fs.mkdirSync(DEST, { recursive: true });

process.env.SOURCE_UPLOAD_DIR = SOURCE;
process.env.UPLOAD_DIR = DEST;
process.env.STORAGE_DRIVER = 'local';
process.env.DB_CLIENT = 'sqlite';
process.env.DB_FILE = path.join(TMP, 'migrate.db');
process.env.SERVER_HOST_TYPE = 'express';
process.env.JWT_SECRET = 'x';
process.env.RATE_LIMIT_MAX = '1000000';

const storage = require('../src/services/storage');
const db = require('../src/db');

const { execFileSync } = require('child_process');
function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['scripts/storage-migrate.js', ...args], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

(async () => {
  await db.connect();
  const ts = '2026-01-01T00:00:00.000Z';
  await db.run('INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)', ['u1','mig','h',ts]);
  await db.run('INSERT INTO servers (id,owner_id,name,join_code,created_at) VALUES (?,?,?,?,?)', ['s1','u1','S','aaaa0000',ts]);
  await db.run('INSERT INTO channels (id,server_id,name) VALUES (?,?,?)', ['c1','s1','general']);

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const att = { id: 'a1', channel_id: 'c1' };
  const prof = { id: 'pf-1', user_id: 'u1', kind: 'avatar' };
  const srv = { id: 'sv-1', server_id: 's1', kind: 'icon' };

  await db.run('INSERT INTO attachments (id,channel_id,uploader_id,filename,mime,size,url,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [att.id, att.channel_id, 'u1', 'a.png', 'image/png', png.length, '/api/attachments/a1', ts]);
  await db.run('INSERT INTO profile_media (id,user_id,kind,filename,mime,size,created_at) VALUES (?,?,?,?,?,?,?)',
    [prof.id, prof.user_id, prof.kind, 'p.png', 'image/png', png.length, ts]);
  await db.run('INSERT INTO server_media (id,server_id,kind,filename,mime,size,created_at) VALUES (?,?,?,?,?,?,?)',
    [srv.id, srv.server_id, srv.kind, 'i.png', 'image/png', png.length, ts]);
  await db.close();

  // The source tree holds the objects exactly where uploads.js would put them.
  const expectKeys = [
    storage.key.messageMedia(att.channel_id, att.id),
    storage.key.userMedia(prof.user_id, prof.kind, prof.id),
    storage.key.communityMedia(srv.server_id, srv.kind, srv.id),
  ];
  for (const k of expectKeys) {
    const abs = path.join(SOURCE, k);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, png);
  }

  console.log('key agreement between the upload pipeline and the migration tool');
  ok('attachment key is channel/<id>/attachment/<id>', expectKeys[0] === 'channel/c1/attachment/a1');
  ok('profile key is user/<id>/<kind>/<id>', expectKeys[1] === 'user/u1/avatar/pf-1');
  ok('community key is community/<id>/<kind>/<id>', expectKeys[2] === 'community/s1/icon/sv-1');

  console.log('dry run');
  const dry = run(['--dry-run']);
  ok('dry run exits cleanly', dry.code === 0);
  ok('dry run reports the row count', /database rows: 3/.test(dry.out));
  ok('dry run copies nothing', fs.readdirSync(DEST).length === 0);

  console.log('copy');
  const copy = run([]);
  ok('copy exits cleanly', copy.code === 0);
  for (const k of expectKeys) {
    ok('destination has ' + k, fs.existsSync(path.join(DEST, k)));
  }
  ok('copied bytes match', fs.readFileSync(path.join(DEST, expectKeys[0])).equals(png));
  ok('source files are untouched', fs.existsSync(path.join(SOURCE, expectKeys[0])));

  console.log('re-run is safe');
  const again = run([]);
  ok('second copy exits cleanly', again.code === 0);
  ok('second copy does not duplicate or fail', /failed\s+0/.test(again.out));
  ok('second copy reports objects already present', /present\s+3/.test(again.out));

  console.log('verify');
  const verify = run(['--verify']);
  ok('verify exits cleanly', verify.code === 0);
  ok('verify confirms all three', /present\s+3/.test(verify.out));
  ok('verify reports nothing failed', /failed\s+0/.test(verify.out));

  console.log('a missing source file is reported, not silently skipped');
  fs.unlinkSync(path.join(SOURCE, expectKeys[1]));
  const partial = run([]);
  ok('a run with a missing source object fails', partial.code !== 0);
  ok('the missing object is named', /pf-1/.test(partial.out));
  ok('the other objects still copied', fs.existsSync(path.join(DEST, expectKeys[2])));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nstorage-migrate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
