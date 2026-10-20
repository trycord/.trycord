// Feature flags. One authoritative module, read once at startup.
//
// The rule this enforces: a flag is a boolean, an accepted spelling is on/off/true/
// false/1/0, and anything else is a startup error. A typo silently becoming "off" is how
// an operator ships voice to a community that was promised voice; a typo silently
// becoming "on" is how an instance comes up exposing something it was never configured
// for. Both are worse than refusing to start.
//
// Nothing else in the server reads process.env for a feature decision. The flags are
// consumed from here, so the API routes, the realtime gateway, the background jobs and
// the client's capability discovery all answer the same question the same way.

const ON = new Set(['on', 'true', '1', 'yes', 'enabled']);
const OFF = new Set(['off', 'false', '0', 'no', 'disabled']);

function flag(name, fallback, { dependencies = [] } = {}) {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
  if (raw === '') return { value: fallback, source: 'default' };

  const low = raw.toLowerCase();
  if (ON.has(low)) return { value: true, source: 'environment' };
  if (OFF.has(low)) return { value: false, source: 'environment' };

  throw new Error(
    `${name} must be one of on/off (or true/false, 1/0), got "${raw}". ` +
    'A value that cannot be parsed is a startup error, not a default.'
  );
}

function text(name, fallback) {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
  return raw === '' ? fallback : raw;
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  return Math.min(Math.max(n, min), max);
}

