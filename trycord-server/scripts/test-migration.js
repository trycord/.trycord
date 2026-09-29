// Proves scripts/migrate.js copies every table the schema creates, and that a
// row violating a foreign key aborts the import without leaving the target
// half-populated.
//
// This is a regression test: migrate.js once kept its own table list, which
// silently fell behind the schema and dropped bans, pins, reactions, mutes,
// announcements and both permission-override tables.
//
// Pure: no server, no network, no shared database.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { tableNames } = require('../src/db/schema');

const TMP = path.join(os.tmpdir(), 'trycord-migrate-test');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function run(script, args, env) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_CLIENT: 'sqlite', SERVER_HOST_TYPE: 'express', JWT_SECRET: 'x', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function seed(dbFile) {
  fs.rmSync(dbFile, { force: true });
  const d = new Database(dbFile);
  d.pragma('foreign_keys=OFF');
  for (const ddl of require('../src/db/schema').tables('')) d.exec(ddl);
  const id = (n) => 'id-' + n;
  const ts = '2026-01-01T00:00:00.000Z';
  d.exec(`INSERT INTO users (id,username,display_name,password_hash,created_at) VALUES ('u1','srcuser','Src','h','${ts}')`);
  d.exec(`INSERT INTO servers (id,owner_id,name,join_code,created_at) VALUES ('s1','u1','Src','aaaa0000','${ts}')`);
  d.exec(`INSERT INTO categories (id,server_id,name,position) VALUES ('cat1','s1','Text',0)`);
  d.exec(`INSERT INTO category_permission_overrides (category_id,permission,effect) VALUES ('cat1','SEND_MESSAGES','deny')`);
  d.exec(`INSERT INTO roles (id,server_id,name,position,permissions,is_default) VALUES ('r1','s1','@everyone',1,'["SEND_MESSAGES"]',1)`);
  d.exec(`INSERT INTO server_members (id,user_id,server_id,joined_at) VALUES ('m1','u1','s1','${ts}')`);
  d.exec(`INSERT INTO server_bans (id,server_id,user_id,actor_id,created_at) VALUES ('b1','s1','u1','u1','${ts}')`);
  d.exec(`INSERT INTO member_roles (server_id,user_id,role_id) VALUES ('s1','u1','r1')`);
  d.exec(`INSERT INTO channels (id,server_id,category_id,name) VALUES ('c1','s1','cat1','general')`);
  d.exec(`INSERT INTO channel_permission_overrides (channel_id,permission,effect) VALUES ('c1','SEND_MESSAGES','deny')`);
  d.exec(`INSERT INTO messages (id,channel_id,author_id,content,created_at,seq) VALUES ('msg1','c1','u1','hi','${ts}',1)`);
  d.exec(`INSERT INTO invites (id,code,server_id,creator_id,created_at) VALUES ('i1','code1','s1','u1','${ts}')`);
  d.exec(`INSERT INTO attachments (id,message_id,channel_id,uploader_id,filename,mime,size,url,created_at) VALUES ('at1','msg1','c1','u1','f.png','image/png',1,'/api/attachments/at1','${ts}')`);
  d.exec(`INSERT INTO revoked_tokens (jti,expires_at) VALUES ('jti1','2099-01-01T00:00:00.000Z')`);
  d.exec(`INSERT INTO dm_conversations (id,pair_key,created_at,updated_at) VALUES ('dc1','pair-1','${ts}','${ts}')`);
  d.exec(`INSERT INTO dm_members (conversation_id,user_id,joined_at) VALUES ('dc1','u1','${ts}')`);
  d.exec(`INSERT INTO dm_messages (id,conversation_id,author_id,content,created_at,seq) VALUES ('dm1','dc1','u1','yo','${ts}',1)`);
  d.exec(`INSERT INTO friend_requests (id,from_user_id,to_user_id,status,created_at,updated_at) VALUES ('fr1','u1','u1','pending','${ts}','${ts}')`);
  d.exec(`INSERT INTO friendships (user_id,friend_id,created_at) VALUES ('u1','u1','${ts}')`);
  d.exec(`INSERT INTO notifications (id,user_id,type,created_at) VALUES ('n1','u1','mention','${ts}')`);
  d.exec(`INSERT INTO password_resets (id,user_id,token_hash,expires_at,created_at) VALUES ('pr1','u1','h1','2099-01-01T00:00:00.000Z','${ts}')`);
  d.exec(`INSERT INTO email_verifications (id,user_id,email,token_hash,expires_at,created_at) VALUES ('ev1','u1','a@b.co','h2','2099-01-01T00:00:00.000Z','${ts}')`);
  d.exec(`INSERT INTO admins (user_id,created_at) VALUES ('u1','${ts}')`);
  d.exec(`INSERT INTO profile_media (id,user_id,kind,filename,mime,size,created_at) VALUES ('pm1','u1','avatar','a.png','image/png',1,'${ts}')`);
  d.exec(`INSERT INTO server_media (id,server_id,kind,filename,mime,size,created_at) VALUES ('sv1','s1','icon','i.png','image/png',1,'${ts}')`);
  d.exec(`INSERT INTO reports (id,reporter_id,target_type,target_id,reason,status,created_at,updated_at) VALUES ('rp1','u1','user','u1','spam','OPEN','${ts}','${ts}')`);
  d.exec(`INSERT INTO moderation_actions (id,actor_id,target_type,target_id,action_type,reason,created_at) VALUES ('mo1','u1','user','u1','WARNING','behave','${ts}')`);
  d.exec(`INSERT INTO appeals (id,user_id,action_id,reason,status,created_at,updated_at) VALUES ('ap1','u1','mo1','why','OPEN','${ts}','${ts}')`);
  d.exec(`INSERT INTO audit_logs (id,actor_id,action,target_type,target_id,created_at) VALUES ('au1','u1','REPORT_CREATED','user','u1','${ts}')`);
  d.exec(`INSERT INTO account_deletion_requests (id,user_id,status,request_type,reason,requested_at) VALUES ('ad1','u1','CANCELLED','GDPR','changed my mind','${ts}')`);
  d.exec(`INSERT INTO pages (id,route,title,status,legal,created_at,draft_body,published_body) VALUES ('pg1','privacy','Privacy Policy','DRAFT',1,'${ts}','[]','[]')`);
  d.exec(`INSERT INTO page_revisions (id,page_id,revision,body,title,state,author_id,created_at) VALUES ('pr1','pg1',1,'[]','Privacy Policy','DRAFT','u1','${ts}')`);
  d.exec(`INSERT INTO pinned_messages (message_id,channel_id,server_id,pinned_by,pinned_at) VALUES ('msg1','c1','s1','u1','${ts}')`);
  d.exec(`INSERT INTO reactions (message_id,user_id,emoji,created_at) VALUES ('msg1','u1','X','${ts}')`);
  d.exec(`INSERT INTO muted_channels (user_id,channel_id,muted_at) VALUES ('u1','c1','${ts}')`);
  d.exec(`INSERT INTO announcements (id,body,level,active,created_by,created_at) VALUES ('an1','hi','info',1,'u1','${ts}')`);
  d.close();
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const src = path.join(TMP, 'source.db');
  const tgt = path.join(TMP, 'target.db');
  seed(src);

  console.log('migrate: every table is copied');
  const r = run('scripts/migrate.js', ['--from', src], { DB_FILE: tgt });
  ok('exits cleanly', r.code === 0);

  const d = new Database(tgt, { readonly: true });
  const present = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  const empty = [];
  for (const t of tableNames()) {
    if (!present.includes(t)) { empty.push(t + ' (absent)'); continue; }
    const c = d.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c;
    if (c === 0) empty.push(t + ' (0 rows)');
  }
  ok(`all ${tableNames().length} schema tables exist and are non-empty`, empty.length === 0);
  if (empty.length) console.log('       ' + empty.join(', '));
  ok('moderation_actions, reports, appeals, audit_logs exist', ['moderation_actions', 'reports', 'appeals', 'audit_logs'].every((t) => present.includes(t)));
  d.close();

  console.log('migrate: re-running is idempotent');
  const r2 = run('scripts/migrate.js', ['--from', src], { DB_FILE: tgt });
  ok('exits cleanly on the second run', r2.code === 0);
  const d2 = new Database(tgt, { readonly: true });
  ok('no duplicate users after the second run', d2.prepare('SELECT COUNT(*) c FROM users').get().c === 1);
  ok('no duplicate bans after the second run', d2.prepare('SELECT COUNT(*) c FROM server_bans').get().c === 1);
  d2.close();

  console.log('migrate: a bad row aborts the import without partial writes');
  const bad = path.join(TMP, 'bad.db');
  const tgt2 = path.join(TMP, 'target2.db');
  fs.copyFileSync(src, bad);
  const b = new Database(bad);
  b.pragma('foreign_keys=OFF');
  b.exec(`INSERT INTO announcements (id,body,level,active,created_by,created_at) VALUES ('an-bad','x','info',1,'ghost','2026-01-01T00:00:00.000Z')`);
  b.close();
  const r3 = run('scripts/migrate.js', ['--from', bad], { DB_FILE: tgt2 });
  ok('exits non-zero', r3.code !== 0);
  ok('reports that the target was rolled back', /rolled back/i.test(r3.out));
  const d3 = new Database(tgt2, { readonly: true });
  const leftover = ['users', 'servers', 'channels', 'messages', 'announcements']
    .map((t) => d3.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c)
    .reduce((a, x) => a + x, 0);
  ok('no rows survive the failed import', leftover === 0);
  d3.close();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nmigration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
