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
const PROVIDERS = ['cloudflare'];

function providerName() {
  const raw = text('VOICE_VIDEO_PROVIDER', PROVIDERS[0]).toLowerCase();
  if (PROVIDERS.indexOf(raw) === -1) {
    throw new Error(
      `VOICE_VIDEO_PROVIDER must be one of ${PROVIDERS.join(', ')}, got "${raw}".`
    );
  }
  return raw;
}

function build() {
  const registration = flag('REGISTRATION_ENABLED', true);
  const emailVerification = flag('EMAIL_VERIFICATION_REQUIRED', false);
  const uploads = flag('FILE_UPLOADS_ENABLED', true);
  const discovery = flag('COMMUNITY_DISCOVERY_ENABLED', true);
  const bots = flag('BOTS_ENABLED', true);
  const webhooks = flag('WEBHOOKS_ENABLED', true);
  const push = flag('PUSH_NOTIFICATIONS_ENABLED', false);

  // Voice and video carries the master switch plus the two sub-capabilities beneath it.
  // A sub-capability can be off while the master is on, but never on while the master is
  // off: the master is the one that decides whether the infrastructure exists at all.
  const voice = flag('VOICE_VIDEO_ENABLED', false);
  const screenSharing = flag('VOICE_VIDEO_SCREEN_SHARING', true);
  const stageChannels = flag('VOICE_VIDEO_STAGE_CHANNELS', true);

  return {
    registration: registration.value,
    emailVerificationRequired: emailVerification.value,
    uploads: uploads.value,
    communityDiscovery: discovery.value,
    bots: bots.value,
    webhooks: webhooks.value,
    pushNotifications: push.value,

    voiceVideo: {
      enabled: voice.value,
      // The sub-flags are read only so a bad spelling is still a startup error; the
      // effective values are computed below, gated on the master.
      screenSharingRequested: screenSharing.value,
      stageChannelsRequested: stageChannels.value,
      screenSharing: voice.value && screenSharing.value,
      stageChannels: voice.value && stageChannels.value,

      // Only one provider is implemented. An operator who sets anything else gets a
      // startup error naming what is supported, rather than a runtime failure at the
      // first join.
      provider: providerName(),
      maxParticipants: integer('VOICE_VIDEO_MAX_PARTICIPANTS', 25, { min: 1, max: 200 }),

      stun: list('VOICE_VIDEO_STUN_URLS', []),
      turn: {
        url: text('VOICE_VIDEO_TURN_URL', ''),
        username: text('VOICE_VIDEO_TURN_USERNAME', ''),
        credential: text('VOICE_VIDEO_TURN_CREDENTIAL', ''),
      },
    },
  };
}

// Secrets, which never leave the process. The capability response below is built from
// everything else.
function secretsOf(features) {
  return {
    turnCredential: features.voiceVideo.turn.credential,
    turnUsername: features.voiceVideo.turn.username,
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
      // A client needs the ICE servers to open a connection at all. The TURN URL is
      // therefore public - that is what it is for - but its credential is minted
      // per-session by the backend and never appears here.
      iceServers: iceServers(features),
    },
  };
}

// The ICE server list a client is handed, credentials stripped.
function iceServers(features) {
  const v = features.voiceVideo;
  if (!v.enabled) return [];

  const out = [];
  for (const u of v.stun) {
    out.push({ urls: u });
  }
  // The TURN URL is here because a client needs it to open a connection. The credential is
  // deliberately absent: the capability response is fetched by every client, including
  // ones that are not signed in, and a credential in it would be standing TURN access for
  // anyone. POST /api/voice/credentials hands it over to a session that belongs to the
  // caller.
  if (v.turn.url) {
    out.push({ urls: v.turn.url });
  }
  return out;
}

// Is this feature usable, or is it configured but broken?
//
// A flag that is on with no infrastructure is not usable, and a client that cannot tell
// the difference shows a join button that does nothing. The diagnostics are for the
// operator; the reason code is for both.
function healthOf(features) {
  const v = features.voiceVideo;
  if (!v.enabled) {
    return { available: false, reason: 'disabled', detail: 'voice and video is off on this instance' };
  }

  const problems = [];
  if (v.stun.length === 0 && !v.turn.url) {
    problems.push('no STUN or TURN server is configured');
  }
  if (!text('VOICE_VIDEO_SFU_APP_ID', '')) {
    problems.push('VOICE_VIDEO_SFU_APP_ID is not set');
  }

  if (problems.length) {
    return {
      available: false,
      reason: 'misconfigured',
      detail: 'voice and video is enabled but its infrastructure is incomplete',
      problems,
    };
  }

  return { available: true, reason: 'ready', detail: '' };
}

let features = null;

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
  get current() { return load(); },
  capabilities,
  healthOf,
  secretsOf,
  iceServers,
};
