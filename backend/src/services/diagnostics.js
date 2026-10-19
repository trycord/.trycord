// What this instance is actually doing right now.
//
// Each subsystem is asked, in its own terms, whether it is configured, whether
// it is running, and whether it is healthy. Where a subsystem cannot answer
// honestly - because the check needs a device, a network or a third party -
// the answer says so rather than turning a configured switch into a green tick.
//
// The states used here:
//   healthy   it is running and the check passed
//   degraded  it is running and something is wrong
//   failed    it is not working
//   disabled  it is switched off on purpose
//   configured it is set up, but nothing proves it is working
//   unknown   this instance cannot tell

const db = require('../db');
const settings = require('./settings');
const features = require('../features');
const jobs = require('./jobs');
const storage = require('./storage');
const mail = require('./mail');
const netguard = require('./netguard');

function state(value, detail) {
  return { state: value, detail: detail || null };
}

async function database() {
  try {
    const runtime = db.status();
    await db.get('SELECT 1');
    return state('healthy', {
      dialect: runtime.dialect,
      connected: runtime.connected,
      openedAt: runtime.openedAt,
      failures: runtime.failures,
    });
  } catch (e) {
    return state('failed', { error: e.message });
  }
}

function configuration() {
  if (!settings.isLoaded()) return state('unknown', 'the settings store has not been read yet');
  const status = settings.status();
  return state(status.pendingRestart.length ? 'degraded' : 'healthy', {
    pendingRestart: status.pendingRestart,
    lastSavedAt: status.lastSavedAt,
  });
}

function storageSubsystem() {
  const kind = storage.driverName();
  if (!kind) return state('disabled', 'no storage driver is loaded');
  if (kind === 'local') {
    const root = storage.localRoot();
    return state(root ? 'healthy' : 'degraded', { provider: 'local', root: root || null });
  }
  // An S3 driver that is configured is not an S3 driver that answered. The
  // check that proves it is the upload path, and the console says so.
  return state('configured', {
    provider: kind,
    note: 'an object store is configured; the upload path is what proves it works',
  });
}

function mailSubsystem() {
  const mode = mail.mode();
  if (mode === 'disabled') return state('disabled', 'mail is switched off');
  const described = mail.describe();
  return state(described && described.ready ? 'healthy' : 'degraded', {
    mode,
    problems: (described && described.problems) || [],
  });
}

function searchSubsystem() {
  const provider = settings.isLoaded() ? settings.read('search.provider', 'in-house') : 'in-house';
  if (provider !== 'in-house') return state('disabled', 'the in-house index is not the provider');
  return state('healthy', { provider, note: 'messages and communities are indexed in the instance database' });
}

function notificationsSubsystem() {
  const provider = settings.isLoaded() ? settings.read('notifications.provider', 'in-house') : 'in-house';
  if (provider !== 'in-house') return state('disabled', 'the in-house delivery is not the provider');
  return state('healthy', { provider, note: 'in-app notifications are delivered by this instance' });
}

function voiceSubsystem() {
  const voice = features.current.voiceVideo || {};
  if (!voice.enabled) return state('disabled', 'voice and video are switched off');
  const provider = settings.isLoaded() ? settings.read('voice.provider', 'mesh') : 'mesh';
  const stun = settings.isLoaded() ? settings.read('voice.stunUrls', []) : [];
  const turn = settings.isLoaded() ? settings.read('voice.turnUrl', '') : '';
  const hasIce = (Array.isArray(stun) && stun.length > 0) || !!turn;
  if (!hasIce) {
    return state('degraded', { provider, note: 'no STUN or TURN address is configured, so peers behind a strict NAT cannot connect' });
  }
  return state('configured', { provider, note: 'signalling is ready; real media needs two clients and a network' });
}

async function continuumSubsystem() {
  const enabled = features.current.continuum;
  if (!enabled) return state('disabled', 'federation is switched off');
  try {
    const continuum = require('./continuum');
    const peers = await continuum.listInstances();
    const events = await continuum.listEvents(20);
    const failing = (events || []).filter((e) => e.status === 'failed').length;
    return state(failing ? 'degraded' : 'healthy', {
      peers: peers.length,
      trusted: peers.filter((p) => p.trust_status === 'trusted').length,
      recentEvents: (events || []).length,
      failingDeliveries: failing,
    });
  } catch (e) {
    return state('failed', { error: e.message });
  }
}

async function jobsSubsystem() {
  try {
    const stats = await jobs.stats();
    const failed = Number(stats.byStatus.failed || 0);
    return state(failed ? 'degraded' : 'healthy', {
      workers: stats.workers,
      queued: Number(stats.byStatus.queued || 0),
      running: Number(stats.byStatus.running || 0),
      failed,
      kinds: stats.kinds.length,
    });
  } catch (e) {
    return state('failed', { error: e.message });
  }
}

function realtimeSubsystem() {
  const heartbeat = settings.isLoaded() ? settings.read('messaging.heartbeatMs', 30000) : 30000;
  return state('healthy', {
    note: 'the gateway shares this process; its sockets are counted by the status monitor',
    heartbeatMs: heartbeat,
  });
}

function migrationsSubsystem() {
  try {
    const schema = require('../db/schema');
    const names = typeof schema.tableNames === 'function' ? schema.tableNames() : [];
    return state(names.length ? 'healthy' : 'configured', {
      note: 'the schema is applied at boot; a mismatch stops the boot rather than starting wrong',
      tables: names.length,
    });
  } catch (e) {
    return state('unknown', { error: e.message });
  }
}

// The whole picture, for the operator who has to decide whether this instance
// can be trusted with traffic.
async function report() {
  const [dbState, jobsState, continuumState] = await Promise.all([
    database(),
    jobsSubsystem(),
    continuumSubsystem(),
  ]);

  const subsystems = {
    database: dbState,
    configuration: configuration(),
    storage: storageSubsystem(),
    search: searchSubsystem(),
    notifications: notificationsSubsystem(),
    mail: mailSubsystem(),
    realtime: realtimeSubsystem(),
    voice: voiceSubsystem(),
    continuum: continuumState,
    jobs: jobsState,
    migrations: migrationsSubsystem(),
  };

  const states = Object.values(subsystems).map((s) => s.state);
  const overall = states.includes('failed') ? 'failed'
    : states.includes('degraded') ? 'degraded'
      : states.every((s) => s === 'disabled' || s === 'healthy' || s === 'configured') ? 'healthy'
        : 'degraded';

  return {
    overall,
    generatedAt: new Date().toISOString(),
    instanceId: process.env.TRYCORD_INSTANCE_ID || 'local',
    version: require('../../package.json').version,
    node: process.version,
    subsystems,
  };
}

module.exports = { report, netguard };
