// Instance configuration: the schema, the store, and the precedence.
//
// Configuration has three sources and they resolve in this order:
//
//   database    what a system administrator saved through the dashboard
//   environment what the deployment set, in .env or a container
//   default     what the schema declares
//
// For an application setting the saved value is the one in force: the environment seeds
// a setting nobody has saved yet and then stops overriding it, so a restart cannot undo
// a change made in the dashboard. A value the deployment must force belongs in the
// deployment-managed list, which the interface explains. Secrets are the exception - a
// secret the deployment set stays the deployment's, because rotating a credential is not
// an application setting.
//
// The store records which source is in force, and the UI shows it next to every value.
//
// Secrets are never returned. A secret is stored as a marker, replaced only by an
// explicit write, and a blank field leaves the stored one alone.

const db = require('../db');
// clock, not util: settings needs a timestamp and an id, and util needs the
// settings store to read a session lifetime. Importing util here closed a cycle
// through the module scope, which Node resolves by handing one side a partially
// built exports object - it worked only because server.js happened to reach
// settings before util.
const { now, uuid } = require('../clock');
const secrets = require('./secrets');

// Every secret's stored (encrypted) value, kept alongside the other loaded state so
// the catalogue can report whether one is set without a query per key. Never exposed
// except through catalogue(), which reports presence only.
const secretValues = {};

// The interfaces that own settings.
//
// A setting has one authoritative editor. Where a setting is changed somewhere
// other than the general Configuration page - in the voice console, say - the
// general page shows the value that is in force and a link to where it is
// changed, and a write that arrives from the general page is refused.
//
// The rule is the Instance Admin's: the console that owns a setting is where it
// is changed. Two editors for one value is how an instance ends up with a
// setting that says one thing and behaves like another.
const CANONICAL_INTERFACES = {
  'admin.voice': { id: 'admin.voice', label: 'Voice and video', route: '/admin/voice' },
};

// The settings the voice console owns. Every one of them, because the voice
// console is where a person goes to make sense of the voice settings: the
// provider, the credentials, the participants, the relay.
const VOICE_OWNED = [
  'voice.enabled', 'voice.provider', 'voice.screenSharing', 'voice.stageChannels',
  'voice.maxParticipants', 'voice.stunUrls', 'voice.turnUrl', 'voice.turnUsername',
  'voice.turnCredential', 'voice.sfuAppId', 'voice.sfuAppSecret',
  'voice.mesh.maxParticipants', 'voice.mesh.stunUrls', 'voice.mesh.turnUrl',
  'voice.mesh.turnUsername', 'voice.mesh.turnCredential',
  'voice.cloudflare.appId', 'voice.cloudflare.appSecret', 'voice.cloudflare.endpoint',
  'voice.cloudflare.maxParticipants',
  'voice.sfu.endpoint', 'voice.sfu.stunUrls', 'voice.sfu.turnUrl',
  'voice.sfu.turnUsername', 'voice.sfu.turnCredential', 'voice.sfu.maxParticipants',
  'voice.sfu.token',
];

