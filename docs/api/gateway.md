# The application gateway

An application that can post and cannot hear anything is a mail-merge, not a
bot. The gateway is what an application holds open to receive the events of
its community.

It is the same envelope the webhooks are handed, from the same dispatch, so a
bot and a webhook cannot see different events. It is a socket rather than an
HTTP request because a bot wants the event as it happens, without a request to
a third party in between.

## Connecting a bot

Three steps, and the token is never in a URL.

1. **Ask for a ticket.**

   ```
   POST /api/v1/applications/:applicationId/gateway-ticket
   Authorization: Bearer <the application's token>
   ```

   The answer carries a ticket, good for one connection and for a minute. A
   URL ends up in access logs, proxy logs and referrer headers, so a token in
   one is a token that leaks; the ticket is what goes in the URL instead, and
   it is spent the moment it is used.

2. **Open the socket.**

   ```
   wss://<the instance>/api/v1/gateway?application=<applicationId>&ticket=<the ticket>
   ```

   The ticket is spent here and nowhere else, and the application is read
   again: a ticket issued before the application was disabled, or before its
   token was revoked, does not open a socket.

3. **Say which events you want.**

   ```json
   { "op": "subscribe", "events": ["message.created", "member.joined"] }
   ```

   The answer is the list the socket is now subscribed to:

   ```json
   { "op": "subscribed", "events": ["message.created", "member.joined"], "application": "…", "community": "…" }
   ```

   An application that has not asked for anything hears nothing. That is
   deliberate: an application handed every event of a community is an
   application that can read everything, and the list is how an operator says
   what it is allowed to hear.

## What it may hear

- Only the events it asked for.
- Only the events of the community the application belongs to.
- Only while it is active. An application that is disabled, or whose token has
  been revoked, is disconnected at once — not left to notice.

## The events

The vocabulary is the one the webhooks use:

| Event | When |
| --- | --- |
| `message.created` | A message was sent |
| `member.joined` | Somebody joined the community |
| `member.left` | Somebody left the community |
| `channel.created` | A channel was made |
| `channel.deleted` | A channel was removed |
| `role.created` | A role was made |
| `role.updated` | A role was changed |
| `role.deleted` | A role was removed |
| `command.created` | A slash command was registered |

## The envelope

The same one a webhook is handed:

```json
{
  "v": 1,
  "event": "message.created",
  "id": "…",
  "at": "2026-07-01T12:00:00.000Z",
  "instance": { "id": "…", "name": "Trycord" },
  "serverId": "…",
  "channelId": "…",
  "actor": { "id": "…", "type": "user" }
}
```

The body's own fields are spread into the envelope, so a receiver does not
have to reach into `data` to find the message.

## Seeing whether a bot is connected

```
GET /api/v1/applications/:applicationId/gateway
Authorization: Bearer <the application's token>
```

The answer says whether the application is connected, how many sockets it
holds and which events it has asked for. The developer console shows the same
thing under **Gateway**.

## What it is not

- It is not a way to be a member. An application posts as itself, with the
  scopes its credential carries, and it has no account, no login and no
  session.
- It is not a way to hear another community. The community is fixed by the
  application.
- It is not a second way to deliver events. The webhooks and the gateway are
  handed the same envelope by the same dispatch.
