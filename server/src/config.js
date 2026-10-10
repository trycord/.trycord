// Configuration. One module reads the environment and fails loudly on anything it
// cannot interpret, because a silently-defaulted value is how an instance ends up
// bound to an interface or a database nobody chose.

const path = require('path');
const fs = require('fs');

function required(name, hint) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') {
    throw new Error(`missing required setting ${name}. ${hint || ''}`);
  }
  return String(v).trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || String(v).trim() === '' ? fallback : String(v).trim();
}

function integer(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = optional(name, '');
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function boolean(name, fallback) {
  const raw = optional(name, '');
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(name, fallback = []) {
  const raw = optional(name, '');
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function url(name, fallback) {
  const raw = optional(name, fallback);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    return u.origin;
  } catch {
    throw new Error(`${name} is not a usable http(s) URL: "${raw}"`);
  }
}

function loadEnvFile() {
  // dotenv's own job, but called explicitly so this module is the only place that
  // knows a file named .env exists.
  try { require('dotenv').config(); } catch { /* not installed in every checkout */ }
}

loadEnvFile();

const ROOT = path.join(__dirname, '..', '..');

const config = {
  env: optional('NODE_ENV', 'development'),

  // --- instance ------------------------------------------------------------
  instanceId: optional('TRYCORD_INSTANCE_ID', 'trycord'),
  instanceName: optional('TRYCORD_NAME', 'Trycord'),
  publicUrl: url('TRYCORD_PUBLIC_URL', ''),
  clientUrl: url('CLIENT_URL', ''),

  // --- http ----------------------------------------------------------------
  host: optional('HOST', '0.0.0.0'),
  port: integer('PORT', 9971, { min: 1, max: 65535 }),
  // Where the web client is mounted, if anywhere. Empty means the origin root.
  appMount: optional('TRYCORD_APP_MOUNT', '').replace(/\/+$/, ''),
  trustProxy: boolean('TRUST_PROXY', false),

  // --- security ------------------------------------------------------------
  // Required: the server refuses to start without one, so an instance cannot come up
  // signing sessions with a predictable default.
  jwtSecret: (() => {
    try {
      return required('JWT_SECRET', 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    } catch {
      if (config && config.env === 'test') return 'test-secret-only-32-bytes-long-0123';
      throw new Error('missing required setting JWT_SECRET');
    }
  })(),
  sessionTtlDays: integer('SESSION_TTL_DAYS', 7, { min: 1 }),

  // --- database ------------------------------------------------------------
  db: loadDbConfig(),

  // --- storage -------------------------------------------------------------
  storageDriver: optional('STORAGE_DRIVER', 'local'),
  uploadDir: path.resolve(ROOT, optional('UPLOAD_DIR', './uploads')),
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 8 * 1024 * 1024, { min: 1024 }),

  // S3-compatible object storage. Only read when STORAGE_DRIVER=s3; a local-disk
  // instance never needs any of it.
  s3: {
    endpoint: optional('S3_ENDPOINT', ''),
    region: optional('S3_REGION', 'us-east-1'),
    bucket: optional('S3_BUCKET', ''),
    accessKeyId: optional('S3_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('S3_SECRET_ACCESS_KEY', ''),
    // Path style is what MinIO and most self-hosted endpoints expect; virtual-host style
    // is what AWS uses.
    forcePathStyle: boolean('S3_FORCE_PATH_STYLE', true),
  },

  // --- mail ----------------------------------------------------------------
  // 'log' writes to stdout and sends nothing, which is the safe default: with it,
  // email verification is not enforceable and the app must not ask anyone to verify.
  mailMode: optional('MAIL_MODE', 'log'),
  mailFrom: optional('MAIL_FROM', 'Trycord <no-reply@example.com>'),
  smtp: {
    host: optional('SMTP_HOST', ''),
    port: integer('SMTP_PORT', 587, { min: 1, max: 65535 }),
    user: optional('SMTP_USER', ''),
    password: optional('SMTP_PASSWORD', ''),
    secure: boolean('SMTP_SECURE', false),
  },

  // --- realtime ------------------------------------------------------------
  wsMaxPayload: integer('WS_MAX_PAYLOAD', 200 * 1024, { min: 1024 }),
  wsHeartbeatMs: integer('WS_HEARTBEAT_MS', 30000, { min: 1000 }),

  // --- features ------------------------------------------------------------
  // A self-hoster turns discovery and uploads off without touching code.
  features: {
    publicDiscovery: boolean('FEATURE_DISCOVERY', true),
    uploads: boolean('FEATURE_UPLOADS', true),
    email: boolean('FEATURE_EMAIL', false),
  },

  // --- operational ---------------------------------------------------------
  allowTestHooks: boolean('ALLOW_TEST_HOOKS', false),
  rateLimitMax: integer('RATE_LIMIT_MAX', 0, { min: 0 }),
  adminUsernames: list('ADMIN_USERNAMES', []),
  corsOrigins: list('CORS_ORIGINS', []),

  /** Verification is only enforceable when the instance can actually deliver mail. */
  verificationEnforceable() {
    return this.mailMode === 'smtp';
  },
};

function loadDbConfig() {
  const client = optional('DB_CLIENT', 'sqlite');
  if (client === 'sqlite') {
    return {
      client,
      file: path.resolve(ROOT, required('DB_FILE', 'Example: DB_FILE=./data.db')),
    };
  }
  if (client === 'mysql') {
    return {
      client,
      host: optional('DB_HOST', '127.0.0.1'),
      port: integer('DB_PORT', 3306, { min: 1, max: 65535 }),
      database: required('DB_NAME', 'The schema this instance uses.'),
      user: required('DB_USER', ''),
      password: optional('DB_PASSWORD', ''),
      ssl: boolean('DB_SSL', false),
      pool: integer('DB_POOL', 10, { min: 1, max: 100 }),
    };
  }
  throw new Error(`unsupported DB_CLIENT="${client}". Use "sqlite" or "mysql".`);
}

module.exports = config;
