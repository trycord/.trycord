// The data model, in six files.
//
// One per concern rather than one per table, because the concern is what a reader is
// actually looking for: where are the accounts, where are the messages, where does
// moderation live. Tables that have to be written together stay together.
//
// Every module takes the engine suffix, because SQLite and MySQL disagree about what
// belongs after the closing parenthesis. schema.js owns the migrations from here on; this
// directory owns the shape.
//
// Grouped by concern, which is not the order they used to be created in: the old list
// interleaved all forty-nine, so servers sat between users and categories and accounts
// sat between invites and direct messages. Every statement is the same one as before and
// the set is identical - only the sequence changed, and neither engine enforces the
// foreign keys declared in the DDL, so creation order is presentation rather than
// correctness. It reads as: accounts, then communities, then what lives inside them,
// then this deployment.

const identity = require('./identity');
const e2ee = require('./e2ee');
const communities = require('./communities');
const messaging = require('./messaging');
const social = require('./social');
const moderation = require('./moderation');
const instance = require('./instance');
const continuum = require('./continuum');
const developer = require('./developer');
const extensions = require('./extensions');
const workspace = require('./workspace');

// e2ee sits next to identity because every table in it points at users(id)
// and nothing in it points at anything else: the sessions, the prekeys and
// the conversation keys all hang off a device, and a device hangs off an
// account.
//
// The developer tables come last because they point at more than one thing:
// a credential points at a user and, for an application, at the application
// row that owns its token.
//
// The workspace tables come after everything they reference - servers, roles,
// users, channels, messages - and before nothing, because nothing references
// them yet.
const GROUPS = [
  identity, e2ee, communities, messaging, social, moderation, instance, continuum,
  developer, extensions, workspace,
];

module.exports = (engine) => GROUPS.flatMap((group) => group(engine));
