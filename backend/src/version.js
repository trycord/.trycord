// One place that knows what this build is.
//
// The version is written down once, in the package manifest, and read from
// there by everything that has to report it: the API metadata route, the
// instance endpoint the clients read, the health check, and the build the
// client is told about. A second copy of the number is a second chance for the
// product to say it is two different things.
//
// The numbers here are the application's own. They are not the same as a
// dependency's version, a protocol's version or a schema's version, and
// changing one of those must never change the others:
//
//   VERSION          the application release (3.0.0)
//   API_VERSION      the version of the HTTP contract (1)
//   PROTOCOL_VERSION the native federation protocol (trycord-continuum/1.0)
//
// A client that speaks an older API or protocol version is told so by the
// instance endpoint rather than discovering it through a confusing failure.
'use strict';

const manifest = require('../package.json');

// The application release. The manifest is the source of truth; this only
// names it once so the rest of the codebase has a single import.
const VERSION = manifest.version;

// The HTTP contract version. Bumped when a request or response shape changes
// in a way an existing client would not survive. The version is reported by
// GET /api/instance, which is where a client asks before it commits.
const API_VERSION = 1;

// The native federation protocol. Continuum is Trycord's own protocol and is
// not Matrix and not ActivityPub; the string names the protocol and its major
// revision, and two instances negotiate on it before exchanging anything.
const PROTOCOL_VERSION = 'trycord-continuum/1.0';

const NAME = manifest.name === 'backend' ? 'Trycord' : manifest.name;

module.exports = { VERSION, API_VERSION, PROTOCOL_VERSION, NAME };
