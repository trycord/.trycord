// The provider registry.
//
// The administration console's Configuration menu is the one place an operator
// chooses how a subsystem works, and this module is what it renders from.
// A subsystem's providers are described here, once: what they are called, what
// they can do, which settings they read, which secrets they need, how they
// are validated, and how their health is checked.
//
// The reason for one registry is drift. Four subsystems each carried their own
// idea of what a provider is - the storage drivers knew their names, the mail
// registry knew its modes, the search and notification settings knew a string -
// and the console had to be told about each of them separately. A provider that
// the console could select but the service would refuse, or a service that
// could be configured through a setting the console did not show, is the
// failure this prevents.
//
// The states are the point of the whole thing:
//
//   disabled     the subsystem is switched off, deliberately
//   configured   the settings are filled in, but the subsystem is not running
//   active       it is running and healthy
//   degraded     it is running, and something is wrong
//   failed       it could not start, and the reason is reported
//
// "Configured" and "active" are different states because an operator has to
// be able to see that a value was saved and that it is not in force yet -
// because the change needs a restart, or because the provider has not been
// started yet. A console that shows a saved value as if it were running is
// telling a lie about the instance.
//
// The descriptions here are **descriptions**. The behaviour belongs to the
// service: this module asks the storage driver whether it is usable, and the
// mail registry whether its mode validates. Nothing here reimplements a
// provider, and nothing here is the only place a provider is defined.
//
// Every setting key named below is a real key in the settings catalogue. A key
// that does not exist would be a description of a control that is not there,
// which is the drift this module exists to prevent.

'use strict';

const settings = require('../settings');

