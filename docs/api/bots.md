# Bots

A bot in Trycord is an **application**: something a community administrator
creates, with a token that is shown once and stored hashed. The application
is a first-class identity of its own - it has a bot account, it belongs to
the community it was made in, and it is marked as a bot everywhere it
appears. It is not the developer who made it, and it cannot be used as them.

This page says how to make one, what it may do, and how to talk to it. The
[API reference](reference.md) has the routes; the [SDK](sdk.md) has a client
for them.

## What a bot is not

- It is not an account with a badge. Its messages are written by its own
  account, and the account is marked as a bot in every surface that shows
  an author: a message, a member list, a conversation list, a profile.
- It is not the developer. An application posts with the rights the
  community gave it, and the developer cannot speak as it with their own
  session.
- It is not a person. It has no password, so there is nothing to sign in
  with and nothing to guess.

## Making one

An application is made inside a community, by somebody who can manage that
community:

```
POST /api/v1/communities/{communityId}/applications
Authorization: Bearer {a person with communities:write and bots:write}

{ "name": "helper", "scopes": ["communities:read", "members:read", "channels:read", "roles:read", "messages:read", "messages:write"] }
```

The answer carries the application, its token and its credential. **The
token is shown once.** It is stored hashed, and it is not in any answer
after that - not the application, not the credential, not the health report.
If it is lost, rotate it:

```
POST /api/v1/communities/{communityId}/applications/{applicationId}/rotate-token
```

Rotating ends the old token at once.

## The scopes are the permissions

A credential carries scopes, and a route checks them. The scope a route
asks for is the scope that says what the route does:

| Scope | What it allows |
|---|---|
| `communities:read` | read a community |
| `members:read` | list the members of a community |
| `channels:read` | read channel names, topics and types |
| `roles:read` | read role names, colors and permissions |
| `communities:write` | change the community's developer configuration |
| `bots:read` | list the applications, read one, read its health |
| `bots:write` | create an application, give it scopes, rotate and revoke it |
| `commands:read` | list the commands an application answers |
| `commands:write` | declare, change and remove those commands |
| `messages:read` | read the recent messages of a channel |
| `messages:write` | post a message in a channel |
| `webhooks:manage` | manage the community's webhooks |

A credential may only be created with scopes that are a subset of its own,
so a key can never widen itself.

The scopes are not the whole of the permission. A bot that may post must be a
community member and have `SEND_MESSAGES` in that channel. The server checks
the bot's own account, not the developer who made it.

## The gateway

An application that can post and cannot hear anything is a mail-merge. The
gateway is the socket it holds open.

```
POST /api/v1/applications/{applicationId}/gateway-ticket
```

The answer carries a ticket, good for one connection and for a minute. The
token never rides in a URL - a URL ends up in access logs, proxy logs and
referrer headers - so the ticket is what goes in the URL instead:

```
wss://{instance}/api/v1/gateway?application={applicationId}&ticket={ticket}
```

Then say what to hear:

```json
{ "op": "subscribe", "events": ["message.created", "member.joined"] }
```

The events are the same names the webhooks are handed, from the same
dispatch, so a bot and a webhook cannot see different events:

`message.created`, `member.joined`, `member.left`, `channel.created`,
`channel.deleted`, `role.created`, `role.updated`, `role.deleted`,
`command.created`.

A connection that has not said which events it wants hears nothing, and an
application only hears the events of the community it belongs to.

### What the gateway does not promise

An event is delivered while the socket is open. **Nothing is replayed**, and
nothing is queued for a socket that was closed: a bot that was not
connected missed what happened, and the messages it can read are still there
when it comes back. A socket that drops is reopened by the SDK, with a
pause that grows, and after a few tries it gives up and says so.

## Commands

A command is declared in the community, so a member sees it there. The
declaration needs a **person's** credential with `communities:write` and
`commands:write` - the server refuses an application on that route, because
a bot that could declare its own commands would be able to answer anything
it liked.

```
PUT /api/v1/communities/{communityId}/applications/{applicationId}/commands

{ "name": "ping", "description": "Answers with a word.", "response": "Pong." }
```

The response is a template, not a script. `{name}` is filled in with the
argument of that name, and `{name:something}` with the argument or with
`something` when the member left it out. Nothing else is substituted: a
response cannot reach into anything the declaration did not name, and there
is no expression evaluation anywhere on this path.

## Taking one away

```
DELETE /api/v1/communities/{communityId}/applications/{applicationId}
```

The token stops working at once, the credential is revoked with it, and the
bot leaves the community - an application that is gone has no business
being a member, and a member that is still there could still be spoken for.
The messages it wrote stay where they are.

To keep an application but stop it for a while, disable it instead:

```
PATCH /api/v1/communities/{communityId}/applications/{applicationId}
{ "status": "disabled" }
```

A disabled application is switched off, not merely quiet: the token still
matches, so the status is checked at the door.

## Rate limits

A credential has a rate limit, enforced on every request it makes, and the
server sends a `Retry-After` header when it is over. The limits are per
credential, per community where it matters, and a single bot cannot use up
the instance's capacity for everybody else.

The SDK waits a `429` out, using the number the server sent, and only when
the wait is short enough to be worth it.

## The SDK

```ts
import { Client, Events } from 'trycord-botjs';

const client = new Client({
  token: process.env.TRYCORD_BOT_TOKEN!,
  baseUrl: 'https://your-instance.example',
});

client.on(Events.MessageCreated, async (event) => {
  if (event.message?.content === '!ping') {
    await client.send(event.serverId!, event.channelId!, 'Pong.');
  }
});

await client.login();
```

See [the SDK's page](sdk.md) for the rest.

## When it does not work

| What you see | What it means |
|---|---|
| `401 API_KEY_INVALID` | the token was revoked, or the application was deleted |
| `403 INSUFFICIENT_SCOPE` | the credential does not hold the scope the route asks for; the message names it |
| `403 BOT_NOT_ALLOWED` | the route is not for applications, or the application is disabled |
| `403 PERMISSION_DENIED` | the community does not let this bot post in this channel |
| `404 NOT_FOUND` | the application is gone, or the token is not one of its credentials |
| nothing arrives on the socket | the application has not subscribed, or it is not connected |

The health report says what the instance thinks of the application:

```
GET /api/v1/communities/{communityId}/applications/{applicationId}/health
```

It is never a guess: every number in it comes from a row this instance
wrote.