// The interface that owns a setting, or null when the general Configuration
// page is where it is changed.
function canonicalInterface(key) {
  if (VOICE_OWNED.indexOf(String(key || '')) !== -1) return 'admin.voice';
  return null;
}

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
    key: 'instance.backendRole', env: 'TRYCORD_BACKEND_ROLE', type: 'string', default: 'primary',
    category: 'general', label: 'Backend role',
    description: 'This server\'s role within the logical instance: PRIMARY API (serves traffic) or BACKUP API (standby). Actual failover routing is handled separately.',
    allowed: ['primary', 'backup'],
    live: false,
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
    key: 'content.allowedUploadTypes', env: 'ALLOWED_UPLOAD_TYPES', type: 'list', default: [],
    category: 'content', label: 'Allowed upload types',
    description: 'MIME types members may attach, for example image/png, application/pdf. Empty means anything is accepted and is served as a download when its type is not recognised. When this is set, a file whose detected type is not on the list is refused - the type is detected from the bytes, never from what the client claims.',
    live: true,
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
    description: 'Whether this instance offers voice at all. On, the instance runs its own relay and hands the clients everything they need.',
    live: true, consequential: true,
  },
  {
    key: 'voice.provider', env: 'VOICE_VIDEO_PROVIDER', type: 'string', default: 'mesh',
    category: 'voice', label: 'Media server provider',
    description: 'The path a call takes. Mesh: this instance\'s own peer-to-peer path - the media travels between the participants and the server carries the signalling, so a call does not leave the host. Cloudflare Realtime: the media is carried by Cloudflare\'s SFU. Third-party SFU: a media server the operator runs. Each provider keeps its own settings, so switching between them does not erase what was saved for the other one.',
    allowed: ['mesh', 'cloudflare', 'sfu'], live: true, consequential: true,
  },
  {
    key: 'search.provider', env: 'SEARCH_PROVIDER', type: 'string', default: 'in-house',
    category: 'search', label: 'Search provider',
    description: 'In-house indexes messages and community content in the instance database with permission-scoped results. No external search service is required.',
    allowed: ['in-house'], live: false,
  },
  {
    key: 'search.historyLimit', env: 'SEARCH_HISTORY_LIMIT', type: 'integer', default: 25,
    category: 'search', label: 'Search history entries',
    description: 'How many of a reader\'s recent searches are kept. The list is the reader\'s own and goes with the account.',
    min: 1, max: 200, live: true,
  },
  {
    key: 'localisation.defaultLocale', env: 'TRYCORD_DEFAULT_LOCALE', type: 'string', default: 'en',
    category: 'localisation', label: 'Default locale',
    description: 'The locale this instance answers in when a reader has not asked for one. It is used before the browser\'s Accept-Language, so it is the instance\'s own answer rather than the visitor\'s.',
    live: true,
  },
  {
    key: 'localisation.allowedLocales', env: 'TRYCORD_ALLOWED_LOCALES', type: 'list', default: [],
    category: 'localisation', label: 'Allowed locales',
    description: 'The locales a pack may be installed for. Empty means any locale a pack declares.',
    live: true,
  },
  {
    key: 'localisation.allowCommunityPacks', env: 'TRYCORD_COMMUNITY_PACKS', type: 'boolean', default: true,
    category: 'localisation', label: 'Community localisation packs',
    description: 'Whether a community may install its own pack. A community pack still has to be reviewed before it is served.',
    live: true,
  },
  {
    key: 'themes.allowCommunityThemes', env: 'TRYCORD_COMMUNITY_THEMES', type: 'boolean', default: true,
    category: 'themes', label: 'Community themes',
    description: 'Whether a community may install its own theme package. A theme carries values only, and one that would break the interface is refused.',
    live: true,
  },
  {
    key: 'incidents.statusPageEnabled', env: 'TRYCORD_STATUS_PAGE', type: 'boolean', default: true,
    category: 'incidents', label: 'Public status page',
    description: 'Whether the incident timeline is published. What it shows is only what an operator wrote; an instance with nothing recorded says so.',
    live: true,
  },
  {
    key: 'notifications.provider', env: 'NOTIFICATIONS_PROVIDER', type: 'string', default: 'in-house',
    category: 'notifications', label: 'Notification provider',
    description: 'In-house delivers in-app notifications through the instance itself. External push providers are optional add-ons; core notification delivery does not depend on them.',
    allowed: ['in-house'], live: false,
  },
  {
    key: 'voice.screenSharing', env: 'VOICE_VIDEO_SCREEN_SHARING', type: 'boolean', default: true,
    category: 'voice', label: 'Allow screen sharing',
    // The media never reaches this server, so this is a switch the clients
    // honour rather than one the server refuses. It says so, because a
    // switch nobody can see the enforcement of is a switch nobody trusts.
    description: 'Whether a member may share their screen. The clients honour this one, and it cannot be on while voice itself is off.',
    live: true,
  },
  {
    key: 'voice.stageChannels', env: 'VOICE_VIDEO_STAGE_CHANNELS', type: 'boolean', default: true,
    category: 'voice', label: 'Allow stage channels',
    description: 'A stage is a voice channel where an audience listens and a moderator brings speakers up.',
    live: true,
  },

  // ---- the media providers.
  //
  // Each provider owns its own settings, so choosing a different one cannot
  // erase what was saved for the one before it. The group is deliberately kept
  // apart from the shared settings above: the console shows the provider first
  // and then only that provider's fields.
  //
  // These entries live in a category the catalogue does not publish, because
  // the Voice and video console renders them per provider - a flat list of
  // three providers' settings would say nothing about which one is in force.
  {
    key: 'voice.mesh.maxParticipants', env: 'VOICE_VIDEO_MESH_MAX_PARTICIPANTS', type: 'integer', default: 6,
    category: 'voice-media', label: 'Participants per mesh room',
    description: 'The media travels between every participant, so the room is small. Six keeps the CPU and the bandwidth of a small host predictable.',
    min: 1, max: 200, live: true,
  },
  {
    key: 'voice.mesh.stunUrls', env: 'VOICE_VIDEO_MESH_STUN_URLS', type: 'list', default: [],
    category: 'voice-media', label: 'STUN servers for the mesh',
    description: 'Comma-separated. Leave empty to use the STUN server this instance runs itself.',
    live: true,
  },
  {
    key: 'voice.mesh.turnUrl', env: 'VOICE_VIDEO_MESH_TURN_URL', type: 'string', default: '',
    category: 'voice-media', label: 'TURN server for the mesh',
    description: 'Relays media for a peer that cannot be reached directly. Leave empty to use the relay this instance runs itself.',
    live: true,
  },
  {
    key: 'voice.mesh.turnUsername', env: 'VOICE_VIDEO_MESH_TURN_USERNAME', type: 'string', default: '',
    category: 'voice-media', label: 'TURN username for the mesh',
    description: 'For a static TURN credential. Leave blank to use the short-lived credential this instance mints.',
    live: true,
  },
  {
    key: 'voice.cloudflare.appId', env: 'VOICE_VIDEO_CLOUDFLARE_APP_ID', type: 'string', default: '',
    category: 'voice-media', label: 'Cloudflare application id',
    description: 'From the Cloudflare Realtime dashboard. Required when the Cloudflare provider is the one in force.',
    live: true,
  },
  {
    key: 'voice.cloudflare.endpoint', env: 'VOICE_VIDEO_CLOUDFLARE_ENDPOINT', type: 'string', default: 'https://rtc.live.cloudflare.com/v1',
    category: 'voice-media', label: 'Cloudflare Realtime endpoint',
    description: 'Where the media sessions are created. Change it only for a self-hosted Realtime deployment.',
    live: true,
  },
  {
    key: 'voice.cloudflare.maxParticipants', env: 'VOICE_VIDEO_CLOUDFLARE_MAX_PARTICIPANTS', type: 'integer', default: 25,
    category: 'voice-media', label: 'Participants per channel (Cloudflare)',
    description: 'Enforced before a session is created, so a full channel refuses rather than dropping someone.',
    min: 1, max: 200, live: true,
  },
  {
    key: 'voice.sfu.endpoint', env: 'VOICE_VIDEO_SFU_ENDPOINT', type: 'string', default: '',
    category: 'voice-media', label: 'Third-party SFU endpoint',
    description: 'The base URL of a media server that speaks the documented session API. Required when the third-party provider is the one in force.',
    live: true,
  },
  {
    key: 'voice.sfu.stunUrls', env: 'VOICE_VIDEO_SFU_STUN_URLS', type: 'list', default: [],
    category: 'voice-media', label: 'STUN servers for the third-party SFU',
    description: 'Comma-separated. The SFU sends its own candidates; these are for the browser\'s own.',
    live: true,
  },
  {
    key: 'voice.sfu.turnUrl', env: 'VOICE_VIDEO_SFU_TURN_URL', type: 'string', default: '',
    category: 'voice-media', label: 'TURN server for the third-party SFU',
    description: 'Relays media for a peer that cannot be reached directly.',
    live: true,
  },
  {
    key: 'voice.sfu.turnUsername', env: 'VOICE_VIDEO_SFU_TURN_USERNAME', type: 'string', default: '',
    category: 'voice-media', label: 'TURN username for the third-party SFU',
    description: 'For a static TURN credential. Leave blank if the media server mints short-lived ones.',
    live: true,
  },
  {
    key: 'voice.sfu.maxParticipants', env: 'VOICE_VIDEO_SFU_MAX_PARTICIPANTS', type: 'integer', default: 25,
    category: 'voice-media', label: 'Participants per channel (third-party SFU)',
    description: 'Enforced before a session is created, so a full channel refuses rather than dropping someone.',
    min: 1, max: 200, live: true,
  },

  // ---- the settings the grouped ones replace.
  //
  // These are the keys the previous release used. They still work: a value
  // saved here is the value the matching new key takes, until the operator
  // saves that provider's configuration and the new key takes over. They are
  // not published in the catalogue, because the console edits the new keys and
  // an operator should not be shown two fields for one value.
  {
    key: 'voice.maxParticipants', env: 'VOICE_VIDEO_MAX_PARTICIPANTS', type: 'integer', default: 25,
    category: 'voice-legacy', label: 'Participants per channel (superseded)',
    description: 'Replaced by the limit of the provider in force. Still read when that provider has no limit of its own.',
    min: 1, max: 200, live: true,
  },
  {
    key: 'voice.stunUrls', env: 'VOICE_VIDEO_STUN_URLS', type: 'list', default: [],
    category: 'voice-legacy', label: 'STUN servers (superseded)',
    description: 'Replaced by the mesh\'s own STUN servers, because the mesh was the only path that could run.',
    live: true,
  },
  {
    key: 'voice.sfuAppId', env: 'VOICE_VIDEO_SFU_APP_ID', type: 'string', default: '',
    category: 'voice-legacy', label: 'Media server app id (superseded)',
    description: 'Replaced by the Cloudflare application id.',
    live: true,
  },
  {
    key: 'voice.turnUrl', env: 'VOICE_VIDEO_TURN_URL', type: 'string', default: '',
    category: 'voice-legacy', label: 'TURN server URL (superseded)',
    description: 'Replaced by the mesh\'s own TURN server.',
    live: true,
  },
  {
    key: 'voice.turnUsername', env: 'VOICE_VIDEO_TURN_USERNAME', type: 'string', default: '',
    category: 'voice-legacy', label: 'TURN username (superseded)',
    description: 'Replaced by the mesh\'s own TURN username.',
    live: true,
  },
  {
    key: 'continuum.enabled', env: 'CONTINUUM_ENABLED', type: 'boolean', default: false,
    category: 'continuum', label: 'Community Continuum',
    description: 'Federate with compatible Trycord instances. While on, trusted peers receive signed events from this one and this instance accepts events from instances an administrator added.',
    live: true, consequential: true,
  },

  // Read at call time by services/mail, so these are live.
  {
    key: 'mail.mode', env: 'MAIL_MODE', type: 'string', default: 'disabled',
    category: 'mail', label: 'Delivery mode',
    description: 'smtp sends through a relay, api posts JSON to an HTTPS endpoint, disabled sends nothing. Nothing is sent until this is set.',
    live: true, consequential: true,
  },
  {
    key: 'mail.from', env: 'MAIL_FROM', type: 'string', default: '',
    category: 'mail', label: 'From address',
    description: 'What recipients see. Required by every mode that delivers.',
    live: true,
  },
  {
    key: 'mail.smtpHost', env: 'SMTP_HOST', type: 'string', default: '',
    category: 'mail', label: 'SMTP host',
    description: 'The relay that delivers mail in smtp mode.',
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
    key: 'mail.smtpSecure', env: 'SMTP_SECURE', type: 'boolean', default: false,
    category: 'mail', label: 'Implicit TLS',
    description: 'On for port 465. Off for STARTTLS on 587.',
    live: true,
  },
  {
    key: 'mail.smtpRejectUnauthorized', env: 'SMTP_REJECT_UNAUTHORIZED', type: 'boolean', default: true,
    category: 'mail', label: 'Verify the relay certificate',
    description: 'Turn this off only for a self-signed relay on a private network. With it off, the connection can be intercepted.',
    live: true, consequential: true,
  },

  // The HTTP mode. Which vendor these reach is the operator's business; what
  // differs between vendors is which path in the request body holds each part,
  // and that is configuration rather than code.
  {
    key: 'mail.apiEndpoint', env: 'MAIL_API_ENDPOINT', type: 'string', default: '',
    category: 'mail', label: 'API endpoint',
    description: 'The HTTPS URL that accepts a message. http is only allowed for localhost.',
    live: true,
  },
  {
    key: 'mail.apiAuthHeader', env: 'MAIL_API_AUTH_HEADER', type: 'string', default: 'Authorization',
    category: 'mail', label: 'Auth header name',
    description: 'Which header carries the key. Most providers use Authorization.',
    live: true,
  },
  {
    key: 'mail.apiAuthPrefix', env: 'MAIL_API_AUTH_PREFIX', type: 'string', default: 'Bearer ',
    category: 'mail', label: 'Auth value prefix',
    description: 'Put in front of the key. "Bearer " is what most providers expect.',
    live: true, trim: false,
  },
  {
    key: 'mail.apiFromField', env: 'MAIL_API_FROM_FIELD', type: 'string', default: 'from',
    category: 'mail', label: 'From field',
    description: 'Path in the JSON body that holds the sender. Dots nest, so personalisation.from becomes {"personalisation":{"from":...}}.',
    live: true,
  },
  {
    key: 'mail.apiToField', env: 'MAIL_API_TO_FIELD', type: 'string', default: 'to',
    category: 'mail', label: 'Recipient field',
    description: 'Path in the JSON body that holds the recipient.',
    live: true,
  },
  {
    key: 'mail.apiSubjectField', env: 'MAIL_API_SUBJECT_FIELD', type: 'string', default: 'subject',
    category: 'mail', label: 'Subject field',
    description: 'Path in the JSON body that holds the subject.',
    live: true,
  },
  {
    key: 'mail.apiTextField', env: 'MAIL_API_TEXT_FIELD', type: 'string', default: 'text',
    category: 'mail', label: 'Plain text field',
    description: 'Path in the JSON body that holds the plain text alternative.',
    live: true,
  },
  {
    key: 'mail.apiHtmlField', env: 'MAIL_API_HTML_FIELD', type: 'string', default: 'html',
    category: 'mail', label: 'HTML field',
    description: 'Path in the JSON body that holds the HTML version.',
    live: true,
  },

  // The driver is read once when the storage module loads, so changing it needs a
  // restart. The quota is read per upload and is live.
  {
    key: 'storage.provider', env: 'STORAGE_DRIVER', type: 'string', default: 'local',
    category: 'storage', label: 'Storage provider',
    description: 'Local writes uploads to this instance\'s filesystem - no external account needed. S3-compatible (Amazon S3, Cloudflare R2, MinIO, Backblaze) needs a bucket, region and credentials. Both are served through authenticated routes; switching preserves existing files - run the storage migration after changing.',
    allowed: ['local', 's3'], live: false,
  },
  {
    key: 'storage.quotaMb', env: 'STORAGE_QUOTA_MB', type: 'integer', default: 512,
    category: 'storage', label: 'Upload quota per member (MB)',
    description: 'Enforced before a file is stored, so a refusal costs nothing.',
    min: 1, max: 1048576, live: true,
  },

  // S3 settings. Read through the settings store so the dashboard can configure them
  // and the environment still wins, which is the same precedence everything else uses.
  {
    key: 'storage.s3Bucket', env: 'S3_BUCKET', type: 'string', default: '',
    category: 'storage', label: 'S3 bucket',
    description: 'The bucket that holds uploaded files. Shown only when storage provider is S3.',
    live: true,
    showIf: { key: 'storage.provider', value: 's3' },
  },
  {
    key: 'storage.s3AccessKeyId', env: 'S3_ACCESS_KEY_ID', type: 'string', default: '',
    category: 'storage', label: 'S3 access key ID',
    description: 'The public half of the S3 credential. Shown only when storage provider is S3.',
    live: true,
    showIf: { key: 'storage.provider', value: 's3' },
  },
  {
    key: 'storage.s3Endpoint', env: 'S3_ENDPOINT', type: 'url', default: '',
    category: 'storage', label: 'S3 endpoint',
    description: 'The service endpoint. Leave blank for AWS S3; set for R2, MinIO or others. Shown only when storage provider is S3.',
    live: true,
    showIf: { key: 'storage.provider', value: 's3' },
  },
  {
    key: 'storage.s3Region', env: 'S3_REGION', type: 'string', default: 'us-east-1',
    category: 'storage', label: 'S3 region',
    description: 'The bucket region. us-east-1 for AWS S3; other services use different values. Shown only when storage provider is S3.',
    live: true,
    showIf: { key: 'storage.provider', value: 's3' },
  },
  {
    key: 'storage.s3ForcePathStyle', env: 'S3_FORCE_PATH_STYLE', type: 'boolean', default: true,
    category: 'storage', label: 'Force path-style addressing',
    description: 'On for R2 and MinIO. Off for AWS S3 with DNS-safe bucket names. Shown only when storage provider is S3.',
    live: true,
    showIf: { key: 'storage.provider', value: 's3' },
  },

  {
    key: 'retention.notificationsDays', env: 'RETENTION_NOTIFICATIONS_DAYS', type: 'integer', default: 90,
    category: 'retention', label: 'Keep notifications for (days)',
    description: 'How long an unread or read notification stays in the inbox. 90 days is about a quarter.',
    min: 1, max: 3650, live: true,
  },
  {
    key: 'retention.jobHistoryDays', env: 'RETENTION_JOB_HISTORY_DAYS', type: 'integer', default: 30,
    category: 'retention', label: 'Keep job history for (days)',
    description: 'How long the record of finished and failed background work is kept. A month is enough to see what happened.',
    min: 1, max: 3650, live: true,
  },
  {
    key: 'retention.auditDays', env: 'RETENTION_AUDIT_DAYS', type: 'integer', default: 365,
    category: 'retention', label: 'Keep the audit trail for (days)',
    description: 'How long the record of administrative actions is kept. This is the one history whose loss matters, so it is the longest.',
    min: 30, max: 3650, live: true,
  },
  {
    key: 'retention.continuumDays', env: 'RETENTION_CONTINUUM_DAYS', type: 'integer', default: 90,
    category: 'retention', label: 'Keep federation delivery records for (days)',
    description: 'How long delivered federation traffic is recorded. Undelivered and failed events are always kept until they are resolved.',
    min: 1, max: 3650, live: true,
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
    key: 'instance.discoverable', env: 'TRYCORD_DISCOVERABLE', type: 'boolean', default: false,
    category: 'general', label: 'List this instance in discovery',
    description: 'When on, this instance appears in the public listing other readers browse. Being listed is not federation: it says where the instance is, not that it trusts anyone.',
    live: true,
  },
  {
    key: 'instance.discoverySources', env: 'TRYCORD_DISCOVERY_SOURCES', type: 'list', default: [],
    category: 'general', label: 'Discovery directories',
    description: 'Addresses of JSON directories listing other instances. Each is read over https, never followed past a redirect, and a directory that is down costs nothing. Leave empty to publish only this instance.',
    live: true,
  },
  {
    key: 'instance.quickSetup', env: 'TRYCORD_QUICK_SETUP', type: 'boolean', default: false,
    category: 'general', label: 'Quick setup',
    description: 'Offer a guided first-run setup that sets the instance name, public URL, registration and mail in one pass.',
    live: true,
  },

  // How the process is reached. These were environment-only and listed as
  // untouchable, which told an operator to go and edit a file to move a port. They
  // are ordinary settings that happen to be read once at startup, so saving one
  // works and the pinned notice says when it applies.
  {
    key: 'server.port', env: 'PORT', type: 'integer', default: 9971,
    category: 'deployment', label: 'Listening port',
    description: 'The port this server accepts connections on. Applied when the process next starts.',
    min: 1, max: 65535, live: false,
  },
  {
    key: 'server.host', env: 'HOST', type: 'string', default: '',
    category: 'deployment', label: 'Bind address',
    description: 'The interface to accept connections on. Blank binds every interface when exposed directly, and loopback behind a proxy. Applied when the process next starts.',
    live: false,
  },
  {
    key: 'server.hostType', env: 'SERVER_HOST_TYPE', type: 'string', default: '',
    allowed: ['', 'express', 'nginx'],
    category: 'deployment', label: 'Exposure',
    description: 'express when this server is reached directly; nginx when it sits behind a reverse proxy. Applied when the process next starts.',
    live: false,
  },
  {
    key: 'app.mount', env: 'TRYCORD_APP_MOUNT', type: 'string', default: '',
    category: 'deployment', label: 'Mount prefix',
    description: 'Serve the application under a path such as /app. Blank serves it from the site root. Applied when the process next starts.',
    live: false,
  },
  {
    key: 'dashboard.mode', env: 'DASHBOARD_MODE', type: 'string', default: 'bundled',
    allowed: ['bundled', 'separate'],
    category: 'deployment', label: 'Dashboard deployment',
    description: 'Where the administrative console is served. "bundled" serves it from the main application; "separate" runs it as its own service that talks to the API over HTTP. The environment variable decides at startup and an unusable value stops the boot rather than being ignored. Applied when the process next starts.',
    live: false,
  },
  {
    key: 'cpu.worker_count', env: 'JOBS_WORKERS', type: 'integer', default: 0,
    category: 'limits', label: 'CPU worker count',
    description: 'Number of background job workers the job system runs. 0 means auto: half the logical CPUs, at least one, capped at eight. Applied when the process next starts.',
    min: 0, max: 64, live: false,
  },
  {
    key: 'cpu.concurrent_jobs', env: 'JOBS_CONCURRENT_JOBS', type: 'integer', default: 4,
    category: 'limits', label: 'Concurrent jobs per type',
    description: 'Maximum jobs of the same type running at once, so one expensive job type cannot starve the rest. Applied when the process next starts.',
    min: 1, max: 100, live: false,
  },
];

