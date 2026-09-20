# Security Policy

## Supported versions

Only the latest desktop release and the current `main` branch receive
security fixes. If you self-host, keep your server on the latest commit —
there is no long-term-support branch.

| Component         | Supported              |
| ----------------- | ---------------------- |
| Desktop (latest)  | :white_check_mark:     |
| Server (`main`)   | :white_check_mark:     |
| Older releases    | :x:                    |

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/LanxTheShowmaker/.trycord/issues)
for anything that isn't sensitive (outdated dependency, insecure default,
unclear documentation).

For anything sensitive — authentication bypass, token leakage, privilege
escalation, remote code execution — **do not open a public issue**.
Contact the maintainer privately with:

1. What you found and where (file/route/commit if you have it)
2. Steps to reproduce, ideally minimal
3. What you think the impact is
4. Whether you believe it is already being exploited

You will get a reply describing next steps. Please give a reasonable window
to ship a fix before disclosing publicly.

## What to expect

- Reports are triaged as they come in; this is a small project, so allow a
  few days.
- Fixes land on `main` first, then in the next desktop release where the
  client is affected.
- Severe issues are called out in the release notes.

## Self-hosting notes

- Never share your `JWT_SECRET`. Each instance needs its own, generated with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Never commit `.env` (it is gitignored for this reason). The checked-in
  `.env.example` contains no real credentials.
- The `demo` / `demo1234` seed login is development-only. Do not seed
  production databases, and do not expose a seeded instance publicly.
- Serve the API over HTTPS in production and set `CLIENT_ORIGIN` to your
  client's origin instead of leaving development CORS behavior in place.