// A subsystem and the providers it can use.
//
//   id          the subsystem's stable identifier
//   label       what the console shows
//   summary     one line on what this subsystem does
//   setting     the setting that names the active provider, or null
//   current     reads the active provider, when the setting is not the source
//   enabled     reads whether the subsystem is switched on at all
//   providers   the providers, in the order the console lists them
//
// A provider:
//
//   id          the string that appears in stored configuration
//   label       what the console shows
//   summary     one line on what configuring it involves
//   settings    the setting keys it reads
//   secrets     the secret keys it needs, which are never returned
//   validate    (config) -> { ok, problems[] }, never touches the network
//   check       (config) -> { ok, detail }, where the network is touched
const SUBSYSTEMS = [
  {
    id: 'storage',
    label: 'File storage',
    summary: 'Where attachments, avatars and community images are kept.',
    setting: 'storage.provider',
    enabled: () => true,
    providers: [
      {
        id: 'local',
        label: 'Local disk',
        summary: 'Files on this machine, under the uploads directory. No other service is needed.',
        settings: ['storage.quotaMb'],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({ ok: true, detail: 'Files are written to the local uploads directory.' }),
      },
      {
        id: 's3',
        label: 'S3-compatible object storage',
        summary: 'Any S3-compatible bucket: Amazon S3, Cloudflare R2, MinIO, Backblaze B2, SeaweedFS.',
        settings: [
          'storage.s3Endpoint', 'storage.s3Region', 'storage.s3Bucket', 'storage.s3ForcePathStyle',
        ],
        secrets: ['storage.s3AccessKeyId', 'storage.s3SecretKey'],
        validate: (config) => {
          const problems = [];
          if (!config.s3Endpoint) problems.push('An endpoint is required.');
          if (!config.s3Bucket) problems.push('A bucket is required.');
          if (!config.s3AccessKeyId) problems.push('An access key id is required.');
          if (!config.s3SecretAccessKey) problems.push('A secret access key is required.');
          return { ok: !problems.length, problems };
        },
        check: (config) => {
          if (!config.s3Endpoint || !config.s3Bucket) {
            return { ok: false, detail: 'The endpoint or the bucket is not set.' };
          }
          return {
            ok: true,
            detail: 'The endpoint and the bucket are set. A live round trip is not attempted from here.',
          };
        },
      },
    ],
  },
  {
    id: 'mail',
    label: 'Mail delivery',
    summary: 'How password resets, verification and notifications are delivered.',
    setting: 'mail.mode',
    enabled: () => true,
    // The mail registry is the authority. Its catalogue names the modes and
    // the settings each one reads, so this entry does not restate them.
    providers: () => require('../mail/registry').catalogue().map((m) => Object.assign({}, m, {
      id: m.mode,
      validate: (config) => {
        const problems = [];
        for (const key of keyList(m.secrets)) {
          if (!config[lastPart(key)]) problems.push('A secret is required.');
        }
        return { ok: !problems.length, problems };
      },
      check: (config) => ({
        ok: true,
        detail: m.id === 'disabled'
          ? 'Mail delivery is switched off. Password recovery and verification are unavailable.'
          : 'The mode is configured. A real delivery is only attempted from the mail console.',
      }),
    })),
  },
  {
    id: 'search',
    label: 'Search',
    summary: 'How a reader finds messages.',
    setting: 'search.provider',
    enabled: () => true,
    providers: [
      {
        id: 'in-house',
        label: 'In-house index',
        summary: 'A word-per-message index in this instance\'s own database. No other service is needed.',
        settings: ['search.historyLimit'],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({ ok: true, detail: 'The index is in this instance\'s database.' }),
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    summary: 'How a reader is told about something.',
    setting: 'notifications.provider',
    enabled: () => true,
    providers: [
      {
        id: 'in-house',
        label: 'In-house',
        summary: 'Notifications are stored in this instance and delivered over the realtime gateway.',
        settings: ['retention.notificationsDays'],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({ ok: true, detail: 'Notifications are delivered by this instance.' }),
      },
    ],
  },
  {
    id: 'voice',
    label: 'Voice and video',
    summary: 'How a call is carried.',
    setting: 'voice.provider',
    enabled: () => settings.read('voice.enabled', false),
    providers: [
      {
        id: 'mesh',
        label: 'In-house mesh',
        summary: 'The media travels between the participants. Good for a small room.',
        settings: [
          'voice.maxParticipants', 'voice.screenSharing', 'voice.stageChannels',
          'voice.stunUrls', 'voice.turnUrl', 'voice.turnUsername', 'voice.turnCredential',
        ],
        secrets: ['voice.turnCredential'],
        validate: (config) => {
          const problems = [];
          if (!config.turnUrl && !config.stunUrls) {
            problems.push('A STUN or a TURN address is needed for a call to connect.');
          }
          return { ok: !problems.length, problems };
        },
        check: () => ({ ok: true, detail: 'The mesh relays between the participants.' }),
      },
    ],
  },
  {
    id: 'turn',
    label: 'STUN and TURN',
    summary: 'How a client reaches a peer it cannot reach directly.',
    setting: null,
    enabled: () => true,
    providers: [
      {
        id: 'in-house',
        label: 'In-house',
        summary: 'A STUN and TURN server run by this instance. Its secret comes from the environment, and it is not a setting an administrator saves.',
        settings: [],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({
          ok: true,
          detail: 'The TURN service reads its configuration from the environment when it starts.',
        }),
      },
    ],
  },
  {
    id: 'push',
    label: 'Push notifications',
    summary: 'How a device is reached while the application is closed.',
    setting: null,
    enabled: () => settings.read('features.push', false),
    providers: [
      {
        id: 'registry',
        label: 'Device registry',
        summary: 'The devices this instance may reach. The transport that reaches them is the operator\'s to provide.',
        settings: [],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({
          ok: true,
          detail: 'The registry is in this instance\'s database. No delivery transport is configured.',
        }),
      },
    ],
  },
  {
    id: 'extensions',
    label: 'Extension registry',
    summary: 'Where extensions are listed.',
    setting: null,
    // The extension policy is its own row, not a setting: it carries an
    // allowlist and a signature rule as well as the mode, so it does not fit
    // the key-and-value shape the settings store holds.
    current: async () => {
      try {
        const policy = await require('../extensions').policy();
        return policy && policy.registryMode ? policy.registryMode : 'builtin';
      } catch {
        // The extensions service is not part of this build, or the policy row
        // has never been written. The shipped default is the one the
        // extensions service itself uses.
        return 'builtin';
      }
    },
    enabled: () => true,
    providers: [
      {
        id: 'builtin',
        label: 'The packages that ship with the instance',
        summary: 'The first-party packages, with no network at all.',
        settings: [],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({ ok: true, detail: 'The shipped packages are available.' }),
      },
      {
        id: 'mirror',
        label: 'A mirror',
        summary: 'A directory the operator runs. The instance reaches it server-side.',
        settings: [],
        secrets: [],
        validate: (config) => {
          const problems = [];
          if (!config.registryUrl) problems.push('A registry address is required.');
          return { ok: !problems.length, problems };
        },
        check: (config) => ({
          ok: !!config.registryUrl,
          detail: config.registryUrl
            ? 'A registry address is set. The instance reaches it server-side.'
            : 'No registry address is set.',
        }),
      },
      {
        id: 'disabled',
        label: 'No registry',
        summary: 'Nothing is listed and nothing is fetched. The instance does not depend on one.',
        settings: [],
        secrets: [],
        validate: () => ({ ok: true, problems: [] }),
        check: () => ({ ok: true, detail: 'No registry is configured, and none is needed.' }),
      },
    ],
  },
];

/**
 * The setting keys a provider names.
 *
 * A provider may name a key as a plain string or as an object carrying a key
 * and a label - the mail providers use the second shape, because their console
 * fields are labelled. Both are read here, so the registry does not care which
 * a provider chose, and every key it reports is a string.
 */
function keyList(list) {
  return (list || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.key))
    .filter(Boolean);
}

function providersOf(subsystem) {
  const list = typeof subsystem.providers === 'function' ? subsystem.providers() : subsystem.providers;
  return list || [];
}

function findSubsystem(id) {
  return SUBSYSTEMS.find((s) => s.id === id) || null;
}

function currentOf(subsystem) {
  if (typeof subsystem.current === 'function') return subsystem.current();
  if (!subsystem.setting) return null;
  return settings.read(subsystem.setting, null);
}

/**
 * The whole catalogue, with each provider's current state.
 *
 * This is what the console renders. Every provider of every subsystem is
 * listed, whether or not it is in force, so an operator can see what else
 * exists — and a provider that is not listed cannot be selected, because
 * nothing would accept the value.
 *
 * It is asynchronous because one subsystem's configuration lives in a table
 * rather than in the settings store: the extension policy carries an
 * allowlist and a signature rule as well as the registry mode, so it does not
 * fit the key-and-value shape. Reading it is a query, and the catalogue
 * waits for it rather than guessing the default and reporting a provider that
 * is not in force as the one that is.
 */
async function catalogue() {
  const out = [];
  for (const subsystem of SUBSYSTEMS) {
    const providers = providersOf(subsystem);
    const current = await currentOf(subsystem);
    const enabled = subsystem.enabled ? !!subsystem.enabled() : true;
    out.push({
      id: subsystem.id,
      label: subsystem.label,
      summary: subsystem.summary,
      setting: subsystem.setting,
      enabled,
      current: current || null,
      providers: providers.map((provider) => {
        const config = configFor(provider);
        let validation = { ok: true, problems: [] };
        try {
          validation = provider.validate(config) || validation;
        } catch (e) {
          validation = { ok: false, problems: [e && e.message ? e.message : 'The provider could not be checked.'] };
        }
        let state;
        if (!enabled) {
          state = 'disabled';
        } else if (current && current !== provider.id) {
          state = 'configured';
        } else if (!validation.ok) {
          state = 'failed';
        } else {
          state = 'active';
        }
        return {
          id: provider.id,
          label: provider.label,
          summary: provider.summary,
          settings: keyList(provider.settings),
          secrets: keyList(provider.secrets),
          state,
          problems: validation.problems || [],
          configured: validation.ok,
          // A subsystem with no setting and one provider - the TURN server,
          // the push registry - has that provider in force. "In force" without
          // a setting to name it would otherwise be true of nothing, and the
          // console would show a provider that is running as one that is not.
          inForce: current ? current === provider.id : providers.length === 1,
        };
      }),
    });
  }
  return out;
}

/**
 * The configuration a provider is given to validate against.
 *
 * It is the provider's own settings and secrets, read from the settings
 * store, with the secrets **masked**: a validator needs to know whether a
 * secret is set, not what it is.
 */
function configFor(provider, extra) {
  const config = Object.assign({}, extra || {});
  for (const key of keyList(provider.settings)) {
    config[lastPart(key)] = settings.read(key, null);
  }
  for (const key of keyList(provider.secrets)) {
    const value = settings.read(key, null);
    config[lastPart(key)] = value ? 'set' : null;
  }
  return config;
}

function lastPart(key) {
  const parts = String(key || '').split('.');
  return parts[parts.length - 1];
}


/**
 * One provider's health, checked for real.
 *
 * The check is the provider's own: it is the only thing that knows what
 * "working" means for it. A provider with no check is reported as unknown
 * rather than as healthy, because a green light nobody verified is worse than
 * no light.
 */
async function check(subsystemId, providerId) {
  const subsystem = findSubsystem(subsystemId);
  if (!subsystem) return { ok: false, detail: 'No such subsystem.' };
  const provider = providersOf(subsystem).find((p) => p.id === providerId);
  if (!provider) return { ok: false, detail: 'No such provider.' };
  if (typeof provider.check !== 'function') {
    return { ok: false, detail: 'This provider does not offer a check.' };
  }
  try {
    const out = await provider.check(configFor(provider));
    return out || { ok: false, detail: 'The check returned nothing.' };
  } catch (e) {
    return { ok: false, detail: e && e.message ? e.message : 'The check failed.' };
  }
}

/**
 * Whether a value names a provider that exists.
 *
 * The console offers only the providers that are here, and a configuration
 * naming anything else is a configuration error rather than something to
 * coerce: silently falling back would leave an operator believing a subsystem
 * was doing something it is not.
 */
function isProvider(subsystemId, providerId) {
  const subsystem = findSubsystem(subsystemId);
  if (!subsystem) return false;
  return providersOf(subsystem).some((p) => p.id === String(providerId || '').trim().toLowerCase());
}

module.exports = {
  SUBSYSTEMS, catalogue, check, isProvider, findSubsystem, providersOf,
};