// Secret-bearing settings. Named explicitly rather than inferred, because a type of
// 'secret' would leak into the schema and the schema is what the UI renders.
//
// A secret's value is encrypted before it is written (see services/secrets) and is
// never returned by the catalogue. A blank write leaves the stored value alone, and
// clearing one is an explicit request, so a dashboard that renders an empty secret
// field cannot wipe a credential by accident.
//
// A secret is still declared in SCHEMA. That is what gives it a label, a category and
// an environment variable, so an install configured through .env keeps working and the
// dashboard has something to render. The entry is read as a marker: its `value` is
// never the credential.
const SECRETS = new Set([
  'mail.smtpPassword',
  'mail.apiKey',
  'storage.s3SecretKey',
  'voice.sfuAppSecret',
  'voice.turnCredential',
  'voice.mesh.turnCredential',
  'voice.cloudflare.appSecret',
  'voice.sfu.token',
  'voice.sfu.turnCredential',
]);

// Settings that cannot be changed from the dashboard at all, with the reason. Listed
// rather than hidden, so an administrator knows what they are and why.
// Settings an administrator cannot change from here at all.
//
// Empty, and meant to stay that way. It held a database connection, a listening
// port, a bind address and a mount prefix, which told an operator to edit a
// deployment file to move a port - on a page whose whole purpose is to be where
// deployment settings are changed. The database has its own page now, and the
// rest are settings like any other, distinguished only by being read once, so
// they carry a restart notice instead of a refusal.
//
// The shape stays: the settings API returns this list and the interface renders
// it as a read-only section, so a future entry has somewhere to go.
//
// The dashboard's mode is here, and here rather than among the ordinary
// settings, for a reason that is not tidiness. The separate dashboard service
// has no database of its own - it is a presentation surface for the main
// instance - so it cannot read a value saved here. If an administrator could
// save "separate" in the console while the process kept running "bundled",
// the console would report a mode that is not in force, and the two processes
// would disagree about which deployment they are part of. The environment is
// the authority for this one, and the console shows the deployment's choice
// rather than offering a different one.
const DEPLOYMENT_ONLY = ['dashboard.mode'];

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]));