function list(name, fallback = []) {
  const raw = String(process.env[name] === undefined ? '' : process.env[name]).trim();
  if (raw === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// A URL, validated for shape only. Whether it is reachable is a separate question
// answered by the health probe, not by the parser.
function url(name) {
  const raw = text(name, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    return u.origin + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    throw new Error(`${name} is not a usable http(s) URL: "${raw}"`);
  }
}

// The declared flags. Order here is documentation order, not precedence.
// The media providers this build understands.
//
// The first-party mesh is the one an instance is expected to run: the server
// carries the signalling and the peers carry the media, so a call does not
// leave the host. The hosted SFU and the operator's own SFU are read as well,
// because a deployment that has one of them configured should not lose voice
// on upgrade - each keeps its own settings, so switching between them does
// not erase what was saved for the other one.
const PROVIDERS = ['mesh', 'cloudflare', 'sfu'];
const SUPPORTED_PROVIDERS = PROVIDERS;

// Settings the configuration centre owns. Each of these has a row in
// services/settings.js, and that module already implements the precedence this
// package needs: the saved value wins, the environment seeds a setting nobody has
// saved, and the schema default is the floor.
//
// features.js used to read these straight from process.env, which meant the
// dashboard could save a value and nothing would read it - the toggle moved, the
// application did not. Reading through the store is what makes a saved setting
// real, and it means there is exactly one implementation of the precedence rule
// rather than two that can disagree.
const FROM_SETTINGS = {
  REGISTRATION_ENABLED: 'registration.enabled',
  REGISTRATION_APPROVAL: 'registration.approval',
  EMAIL_VERIFICATION_REQUIRED: 'registration.emailVerification',
  COMMUNITY_DISCOVERY_ENABLED: 'content.discovery',
  MAX_UPLOAD_BYTES: 'content.maxUploadBytes',
  WS_MAX_PAYLOAD: 'messaging.maxPayload',
  WS_HEARTBEAT_MS: 'messaging.heartbeatMs',
  VOICE_VIDEO_ENABLED: 'voice.enabled',
  VOICE_VIDEO_PROVIDER: 'voice.provider',
  VOICE_VIDEO_SCREEN_SHARING: 'voice.screenSharing',
  VOICE_VIDEO_STAGE_CHANNELS: 'voice.stageChannels',
  FILE_UPLOADS_ENABLED: 'features.uploads',
  BOTS_ENABLED: 'features.bots',
  WEBHOOKS_ENABLED: 'features.webhooks',
  PUSH_NOTIFICATIONS_ENABLED: 'features.push',
  STORAGE_QUOTA_MB: 'storage.quotaMb',
  RATE_LIMIT_MAX: 'limits.rateMax',
  CONTINUUM_ENABLED: 'continuum.enabled',
};

// The value for a flag, from wherever it actually comes from.
//
// The settings store is consulted first because it owns the precedence. It is only
// reachable once it has loaded, which the boot sequence guarantees; if it has not, the
// environment is read directly so a flag still resolves during startup validation
// rather than throwing about a store that is merely not ready yet.
function valueOf(envName, fallback) {
  const key = FROM_SETTINGS[envName];
  if (key) {
    try {
      const settings = require('./services/settings');
      if (settings.isLoaded()) return settings.get(key);
    } catch { /* not loaded yet: fall through to the environment */ }
  }
  const raw = String(process.env[envName] === undefined ? '' : process.env[envName]).trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && String(n) === raw) return n;
  if (/^(true|on|yes|1)$/i.test(raw)) return true;
  if (/^(false|off|no|0)$/i.test(raw)) return false;
  return raw;
}

function providerName() {
  // Through valueOf, not the environment directly: every other flag is read
  // from the settings store first, and a provider read straight from the
  // environment would ignore what an administrator saved in the configuration
  // centre - the setting would save and change nothing.
  const raw = String(valueOf('VOICE_VIDEO_PROVIDER', SUPPORTED_PROVIDERS[0])).toLowerCase();
  if (PROVIDERS.indexOf(raw) === -1) {
    throw new Error(
      `VOICE_VIDEO_PROVIDER must be one of ${PROVIDERS.join(', ')}, got "${raw}".`
    );
  }
  if (SUPPORTED_PROVIDERS.indexOf(raw) === -1) {
    console.warn('[warn] voice and video is configured for the "' + raw + '" provider, which this build does not support.'
      + ' Set voice.provider to one of ' + SUPPORTED_PROVIDERS.join(', ') + ' in the admin configuration.');
  }
  return raw;
}

function build() {
  const registration = valueOf('REGISTRATION_ENABLED', true);
  const registrationApproval = valueOf('REGISTRATION_APPROVAL', false);
  const emailVerification = valueOf('EMAIL_VERIFICATION_REQUIRED', false);
  // A typo in a flag's environment spelling is still a startup error, so each is parsed
  // here - but the value comes from the store, which owns precedence. Reading it straight
  // from the environment would let a stray .env value outrank a saved one and put the
  // toggle-moved-the-application-did-not failure back.
  flag('FILE_UPLOADS_ENABLED', true);
  flag('BOTS_ENABLED', true);
  flag('WEBHOOKS_ENABLED', true);
  flag('PUSH_NOTIFICATIONS_ENABLED', false);
  const uploads = !!valueOf('FILE_UPLOADS_ENABLED', true);
  const discovery = valueOf('COMMUNITY_DISCOVERY_ENABLED', true);
  const bots = !!valueOf('BOTS_ENABLED', true);
  const webhooks = !!valueOf('WEBHOOKS_ENABLED', true);
  const push = !!valueOf('PUSH_NOTIFICATIONS_ENABLED', false);
  const continuum = !!valueOf('CONTINUUM_ENABLED', false);

  // Voice and video carries the master switch plus the two sub-capabilities beneath it.
  // A sub-capability can be off while the master is on, but never on while the master is
  // off: the master is the one that decides whether the infrastructure exists at all.
  const voice = valueOf('VOICE_VIDEO_ENABLED', false);
  const screenSharing = valueOf('VOICE_VIDEO_SCREEN_SHARING', true);
  const stageChannels = flag('VOICE_VIDEO_STAGE_CHANNELS', true);
  const stageChannelsOn = !!valueOf('VOICE_VIDEO_STAGE_CHANNELS', stageChannels.value);
  const provider = providerName();
  // The configuration of the provider in force, and the participant limit that
  // provider enforces. Both come from the voice configuration module, which
  // resolves the provider's own settings and the older keys they replace.
  const voiceConfig = require('./services/voice/config');
  const providerConfig = voiceConfig.publicConfiguration(provider);
  const maxPayload = valueOf('WS_MAX_PAYLOAD', 204800);
  const heartbeatMs = valueOf('WS_HEARTBEAT_MS', 30000);
  const maxUploadBytes = valueOf('MAX_UPLOAD_BYTES', 8388608);

  return {
    registration: !!registration,
    registrationApproval: !!registrationApproval,
    emailVerificationRequired: !!emailVerification,
    uploads: !!uploads,
    communityDiscovery: !!discovery,
    bots: !!bots,
    webhooks: !!webhooks,
    pushNotifications: !!push,
    continuum: !!continuum,
    maxUploadBytes: Number(maxUploadBytes),
    quotaBytes: Number(valueOf('STORAGE_QUOTA_MB', 512)) * 1024 * 1024,
    rateLimitMax: Number(valueOf('RATE_LIMIT_MAX', 0)) || 0,

    voiceVideo: {
      enabled: !!voice,
      // The sub-flags are read only so a bad spelling is still a startup error; the
      // effective values are computed below, gated on the master.
      screenSharingRequested: !!screenSharing,
      stageChannelsRequested: stageChannelsOn,
      screenSharing: !!voice && !!screenSharing,
      stageChannels: !!voice && stageChannelsOn,

      // Only one provider is in force. The others keep their own settings, so
      // choosing a different one does not erase what was saved for this one.
      provider: provider,
      // The participant limit of the provider in force. The limit is shared in
      // meaning and per-provider in value: each provider holds its own.
      maxParticipants: providerConfig ? providerConfig.maxParticipants : 25,
      // The configuration of the provider in force. It carries no secret: a
      // credential is reported as set or not set, never as its value.
      providerConfig: providerConfig,
    },

    realtime: {
      maxPayload: Math.min(Math.max(Number(maxPayload) || 204800, 1024), 4194304),
      heartbeatMs: Math.min(Math.max(Number(heartbeatMs) || 30000, 1000), 300000),
    },
  };
}

// Secrets, which never leave the process. The capability response below is built from
// everything else.
function secretsOf(features) {
  const voiceConfig = require('./services/voice/config');
  const cfg = voiceConfig.configuration(features.voiceVideo.provider);
  if (!cfg) return {};
  return {
    turnUsername: cfg.turnUsername,
    // The TURN credential of the provider in force. It is read by the code that
    // authenticates with it and by nothing else.
    turnCredential: cfg.resolved.turnCredential ? cfg.resolved.turnCredential.value : '',
  };
}

// What the client is allowed to know.
//
// A capability response answers "may I do this, and what does it cost me". It carries no
// credentials and no internal hostnames, because it is fetched by every client including
// ones that are not signed in.
function capabilities(features) {
  return {
    registration: features.registration,
    emailVerificationRequired: features.emailVerificationRequired,
    fileUploads: features.uploads,
    communityDiscovery: features.communityDiscovery,
    bots: features.bots,
    webhooks: features.webhooks,
    pushNotifications: features.pushNotifications,
    voiceVideo: {
      enabled: features.voiceVideo.enabled,
      screenSharing: features.voiceVideo.screenSharing,
      stageChannels: features.voiceVideo.stageChannels,
      maxParticipants: features.voiceVideo.maxParticipants,
      // Which path a call takes. The client has to know: the mesh is
      // peer-to-peer and the SFU paths are not.
      provider: features.voiceVideo.provider,
      // A client needs the ICE servers to open a connection at all. The TURN URL is
      // therefore public - that is what it is for - but its credential is minted
      // per-session by the backend and never appears here.
      iceServers: iceServers(features),
    },
  };
}

// The ICE server list a client is handed, credentials stripped.
//
// The list belongs to the provider in force: the mesh is reached through the
// instance's own relay, and the SFU carries the media itself.
function iceServers(features) {
  const v = features.voiceVideo;
  if (!v.enabled) return [];
  const voiceConfig = require('./services/voice/config');
  return voiceConfig.iceServers(v.provider);
}

// Is this feature usable, or is it configured but broken?
//
// A flag that is on with no infrastructure is not usable, and a client that cannot tell
// the difference shows a join button that does nothing. The diagnostics are for the
// operator; the reason code is for both.
//
// The question is asked of the provider in force: each one has its own
// requirements, and a mesh with no SFU credentials is not a broken mesh.
function healthOf(features) {
  const v = features.voiceVideo;
  if (!v.enabled) {
    return { available: false, reason: 'disabled', detail: 'Voice and video are off on this instance' };
  }

  const voiceConfig = require('./services/voice/config');
  const problems = voiceConfig.missing(v.provider);

  if (problems.length) {
    return {
      available: false,
      reason: 'misconfigured',
      detail: 'Voice and video is on, but the provider in force is not ready',
      problems,
    };
  }

  return { available: true, reason: 'ready', detail: '' };
}

let features = null;

// Drops the cached build so the next read consults the settings store again.
//
// Without this, saving a flag in the configuration centre updates the database and
// nothing else: features.current keeps answering from the build it made at boot,
// which is exactly the "the toggle moved and the application did not" failure.
//
// A reload does not refuse the way a boot does. An administrator may leave the
// instance in a configuration that cannot carry a call - a provider that is
// selected and not yet filled in - and the refusal belongs where a session is
// created, where it can say what is missing. The build is still replaced, so the
// instance answers with the configuration that was actually saved.
function reload() {
  features = null;
  try {
    return load();
  } catch (error) {
    features = build();
    console.warn('[warn] ' + (error && error.message ? error.message : 'the configuration could not be applied'));
    return features;
  }
}

function load() {
  if (features) return features;
  features = build();
  // Startup validation: refuse to come up with a configuration that cannot work, rather
  // than coming up and failing at the first join.
  const health = healthOf(features);
  if (features.voiceVideo.enabled && !health.available) {
    throw new Error(
      'VOICE_VIDEO_ENABLED is on, but voice cannot work: ' + health.problems.join('; ')
    );
  }
  return features;
}

module.exports = {
  load,
  reload,
  get current() { return load(); },
  capabilities,
  healthOf,
  secretsOf,
  iceServers,
};
