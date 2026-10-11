// Instance configuration: the schema, the store, and the precedence.
//
// Configuration has three sources and they are not equal:
//
//   default     what the schema declares
//   database    what a system administrator saved through the dashboard
//   environment what the deployment set, in .env or a container
//
// Environment wins over database, and database wins over default. An operator who put a
// value in .env meant it, and a dashboard that silently overwrote it would be worse than
// no dashboard. So the store records which of the three is in force, and the UI shows
// the source next to every value.
//
// Secrets are never returned. A secret is stored as a marker, replaced only by an
// explicit write, and a blank field leaves the stored one alone.

const db = require('../db');
const { now, uuid } = require('../util');

// The catalogue. Only settings the application genuinely reads appear here - an entry
// that changed nothing would be a decorative control, which is worse than no control.
//
// `env` is the deployment variable that outranks the database. `live` means the running
// process picks the change up without a restart; `restart` means it does not.
const SCHEMA = [
  {
    key: 'instance.name', env: 'TRYCORD_NAME', type: 'string', default: 'Trycord',
    category: 'general', label: 'Instance name',
    description: 'Shown in the header, in emails, and to anyone who asks who you are.',
    live: true,
  },
  {
    key: 'instance.description', env: 'TRYCORD_PUBLIC_DESCRIPTION', type: 'string', default: '',
    category: 'general', label: 'Instance description',
    description: 'A line describing this instance, for the public site and the API.',
    live: true,
  },
  {
    key: 'instance.publicUrl', env: 'TRYCORD_PUBLIC_URL', type: 'url', default: '',
    category: 'general', label: 'Public URL',
    description: 'The address this instance is reached at, used to build links in emails.',
    live: true,
  },
  {
    key: 'instance.supportUrl', env: 'TRYCORD_SUPPORT_URL', type: 'url', default: '',
    category: 'general', label: 'Support URL',
    description: 'Where people go for help. Shown on the public site and in support emails.',
    live: true,
  },

  {
    key: 'registration.enabled', env: 'REGISTRATION_ENABLED', type: 'boolean', default: true,
    category: 'registration', label: 'Open registration',
    description: 'Whether anyone may create an account. Turn this off for an invite-only instance.',
    live: true, consequential: true,
  },
  {
    key: 'registration.approval', env: 'REGISTRATION_APPROVAL', type: 'boolean', default: false,
    category: 'registration', label: 'Approve new accounts',
    description: 'New accounts can sign in but cannot do anything until an administrator approves them. Accounts that already exist are unaffected.',
    live: true, consequential: true,
  },
  {
    key: 'registration.emailVerification', env: 'EMAIL_VERIFICATION_REQUIRED', type: 'boolean', default: false,
    category: 'registration', label: 'Require a verified email',
    description: 'New accounts must confirm an address before they can post. Only enforced when SMTP is configured.',
    live: true,
  },
  {
    key: 'security.sessionTtlDays', env: 'SESSION_TTL_DAYS', type: 'integer', default: 7,
    category: 'security', label: 'Session lifetime (days)',
    description: 'How long a signed-in device stays signed in. Existing sessions are unaffected by a change.',
    min: 1, max: 365, live: true,
  },
  {
    key: 'security.loginRateLimit', env: 'LOGIN_RATE_LIMIT', type: 'integer', default: 30,
    category: 'security', label: 'Login attempts per minute',
    description: 'Per address. Raising it weakens protection against password guessing.',
    min: 3, max: 1000, live: true, consequential: true,
  },
  {
    key: 'security.require2fa', env: 'REQUIRE_2FA', type: 'boolean', default: false,
    category: 'security', label: 'Require two-factor authentication',
    description: 'Accounts without a second factor are signed out until they enrol. Not enforced on the first admin.',
    live: true, consequential: true,
  },

  {
    key: 'content.maxUploadBytes', env: 'MAX_UPLOAD_BYTES', type: 'integer', default: 8388608,
    category: 'content', label: 'Maximum upload size (bytes)',
    description: 'Per file. 8388608 is 8 MB.',
    min: 1024, max: 104857600, live: true,
  },
  {
    key: 'content.discovery', env: 'COMMUNITY_DISCOVERY_ENABLED', type: 'boolean', default: true,
    category: 'content', label: 'Public community discovery',
    description: 'Whether communities that opt in appear in the public discovery feed.',
    live: true,
  },

  {
    key: 'messaging.maxPayload', env: 'WS_MAX_PAYLOAD', type: 'integer', default: 204800,
    category: 'messaging', label: 'Maximum realtime message size (bytes)',
    description: 'A single frame over the gateway. 204800 is 200 KB.',
    min: 1024, max: 4194304, live: false,
  },
  {
    key: 'messaging.heartbeatMs', env: 'WS_HEARTBEAT_MS', type: 'integer', default: 30000,
    category: 'messaging', label: 'Realtime heartbeat (milliseconds)',
    description: 'How often the gateway pings idle sockets. Lower detects dead connections sooner.',
    min: 1000, max: 300000, live: false,
  },

  {
    key: 'voice.enabled', env: 'VOICE_VIDEO_ENABLED', type: 'boolean', default: false,
    category: 'voice', label: 'Enable voice and video',
    description: 'Off until a media server is configured. With it on but no server, the instance refuses to start.',
    live: true, consequential: true,
  },
  {
    key: 'voice.maxParticipants', env: 'VOICE_VIDEO_MAX_PARTICIPANTS', type: 'integer', default: 25,
    category: 'voice', label: 'Participants per channel',
    description: 'Enforced before a session is created, so a full channel refuses rather than dropping someone.',
    min: 1, max: 200, live: true,
  },
  {
    key: 'voice.screenSharing', env: 'VOICE_VIDEO_SCREEN_SHARING', type: 'boolean', default: true,
    category: 'voice', label: 'Allow screen sharing',
    description: 'Cannot be on while voice itself is off.',
    live: true,
  },
  {
    key: 'voice.stunUrls', env: 'VOICE_VIDEO_STUN_URLS', type: 'list', default: [],
    category: 'voice', label: 'STUN servers',
    description: 'Comma-separated. At least one STUN server or a TURN URL is required when voice is on.',
    live: true,
  },

  // Read at call time by auth/mail.js, so these are live.
  {
    key: 'mail.smtpHost', env: 'SMTP_HOST', type: 'string', default: '',
    category: 'mail', label: 'SMTP host',
    description: 'The relay that delivers verification and recovery mail. Empty means mail is captured to the server log instead.',
    live: true,
  },
  {
    key: 'mail.smtpPort', env: 'SMTP_PORT', type: 'integer', default: 587,
    category: 'mail', label: 'SMTP port',
    description: '465 implies TLS, 587 implies STARTTLS.',
    min: 1, max: 65535, live: true,
  },
  {
    key: 'mail.smtpUser', env: 'SMTP_USER', type: 'string', default: '',
    category: 'mail', label: 'SMTP username',
    description: 'Left empty for a relay that needs no authentication.',
    live: true,
  },
  {
    key: 'mail.from', env: 'MAIL_FROM', type: 'string', default: '',
    category: 'mail', label: 'From address',
    description: 'What recipients see. Defaults to a noreply address at the instance name.',
    live: true,
  },
  {
    key: 'mail.smtpSecure', env: 'SMTP_SECURE', type: 'boolean', default: false,
    category: 'mail', label: 'Implicit TLS',
    description: 'On for port 465. Off for STARTTLS on 587.',
    live: true,
  },

  // The driver is read once when the storage module loads, so changing it needs a
  // restart. The quota is read per upload and is live.
  {
    key: 'storage.driver', env: 'STORAGE_DRIVER', type: 'string', default: 'local',
    category: 'storage', label: 'Storage driver',
    description: 'local writes under the upload directory. s3 needs a bucket, a region and credentials.',
    live: false,
  },
  {
    key: 'storage.quotaMb', env: 'STORAGE_QUOTA_MB', type: 'integer', default: 512,
    category: 'storage', label: 'Upload quota per member (MB)',
    description: 'Enforced before a file is stored, so a refusal costs nothing.',
    min: 1, max: 1048576, live: true,
  },

  {
    key: 'limits.rateMax', env: 'RATE_LIMIT_MAX', type: 'integer', default: 0,
    category: 'limits', label: 'Rate-limit ceiling override',
    description: 'Raises every per-endpoint ceiling to this one number. 0 means leave each endpoint at its own default.',
    min: 0, max: 1000000, live: true,
  },

  // The surface for the flags features.js already enforces. A toggle here moves
  // the same flag, so there is one switch per capability rather than two.
  {
    key: 'features.uploads', env: 'FILE_UPLOADS_ENABLED', type: 'boolean', default: true,
    category: 'features', label: 'File uploads',
    description: 'Off refuses every upload, whatever a member\'s permissions allow.',
    live: true,
  },
  {
    key: 'features.bots', env: 'BOTS_ENABLED', type: 'boolean', default: true,
    category: 'features', label: 'Bot applications',
    description: 'Off refuses new applications and stops existing ones posting.',
    live: true,
  },
  {
    key: 'features.webhooks', env: 'WEBHOOKS_ENABLED', type: 'boolean', default: true,
    category: 'features', label: 'Outgoing webhooks',
    description: 'Off stops delivery. Existing webhooks keep their configuration.',
    live: true,
  },
  {
    key: 'features.push', env: 'PUSH_NOTIFICATIONS_ENABLED', type: 'boolean', default: false,
    description: 'Push needs a delivery service configured. Off by default.',
    category: 'features', label: 'Push notifications',
    live: true,
  },

  // Off by default. With it on, the boot sequence logs a line saying the guided
  // setup is available, so an operator on a fresh install is not left to find it.
  {
    key: 'instance.quickSetup', env: 'TRYCORD_QUICK_SETUP', type: 'boolean', default: false,
    category: 'general', label: 'Quick setup',
    description: 'Offer a guided first-run setup that sets the instance name, public URL, registration and mail in one pass.',
    live: true,
  },
];

