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
//   EXTENSION_API_VERSION the version of the extension surface (3.0)
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

// The extension surface version.
//
// This is **not** the application version, and it is not derived from it.
// The two change for different reasons and on different schedules: an
// application release may add features, fix faults or change the interface it
// offers, none of which changes what an extension may ask the host to do.
//
// Deriving it from the application version broke every installed extension
// at the first release that was numbered differently from the one the
// extensions were written against: a package that targets extension API 3.0
// was refused by a 3.6 release with "this instance implements 3.6", and the
// extensions were fine.
//
// So it is written down here, and it is changed by hand, and only when the
// extension surface itself changes: a new capability, a changed event, a
// changed host API.
//
// Within a generation the surface only grows, so a package built against an
// earlier minor of this generation still installs.
//
// The **floor** is the oldest surface this family still supports, and it is
// where a deliberate break is recorded: a release that changes what an
// extension may ask the host to do moves the floor up, and a package built
// against what came before it is refused. Nothing else moves it, so a
// release that adds features, or fixes faults, or changes the interface the
// application offers, leaves every installed extension working.
//
// The ceiling is the application version: the newest surface the family has
// reached. A package built for something beyond it is asking for a surface
// this instance cannot know about.
const EXTENSION_API_VERSION = '3.0';

// The oldest extension surface this family still supports.
//
// It is 3.0 because the surface has not broken: the 4.0 release changed
// what the application does, and none of it is what an extension may ask
// the host to do. A release that does change that moves this up, and the
// packages built against what came before it are refused then.
const EXTENSION_API_FLOOR = '3.0';

const NAME = manifest.name === 'backend' ? 'Trycord' : manifest.name;

module.exports = {
  VERSION, API_VERSION, PROTOCOL_VERSION, EXTENSION_API_VERSION, EXTENSION_API_FLOOR, NAME,
};
