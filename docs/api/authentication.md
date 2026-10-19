# Authentication, keys and limits

## The two credentials

A request to `/api/v1` carries a bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

There are three kinds of token, and they are told apart by their shape:

| Token | Looks like | Who it is |
| --- | --- | --- |
| session | a JWT, three dot-separated parts | a signed-in person; the account itself |
| developer key | `tc_<handle>.<secret>` | a third-party integration, with an explicit scope set |
| application | `trcd_bot_<secret>` | a bot application, scoped to one community |

A session token works exactly as it does everywhere else in the API, so the
interface and an integration use the same surface. A developer key and an
application token are machine credentials: they carry scopes, they are rate
limited by their own limit, and they are refused on a route whose scopes they
do not hold.

## Creating a key

```http
POST /api/v1/keys
Authorization: Bearer <session token>
Content-Type: application/json

{
  "name": "reporting integration",
  "scopes": ["keys:read", "messages:read"],
  "rateLimitPerMinute": 120,
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

```json
{
  "key": {
    "id": "k_9xQm2pLd7Rt4Kc",
    "name": "reporting integration",
    "kind": "user",
    "status": "active",
    "ownerUserId": "4b7a9c10-...",
    "scopes": ["keys:read", "messages:read"],
    "communityId": null,
    "botApplicationId": null,
    "rateLimitPerMinute": 120,
    "createdAt": "2026-10-19T09:14:02.118Z",
    "lastUsedAt": null,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "revokedAt": null,
    "revokedReason": null,
    "rotatedAt": null,
    "rotatedFrom": null,
    "previousSecretExpiresAt": null
  },
  "secret": "tc_0f7c1f6e-9f2a-4d2b-8a51-0f1b2c3d4e5f.aG9xQ2mLp7Rt4Kc8vNb3Wd6Yh1Js5"
}
```

**The secret is in that answer and nowhere else.** It is stored as a hash, so
it cannot be recovered afterwards; a read of the key returns the key and never
the secret. If it is lost, the key is rotated and a new one is issued.

The `id` is the key's public identifier: it is what goes in a URL, and it stays
the same when the key is rotated. The `handle` in the token is a different
string, and it changes on every rotation, because it names one secret
generation rather than the credential.

A key may be bound to a community with `"communityId"`. A bound key only acts
inside that community.

### Who may create a key

A session may create a key with any scope in the catalogue. A credential may
only create a key whose scopes are a **subset of its own**: a key with
`keys:write` and nothing else cannot mint itself an `admin:read` key. The
refusal is a 403 with the code `INSUFFICIENT_SCOPE` and the missing scopes in
`error.details.missing`.

## Rotating a key

```http
POST /api/v1/keys/k_9xQm2pLd7Rt4Kc/rotate
{ "overlapSeconds": 300 }
```

The rotation issues a new secret and **keeps the key's identity**: the same
`id`, the same name, the same scopes, the same limit. What changes is the
secret, and the handle inside the token.

The previous secret keeps working until the end of the overlap window, so an
integration can be redeployed without a gap. The window is 300 seconds by
default and 900 at most; `overlapSeconds: 0` ends the previous secret at once.
The answer says when the previous secret stops working:

```json
{
  "key": { "id": "k_9xQm2pLd7Rt4Kc", "rotatedAt": "2026-10-19T09:20:41.006Z", "...": "..." },
  "secret": "tc_8a51b0c2-...-4e5f.sZ3pQ8mLp7Rt4Kc8vNb3Wd6Yh1Js5",
  "previousSecretExpiresAt": "2026-10-19T09:25:41.006Z"
}
```

A request with the previous secret after the window is refused with
`API_KEY_INVALID`.

## Revoking a key

```http
POST /api/v1/keys/k_9xQm2pLd7Rt4Kc/revoke
{ "reason": "the integration was decommissioned" }
```

Revocation is immediate and permanent: every secret the key ever issued stops
working on the next request, and the answer is 401 with the code
`API_KEY_REVOKED`. A revoked key cannot be un-revoked; create a new one.

## Application tokens

An application is created with a scope set and a token:

```http
POST /api/v1/communities/{serverId}/applications
{ "name": "moderation helper", "scopes": ["messages:write"] }
```

The answer carries `token` (the `trcd_bot_` credential, shown once) and
`credential` (the scopes and the limit that go with it). The application uses
the token to post messages through the versioned API and through the
existing bot API; it never has an account and never has a session.

- **Rotation** issues a new token and the previous one stops working at once.
  There is no overlap window: the application row holds one token, and that
  row is not the developer platform's to change.
- **Revocation** burns the token - the stored hash becomes the hash of a value
  nobody has - and disables the application. The token stops authenticating on
  the next request.
- An application created before the developer platform existed has no
  credential until `PUT /api/v1/communities/{serverId}/applications/{id}/credential`
  gives it one. Without a credential it cannot use the versioned API at all.

## Rate limits

Every key carries its own limit, in requests per minute. It is enforced on
every request the key makes, in the same place the per-route limits are
enforced. Over the limit, the answer is 429 with the code `RATE_LIMITED` and
a `Retry-After` header:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 37

{"error": {"code": "RATE_LIMITED", "message": "slow down. Try again shortly"}}
```

The default is 120 requests a minute and the ceiling is 6000. A session is
not limited this way: the per-route limits already cover an authenticated
person.

The buckets live in the process, like the rest of the rate limiting in this
server. A deployment that runs more than one API process keeps one bucket per
process.

## The error envelope

Every error on this surface, and every error in the rest of the API, has the
same shape:

```json
{ "error": { "code": "INSUFFICIENT_SCOPE", "message": "this credential lacks the scope: messages:write" } }
```

`error.details` carries extra context when there is any: the missing scopes
for `INSUFFICIENT_SCOPE`, the suspended flag for `SERVER_SUSPENDED`.

| Code | Status | What it means |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | no credential was presented |
| `API_KEY_INVALID` | 401 | the key does not exist, or the secret does not match |
| `API_KEY_REVOKED` | 401 | the key has been withdrawn |
| `API_KEY_EXPIRED` | 401 | the key's expiry has passed |
| `INSUFFICIENT_SCOPE` | 403 | the credential does not hold the scopes the route needs |
| `BOT_NOT_ALLOWED` | 403 | an application credential cannot use this route |
| `NOT_A_MEMBER` | 403 | the caller does not belong to the community |
| `PERMISSION_DENIED` | 403 | the caller does not have the permission in the community |
| `VALIDATION_ERROR` | 400 | the request was refused before it did anything |
| `NOT_FOUND` | 404 | there is no such resource, or it is not the caller's |
| `RATE_LIMITED` | 429 | over the credential's limit |
