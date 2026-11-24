# Upgrading to 3.0

What an operator must know before moving an existing instance to 3.0.

## Before you start

1. Take a backup with `npm run db:backup` in `backend/`.
2. Read `backend/.env.example` for the current environment reference.
3. Stop the running instance so migrations run against a quiet database.

## Schema

`npm run migrate` applies the schema and records each migration. Applied
migrations are never run twice. A failed migration blocks later ones until it
is retried. A database written by a newer build is refused rather than
downgraded. Confirm the application boots and that the schema fingerprint
matches this build after the upgrade.

## Configuration

- `JWT_SECRET`, `SERVER_HOST_TYPE` and a database profile are required.
- `SERVER_HOST_TYPE` is `express` or `nginx`; anything else stops startup.
- Set `TRYCORD_CLIENT_DIR` if the client is not in the default repository
  layout.
- Voice signalling stays with the API. The STUN/TURN relay is a separate
  process on port 9973 with its own key.

## Data and files

Uploaded files stay under `backend/uploads/`. The instance bootstrap and any
generated signing key stay under `backend/instance/`. Preserve both across the
upgrade. Existing accounts, communities and moderation records are kept.

## After the upgrade

Run the suites in `docs/verification-matrix.md`, then exercise sign-in,
messaging, moderation and the public site against the live instance.
