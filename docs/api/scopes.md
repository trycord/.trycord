# The scope catalogue

A scope is a verb over a resource area: `messages:read` is "read the messages
of a community", `webhooks:manage` is "administer the webhooks of a
community".

The catalogue is fixed. A scope that is not in it is not a scope, and a key
carrying one is refused when it is created, with a 400 and the code
`VALIDATION_ERROR`. The catalogue is served from `GET /api/v1/scopes` and is
read by the interface, by the API and by the checker that refuses a request,
so there is one answer to "what does this scope allow".

## The catalogue

| Scope | Allows |
| --- | --- |
| `profile:read` | read the calling credential: what it is, what it may do and what it is limited to |
| `keys:read` | list the API keys of the owner and read one key, its usage and its health |
| `keys:write` | create, rotate and revoke API keys |
| `communities:read` | read a community the caller belongs to |
| `communities:write` | change the developer configuration of a community: its applications, commands, webhooks and subscriptions |
| `members:read` | list the members of a community |
| `bots:read` | list the bot applications of a community, read one, and read its health |
| `bots:write` | create a bot application, give it its scopes, rotate its token and revoke it |
| `commands:read` | list the slash commands an application answers |
| `commands:write` | register, change and remove the slash commands an application answers |
| `messages:read` | read the recent messages of a channel |
| `messages:write` | post a message as a bot application |
| `webhooks:read` | list the webhooks of a community and read their deliveries and their health |
| `webhooks:manage` | create, rotate the secret of and remove the webhooks of a community |
| `events:read` | read the event vocabulary and the envelope the platform delivers |
| `events:subscribe` | subscribe a webhook to the events of a community, and end that subscription |
| `admin:read` | read the developer platform diagnostics of this instance |

## How the scopes are used

- A **session** is not scope-checked. A person signing in is the account
  itself, and a scope set on a session would be a decoration.
- A **developer key** and an **application token** are checked on every
  request. A route states the scopes it needs, and a request whose credential
  does not hold them is refused with a 403 and the code `INSUFFICIENT_SCOPE`.
- Every authenticated route states its scopes. A route that checked nothing
  would make the whole catalogue a decoration, so the route definitions
  require one and the OpenAPI document repeats it in the operation's
  description.

## The two-scope pattern

Routes that change a community's developer configuration ask for two scopes:
the one for the resource and `communities:write`.

```
POST /api/v1/communities/{serverId}/applications
  needs communities:write and bots:write
```

`communities:write` says "this credential may change this community's
developer configuration", and the resource scope says "and it may change this
particular thing". A key that has `bots:write` but not `communities:write` can
create an application nowhere; a key that has `communities:write` but not
`bots:write` can change the community's configuration but not its
applications.

Reads ask for one scope. A read does not change anything, so there is nothing
for the second scope to guard.

## What a credential may not do

- It may not create a key with a scope it does not hold. A key may only
  create a key whose scopes are a subset of its own.
- It may not administer credentials at all when it is an application: an
  application is a machine that acts in a community, and minting credentials
  is not something a bot does.
- It may not read another account's keys, another community's applications or
  another community's webhooks. A key that is not the caller's is answered
  with a 404, not with a 403: the answer must not say that the id exists.
