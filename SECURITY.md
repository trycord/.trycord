# Security Policy

Security issues in Trycord should be reported privately whenever they could
allow unauthorized access, data exposure, privilege escalation, or other
harm to users or self-hosted instances.

## Supported versions

Trycord is continuously developed on `main`. Security fixes are applied to
the current codebase and included in subsequent releases where applicable.

| Component | Supported |
| --- | --- |
| Server (`main`) | :white_check_mark: |
| Web client (`main`) | :white_check_mark: |
| Latest desktop release | :white_check_mark: |
| Older desktop releases | :x: |
| Unmaintained forks or modified builds | :x: |

There is currently no long-term-support branch.

If you self-host Trycord, keep your server updated with the latest supported
code and apply security fixes promptly.

## Reporting a vulnerability

### Preferred method

Use GitHub's **private vulnerability reporting** for this repository when
available.

Do **not** open a public GitHub issue for a security vulnerability.

Private reports are appropriate for issues such as:

- Authentication bypass
- Authorization or privilege escalation
- Account takeover
- Token or credential leakage
- Sensitive data exposure
- Remote code execution
- SQL injection
- Server-side request forgery
- WebSocket authorization issues
- File upload vulnerabilities
- Cross-site scripting
- Security-sensitive configuration flaws
- Vulnerabilities that could compromise a self-hosted instance

If private vulnerability reporting is unavailable, contact the maintainer
through the private security contact associated with the repository before
disclosing the vulnerability publicly.

### What to include

Please provide as much of the following information as possible:

1. **Summary** — a clear description of the vulnerability.
2. **Affected component** — server, web client, desktop client, deployment
   configuration, or another component.
3. **Affected location** — file, route, endpoint, feature, commit, or version
   if known.
4. **Steps to reproduce** — preferably a minimal and reliable reproduction.
5. **Impact** — what an attacker could achieve and what permissions are
   required.
6. **Affected versions or commits** — if known.
7. **Proof of concept** — when safe and appropriate.
8. **Whether you believe the issue is being actively exploited**.

Do not include real user credentials, private tokens, production secrets, or
other sensitive data that is not necessary to reproduce the issue.

## Responsible disclosure

Please allow the maintainers a reasonable amount of time to investigate,
develop, test, and deploy a fix before publicly disclosing the vulnerability.

Trycord uses coordinated disclosure. Security details should remain private
until a fix or mitigation is available, unless disclosure is required for
another legitimate reason.

Once a vulnerability has been addressed, the maintainers may publish a
security advisory containing the relevant details, affected versions,
patched versions, and any required upgrade instructions.

## What to expect

Trycord is an independently maintained open-source project.

- Security reports are reviewed as they are received.
- Initial triage may take several days.
- Additional information may be requested during investigation.
- Confirmed vulnerabilities are fixed in the active development branch.
- Security fixes affecting released desktop builds are included in a
  subsequent desktop release.
- Security-related releases or advisories may be documented in the GitHub
  release notes or repository security advisories.
- Reporters may be credited when a security advisory is published, subject
  to their preference.

No guaranteed response or remediation deadline is provided.

## Self-hosting security

Self-hosted instances are independently operated. The security of a
self-hosted deployment also depends on its host, network, database,
reverse proxy, TLS configuration, and administrator practices.

### Secrets

Never expose or commit your `JWT_SECRET`.

Generate a unique secret for each instance:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not reuse the same secret across unrelated installations.

Never commit `.env` files or other files containing production credentials.

The repository's `.env.example` is intended as a configuration reference and
must not contain real credentials.

### Database

Production deployments should use the production database configuration
documented in the README and `.env.example`.

Keep database credentials private and restrict database access to trusted
hosts where possible.

Do not expose the database directly to the public internet unless there is
a specific operational requirement and appropriate access controls are in
place.

### Development seed account

The `demo` / `demo1234` account is a development seed account.

It must not be used on a public or production instance.

Do not expose an instance containing the development seed account to the
internet.

Production databases should not be seeded with development credentials.

### HTTPS and reverse proxies

Production instances should use HTTPS.

When deploying Trycord behind nginx or another trusted reverse proxy,
configure the server according to the deployment documentation and ensure
forwarded headers are handled correctly.

For nginx deployments, use the documented `SERVER_HOST_TYPE=nginx` setup and
configure `TRUST_PROXY` appropriately.

Do not blindly trust client-controlled proxy headers when the server is
directly exposed to the internet.

### CORS and client origins

Configure `CLIENT_ORIGIN` to the actual origin of the deployed Trycord
client.

Do not leave development CORS configuration enabled on a public production
instance.

### File uploads

Treat uploaded files as untrusted input.

Do not assume uploaded filenames, MIME types, extensions, or file contents
are safe.

Self-hosters should also consider storage limits, filesystem permissions,
reverse-proxy limits, and available disk space.

## Scope

This policy covers the Trycord project and its official source code,
including:

- `trycord-server`
- `trycord-client`
- `trycord-desktop`
- Official deployment configuration

Third-party hosting providers, self-hosted infrastructure, operating
systems, databases, reverse proxies, and unrelated dependencies are outside
the project's direct operational control.

Security issues caused solely by a self-hosted administrator's infrastructure
or configuration should be reported to the relevant infrastructure provider
or administrator.

## No bug bounty

Trycord does not currently operate a paid bug bounty program.

Security researchers should not expect monetary compensation unless a
separate program is announced by the maintainers.

Thank you for helping keep Trycord and its self-hosted community safe.
