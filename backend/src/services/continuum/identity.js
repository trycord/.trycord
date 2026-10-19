// This instance's federation identity.
//
// The parent module (services/continuum.js) owns the signing key pair; the
// identity itself is kept here so the modules that build an event's origin
// block can read it without requiring the parent back - the parent requires
// them, and a require in the other direction at load time would be a cycle.

let instanceId = null;

function setInstanceId(id) { instanceId = id ? String(id) : null; }

function getInstanceId() { return instanceId; }

module.exports = { setInstanceId, getInstanceId };
