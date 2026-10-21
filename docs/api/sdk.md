# The SDK

`trycord-botjs` is the official client for the API in this directory. It is
not a wrapper around a second implementation of the server: it calls the
routes documented here, and the shapes it returns are the shapes the server
sends.

It lives in its own package, under `sdk/trycord-botjs`, and it is built and
tested on its own:

```bash
cd sdk/trycord-botjs
npm install
npm test        # the tests, against the built package
npm run build   # the package, with its type declarations
```

The package is ready to be published. Publishing it needs an npm account
with the name, which is the operator's business and not the repository's:

```bash
npm publish --access public
```

## What it covers

| The API | The SDK |
|---|---|
| `GET /api/v1/communities/:id` | `client.community(id)` |
| `GET /api/v1/communities/:id/members` | `client.members(id)` |
| `GET /api/v1/communities/:id/applications` | `client.applications(id)` |
| `GET|POST /api/v1/communities/:id/channels/:id/messages` | `client.messages(...)`, `client.send(...)` |
| `GET /api/v1/applications/:id/commands` | `client.commands()` |
| `GET /api/v1/applications/:id/health` | `client.health()` |
| `POST /api/v1/applications/:id/gateway-ticket` | `client.login()` |
| the application socket | `Gateway` |

The quick start is in the package's own README.

## What it does not do

- It does not decide anything the server decides. The identity, the
  membership, the channel, the permissions, the credential and the rate
  limits are the server's business, and the SDK checks none of them.
- It does not retry a request that writes something. A post that is
  repeated is a post that happens twice.
- It does not keep the token in a URL, and it does not print it.

## The names

The event names are the ones the server sends, and they are the same names
the webhooks are handed: `message.created`, `member.joined`, `member.left`,
`channel.created`, `channel.deleted`, `role.created`, `role.updated`,
`role.deleted`, `command.created`.

A connection that has not said which events it wants hears nothing, so the
SDK's `client.on(...)` is a subscription and not a tap on everything.
