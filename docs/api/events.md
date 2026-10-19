# Events and the envelope

A community can point an endpoint at itself and receive an event when
something happens. The body is a contract, so it is versioned: the `v` field
says which contract the body follows.

## The envelope

```json
{
  "v": 1,
  "event": "message.created",
  "id": "0f7c1f6e-9f2a-4d2b-8a51-0f1b2c3d4e5f",
  "at": "2026-10-19T09:31:12.884Z",
  "instance": { "id": "local", "name": "Trycord" },
  "serverId": "6c1f0a44-2b7e-4a0e-9f6a-9c2d3e4f5a6b",
  "channelId": "9d2e1f30-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  "actor": { "id": "4b7a9c10-...", "type": "application" },
  "message": { "id": "1e2d3c4b-...", "authorId": "4b7a9c10-...", "content": "hello" }
}
```

| Field | What it is |
| --- | --- |
| `v` | the envelope version. A body without it was delivered before the version existed |
| `event` | the event type, from the vocabulary below |
| `id` | the delivery id. The same value is in the `x-trycord-delivery` header |
| `at` | when the event happened |
| `instance` | the instance that produced it: its id and its name |
| `serverId` | the community the event belongs to |
| `channelId` | the channel, when the event belongs to one; otherwise null |
| `actor` | who caused it: an id and a type (`user` or `application`); null when there is no actor |
| the event's own fields | at the top level, next to the fields above |

The event's own fields stay at the top level, which is where the deliveries
that predate this version put them. A consumer written against those keeps
reading `body.message`; the versioned fields are additions, not renames.

## The vocabulary

The types are the ones the instance already delivers:

`message.created`, `member.joined`, `member.left`, `channel.created`,
`channel.deleted`, `role.created`, `role.updated`, `role.deleted`,
`command.created`.

`GET /api/v1/events` answers with the vocabulary and the field descriptions,
so a client can read the contract from the instance it is talking to rather
than from a copy of this document.

## Subscribing

A subscription says which events of a community are delivered to which
webhook:

```http
POST /api/v1/communities/{serverId}/subscriptions
{ "webhookId": "…", "events": ["message.created", "member.joined"] }
```

`POST /api/v1/communities/{serverId}/webhooks` creates the endpoint and the
subscription in one call. The endpoint's signing secret is in that answer and
nowhere else.

A delivery is an HTTPS POST with these headers:

| Header | What it is |
| --- | --- |
| `x-trycord-event` | the event type |
| `x-trycord-delivery` | the delivery id, the same value as the body's `id` |
| `x-trycord-signature` | `sha256=<hex>`, the HMAC of the body under the webhook's secret |

The signature is computed the way the instance's other deliveries compute it:
the HMAC key is the stored hash of the secret, so the instance never holds
the plaintext after creation. A receiver verifies it by hashing the secret it
kept and using the result as the HMAC key.

Every attempt is recorded in the same delivery log the rest of the instance
writes to, and `GET /api/v1/communities/{serverId}/webhooks/{webhookId}/deliveries`
reads it back.

## What the versioned envelope does not change

The fan-out in `services/webhooks.js` delivers to every active webhook of a
community and knows nothing about subscriptions. It has not been changed, so:

- an event the **developer platform** produces - a message an application
  posts through the versioned API - arrives as the versioned envelope.
- an event the **rest of the application** produces - a message a person
  posts, a member joining - arrives in the older shape, which has the same
  field names minus `v`, `id`, `instance` and `actor`.

A consumer that reads the versioned envelope reads both. A consumer that
wants only the versioned bodies checks for `v`.

The subscription's event filter applies to the versioned envelope. The older
fan-out has no filter: it delivers every event type it knows to every active
webhook. Narrowing that is a change to `services/webhooks.js`, which the
developer platform does not own; it is the first thing to change when the two
delivery paths are brought together.

## The vocabulary of an application

An application posts a message through
`POST /api/v1/communities/{serverId}/channels/{channelId}/messages`. The event
is `message.created`, and the actor is the application:

```json
{ "actor": { "id": "<application id>", "type": "application" } }
```

The message's `authorId` is the account that owns the application, which is
what the message row records: an application has no account of its own.
