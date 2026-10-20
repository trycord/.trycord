# The Trycord developer API

The versioned surface a third-party integration builds against. It lives at
`/api/v1` and it is a **contracted subset** of the API, not a copy of it: the
routes under `/api` that the interface uses are unchanged and are not covered
here.

| Document | What it is about |
| --- | --- |
| [authentication.md](authentication.md) | session tokens and API keys, rotation, revocation, rate limits, the error envelope |
| [scopes.md](scopes.md) | the scope catalogue: what a key may be given |
| [reference.md](reference.md) | every route of the surface, with the scope it needs |
| [events.md](events.md) | the event envelope a webhook receives, and the vocabulary |
| [gateway.md](gateway.md) | the socket an application holds open to receive events |
| [migration.md](migration.md) | moving an integration from the unversioned routes to `/api/v1` |
| [deprecation.md](deprecation.md) | how a version is deprecated, and for how long |
| [sandbox.md](sandbox.md) | running the surface against a disposable instance |

## The shape of it

```json
GET /api/v1
{
  "name": "Trycord Developer API",
  "apiVersion": "v1",
  "version": "3.0.0",
  "eventVersion": 1,
  "basePath": "/api/v1",
  "openapi": "/api/v1/openapi.json",
  "scopes": "/api/v1/scopes",
  "events": "/api/v1/events",
  "documentation": "docs/api/",
  "instance": { "id": "local", "name": "Trycord" }
}
```

Four public routes answer without a credential: `GET /api/v1`,
`GET /api/v1/openapi.json`, `GET /api/v1/scopes` and `GET /api/v1/instance`.
Everything else needs one.

The machine-readable description of the surface is served from
`GET /api/v1/openapi.json`. It is **generated from the route definitions the
server routes on**, and a test walks the router and compares it with the
document, in both directions: a route the server serves that the document does
not describe fails the build, and so does a documented path the server does
not serve. The document cannot drift away from the code without a test
noticing.

## Who may call it

A request authenticates with one of two credentials:

- a **user session token**, the same bearer token the interface uses. It is
  the account itself, and it is not restricted by scopes.
- a **developer API key**, `tc_<handle>.<secret>`, carrying an explicit scope
  set. A key is refused on any route whose scopes it does not hold.

An **application** (a bot) has its own token, `trcd_bot_<secret>`. It is a
scoped credential in its own right: it is not a session token, it never
belongs to a person, and it only acts in the community that owns it. See
[authentication.md](authentication.md#application-tokens).

## What a caller gets

- Errors in one envelope, everywhere: `{"error": {"code": "...", "message":
  "..."}}`. The code is stable and machine-readable; the message is for a
  person.
- A **per-key rate limit**, enforced on every request the key makes, with a
  `Retry-After` header when it is over.
- **Usage counters** per key, by route and by outcome, and a **health** report
  that says whether a key or an application is configured, active or failing.
  Nothing in the health report is a guess: every number in it comes from a
  row this instance wrote.

## What this surface deliberately does not have

- No way to change a community's settings, roles or messages. Those are
  community operations, and they stay on the community routes.
- No way for a key to grant itself a scope it does not have. A credential may
  only create a key whose scopes are a subset of its own.
- No account-wide "give me everything" scope.
