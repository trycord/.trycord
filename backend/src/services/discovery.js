// Instance discovery.
//
// Two sources, neither of them required:
//   - this instance, when its operator has said it may be listed;
//   - directories the operator configured, each a plain JSON document served
//     by whoever runs it.
//
// A directory is not an authority. It holds pointers to instances; a client
// checks the instance itself before offering it, and nothing here decides who
// trusts whom. An instance that is listed is not thereby federated, and an
// instance that is not listed is not thereby unreachable.
//
// A directory that is slow, broken or hostile costs the reader nothing: the
// failure is reported per source, and the rest of the answer still comes back.

const settings = require('./settings');
const netguard = require('./netguard');
const db = require('../db');
const features = require('../features');

const MAX_SOURCES = 8;
const MAX_RECORDS_PER_SOURCE = 100;
const MAX_TOTAL = 200;

// The public shape of one instance in a listing. Only what a reader needs to
// decide whether to look closer.
function shape(record) {
  const url = String(record && (record.url || record.baseUrl || record.origin) || '').trim()
    .replace(/\/+$/, '');
  return {
    url,
    name: String(record && (record.name || record.displayName) || '').trim(),
    description: String(record && record.description || '').trim().slice(0, 200),
    instanceId: record && record.instanceId ? String(record.instanceId) : null,
    // A directory may say an instance accepts registrations. That is a claim by
    // the directory, not a fact, and the client confirms it with the instance.
    registrationOpen: record && typeof record.registrationOpen === 'boolean'
      ? record.registrationOpen : null,
    // Whether the directory claims cryptographic verification. A claim is not a
    // proof, and the client checks the instance's own document before saying so.
    verified: record && typeof record.verified === 'boolean' ? record.verified : null,
  };
}

function validRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const shaped = shape(record);
  if (!shaped.url) return false;
  try {
    netguard.validateOrigin(shaped.url, { allowLocalhost: false, allowInsecure: false });
  } catch {
    return false;
  }
  return true;
}

async function readSource(source) {
  const out = await netguard.fetchJson(source, {
    allowLocalhost: false,
    allowInsecure: false,
    timeoutMs: 5000,
    maxBytes: 262144,
  });
  if (!out.ok) return { ok: false, source, error: out.error };

  const body = out.data;
  const list = Array.isArray(body) ? body
    : (body && Array.isArray(body.instances) ? body.instances : null);
  if (!list) return { ok: false, source, error: 'the directory did not answer with a list of instances' };

  const records = [];
  for (const item of list.slice(0, MAX_RECORDS_PER_SOURCE)) {
    if (!validRecord(item)) continue;
    records.push(shape(item));
  }
  return { ok: true, source, records };
}

// This instance's own entry, when the operator has allowed it to be listed.
async function selfEntry() {
  if (!settings.isLoaded()) return null;
  if (settings.get('instance.discoverable') !== true) return null;
  return {
    url: String(settings.get('instance.publicUrl') || '').trim(),
    name: String(settings.get('instance.name') || 'Trycord'),
    description: String(settings.get('instance.description') || ''),
    instanceId: null,
    registrationOpen: !!features.current.registration,
    verified: null,
  };
}

// The answer: the instances that could be reached, and what went wrong with
// the ones that could not.
async function discover() {
  const instances = [];
  const problems = [];
  const seen = new Set();

  const self = await selfEntry();
  if (self && self.url && netguard.validateOrigin) {
    try {
      netguard.validateOrigin(self.url, { allowLocalhost: false, allowInsecure: false });
      if (!seen.has(self.url)) { seen.add(self.url); instances.push(self); }
    } catch {
      problems.push({ source: 'this instance', error: 'the public URL is not a usable address' });
    }
  }

  const sources = settings.isLoaded() ? settings.get('instance.discoverySources') : [];
  const list = Array.isArray(sources) ? sources.slice(0, MAX_SOURCES) : [];
  for (const source of list) {
    const result = await readSource(String(source));
    if (!result.ok) { problems.push({ source: String(source), error: result.error }); continue; }
    for (const record of result.records) {
      if (seen.has(record.url)) continue;
      seen.add(record.url);
      instances.push(record);
      if (instances.length >= MAX_TOTAL) break;
    }
    if (instances.length >= MAX_TOTAL) break;
  }

  return { instances, problems, generatedAt: new Date().toISOString() };
}

module.exports = { discover, shape, validRecord };