// Secret-bearing settings. Named explicitly rather than inferred, because a type of
// 'secret' would leak into the schema and the schema is what the UI renders.
const SECRETS = new Set([
  'mail.smtpPassword',
  'storage.s3SecretKey',
]);

// Settings that cannot be changed from the dashboard at all, with the reason. Listed
// rather than hidden, so an administrator knows what they are and why.
const DEPLOYMENT_ONLY = [
  { key: 'db.connection', reason: 'Changing the database requires a migration and a restart. Use the documented deployment configuration.' },
  { key: 'server.port', reason: 'The listening port is set by the container or the process manager, not the application.' },
  { key: 'server.host', reason: 'The bind address is a deployment setting. The app cannot safely rebind itself.' },
  { key: 'jwt.secret', reason: 'Rotating the signing secret invalidates every session. Rotate it through the deployment configuration.' },
  { key: 'app.mount', reason: 'The mount prefix is decided when the server starts, because every asset path depends on it.' },
];

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]));

const CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'registration', label: 'Registration and onboarding' },
  { id: 'security', label: 'Authentication and security' },
  { id: 'content', label: 'Content and communities' },
  { id: 'messaging', label: 'Messaging and realtime' },
  { id: 'voice', label: 'Voice and video' },
  { id: 'mail', label: 'Email' },
  { id: 'storage', label: 'Storage' },
  { id: 'features', label: 'Feature availability' },
  { id: 'limits', label: 'Limits and performance' },
];

