# Verification

How to check a change, and what each check covers.

## Automated suites

```
cd backend && npm test
cd frontend && npm test
cd public && node --test "tests/**/*.test.js"
cd sdk/trycord-botjs && npm test
```

Integration tests start a temporary instance with its own database, port and
signing secret, then exercise real routes. Frontend tests cover routing, render
contracts and accessibility. The public site and SDK have their own suites.

## Static checks

```
cd backend && npm run check:names
cd backend && npm run check:names:backend
cd backend && npm run check:contract
cd backend && npm run check:deployment
cd public && node scripts/build-site.mjs --check
cd trycord-desktop && npm run check
```

These check names that resolve, client paths against registered routes, the
container and compose files, the shared site chrome and the desktop shell.

## Manual surfaces

Run an instance with `npm start` in `backend/`, then exercise:

| Surface | What to confirm |
|---|---|
| Sign in and registration | A session is minted, revoked sessions are refused, and recovery works. |
| Communities and channels | Creation, membership, roles, permissions, invites and channel settings. |
| Messaging | Send, edit, delete, reactions, attachments, DMs and group conversations. |
| Moderation | Reports, cases, timeouts, bans, appeals and the audit chain. An action changes the underlying account or content. |
| Administration | Configuration, enforcement, instance status and the public site. |
| Voice | Joining a voice channel, signalling and relay credentials. |
| Clients | Desktop web client, phone module, desktop shell and public site. |

Report a change as implemented, tested or verified end to end. Do not call a
surface verified unless the request or interaction was actually exercised.