// A secret is declared in SCHEMA so it has a label, a category and an environment
// variable, which is what lets an install configured through .env keep working and
// gives the dashboard something to render. Its entry is read as a marker: the value
// it carries is never the credential.
//
// This runs after BY_KEY exists, so each addition is registered as it is made.
const SECRET_META = {
  'mail.smtpPassword': {
    env: 'SMTP_PASSWORD',
    label: 'SMTP password',
    category: 'mail',
    description: 'The relay password or API key. Stored encrypted and never shown again.',
  },
  'mail.apiKey': {
    env: 'MAIL_API_KEY',
    label: 'API key',
    category: 'mail',
    description: 'The credential for the mail API. Stored encrypted and never shown again.',
  },
  'storage.s3SecretKey': {
    env: 'S3_SECRET_ACCESS_KEY',
    label: 'S3 secret key',
    category: 'storage',
    description: 'The secret half of the S3 credential. Stored encrypted and never shown again.',
  },
  'voice.sfuAppSecret': {
    env: 'VOICE_VIDEO_SFU_APP_SECRET',
    label: 'Media server app secret (superseded)',
    category: 'voice-legacy',
    description: 'Replaced by the Cloudflare application secret. Stored encrypted and never shown again.',
  },
  'voice.turnCredential': {
    env: 'VOICE_VIDEO_TURN_CREDENTIAL',
    label: 'TURN credential (superseded)',
    category: 'voice-legacy',
    description: 'Replaced by the mesh\'s own TURN credential. Stored encrypted and never shown again.',
  },
  'voice.mesh.turnCredential': {
    env: 'VOICE_VIDEO_MESH_TURN_CREDENTIAL',
    label: 'TURN credential for the mesh',
    category: 'voice-media',
    description: 'The password half of a static TURN credential. Leave blank to use the short-lived credential this instance mints. Stored encrypted and never shown again.',
  },
  'voice.cloudflare.appSecret': {
    env: 'VOICE_VIDEO_CLOUDFLARE_APP_SECRET',
    label: 'Cloudflare application secret',
    category: 'voice-media',
    description: 'Issued with the application id and used to create media sessions. Stored encrypted and never shown again.',
  },
  'voice.sfu.token': {
    env: 'VOICE_VIDEO_SFU_TOKEN',
    label: 'Third-party SFU token',
    category: 'voice-media',
    description: 'The bearer token the media server expects. Stored encrypted and never shown again.',
  },
  'voice.sfu.turnCredential': {
    env: 'VOICE_VIDEO_SFU_TURN_CREDENTIAL',
    label: 'TURN credential for the third-party SFU',
    category: 'voice-media',
    description: 'The password half of a static TURN credential. Stored encrypted and never shown again.',
  },
};