// The live values, and where each came from. Loaded at boot, re-read after a save.
const store = {
  values: {},
  sources: {},
  // What the database actually holds, as a string, before any precedence is
  // applied. The concurrency guard compares this rather than the effective
  // value: when a value comes from the environment the two differ by design, and
  // comparing the effective value against the stored one reports a conflict on
  // every legitimate save.
  raw: {},
  loaded: false,
};

function parse(raw, type, def) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, value: def };
  }
  const text = String(raw).trim();
  if (type === 'boolean') {
    if (['1', 'true', 'on', 'yes'].includes(text.toLowerCase())) return { ok: true, value: true };
    if (['0', 'false', 'off', 'no'].includes(text.toLowerCase())) return { ok: true, value: false };
    return { ok: false, error: 'must be on or off' };
  }
  if (type === 'integer') {
    const n = Number(text);
    if (!Number.isInteger(n)) return { ok: false, error: 'must be a whole number' };
    return { ok: true, value: n };
  }
  if (type === 'url') {
    try {
      const u = new URL(text);
      if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'must be an http(s) URL' };
      // The path is kept, without its trailing slash, because an instance can be
      // served from a subdirectory. Dropping it is what this used to do, which
      // disagreed with features.js and quietly broke every emailed link on such
      // an instance.
      const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
      return { ok: true, value: u.origin + path };
    } catch { return { ok: false, error: 'must be a valid URL' }; }
  }
  if (type === 'list') {
    return { ok: true, value: text.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  return { ok: true, value: text };
}

function validate(entry, raw) {
  const parsed = parse(raw, entry.type, entry.default);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const value = parsed.value;

  if (entry.type === 'integer') {
    if (entry.min != null && value < entry.min) return { ok: false, error: 'must be at least ' + entry.min };
    if (entry.max != null && value > entry.max) return { ok: false, error: 'must be at most ' + entry.max };
  }
  return { ok: true, value };
}

// Read the environment for one setting, so an explicit deployment value is not
// overridden by anything the dashboard saved.
function envValueOf(entry) {
  if (!entry.env || process.env[entry.env] === undefined) return undefined;
  const text = String(process.env[entry.env]).trim();
  if (text === '') return undefined;
  return text;
}

async function load(force = false) {
  // Reloaded after a save, because a reset deleted a row and the in-memory source has to
  // go back to 'default' rather than remembering what it was.
  if (store.loaded && !force) return store;
  store.values = {};
  store.sources = {};
  store.raw = {};
  store.loaded = false;
  const rows = await db.all('SELECT `key`, value FROM instance_settings');
  const saved = new Map(rows.map((r) => [r.key, r.value]));

  for (const entry of SCHEMA) {
    const fromEnv = envValueOf(entry);
    if (fromEnv !== undefined) {
      const check = validate(entry, fromEnv);
      if (check.ok) {
        store.values[entry.key] = check.value;
        store.sources[entry.key] = 'environment';
        continue;
      }
      // A deployment value that fails validation is reported, not silently replaced.
      store.values[entry.key] = entry.default;
      store.sources[entry.key] = 'default (environment value was invalid)';
      continue;
    }
    const fromDb = saved.get(entry.key);
    store.raw[entry.key] = fromDb;
    if (fromDb !== undefined) {
      const check = validate(entry, fromDb);
      if (check.ok) {
        store.values[entry.key] = check.value;
        store.sources[entry.key] = 'instance';
        continue;
      }
    }
    store.values[entry.key] = entry.default;
    store.sources[entry.key] = 'default';
  }

  store.loaded = true;
  return store;
}

// The effective value. Throws if the store is not loaded, so a caller cannot read a
// default and believe it is what the instance is configured with.
function get(key) {
  const entry = BY_KEY.get(key);
  if (!entry) throw new Error('unknown setting ' + key);
  if (!store.loaded) throw new Error('the settings store is not loaded');
  return store.values[key];
}

function source(key) {
  return store.sources[key] || 'default';
}

// Whether the store has been read yet.
//
// features.js consults this before asking for a value, so a flag still resolves
// during startup validation when the database connection is not up yet, rather than
// throwing about a store that is merely not ready.
function isLoaded() {
  return store.loaded;
}

// The upsert, spelled per dialect.
//
// `ON DUPLICATE KEY UPDATE` is MySQL and `ON CONFLICT ... DO UPDATE` is SQLite, and the
// wrong one is a syntax error rather than a load-time failure - so the settings write
// worked on MariaDB and threw on every SQLite deployment, which is what a fresh install
// and every test run uses. The two dialects also disagree on how to name the row being
// inserted: MySQL says `VALUES(col)` and SQLite says `excluded.col`, which is what
// db.newRef exists for.
function upsertSetting(t, key, value, adminId) {
  const mysql = t.dialect === 'mysql';
  const sql = mysql
    ? 'INSERT INTO instance_settings (`key`, value, updated_at, updated_by) '
      + 'VALUES (?, ?, ?, ?) '
      + 'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), '
      + 'updated_by = VALUES(updated_by)'
    : 'INSERT INTO instance_settings (`key`, value, updated_at, updated_by) '
      + 'VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (`key`) DO UPDATE SET value = excluded.value, '
      + 'updated_at = excluded.updated_at, updated_by = excluded.updated_by';
  return t.run(sql, [key, serialise(value), now(), adminId]);
}

// Save. Every key is validated before a single row is written, and the writes and the
// audit row share one transaction, so a batch that fails partway leaves the stored
// configuration exactly as it was.
//
// The concurrency guard: each key carries the value this process read at load time, and
// the write only lands if the stored value has not moved since. Two administrators
// editing the same setting from two browsers get the second one refused with the keys
// in conflict, rather than whichever write happened to be issued last silently winning.
async function save(entries, adminId) {
  await load();
  const before = {};
  const problems = [];
  const writes = [];

  // The cross-setting rules resolve before anything is written, because a rule that is
  // checked while writing would leave the earlier keys applied and the later ones not.
  const screenSharing = entries['voice.screenSharing'];
  const voiceEnabled = store.values['voice.enabled'];

  for (const [key, raw] of Object.entries(entries)) {
    const entry = BY_KEY.get(key);
    if (!entry) { problems.push(key + ': unknown setting'); continue; }
    if (SECRETS.has(key)) continue;

    const check = validate(entry, raw);
    if (!check.ok) { problems.push(key + ': ' + check.error); continue; }

    if (entry.key === 'voice.screenSharing' && check.value && !voiceEnabled) {
      problems.push('voice.screenSharing: screen sharing cannot be on while voice is off');
      continue;
    }

    before[key] = store.values[key];
    writes.push({ key, value: check.value, seen: store.raw[key] });
  }

  if (problems.length) return { ok: false, problems };

  // Turning voice off turns the sub-capabilities off with it. The caller's object is not
  // mutated: it came off the request body, and changing it would make the response and
  // the log disagree with what the administrator sent.
  const effective = new Map(writes.map((w) => [w.key, w.value]));
  if (effective.get('voice.enabled') === false) {
    for (const w of writes) {
      if (w.key === 'voice.screenSharing' && w.value) {
        w.value = false;
        effective.set(w.key, false);
      }
    }
  }
  // A request that turned voice on while asking for screen sharing has to be judged
  // against the *new* voice state, not the one read before the save.
  if (effective.has('voice.screenSharing') && effective.get('voice.screenSharing')
      && effective.get('voice.enabled') !== true && !voiceEnabled) {
    return { ok: false, problems: ['voice.screenSharing: screen sharing cannot be on while voice is off'] };
  }

  const conflicts = [];
  await db.transaction(async (t) => {
    for (const w of writes) {
      const row = await t.get('SELECT value FROM instance_settings WHERE `key` = ?', [w.key]);
      const stored = row ? row.value : undefined;
      // A key with no row is at its default, and that is what the write was made
      // against. serialise(undefined) is the string "undefined", so the absent case
      // has to be compared as absent rather than as a value.
      const expected = w.seen === undefined ? undefined : serialise(w.seen);
      if (stored !== expected) {
        conflicts.push(w.key);
        continue;
      }
      await upsertSetting(t, w.key, w.value, adminId);
    }
    if (conflicts.length) {
      throw { code: 'CONFLICT', message: 'changed by someone else: ' + conflicts.join(', ') };
    }
    // The log records what changed and nothing sensitive. Written inside the same
    // transaction as the values, so an audit trail can never claim a change that was
    // rolled back.
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, 'update_settings', 'instance', NULL, ?, ?)`,
      [uuid(), adminId, JSON.stringify(Object.keys(before)), now()]
    );
  });

  await load(true);

  // The flags are rebuilt from the store that just changed. Without this a saved
  // setting is stored and nothing else: every gate keeps answering from the build it
  // made at boot.
  try { require('../features').reload(); } catch { /* a voice config that cannot work is refused by reload, which is correct */ }

  return { ok: true, changed: Object.keys(before) };
}

function changed(before) {
  const out = [];
  for (const [key, value] of Object.entries(before)) {
    if (store.values[key] !== value) out.push(key);
  }
  return out;
}

function serialise(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

// The catalogue as the dashboard renders it: the setting, its effective value, where that
// value came from, and whether a change is live or needs a restart. Never a secret.
function catalogue() {
  return CATEGORIES.map((cat) => ({
    id: cat.id,
    label: cat.label,
    settings: SCHEMA.filter((s) => s.category === cat.id).map((s) => ({
      key: s.key,
      env: s.env || null,
      label: s.label,
      description: s.description,
      type: s.type,
      value: store.values[s.key],
      source: store.sources[s.key],
      live: !!s.live,
      consequential: !!s.consequential,
      locked: store.sources[s.key] === 'environment',
      lockedReason: store.sources[s.key] === 'environment'
        ? 'Set by the deployment environment (' + s.env + '). Change it there.'
        : null,
    })),
  })).filter((c) => c.settings.length);
}

module.exports = {
  SCHEMA, CATEGORIES, SECRETS, DEPLOYMENT_ONLY,
  load, get, source, save, catalogue, validate, serialise, isLoaded,
};
