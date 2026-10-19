# Migrating to /api/v1

The routes under `/api` are unchanged and keep working. This document is for
an integration that wants the contracted surface, the machine-readable
description, and credentials that are scoped rather than borrowed.

## What has not changed

Everything the interface uses still works exactly as it did:

```
GET  /api/users/me
GET  /api/servers
POST /api/servers
GET  /api/servers/:serverId/channels
POST /api/servers/:serverId/channels/:channelId/messages
GET  /api/bot/channels/:channelId/messages
```

Those routes are not versioned, are not described by the OpenAPI document, and
are not covered by the deprecation policy in [deprecation.md](deprecation.md).
They are the interface's API, and the interface is not going anywhere.

## What the versioned surface adds

| | Unversioned routes | `/api/v1` |
| --- | --- | --- |
| Description | none | an OpenAPI 3.1 document generated from the routes |
| Credentials | a session token, or an application token | a session token, an application token, or a scoped API key |
| Limits | per route, per address | per route, per address, and per credential |
| Revocation | sign out the session | withdraw one key, without touching the session |
| Audit | none | per-key usage counters and a health report |

## Moving a step at a time

### 1. Read the document

```
GET /api/v1/openapi.json
```

Every route of the surface, with the scope it needs and the shape it answers
with. It is generated from the same definitions the server routes on, so it
cannot describe a route that does not exist.

### 2. Create a key

The session token you have now is enough to create one:

```
POST /api/v1/keys
Authorization: Bearer <your session token>
{ "name": "reporting", "scopes": ["messages:read", "keys:read"] }
```

The answer carries the secret. Keep it: it is not recoverable.

### 3. Send it instead of the session token

```
GET /api/v1/keys
Authorization: Bearer tc_<handle>.<secret>
```

Nothing else about the request changes. The key acts for the account that
created it, and it is refused on any route whose scopes it does not hold.

### 4. Narrow the scopes

Start with what the integration uses and add scopes as it needs them. A key
with a scope it does not need is a key that can do more than it should.

The catalogue is at `GET /api/v1/scopes`, and the scopes each route needs are
in the OpenAPI document and in [reference.md](reference.md).

### 5. Move the community calls

The community routes of the versioned surface cover the developer platform:
applications, commands, webhooks, subscriptions, and the messages an
application posts. Everything else - changing a community's settings, its
roles, its channels - stays on the community routes, with the session token
or with a key that holds `communities:read` or `communities:write`.

## Moving an application

An application created through the community routes has a `trcd_bot_` token
and works with the existing bot API. To give it scopes and a limit, issue it a
credential:

```
PUT /api/v1/communities/{serverId}/applications/{applicationId}/credential
{ "scopes": ["messages:write"] }
```

The application keeps its token, so nothing that uses it today breaks. From
then on the versioned API knows what it may do.

To have the application post through the versioned API, it uses its token as
a bearer token:

```
POST /api/v1/communities/{serverId}/channels/{channelId}/messages
Authorization: Bearer trcd_bot_<secret>
{ "content": "hello" }
```

## Rotating without an outage

A key rotation issues a new secret and keeps the previous one working for a
short window, so a deployment can be spread over two machines:

```
POST /api/v1/keys/{keyId}/rotate
{ "overlapSeconds": 300 }
```

Deploy with the new secret, then rotate again with `overlapSeconds: 0` when
everywhere is on the new one. The second rotation ends the first one's secret
immediately.

## What to do when something is refused

| Answer | What it means | What to do |
| --- | --- | --- |
| 401 `API_KEY_INVALID` | the secret is wrong, or it is past its overlap window | take the newest secret |
| 401 `API_KEY_REVOKED` | the key was withdrawn | create a new key |
| 401 `API_KEY_EXPIRED` | the key's expiry passed | create a new key |
| 403 `INSUFFICIENT_SCOPE` | the key does not hold the scope the route needs | add the scope, or use another route |
| 403 `BOT_NOT_ALLOWED` | an application tried to use a route that is not for applications | use a key, or a session |
| 403 `NOT_A_MEMBER` | the account is not in the community | the community has to add it |
| 404 `NOT_FOUND` | there is no such resource, or it belongs to somebody else | check the id |
| 429 `RATE_LIMITED` | over the key's limit | read `Retry-After`, or raise the limit on the key |