for (const key of SECRETS) {
  if (BY_KEY.has(key)) continue;
  const meta = SECRET_META[key];
  if (!meta) throw new Error('a secret was declared with no metadata: ' + key);
  const entry = {
    key,
    env: meta.env,
    type: 'secret',
    default: '',
    category: meta.category,
    label: meta.label,
    description: meta.description,
    live: true,
  };
  SCHEMA.push(entry);
  BY_KEY.set(key, entry);
}

const CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'registration', label: 'Registration and onboarding' },
  { id: 'security', label: 'Authentication and security' },
  { id: 'content', label: 'Content and communities' },
  { id: 'messaging', label: 'Messaging and realtime' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'voice', label: 'Voice and video' },
  { id: 'mail', label: 'Email' },
  { id: 'storage', label: 'Storage' },
  { id: 'search', label: 'Search' },
  { id: 'localisation', label: 'Localisation' },
  { id: 'themes', label: 'Themes' },
  { id: 'incidents', label: 'Incidents and status' },
  { id: 'features', label: 'Feature availability' },
  { id: 'continuum', label: 'Federation' },
  { id: 'limits', label: 'Limits and performance' },
  { id: 'retention', label: 'Retention and cleanup' },
  { id: 'deployment', label: 'Server and deployment' },
];

// The voice settings that are not published here.
//
// 'voice-media' holds the settings each media provider owns, and 'voice-legacy'
// holds the settings the grouped ones replaced. Neither category is listed
// above, so neither appears in this catalogue: the Voice and video console
// renders the providers one at a time, and the older keys are read as a
// fallback rather than shown as a second field for the same value. The keys
// are still real settings - they are saved, validated and read like any other.

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
  // A saved value that a deployment variable also sets. The seed is remembered so the
  // field can say an environment default exists behind the saved override, but it is
  // never applied: an application setting belongs to the application once it is saved.
  seeded: {},
  // Settings the application reads once at boot. A value saved for one of these is
  // stored at once and in force only after the next start, so it is held here until
  // then rather than reported as live.
  pendingRestart: new Set(),
  lastSavedAt: null,
  loaded: false,
};

