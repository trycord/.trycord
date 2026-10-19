// The realtime event names this subsystem emits.
//
// They live here rather than in ../ws/events.js because that file is the
// gateway's vocabulary and is not this subsystem's to change. The names
// below are the ones to merge into it:
//
//   e2ee:device         a device was registered or revoked
//   e2ee:key-change    a conversation key was published, rekeyed or lost
//   e2ee:safety-number the safety number for a peer changed
//
// A client matches on the name, so these are part of the contract between
// the server and the client, not a detail of the implementation.

'use strict';

const E2EE_EVENTS = {
  DEVICE: 'e2ee:device',
  KEY_CHANGE: 'e2ee:key-change',
  SAFETY_NUMBER: 'e2ee:safety-number',
};

module.exports = { E2EE_EVENTS };
