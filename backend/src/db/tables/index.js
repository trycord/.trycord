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
const communities = require('./communities');
const messaging = require('./messaging');
const social = require('./social');
const moderation = require('./moderation');
const instance = require('./instance');

const GROUPS = [identity, communities, messaging, social, moderation, instance];

module.exports = (engine) => GROUPS.flatMap((group) => group(engine));
