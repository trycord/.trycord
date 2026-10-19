// The remote communities this instance knows about.
//
// A community that lives on another instance is a reference, never a copy.
// It is not a row in `servers`, it grants no role and no permission here,
// and the instance it lives on stays the only authority over it: it decides
// who may read its channels, who may post, and who may remove whom.
//
// Two ways a community arrives here:
//
//   - a relay event (community.published, community.updated) tells this
//     instance about a community and the channels it exposes
//   - an operator asks for a peer's federated community list, which reads
//     the peer's discovery document
//
// Both write the same row, so the two ways cannot describe the same
// community differently.

const db = require('../../db');
const { now } = require('../../util');
const netguard = require('../netguard');
const guard = require('./guard');
const rules = require('./rules');
const store = require('./store');

// The discovery document a peer publishes.
function discoveryUrl(origin) {
  return String(origin || '').replace(/\/+$/, '') + '/.well-known/trycord';
}

// Fetch a peer's discovery document. The same guard the delivery path uses
// applies: the address is validated, the name is resolved and checked, no
// redirect is followed, and the answer is bounded in size and time.
async function fetchDiscovery(origin) {
  const options = { allowLocalhost: guard.allowLocalhost(), allowInsecure: true };
  let safeOrigin;
  try {
    safeOrigin = await guard.validateOrigin(origin);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'the origin is not allowed' };
  }
  const result = await netguard.fetchJson(discoveryUrl(safeOrigin), options);
  if (!result.ok) return result;
  const document = result.data;
  if (!document || typeof document !== 'object') {
    return { ok: false, error: 'the discovery document was not an object' };
  }
  if (document.enabled === false) {
    return { ok: false, error: 'federation is not enabled on that instance' };
  }
  if (!Array.isArray(document.communities)) {
    return { ok: true, document, imported: [] };
  }
  const imported = await importCommunities(document.instance_id, document.communities);
  return { ok: true, document, imported };
}

// Record the communities a peer says it federates.
async function importCommunities(originInstanceId, communities) {
  const imported = [];
  for (const community of communities) {
    if (!community || !community.id) continue;
    await store.upsertCommunity({
      originInstanceId,
      originCommunityId: community.id,
      name: community.name,
      description: community.description,
      iconUrl: community.icon_url,
      channels: Array.isArray(community.channels) ? community.channels : [],
    });
    imported.push(community.id);
  }
  return imported;
}

// The communities this instance federates: the public ones, with the
// channels the members may post in. A private community is not among them,
// and neither is a channel the members cannot post in.
async function federatedCommunities() {
  const rows = await db.all(
    'SELECT id, name, description, icon_url FROM servers WHERE is_public = 1 ORDER BY name ASC'
  );
  const exposed = [];
  for (const row of rows) {
    const gate = await rules.communityMayFederate(row.id);
    if (!gate.ok) continue;
    const channels = await rules.federableChannels(row.id);
    exposed.push({
      id: row.id,
      name: row.name,
      description: row.description == null ? null : String(row.description),
      icon_url: row.icon_url == null ? null : String(row.icon_url),
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type || 'text',
        topic: channel.topic == null ? null : String(channel.topic),
        is_public: true,
      })),
    });
  }
  return exposed;
}

// The local relationship with a remote community: 'joined' when somebody
// here is a member of it, 'left' when everybody who joined has left again,
// 'discovered' when nobody has.
async function relationshipState(originInstanceId, originCommunityId) {
  const rows = await db.all(
    'SELECT state FROM continuum_memberships WHERE origin_instance_id = ? AND origin_community_id = ?',
    [String(originInstanceId), String(originCommunityId)]
  );
  if (rows.some((row) => row.state === 'joined')) return 'joined';
  if (rows.length) return 'left';
  return 'discovered';
}

async function setRelationshipState(originInstanceId, originCommunityId, state) {
  await store.setCommunityState(originInstanceId, originCommunityId, state);
}

module.exports = {
  discoveryUrl,
  fetchDiscovery,
  importCommunities,
  federatedCommunities,
  relationshipState,
  setRelationshipState,
};
