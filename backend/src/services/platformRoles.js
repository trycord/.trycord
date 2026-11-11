// Platform authority is granular and server-side.
//
// Membership in `admins` says somebody may enter the platform console at all.
// Their role says which part of it. The client never supplies its own role,
// and every route asks for the permission it needs rather than checking for
// an admin boolean.
const db = require('../db');
const { now } = require('../util');

const PERMISSIONS = {
  'platform.admin': 'Full control of the instance and of platform roles.',
  'platform.overview': 'Read the Trust & Safety overview and operational counts.',
  'platform.users.view': 'Inspect accounts, enforcement history and notes.',
  'platform.users.enforce': 'Warn, suspend, ban and restrict accounts.',
  'platform.users.lift': 'Lift account enforcement and restrictions.',
  'platform.users.notes': 'Read and write platform notes about accounts.',
  'platform.communities.view': 'Inspect communities and their enforcement history.',
  'platform.communities.enforce': 'Suspend or remove communities.',
  'platform.communities.restore': 'Restore a suspended or removed community.',
  'platform.reports.view': 'Read the platform report and case queues.',
  'platform.reports.manage': 'Assign, update, escalate and resolve reports and cases.',
  'platform.cases.view': 'Read moderation cases, evidence and timelines.',
  'platform.cases.manage': 'Add notes and evidence and change case state.',
  'platform.appeals.view': 'Read appeals.',
  'platform.appeals.decide': 'Decide appeals and lift the matching enforcement.',
  'platform.audit.view': 'Read the audit trail.',
  'platform.audit.verify': 'Verify the audit hash chain.',
  'platform.gdpr.manage': 'Review and process data-protection requests.',
  'platform.roles.manage': 'Assign and change platform roles.',
  'platform.approvals.manage': 'Approve pending registrations.',
  'platform.accounts.manage': 'Clear second factors and change bot identity.',
};

const ROLES = {
  PLATFORM_ADMIN: {
    label: 'Platform administrator',
    description: 'Operates the instance. Full access, including platform roles and data requests.',
    permissions: ['*'],
  },
  TRUST_SAFETY_ADMIN: {
    label: 'Trust & Safety administrator',
    description: 'Runs investigations, enforcement and appeals, including community removal.',
    permissions: [
      'platform.overview',
      'platform.users.view', 'platform.users.enforce', 'platform.users.lift', 'platform.users.notes',
      'platform.communities.view', 'platform.communities.enforce', 'platform.communities.restore',
      'platform.reports.view', 'platform.reports.manage',
      'platform.cases.view', 'platform.cases.manage',
      'platform.appeals.view', 'platform.appeals.decide',
      'platform.audit.view', 'platform.audit.verify',
    ],
  },
  TRUST_SAFETY_MODERATOR: {
    label: 'Trust & Safety moderator',
    description: 'Reviews reports and cases, warns and restricts accounts, and reads appeals.',
    permissions: [
      'platform.overview',
      'platform.users.view', 'platform.users.enforce', 'platform.users.notes',
      'platform.communities.view',
      'platform.reports.view', 'platform.reports.manage',
      'platform.cases.view', 'platform.cases.manage',
      'platform.appeals.view',
      'platform.audit.view',
    ],
  },
  MODERATION_AUDITOR: {
    label: 'Moderation auditor',
    description: 'Read-only access to reports, cases, appeals and the audit trail.',
    permissions: [
      'platform.overview',
      'platform.users.view',
      'platform.communities.view',
      'platform.reports.view', 'platform.cases.view', 'platform.appeals.view',
      'platform.audit.view', 'platform.audit.verify',
    ],
  },
};

const ROLE_NAMES = Object.keys(ROLES);

function knownRole(role) {
  return ROLE_NAMES.includes(String(role || '').toUpperCase());
}

function shape(row) {
  if (!row) return null;
  const role = knownRole(row.role) ? String(row.role).toUpperCase() : 'TRUST_SAFETY_MODERATOR';
  const definition = ROLES[role];
  return {
    userId: row.user_id,
    username: row.username || null,
    displayName: row.display_name || null,
    role,
    roleLabel: definition.label,
    permissions: definition.permissions,
    createdAt: row.created_at,
  };
}

async function get(userId, conn = db) {
  const row = await conn.get(
    `SELECT a.*, u.username, u.display_name
     FROM admins a LEFT JOIN users u ON u.id = a.user_id WHERE a.user_id = ?`,
    [userId]
  );
  return shape(row);
}

function allows(admin, permission) {
  if (!admin) return false;
  return admin.permissions.includes('*') || admin.permissions.includes(permission);
}

async function hasPermission(userId, permission, conn = db) {
  return allows(await get(userId, conn), permission);
}

async function list() {
  const rows = await db.all(
    `SELECT a.*, u.username, u.display_name
     FROM admins a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at ASC`
  );
  return rows.map(shape);
}

async function assign(userId, role, actorId) {
  const clean = String(role || '').toUpperCase();
  if (!knownRole(clean)) {
    const e = new Error('unknown platform role');
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  const user = await db.get('SELECT id, username FROM users WHERE id = ?', [userId]);
  if (!user) {
    const e = new Error('user not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const existing = await db.get('SELECT role FROM admins WHERE user_id = ?', [userId]);
  if (existing) {
    await db.run('UPDATE admins SET role = ? WHERE user_id = ?', [clean, userId]);
  } else {
    await db.run('INSERT INTO admins (user_id, role, created_at) VALUES (?, ?, ?)',
      [userId, clean, now()]);
  }
  await require('./enforcement').audit(actorId, 'PLATFORM_ROLE_ASSIGNED', 'user', userId,
    'role: ' + clean, { metadata: { from: existing ? existing.role : null, to: clean } });
  return get(userId);
}

async function remove(userId, actorId) {
  const existing = await get(userId);
  if (!existing) {
    const e = new Error('platform role not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  await db.run('DELETE FROM admins WHERE user_id = ?', [userId]);
  await require('./enforcement').audit(actorId, 'PLATFORM_ROLE_REMOVED', 'user', userId,
    'role removed: ' + existing.role, { metadata: { from: existing.role, to: null } });
  return { userId, removed: true };
}

// A platform cannot end up with nobody able to assign roles. The check is
// deliberately about the wildcard role, not about the person doing the
// change: a demotion of the last administrator is refused even when it is
// self-service.
async function countPlatformAdmins() {
  const rows = await db.all("SELECT user_id FROM admins WHERE role = 'PLATFORM_ADMIN'");
  return rows.length;
}

module.exports = {
  PERMISSIONS, ROLES, ROLE_NAMES, knownRole, get, allows, hasPermission,
  list, assign, remove, countPlatformAdmins,
};