function parse(raw, type, def, keepWhitespace) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, value: def };
  }
  const text = keepWhitespace ? String(raw) : String(raw).trim();
  if (type === 'boolean') {
    if (['1', 'true', 'on', 'yes'].includes(text.toLowerCase())) return { ok: true, value: true };
    if (['0', 'false', 'off', 'no'].includes(text.toLowerCase())) return { ok: true, value: false };
    return { ok: false, error: 'Must be on or off' };
  }
  if (type === 'integer') {
    const n = Number(text);
    if (!Number.isInteger(n)) return { ok: false, error: 'Must be a whole number' };
    return { ok: true, value: n };
  }
  if (type === 'url') {
    try {
      const u = new URL(text);
      if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Must be an http(s) URL' };
      // The path is kept, without its trailing slash, because an instance can be
      // served from a subdirectory. Dropping it is what this used to do, which
      // disagreed with features.js and quietly broke every emailed link on such
      // an instance.
      const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
      return { ok: true, value: u.origin + path };
    } catch { return { ok: false, error: 'Must be a valid URL' }; }
  }
  if (type === 'list') {
    return { ok: true, value: text.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  return { ok: true, value: text };
}

function validate(entry, raw) {
  // A setting declared trim:false keeps its surrounding whitespace. The auth prefix
  // is the reason: "Bearer" and "Bearer " are different header values, and trimming
  // turned the default into a header of "Bearer" glued to the key.
  const parsed = parse(raw, entry.type, entry.default, entry.trim === false);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const value = parsed.value;

  if (entry.type === 'integer') {
    if (entry.min != null && value < entry.min) return { ok: false, error: 'Must be at least ' + entry.min };
    if (entry.max != null && value > entry.max) return { ok: false, error: 'Must be at most ' + entry.max };
  }
  // A closed set of answers. `allowed` is also what the form renders as a dropdown,
  // so a value outside it can only come from a hand-written request.
  if (entry.allowed && !entry.allowed.includes(value)) {
    return { ok: false, error: 'Must be one of: ' + entry.allowed.filter((v) => v !== '').join(', ') };
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
  store.seeded = {};
  store.loaded = false;
  const rows = await db.all('SELECT `key`, value FROM instance_settings');
  const saved = new Map(rows.map((r) => [r.key, r.value]));

  for (const key of Object.keys(secretValues)) delete secretValues[key];
  for (const key of SECRETS) {
    // A secret set through the environment never touches this table, so a stored row
    // can only exist because an administrator wrote one.
    if (saved.has(key)) secretValues[key] = saved.get(key);
  }

  for (const entry of SCHEMA) {
    // A secret's value never becomes an effective value: an environment secret is read
    // on demand by the service that needs it, and a stored one stays ciphertext until
    // then. Only the source is recorded, which is what the dashboard shows beside the
    // field. A deployment-set secret is the deployment's to rotate and stays locked; a
    // stored one belongs to the instance.
    if (SECRETS.has(entry.key)) {
      const fromEnv = envValueOf(entry);
      if (fromEnv !== undefined) {
        store.values[entry.key] = '';
        store.sources[entry.key] = 'environment';
      } else {
        store.raw[entry.key] = saved.get(entry.key);
        store.values[entry.key] = '';
        store.sources[entry.key] = saved.has(entry.key) ? 'instance' : 'default';
      }
      continue;
    }

    // An application setting: the administrator's saved value is the one in force.
    //
    // The deployment environment seeds a setting that has never been saved, and that is
    // all it does. Once a value is saved here the environment stops overriding it, so a
    // restart cannot quietly undo a change made in the dashboard - which is the whole
    // point of a control plane. A value the deployment must force belongs in the
    // deployment-managed list instead, where the interface says why.
    const fromDb = saved.get(entry.key);
    const fromEnv = envValueOf(entry);

    if (fromDb !== undefined) {
      store.raw[entry.key] = fromDb;
      const check = validate(entry, fromDb);
      if (check.ok) {
        store.values[entry.key] = check.value;
        store.sources[entry.key] = 'instance';
        // The seed is remembered, not applied, so the field can show that a deployment
        // default exists behind the saved value.
        if (fromEnv !== undefined) store.seeded[entry.key] = fromEnv;
        continue;
      }
      // A stored value that no longer validates - a bound was tightened, a type changed -
      // is reported rather than silently honoured or silently dropped.
      store.values[entry.key] = entry.default;
      store.sources[entry.key] = 'default (stored value was invalid)';
      continue;
    }

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

    store.values[entry.key] = entry.default;
    store.sources[entry.key] = 'default';
  }

  store.loaded = true;
  return store;
}

// The effective value. Throws if the store is not loaded, so a caller cannot read a
// default and believe it is what the instance is configured with.
//
// Refuses a secret outright. The one caller that legitimately needs a credential
// asks for it through secretValue(), which makes the privileged read visible in the
// code rather than available to anything that can name a key.
function get(key) {
  const entry = BY_KEY.get(key);
  if (!entry) throw new Error('unknown setting ' + key);
  if (SECRETS.has(key)) throw new Error(key + ' is a secret; read it through secretValue');
  if (!store.loaded) throw new Error('the settings store is not loaded');
  return store.values[key];
}

function source(key) {
  return store.sources[key] || 'default';
}

// Whether the store has been read yet.//
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
async function save(entries, adminId, options) {
  await load();
  const before = {};
  const problems = [];
  const writes = [];

  // Which console is writing.
  //
  // The console that owns a setting is where it is changed. A write that
  // arrives from anywhere else is refused, and the refusal says where it
  // belongs, so a second editor cannot become a second answer.
  //
  // When an owner is named, only the settings that owner owns are accepted:
  // the voice console is not a second place to change the instance name.
  const writer = options && options.owner ? String(options.owner) : null;

  // The cross-setting rules resolve before anything is written, because a rule that is
  // checked while writing would leave the earlier keys applied and the later ones not.
  const screenSharing = entries['voice.screenSharing'];
  const voiceEnabled = store.values['voice.enabled'];

  // The provider a save would leave in force. A save may be changing it, so
  // the pending value is read before the stored one.
  const providerAfter = () => {
    const pending = entries['voice.provider'];
    const chosen = pending === undefined ? store.values['voice.provider'] : pending;
    const id = String(chosen || 'mesh').trim().toLowerCase();
    return ['mesh', 'cloudflare', 'sfu'].indexOf(id) === -1 ? 'mesh' : id;
  };

  for (const [key, raw] of Object.entries(entries)) {
    const entry = BY_KEY.get(key);
    if (!entry) { problems.push(key + ': unknown setting'); continue; }

    // A setting another interface owns is not written from here.
    //
    // The voice console is where the voice settings are changed, because
    // that is where a person goes to make sense of them. A write that
    // arrives here for one of them is refused, and the refusal says where it
    // belongs - so a second editor cannot become a second answer.
    //
    // The general route accepts every setting, including the voice ones.
    // That is not a second editor: the value is one row, and the console
    // that *offers* the control is the voice console - the general page
    // shows the voice settings read-only and says where they are changed.
    //
    // The general route cannot narrow what it accepts, because it is an
    // existing public API: a client written before the consolidation - an
    // older bundle still in a browser's cache, the native app - writes the
    // voice settings here, and refusing them broke the voice console for
    // every one of those clients at once. A new route may be narrow; an
    // old one may not become narrow.
    const owner = canonicalInterface(key);
    if (writer && owner !== writer) {
      problems.push(key + ': not changed in ' + CANONICAL_INTERFACES[writer].label);
      continue;
    }

    // A secret is stored encrypted and is never read back into the value map. An
    // empty write means "leave it alone", because the dashboard renders these as an
    // empty field and a save that wiped the credential would break delivery for
    // every setting on the same screen. Clearing one is explicit.
    if (SECRETS.has(key)) {
      if (store.sources[key] === 'environment') {
        problems.push(key + ': set by the deployment environment and cannot be changed here');
        continue;
      }
      if (raw === null || raw === undefined) {
        // Clearing the credential the provider in force depends on would leave a live
        // capability with no way to create a session. Refused here, so the fix is to turn
        // voice off first rather than to discover it at the next join. The credential of
        // a provider that is not in force can be cleared: nothing depends on it now.
        const voiceConfig = require('./voice/config');
        if (store.values['voice.enabled'] === true
          && voiceConfig.isRequiredSecret(providerAfter(), key)) {
          problems.push(key + ': cannot be cleared while voice and video is on');
          continue;
        }
        writes.push({ key, value: null, seen: store.raw[key], clear: true });
        before[key] = secretValues[key] ? '(set)' : '(unset)';
        continue;
      }
      const text = String(raw);
      if (!text.trim()) continue;
      if (text.length > 4096) { problems.push(key + ': that value is too long to be a credential'); continue; }
      writes.push({ key, value: secrets.encrypt('mail:' + key, text.trim()), seen: store.raw[key], secret: true });
      before[key] = secretValues[key] ? '(set)' : '(unset)';
      continue;
    }

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

  // Turning voice on needs the infrastructure it will use. The check runs after the batch
  // is validated so a single save can set the switch and the credentials together, and it
  // reads the pending values first, falling back to what is already stored. Without it a
  // save would report success, the dashboard would show a green tick, and the first join
  // would be the first sign that nothing worked.
  const pending = (key) => writes.find((w) => w.key === key);
  const after = (key) => {
    const w = pending(key);
    return w ? w.value : store.values[key];
  };
  const voiceOnAfter = after('voice.enabled') === true;
  const voiceWasOn = store.values['voice.enabled'] === true;
  const voiceProviderAfter = String(after('voice.provider') || 'mesh');
  if (voiceOnAfter && !voiceWasOn) {
    // Turning voice on needs the infrastructure the provider in force will use.
    // The check runs after the batch is validated so a single save can set the
    // switch and the credentials together, and it reads the pending values first,
    // falling back to what is already stored. Without it a save would report
    // success, the dashboard would show a green tick, and the first join would be
    // the first sign that nothing worked.
    //
    // The requirements are the provider's own: a mesh needs no SFU credential,
    // and the Cloudflare path needs an application id and a secret.
    //
    // A provider that is changed while voice is already on is not held to the
    // same rule: the operator may be moving to a path they are about to
    // configure, and a call that starts on a provider that is not ready is
    // refused at the session with a list of what is missing.
    const overlay = {};
    for (const w of writes) overlay[w.key] = w.value;
    const voiceConfig = require('./voice/config');
    for (const problem of voiceConfig.missing(voiceProviderAfter, overlay)) {
      problems.push(problem + ' (required when voice and video is on with the '
        + voiceProviderAfter + ' provider)');
    }
    if (problems.length) return { ok: false, problems };
  }

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
      // Clearing a secret deletes the row rather than storing an empty string, so
      // "unset" and "set to nothing" cannot mean two different things later.
      if (w.clear) {
        await t.run('DELETE FROM instance_settings WHERE `key` = ?', [w.key]);
        continue;
      }
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
      throw { code: 'CONFLICT', message: 'Changed by someone else: ' + conflicts.join(', ') };
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

  // The mail service caches the decrypted provider credentials, so it has to be told.
  // A changed mode or a rotated key would otherwise keep being read from the values
  // that were in force a moment ago.
  try { require('./mail').invalidate(); } catch { /* the mail service is optional at boot */ }

  // What the voice providers answered about themselves is no longer true: a
  // changed endpoint or a rotated credential changes what a check would find.
  try { require('./voice/diagnostics').invalidate(); } catch { /* the voice service is optional at boot */ }

  notePending(writes);
  return { ok: true, changed: Object.keys(before), pendingRestart: Array.from(store.pendingRestart) };
}

// What a save actually did to the running process.
//
// A setting the application reads once at boot is stored but not in force, so it is
// held as pending rather than reported as live. The administrator is told exactly that
// rather than shown a green tick over a change nothing has picked up.
function notePending(writes) {
  for (const w of writes) {
    const entry = BY_KEY.get(w.key);
    if (entry && !entry.live) store.pendingRestart.add(w.key);
  }
  store.lastSavedAt = now();
}

// Whether the application is waiting on a restart to pick up stored configuration.
function status() {
  return {
    loaded: store.loaded,
    pendingRestart: Array.from(store.pendingRestart),
    lastSavedAt: store.lastSavedAt,
  };
}

// Reset one setting to whatever the deployment and the schema say without a saved
// value: the environment seed if one exists, otherwise the schema default. Deleting the
// row is what does it, so an absent override and an override equal to the default stay
// distinguishable afterwards.
//
// A secret the deployment owns cannot be reset here - there is nothing of the instance's
// to remove - and that is the only case that refuses.
async function reset(key, adminId, options) {
  await load();
  const entry = BY_KEY.get(key);
  if (!entry) { const e = new Error('unknown setting ' + key); e.code = 'NOT_FOUND'; throw e; }
  if (SECRETS.has(key) && store.sources[key] === 'environment') {
    const e = new Error('that secret is set by the deployment environment and cannot be reset here');
    e.code = 'LOCKED';
    throw e;
  }

  // A setting another console owns is not reset from here either: a reset is
  // a change, and it is changed where it is changed.
  //
  // The general route is the exception, for the same reason it accepts a
  // write for every setting: it is an existing public API, and narrowing it
  // breaks the clients that were written against it.
  const writer = options && options.owner ? String(options.owner) : null;
  const owner = canonicalInterface(key);
  if (writer && owner !== writer) {
    const e = new Error(key + ': not changed in ' + CANONICAL_INTERFACES[writer].label);
    e.code = 'LOCKED';
    throw e;
  }

  await db.transaction(async (t) => {
    await t.run('DELETE FROM instance_settings WHERE `key` = ?', [key]);
    await t.run(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
       VALUES (?, ?, 'reset_setting', 'instance', ?, NULL, ?)`,
      [uuid(), adminId, key, now()]
    );
  });

  // A boot-time setting still needs a restart to actually go back, exactly as saving one
  // does; recording it keeps the pending badge honest in both directions.
  if (!entry.live) store.pendingRestart.add(key);
  await load(true);
  try { require('../features').reload(); } catch { /* refused by reload, which is correct */ }
  try { require('./mail').invalidate(); } catch { /* the mail service is optional at boot */ }
  try { require('./voice/diagnostics').invalidate(); } catch { /* the voice service is optional at boot */ }
  return { ok: true, key, source: store.sources[key] };
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
//
// A secret is reported as set or unset and carries no value field at all, so there is
// nothing for a client to display even if one tried. Whether the stored value can still
// be decrypted is reported separately: an instance whose JWT_SECRET was rotated has
// secrets it can no longer read, and that has to be visible rather than showing up as
// an unexplained delivery failure.
// One setting, as the console that shows it needs it: the value, where it
// came from, whether it is locked, and which console owns it.
//
// The general catalogue and the voice console show the same setting in the
// same words, so the shape is written once here.
function describeSetting(s, state) {
  {
    const base = {
        key: s.key,
        env: s.env || null,
        label: s.label,
        description: s.description,
        type: s.type,
        value: store.values[s.key],
        defaultValue: s.default,
        min: s.min != null ? s.min : null,
        max: s.max != null ? s.max : null,
        source: store.sources[s.key],
        live: !!s.live,
        allowed: s.allowed || null,
        restartRequired: !s.live,
        pendingRestart: store.pendingRestart.has(s.key),
        consequential: !!s.consequential,
        showIf: s.showIf || null,
        // A deployment variable that seeds a setting an administrator has since saved.
        // The saved value is in force; this names the seed so the field can say one
        // exists without implying it still decides anything.
        seededFrom: store.seeded[s.key] !== undefined ? s.env : null,
        // An application setting is editable whatever seeded it. Only a secret the
        // deployment owns, and the deployment-managed list, are read-only here.
        locked: false,
        lockedReason: null,
        // The interface that owns this setting. When it is not this page, the
        // page shows the value in force and a link to where it is changed, and
        // a write from here is refused.
        canonical: canonicalInterface(s.key),
        canonicalLabel: canonicalInterface(s.key)
          ? CANONICAL_INTERFACES[canonicalInterface(s.key)].label
          : null,
        canonicalRoute: canonicalInterface(s.key)
          ? CANONICAL_INTERFACES[canonicalInterface(s.key)].route
          : null,
      };
    if (!SECRETS.has(s.key)) return base;
    const stored = state[s.key];
    return {
      key: s.key,
      env: s.env || null,
      label: s.label,
      description: s.description,
      type: 'secret',
      set: !!stored,
      readable: stored ? secrets.readable('mail:' + s.key, stored) : null,
      source: store.sources[s.key],
      live: !!s.live,
      restartRequired: !s.live,
      pendingRestart: store.pendingRestart.has(s.key),
      consequential: !!s.consequential,
      showIf: s.showIf || null,
      locked: store.sources[s.key] === 'environment',
      lockedReason: store.sources[s.key] === 'environment'
        ? 'Set by the deployment environment (' + s.env + '). Rotate it there.'
        : null,
    };
  }
}

// The catalogue the Configuration page renders: the categories it publishes,
// in order.
function catalogue(secretState) {
  const state = secretState || secretValues;
  return CATEGORIES.map((cat) => ({
    id: cat.id,
    label: cat.label,
    settings: SCHEMA.filter((s) => s.category === cat.id).map((s) => describeSetting(s, state)),
  })).filter((c) => c.settings.length);
}

// The settings one console owns, whatever category they are in.
//
// The general catalogue publishes the categories the Configuration page
// shows. The voice console owns settings that are deliberately not published
// there - the provider's own fields, and the older keys they replaced - so
// it asks for its settings by key rather than by category. Without this the
// provider settings were in no catalogue at all, and a console that asked
// for them by category never saw them.
function ownedSettings(owner, secretState) {
  const state = secretState || secretValues;
  return SCHEMA
    .filter((s) => canonicalInterface(s.key) === owner)
    .map((s) => describeSetting(s, state));
}

// The stored, still-encrypted value of a secret, or null. This is the only way a
// caller gets at one, and what comes back is ciphertext: a provider asks the mail
// service for the decrypted value, and the mail service is the only thing that
// decrypts.
function secretStored(key) {
  return secretValues[key] || null;
}

// The usable value of a secret, following the same precedence as everything else:
// the environment wins, then the stored row, then nothing.
//
// An environment value is already plaintext because it was read from the process,
// so it is returned as it is; a stored row is decrypted. A row that cannot be
// decrypted (the instance's JWT_SECRET was rotated) is reported as absent, because
// returning a partial credential would be worse than saying there is none.
function secretValue(key) {
  const entry = BY_KEY.get(key);
  if (!entry) throw new Error('unknown setting ' + key);
  if (!SECRETS.has(key)) return store.loaded ? store.values[key] : undefined;

  const fromEnv = envValueOf(entry);
  if (fromEnv !== undefined) return fromEnv;

  const stored = secretValues[key];
  if (!stored) return null;
  try {
    return secrets.decrypt('mail:' + key, stored);
  } catch {
    return null;
  }
}

// Read a setting for a caller that may run before the store has loaded, with the
// value to use when it has not.
//
// Five call sites needed `isLoaded() ? get(key) : fallback`, and two of them
// required this module from inside a function to break a require cycle with
// util.js, which is how the cycle existed at all: the lowest-level module in the
// tree was reaching up into the configuration store to sign a token. The
// fallback moves here, so the cycle has nothing left to require.
//
// A caller that cannot proceed without a real value should use get() and let it
// throw. This is for the ones that genuinely have a sane answer before boot.
function read(key, fallback) {
  if (!store.loaded) return fallback;
  const value = store.values[key];
  return value === undefined ? fallback : value;
}

module.exports = {
  canonicalInterface,
  CANONICAL_INTERFACES,
  VOICE_OWNED,
  SCHEMA, CATEGORIES, SECRETS, DEPLOYMENT_ONLY, ownedSettings,
  load, get, read, source, save, reset, catalogue, validate, serialise, isLoaded, status,
  secretStored, secretValue,
};
