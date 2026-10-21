# Route reference

Every route of the versioned surface, and the scope a machine credential must
hold to use it. The same list, with the request and response schemas, is in
the OpenAPI document at `GET /api/v1/openapi.json`.

Paths are relative to the mount point, `/api/v1`. They are written as the
router has them, with `:name` for a parameter; the OpenAPI document writes the
same paths as `{name}`.

## The surface

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /` | public | what this API is: its version, its document, its instance |
| `GET /openapi.json` | public | the OpenAPI 3.1 description of this surface |
| `GET /scopes` | public | the scope catalogue |
| `GET /instance` | public | the instance id, its name and the versions of its contracts |
| `GET /events` | `events:read` | the event vocabulary and the envelope |
| `GET /whoami` | `profile:read` | the calling credential: its kind, its scopes, its limit |
| `GET /diagnostics` | `admin:read` | what the developer platform of this instance holds |

## API keys

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /keys` | `keys:read` | the keys of the account the caller acts for |
| `POST /keys` | `keys:write` | creates a key; the secret is in the answer and nowhere else |
| `GET /keys/:keyId` | `keys:read` | one key |
| `POST /keys/:keyId/rotate` | `keys:write` | issues a new secret, keeping the key's identity |
| `POST /keys/:keyId/revoke` | `keys:write` | withdraws the key, immediately |
| `GET /keys/:keyId/usage` | `keys:read` | what the key has spent, by route and by outcome |
| `GET /keys/:keyId/health` | `keys:read` | whether the key is configured, active or failing |

`POST /keys` takes `name`, `scopes`, `expiresAt`, `rateLimitPerMinute` and
`communityId`. `POST /keys/:keyId/rotate` takes `overlapSeconds`.
`POST /keys/:keyId/revoke` takes `reason`.

`GET /keys/:keyId/usage` and `GET /keys/:keyId/health` take `minutes`, the
window to report over (60 by default, 1440 at most).

## Communities

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /communities/:serverId` | `communities:read` | the community: its name, its owner, how many members it has |
| `GET /communities/:serverId/members` | `members:read` | a page of members, including avatar and bot identity |
| `GET /communities/:serverId/channels/:channelId` | `channels:read` | a channel's details |
| `GET /communities/:serverId/roles` | `roles:read` | role names, colors and permissions |

`:serverId` is a community id or its slug. `GET .../members` takes `limit`
(50 by default, 200 at most) and `offset` (0 by default). Its response includes
`total`, `limit`, `offset` and `hasMore`. Application tokens can use these
reads only when they hold the matching scope and their bot account is still a
member of the community.

## Applications

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /communities/:serverId/applications` | `bots:read` | the applications of the community, with their credentials |
| `POST /communities/:serverId/applications` | `communities:write` + `bots:write` | creates an application, its token and its credential |
| `GET /communities/:serverId/applications/:applicationId` | `bots:read` | one application |
| `PUT /communities/:serverId/applications/:applicationId/credential` | `communities:write` + `bots:write` | the scopes and the limit of an application |
| `POST /communities/:serverId/applications/:applicationId/rotate-token` | `communities:write` + `bots:write` | issues a new token; the old one stops working at once |
| `POST /communities/:serverId/applications/:applicationId/revoke` | `communities:write` + `bots:write` | burns the token and disables the application |
| `GET /communities/:serverId/applications/:applicationId/health` | `bots:read` | whether the application is configured, active or failing |

`POST .../applications` takes `name`, `description`, `iconUrl`, `scopes` and
`rateLimitPerMinute`. The answer carries `token`, which is shown once.

Managing applications requires `MANAGE_SERVER`. A bot may read its own health
and command list with the matching scope, but cannot inspect another
application. Other reads require community membership and their listed scope.

## Commands

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /communities/:serverId/applications/:applicationId/commands` | `commands:read` | the commands the application answers |
| `PUT /communities/:serverId/applications/:applicationId/commands` | `communities:write` + `commands:write` | registers a command, or replaces the one with the same name |
| `DELETE /communities/:serverId/applications/:applicationId/commands/:commandId` | `communities:write` + `commands:write` | removes a command |

`PUT .../commands` takes `name`, `description`, `response` and `options`. A
command's response is a template: `{name}` and `{name:default}` are replaced
with the bound arguments, and nothing else is evaluated.

## Messages

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /communities/:serverId/channels/:channelId/messages` | `messages:read` | a page of recent messages |
| `POST /communities/:serverId/channels/:channelId/messages` | `messages:write` | posts a message in the application's name |

`GET .../messages` takes `limit` (20 by default, 100 at most) and optional
`before`, the sequence of the oldest message already seen. The response gives
`hasMore` and `nextBefore`; pass that cursor as `before` to read the next older
page.
`POST .../messages` takes `content` and answers 201 with the message.

Posting through this route requires an **application credential**: it posts as
the application, and a person posting as themselves has the ordinary message
API for that. Channel membership and send permission are checked against the
bot's own account.

## Webhooks and subscriptions

| Route | Scopes | What it does |
| --- | --- | --- |
| `GET /communities/:serverId/webhooks` | `webhooks:read` | the webhooks of the community |
| `POST /communities/:serverId/webhooks` | `communities:write` + `webhooks:manage` | points the community at an endpoint and subscribes it to events |
| `DELETE /communities/:serverId/webhooks/:webhookId` | `communities:write` + `webhooks:manage` | removes the webhook |
| `POST /communities/:serverId/webhooks/:webhookId/rotate-secret` | `communities:write` + `webhooks:manage` | issues a new signing secret |
| `GET /communities/:serverId/webhooks/:webhookId/deliveries` | `webhooks:read` | the delivery log |
| `GET /communities/:serverId/webhooks/:webhookId/health` | `webhooks:read` | how many deliveries landed, and when the last one did not |
| `GET /communities/:serverId/subscriptions` | `events:read` | which webhook is subscribed to which events |
| `POST /communities/:serverId/subscriptions` | `communities:write` + `events:subscribe` | subscribes a webhook to a set of event types |
| `DELETE /communities/:serverId/subscriptions/:subscriptionId` | `communities:write` + `events:subscribe` | ends a subscription |

`POST .../webhooks` takes `name`, `url`, `channelId` and `events`. The `url`
must be an `https` address on a public host: the instance makes the request,
and a private address would be the instance reading its own network. The
answer carries the signing secret, which is shown once.

`GET .../deliveries` takes `limit` (25 by default, 100 at most).

## The answer shapes

Every list route answers with a named list, and every single-resource route
with a named object, so a client never has to guess:

```json
{ "keys": [ ... ] }
{ "key": { ... } }
{ "applications": [ ... ] }
{ "application": { ... }, "credential": { ... } }
{ "commands": [ ... ] }
{ "command": { ... } }
{ "webhooks": [ ... ] }
{ "webhook": { ... }, "subscription": { ... } }
{ "subscriptions": [ ... ] }
{ "subscription": { ... } }
{ "deliveries": [ ... ] }
{ "messages": [ ... ], "hasMore": true, "nextBefore": 41 }
{ "members": [ ... ], "total": 120, "limit": 50, "offset": 0, "hasMore": true }
{ "community": { ... } }
```

`GET /keys/:keyId/usage` answers with the counters, `GET /keys/:keyId/health`
and the two health routes answer with the state, and `GET /whoami` answers
with the calling credential. The OpenAPI document has the field-by-field
shapes.
