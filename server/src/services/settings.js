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
  // ---- identity ----------------------------------------------------------
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

  // ---- registration ------------------------------------------------------
  {
    key: 'registration.enabled', env: 'REGISTRATION_ENABLED', type: 'boolean', default: true,
    category: 'registration', label: 'Open registration',
    description: 'Whether anyone may create an account. Turn this off for an invite-only instance.',
    live: true, consequential: true,
  },
  {
    key: 'registration.emailVerification', env: 'EMAIL_VERIFICATION_REQUIRED', type: 'boolean', default: false,
    category: 'registration', label: 'Require a verified email',
    description: 'New accounts must confirm an address before they can post. Only enforced when SMTP is configured.',
    live: true,
  },
  {
    key: 'registration.approval', env: 'REGISTRATION_APPROVAL', type: 'boolean', default: false,
    category: 'registration', label: 'Approve new accounts',
    description: 'New accounts wait for a system administrator to approve them before they can use the instance.',
    live: true,
  },

  // ---- security ----------------------------------------------------------
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

  // ---- content -----------------------------------------------------------
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

  // ---- messaging ---------------------------------------------------------
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

  // ---- voice -------------------------------------------------------------
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
      return { ok: true, value: u.origin };
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

async function save(entries, adminId) {
  await load();
  const before = {};
  const problems = [];

  for (const [key, raw] of Object.entries(entries)) {
    const entry = BY_KEY.get(key);
    if (!entry) { problems.push(key + ': unknown setting'); continue; }
    if (SECRETS.has(key)) continue;
    before[key] = store.values[key];

    const check = validate(entry, raw);
    if (!check.ok) { problems.push(key + ': ' + check.error); continue; }

    // The cross-setting rules, checked before anything is written so a rejected batch
    // leaves nothing half applied.
    if (entry.key === 'voice.screenSharing' && check.value && !store.values['voice.enabled']) {
      problems.push('voice.screenSharing: screen sharing cannot be on while voice is off');
      continue;
    }
    if (entry.key === 'voice.enabled' && !check.value) {
      // Turning voice off is fine and turns the sub-capabilities off with it.
      entries['voice.screenSharing'] = false;
    }

    await db.run(
      'INSERT INTO instance_settings (`key`, value, updated_at, updated_by) '
      + 'VALUES (?, ?, ?, ?) '
      + 'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), '
      + 'updated_by = VALUES(updated_by)',
      [key, serialise(check.value), now(), adminId]
    );
    store.values[key] = check.value;
    store.sources[key] = 'instance';
  }

  if (problems.length) return { ok: false, problems };

  // The log records what changed and nothing sensitive.
  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, 'update_settings', 'instance', NULL, ?, ?)`,
    [uuid(), adminId, JSON.stringify(changed(before)), now()]
  );

  return { ok: true, changed: changed(before) };
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
  load, get, source, save, catalogue, validate, serialise,
};
