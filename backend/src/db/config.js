// Database configuration, read and VALIDATED from the environment.
// There is intentionally no default database: without explicit configuration
// the server refuses to start instead of silently creating a local file.
function required(name, hint) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(
      `missing required database setting ${name}. ${hint || ''}\n` +
      'Configure DB_CLIENT=sqlite with DB_FILE for local development, or ' +
      'DB_CLIENT=mysql with DB_HOST/DB_PORT/DB_NAME/DB_USER for production. ' +
      'See .env.example.'
    );
  }
  return String(v).trim();
}

function loadDbConfig() {
  const raw = process.env.DB_CLIENT;
  if (!raw || !String(raw).trim()) {
    throw new Error(
      'missing required database setting DB_CLIENT.\n' +
      'Set DB_CLIENT=sqlite (plus DB_FILE, e.g. ./dev.db) for local development, or ' +
      'DB_CLIENT=mysql (plus DB_HOST/DB_PORT/DB_NAME/DB_USER) for production. ' +
      'Trycord never creates a database implicitly. See .env.example.'
    );
  }
  const client = String(raw).trim().toLowerCase();
  if (client === 'sqlite') {
    const file = required('DB_FILE', 'Example: DB_FILE=./dev.db (relative to backend/).');
    return { client, file };
  }
  if (client === 'mysql') {
    const port = parseInt(process.env.DB_PORT || '3306', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('DB_PORT must be 1-65535.');
    }
    // A remote host means production unless it is explicitly acknowledged.
    //
    // The original .env carried DB_CLIENT twice - `sqlite` then `mysql` - and the
    // last one wins, so a local SQLite expectation silently resolved to the
    // production MySQL host. A test script pointed at this checkout then wrote
    // 40 users, 16 communities and 40 channels into the live database, because
    // nothing in the code distinguished a local run from a deploy.
    //
    // So: a host that is not loopback now requires ALLOW_REMOTE_DB=true. The
    // deployment sets it, local and CI runs do not need it, and a stray script
    // inherits the refusal rather than the credentials.
    const host = required('DB_HOST', 'Example: DB_HOST=localhost');
    const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(host);
    if (!isLocal && String(process.env.ALLOW_REMOTE_DB || '').toLowerCase() !== 'true') {
      throw new Error(
        `refusing to use remote database host ${host}.\n` +
        'A non-loopback DB_HOST is assumed to be production. If this really is the\n' +
        'intended database, set ALLOW_REMOTE_DB=true. For local work use SQLite:\n' +
        '  DB_CLIENT=sqlite\n  DB_FILE=./dev.db'
      );
    }
    return {
      client,
      host,
      port,
      name: required('DB_NAME', 'Example: DB_NAME=trycord'),
      user: required('DB_USER', 'Example: DB_USER=trycord'),
      password: process.env.DB_PASSWORD !== undefined ? String(process.env.DB_PASSWORD) : '',
      ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true',
      connectionLimit: Math.max(1, parseInt(process.env.DB_POOL || '10', 10) || 10),
    };
  }
  throw new Error(`unsupported DB_CLIENT="${raw}". Use "sqlite" or "mysql".`);
}

module.exports = { loadDbConfig };
