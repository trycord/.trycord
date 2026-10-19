// The vocabulary the route definitions are written in.
//
// The OpenAPI document is generated from the route definitions, so a route
// says what it needs as well as what it does: the scopes a machine
// credential must hold, the parameters it takes, the body it accepts and the
// answers it gives. These helpers are the shorthand for that.

/** A reference to a component schema. */
const ref = (name) => ({ $ref: '#/components/schemas/' + name });

/** A path parameter. */
function pathParam(name, description) {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

/** A query parameter. */
function queryParam(name, description, schema) {
  return { name, in: 'query', required: false, description, schema: schema || { type: 'string' } };
}

/** A request body. */
function requestBody(schema, description, required) {
  return { required: required !== false, description, content: { 'application/json': { schema } } };
}

/** An answer. */
function ok(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}

// The answers every route can give, named once.
const ERRORS = {
  badRequest: ok('The request was refused before it did anything.', ref('Error')),
  unauthenticated: ok('The request carried no usable credential.', ref('Error')),
  forbidden: ok('The credential is not allowed to do this.', ref('Error')),
  missing: ok("There is no such resource, or it is not the caller's.", ref('Error')),
};

module.exports = { ref, pathParam, queryParam, requestBody, ok, ERRORS };
