# trycord-botjs

The official SDK for Trycord bots. It talks to the routes the Trycord server
really has, and it does not pretend to more.

```bash
npm install trycord-botjs
```

```ts
import { Client, Events } from 'trycord-botjs';

const client = new Client({
  token: process.env.TRYCORD_BOT_TOKEN!,
  // A self-hosted instance is addressed by its own name.
  baseUrl: process.env.TRYCORD_BASE_URL || 'https://trycord.dev',
});

client.on(Events.MessageCreated, async (event) => {
  if (event.message?.content === '!ping') {
    await client.send(event.serverId!, event.channelId!, 'Pong.');
  }
});

await client.login();
```

## What a bot is

A bot is an **application**: a thing a community administrator creates, with
a token that is shown once and stored hashed. The application is a first
class identity of its own — it has a bot account, it belongs to the
community it was made in, and it is marked as a bot everywhere it appears.
It is not the developer who made it, and it cannot be used as them.

## Making the first request

Every route is under the instance's versioned API root, and the token is
sent in the `Authorization` header:

```
GET {baseUrl}/api/v1/communities/{communityId}
Authorization: Bearer {token}
```

The SDK is that call, and the answers are the server's own shapes.

### Reading

```ts
const community = await client.community('the-community');
const members = await client.members(community.id, { limit: 50 });
const messages = await client.messages(community.id, 'general', { limit: 20 });
```

### Writing

```ts
await client.send(communityId, channelId, 'Hello, community!');
```

A message can answer itself, which is the same call with the message's own
channel:

```ts
const message = messages[0]!;
await message.reply('And hello to you.');
```

## The gateway

An application that can post and cannot hear anything is a mail-merge. The
gateway is the socket it holds open.

The handshake is three steps, and the token never rides in a URL:

1. `POST /api/v1/applications/{applicationId}/gateway-ticket` — a ticket,
   good for one connection and for a minute.
2. Open `wss://{host}/api/v1/gateway?application={id}&ticket={ticket}`.
3. Send `{"op":"subscribe","events":["message.created"]}`.

The SDK does all three:

```ts
const client = new Client({ token, baseUrl, applicationId });
client.on(Events.MessageCreated, (event) => {
  console.log(event.event, event.message?.content);
});
await client.login();
```

### The events

The names are the ones the server sends — the same names the webhooks are
handed, from the same dispatch, so a bot and a webhook cannot see different
events:

| Event | What happened |
|---|---|
| `message.created` | A message was written. |
| `member.joined` | Somebody joined the community. |
| `member.left` | Somebody left it. |
| `channel.created` | A channel was made. |
| `channel.deleted` | A channel was removed. |
| `role.created` | A role was made. |
| `role.updated` | A role was changed. |
| `role.deleted` | A role was removed. |
| `command.created` | A command was declared. |

A connection that has not said which events it wants hears nothing.

### What the gateway does not promise

An event is delivered while the socket is open. **Nothing is replayed** and
nothing is queued for a socket that was closed: a bot that was not
connected missed what happened, and the messages it can read are still
there when it comes back. A socket that drops is reopened, with a pause that
grows; after a few tries the SDK gives up and says so through `onError`.

## The errors

Three kinds, and the difference matters:

| Error | What it means |
|---|---|
| `HttpError` | The server answered, and the answer was a refusal. `code` is the server's own code. |
| `RateLimitError` | A refusal with a number attached: `retryAfter` is how long to wait. |
| `ConnectionError` | The server did not answer. Nothing is known about whether the request had an effect. |
| `UsageError` | The caller asked for something the SDK cannot do. |

A program that cannot tell these apart will retry a request the server
already refused. `HttpError.retryable` says whether trying again could
plausibly work.

## The rules the client keeps

- The token is in the header, never in a URL.
- A request that writes something is not retried unless the caller says it
  may be: repeating a post is how a message gets posted twice.
- A `429` is waited out, using the server's own number, and only when the
  wait is short enough to be worth it.
- The token never appears in an error message, and the debug hook is given
  a description with nothing secret in it.
- The server is the authority. The SDK checks nothing the server does not
  check: the identity, the membership, the channel, the permissions, the
  credential and the rate limits are all the server's business.

## Self-hosting

`baseUrl` is the instance's own address. Nothing in the SDK assumes the
hosted instance:

```ts
const client = new Client({
  token: process.env.TRYCORD_BOT_TOKEN!,
  baseUrl: 'https://chat.example.org',
});
```

The gateway is opened on the same host, over `wss://` when the address is
`https://` and `ws://` when it is not.

## Runtimes

Node 18.17 and later. The client needs `fetch` (in Node 18 and later) and
`WebSocket` for the gateway — Node 22 has one built in. On an older
runtime, pass your own socket:

```ts
const client = new Client({
  token,
  createSocket: (url) => new SomeWebSocketLibrary(url),
});
```

## Building and testing

```bash
npm install
npm run build     # the package, with its type declarations
npm test          # the tests, against the built package
```

## The licence

AGPL-3.0-or-later, the same as Trycord itself.
