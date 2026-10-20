// The route definitions.
//
// One list, read by two things: the router that serves them and the OpenAPI
// document that describes them. A route that is not in this list is not
// served, and a route that is in this list is in the document, because both
// are made from the same entries.
//
// The definitions live with the handlers that serve them, one file per area:
// the surface, the keys, the applications, the webhooks.

const surface = require('./surface');
const keys = require('./keys');
const applications = require('./applications');
const webhooks = require('./webhooks');
const gateway = require('./gateway');

const definitions = [
  ...surface.definitions,
  ...keys.definitions,
  ...applications.definitions,
  ...webhooks.definitions,
  ...gateway.definitions,
];

module.exports = definitions;
