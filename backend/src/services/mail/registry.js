// The mail provider registry.
//
// MAIL_MODE names one of three modes and nothing else: smtp, api, disabled. What
// that mode actually talks to is a provider, and providers are registered here
// rather than referred to anywhere else in the application.
//
// The split is deliberate. A mode is a shape of transport: a relay reached over
// SMTP, an HTTP endpoint reached with a JSON request, or no transport at all.
// A provider is a specific service. Keeping them apart is what lets the core
// carry no vendor: routes ask the service to send a message, the service asks
// the registry for the adapter the current mode names, and the adapter is the
// only file that knows any particular company's API.
//
// Adding a provider therefore means adding one file to providers/ and one entry
// in REGISTRY. No route, no setting, no screen in the dashboard changes, because
// none of them name a provider. The dashboard renders whatever the registry says
// exists, so a provider that is not registered cannot be selected.
//
// An adapter implements:
//
//   id            the string that appears in stored configuration
//   label         what the dashboard shows an administrator
//   summary       one line on what configuring it involves
//   settings      the setting keys it reads, so the dashboard can render them
//   secrets       the secret keys it needs, which are never returned
//   validate(cfg) -> { ok, problems[] }, called before a save and before a send
//   send(cfg, message) -> { id, delivered }, or throws a plain-English error
//   check(cfg)    -> { ok, detail }, a real delivery attempt when one is possible
//
// validate must not perform network IO. It runs on every configuration save and
// on the request path, so a provider that cannot answer instantly still has to
// be saveable. check is where the network is touched, and it is reached only
// from an administrator pressing a button.
'use strict';

// Registration order is the order the dashboard lists them in, which is why
// disabled comes last: it is the mode an operator picks deliberately, not the
// one they land on.
const REGISTRY = [
  require('./providers/smtp'),
  require('./providers/api'),
  require('./providers/disabled'),
];

const BY_ID = new Map(REGISTRY.map((p) => [p.id, p]));

// The three modes. A configuration naming anything else is a configuration
// error, not something to coerce: silently falling back would mean an operator
// who mistyped a provider name believes mail is being delivered when it is not.
const MODES = ['smtp', 'api', 'disabled'];

function isMode(value) {
  return MODES.includes(String(value || '').trim().toLowerCase());
}

function normaliseMode(value) {
  return String(value || '').trim().toLowerCase();
}

// null when the mode is unknown, which callers must treat as a refusal.
function providerFor(mode) {
  const m = normaliseMode(mode);
  if (!isMode(m)) return null;
  // The api mode is served by whichever provider is registered under it. With one
  // registered it is unambiguous; the lookup goes through this so that registering
  // a second HTTP provider does not mean rewriting the dispatcher.
  return BY_ID.get(m) || null;
}

// What the dashboard renders: every registered provider and the keys it reads.
// Derived from the registry, so a provider added here appears without a screen
// being written for it, and one that is not registered cannot be chosen.
function catalogue() {
  return REGISTRY.map((p) => ({
    mode: p.id,
    label: p.label,
    summary: p.summary,
    settings: p.settings,
    secrets: p.secrets,
    defaults: p.defaults || {},
  }));
}

module.exports = { MODES, REGISTRY, catalogue, providerFor, isMode, normaliseMode };
