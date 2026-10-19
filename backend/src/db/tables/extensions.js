// Extensions and workflows.
//
// One module for both, because they are one feature: an extension is installed
// with a set of granted capabilities, and what it does with them is a
// workflow. They share a permission model, an audit trail and a run history,
// and splitting them across two modules would put half of a feature in each.
//
// The tables are written together and read together. An installed extension
// owns a version row (so it can be rolled back), a set of grant rows (so a
// capability can be taken back), and one or more workflows (so its triggers
// have somewhere to run). A workflow owns its runs, and a run owns its steps.

module.exports = (engine) => [

  // The instance-wide extension policy. One row, with a fixed id, because the
  // policy is a property of the deployment rather than of any extension: which
  // registry the instance trusts, whether unreviewed packages may be installed,
  // whether a signature is required, and whether server-side extension code is
  // allowed at all.
  `CREATE TABLE IF NOT EXISTS extension_policy (
      id           VARCHAR(64) PRIMARY KEY,
      registry_mode VARCHAR(16) NOT NULL DEFAULT 'builtin',
      registry_url VARCHAR(512),
      allowlist    TEXT,
      allow_unreviewed INTEGER NOT NULL DEFAULT 0,
      require_signature INTEGER NOT NULL DEFAULT 0,
      allow_trusted INTEGER NOT NULL DEFAULT 0,
      signing_keys TEXT,
      updated_by   VARCHAR(64),
      updated_at   VARCHAR(64) NOT NULL
    )${engine}`,

  // The packages an operator has installed. The current version's metadata is
  // held here directly rather than joined in, because this is the row the
  // list endpoint reads and the permission check reads; the full manifest of
  // every version ever installed is in extension_versions.
  `CREATE TABLE IF NOT EXISTS extensions (
      id           VARCHAR(128) PRIMARY KEY,
      name         VARCHAR(128) NOT NULL,
      version      VARCHAR(64) NOT NULL,
      description  TEXT,
      author       VARCHAR(128),
      maintainers  TEXT,
      homepage     VARCHAR(512),
      entry_point  VARCHAR(255),
      requested_capabilities TEXT,
      trusted      INTEGER NOT NULL DEFAULT 0,
      compatibility TEXT,
      dependencies TEXT,
      review_status VARCHAR(16) NOT NULL DEFAULT 'unreviewed',
      signature_key VARCHAR(64),
      signature_value TEXT,
      signature_status VARCHAR(16) NOT NULL DEFAULT 'unsigned',
      source       VARCHAR(32) NOT NULL DEFAULT 'builtin',
      state        VARCHAR(16) NOT NULL DEFAULT 'installed',
      installed_by VARCHAR(64),
      installed_at VARCHAR(64) NOT NULL,
      updated_at   VARCHAR(64) NOT NULL,
      last_error   TEXT,
      FOREIGN KEY (installed_by) REFERENCES users(id) ON DELETE SET NULL
    )${engine}`,

  // What the operator granted, one row per capability. Revoking a capability
  // marks the row revoked rather than deleting it, so the record of what was
  // granted and when it was taken back survives the grant itself.
  `CREATE TABLE IF NOT EXISTS extension_grants (
      id           VARCHAR(64) PRIMARY KEY,
      extension_id VARCHAR(128) NOT NULL,
      capability   VARCHAR(64) NOT NULL,
      granted_by   VARCHAR(64),
      granted_at   VARCHAR(64) NOT NULL,
      revoked_by   VARCHAR(64),
      revoked_at   VARCHAR(64),
      reason       TEXT,
      FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
    )${engine}`,

  // Every version that was installed, with the manifest as it was at the time.
  // This is what a rollback restores: the code, the requested capabilities and
  // the triggers of that version, byte for byte as they were approved.
  `CREATE TABLE IF NOT EXISTS extension_versions (
      id           VARCHAR(64) PRIMARY KEY,
      extension_id VARCHAR(128) NOT NULL,
      version      VARCHAR(64) NOT NULL,
      manifest     TEXT NOT NULL,
      entry_code   TEXT,
      source       VARCHAR(32) NOT NULL DEFAULT 'builtin',
      review_status VARCHAR(16) NOT NULL DEFAULT 'unreviewed',
      signature_key VARCHAR(64),
      signature_value TEXT,
      signature_status VARCHAR(16) NOT NULL DEFAULT 'unsigned',
      installed_at VARCHAR(64) NOT NULL,
      UNIQUE (extension_id, version),
      FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
    )${engine}`,

  // The registry as this instance last saw it. Kept so an unreachable
  // registry does not empty the list an operator is looking at: the cached
  // copy is still served, with the failure reported next to it.
  `CREATE TABLE IF NOT EXISTS extension_registry_cache (
      id           VARCHAR(128) PRIMARY KEY,
      version      VARCHAR(64) NOT NULL,
      name         VARCHAR(128) NOT NULL,
      description  TEXT,
      author       VARCHAR(128),
      maintainers  TEXT,
      homepage     VARCHAR(512),
      entry_point  VARCHAR(255),
      requested_capabilities TEXT,
      trusted      INTEGER NOT NULL DEFAULT 0,
      compatibility TEXT,
      dependencies TEXT,
      review_status VARCHAR(16) NOT NULL DEFAULT 'unreviewed',
      signature_key VARCHAR(64),
      signature_value TEXT,
      signature_status VARCHAR(16) NOT NULL DEFAULT 'unsigned',
      source       VARCHAR(32) NOT NULL DEFAULT 'builtin',
      reference    VARCHAR(512),
      manifest     TEXT NOT NULL,
      state        VARCHAR(16) NOT NULL DEFAULT 'available',
      fetched_at   VARCHAR(64) NOT NULL
    )${engine}`,

  // An extension's own key/value storage. Namespaced by extension, so two
  // extensions cannot read or overwrite each other's values.
  `CREATE TABLE IF NOT EXISTS extension_storage (
      extension_id VARCHAR(128) NOT NULL,
      \`key\`          VARCHAR(128) NOT NULL,
      value        TEXT NOT NULL,
      updated_at   VARCHAR(64) NOT NULL,
      PRIMARY KEY (extension_id, \`key\`),
      FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
    )${engine}`,

  // A workflow. The definition is stored as JSON because it is read as a
  // whole, written as a whole, and versioned as a whole; splitting it into
  // columns would mean a migration every time a step type is added.
  `CREATE TABLE IF NOT EXISTS workflows (
      id           VARCHAR(64) PRIMARY KEY,
      name         VARCHAR(128) NOT NULL,
      description  TEXT,
      owner_id     VARCHAR(64) NOT NULL,
      state        VARCHAR(16) NOT NULL DEFAULT 'active',
      version      INTEGER NOT NULL DEFAULT 1,
      \`trigger\`    TEXT NOT NULL,
      conditions   TEXT,
      steps        TEXT NOT NULL,
      grants       TEXT NOT NULL,
      limits       TEXT NOT NULL,
      on_error     VARCHAR(16) NOT NULL DEFAULT 'stop',
      source       VARCHAR(32) NOT NULL DEFAULT 'user',
      extension_id VARCHAR(128),
      next_run_at  VARCHAR(64),
      last_run_at  VARCHAR(64),
      created_at   VARCHAR(64) NOT NULL,
      updated_at   VARCHAR(64) NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    )${engine}`,

  // One execution of a workflow. The run key is derived from the trigger, so
  // a retried trigger resolves to the run that already happened instead of
  // posting a second time.
  `CREATE TABLE IF NOT EXISTS workflow_runs (
      id           VARCHAR(64) PRIMARY KEY,
      workflow_id  VARCHAR(64) NOT NULL,
      run_key      VARCHAR(64) NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      trigger_type VARCHAR(32) NOT NULL,
      trigger_event VARCHAR(64),
      payload      TEXT,
      definition   TEXT NOT NULL,
      status       VARCHAR(16) NOT NULL,
      reason       TEXT,
      depth        INTEGER NOT NULL DEFAULT 0,
      origin_workflow_id VARCHAR(64),
      origin_run_id VARCHAR(64),
      dry_run      INTEGER NOT NULL DEFAULT 0,
      started_at   VARCHAR(64) NOT NULL,
      finished_at  VARCHAR(64),
      duration_ms  INTEGER,
      created_at   VARCHAR(64) NOT NULL,
      UNIQUE (workflow_id, run_key),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    )${engine}`,

  // One step of one run. Recorded as it happens rather than at the end, so a
  // run that is still going is readable while it is going.
  `CREATE TABLE IF NOT EXISTS workflow_run_steps (
      id          VARCHAR(64) PRIMARY KEY,
      run_id      VARCHAR(64) NOT NULL,
      step_index  INTEGER NOT NULL,
      type        VARCHAR(32) NOT NULL,
      action      VARCHAR(64),
      params      TEXT,
      capability  VARCHAR(64),
      status      VARCHAR(16) NOT NULL,
      output      TEXT,
      error       TEXT,
      started_at  VARCHAR(64),
      finished_at VARCHAR(64),
      duration_ms INTEGER,
      created_at  VARCHAR(64) NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    )${engine}`,
];
