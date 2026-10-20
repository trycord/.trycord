// The voice rules both clients share.
//
// The desktop console and the phone console show the same thing: the same
// three providers, the same shared controls, the same states. If each kept its
// own list they would drift, and a console that offers a provider the service
// would refuse is the failure this prevents.
//
// Nothing here reaches the network and nothing here draws: it is the shared
// vocabulary, and each client draws it with the classes it already has.

export const PROVIDERS = [
  {
    id: 'mesh',
    label: 'Mesh',
    short: 'Mesh',
    summary: 'The in-house peer-to-peer path. The media travels between the participants and the server carries the signalling.',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Realtime',
    short: 'Cloudflare',
    summary: 'The Cloudflare SFU. The media is carried by Cloudflare and the server holds the authorisation.',
  },
  {
    id: 'sfu',
    label: 'Third-party SFU',
    short: 'Third-party SFU',
    summary: 'A media server the operator runs. It speaks the documented session API over HTTP.',
  },
];

// The controls every provider shares.
//
// The participant limit is shared in meaning and per-provider in value: each
// provider holds its own, and the console shows the one belonging to the
// provider in force.
export const SHARED_CONTROLS = [
  {
    key: 'voice.enabled',
    label: 'Voice and video',
    type: 'boolean',
    description: 'Whether this instance offers voice at all. With it on, the provider in force has to be able to carry a call.',
  },
  {
    key: 'voice.screenSharing',
    label: 'Screen sharing',
    type: 'boolean',
    description: 'Whether a member may share their screen. It needs the screen-sharing permission as well.',
  },
  {
    key: 'voice.stageChannels',
    label: 'Stage channels',
    type: 'boolean',
    description: 'A stage is a voice channel where an audience listens and a moderator brings speakers up.',
  },
];

// The states a provider can be in, and what each one means.
//
// A provider is never reported as working because its form was filled in:
// configuration makes a provider eligible, and only an answer from the other
// end makes it working.
export const STATES = {
  disabled: {
    label: 'switched off',
    tone: 'quiet',
    meaning: 'Voice and video are off on this instance, so no provider is running.',
  },
  configured: {
    label: 'configured',
    tone: 'quiet',
    meaning: 'The provider is set up but is not the one in force, or it has not been checked yet.',
  },
  active: {
    label: 'working',
    tone: 'on',
    meaning: 'The provider is in force, complete, and the other end answered.',
  },
  degraded: {
    label: 'not answering',
    tone: 'warn',
    meaning: 'The provider is in force and complete, but the other end did not answer.',
  },
  failed: {
    label: 'not configured',
    tone: 'warn',
    meaning: 'The provider is in force and something it needs is missing, so it cannot carry a call.',
  },
};

export function providerLabel(id) {
  const provider = PROVIDERS.find((entry) => entry.id === id);
  return provider ? provider.label : String(id || '');
}

export function stateOf(state) {
  return STATES[state] || STATES.configured;
}

// Where a value came from, in the words the console shows beside the field.
export function sourceLabel(field) {
  if (!field) return '';
  if (field.source === 'instance') return 'saved here';
  if (field.source === 'environment') return 'from the environment';
  if (field.source === 'default') return 'the default';
  if (field.source === 'pending') return 'not saved yet';
  if (field.source === 'legacy') {
    return 'from the older setting ' + (field.legacy || '');
  }
  return field.source || '';
}

// The value a control sends for a field.
//
// A list is a comma-separated string, because that is what the settings store
// takes; a number is a number, so a blank field does not become a zero.
export function fieldValue(field, control) {
  if (!control) return '';
  if (field.type === 'integer') {
    const parsed = parseInt(control.value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (field.type === 'list') {
    return String(control.value || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return control.value;
}

// The body the settings endpoint takes: one key per value.
export function saveBody(values) {
  const body = {};
  for (const [key, value] of Object.entries(values)) body[key] = value;
  return body;
}
