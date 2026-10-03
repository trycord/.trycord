# Production readiness

Whether this is fit to run a real community, stated as plainly as the code allows.

This page is deliberately unglamorous. It does not claim certifications, name
hosting providers, or promise response times. Where a commitment depends on a
person making a decision, it says so. Where the software enforces something, it
names the mechanism, because a policy that says "we moderate" and a codebase that
has no report queue are different products.

Read this as the state of the software, not as a compliance document. The legal
documents are [Terms](/terms), [Privacy](/privacy),
[Trust & Safety](/trust-and-safety) and [Security](/security). Where this page
and those disagree, they are wrong and this page is the thing to fix.

## Legal foundation

The terms and privacy policy are versioned in code (`src/legal.js`) and the exact
version accepted is stored against each account. Registration records the version
shown at the time and the server rejects a registration whose versions do not
match the current documents, so an account cannot be created against terms nobody
saw. Accounts that predate versioning are left alone rather than invalidated.

There is no company behind this. The project is the repository, the maintainers
are the people with commit access, and contact happens through the public issues.
That means two things worth being explicit about:

- There is no entity to serve a legal process against. A preservation order or a
  formal data-subject request has to be handled as a request to whoever operates
  the instance, in public, on the project's own terms.
- The official instance is operated as a service without warranty. Its operators
  are volunteers and it can be withdrawn.

Every other instance is somebody else's. See
[operator responsibility](#self-hosted-instances) below, because this is the part
most often assumed and most often wrong.

## User-generated content

Trycord hosts whatever its members post: text, images, attachments, links,
usernames, community names and channel names. That is the product.

- Content is served to other members of the same instance. It is not published,
  syndicated, sold or used for training anything.
- Attachments are served from the instance's own storage driver. A self-hoster
  chooses between local disk and an S3-compatible bucket, and that choice is part
  of the instance's configuration, not a global default.
- Anyone with a valid session can read content from an instance. **Message content
  is not encrypted at rest** and there is no end-to-end encryption; the server can
  read every message, which is what makes server-side search and link previews
  possible. This is the design, not a gap in it — a self-hoster who needs message
  confidentiality against their own operator is running different software.
- Credentials are treated differently, and deliberately: TOTP secrets are
  encrypted at rest with AES-256-GCM under a key derived from the instance's own
  secret, so a stolen database alone does not yield a member's second factor.
- Reporting is available on messages, users, communities, channels, DMs and
  attachments. Reports reach the moderation queue on the instance they were made
  on, and to nowhere else.

## Copyright and takedowns

There is no automated content matching. Nothing scans messages for copyrighted
material, because doing that on every instance would mean either shipping a
third party's index into every self-hosted copy or scanning user content outside
the operator's knowledge, and both are worse than the problem.

What exists instead:

- Rights holders who hold a URL can report that message through the reporting UI
  or the API, identifying the community, the message and the work.
- The report enters the operator's moderation queue as an ordinary report, with
  the reporter's stated reason preserved.
- Action is the operator's decision under their own policy.

This is the honest shape of it: takedown on Trycord is a person reading a report,
not a system matching a fingerprint. A self-hosted instance that wants automated
matching should configure a third-party tool in front of it, and the operator
carries the obligation for doing that correctly.

## Abuse and infrastructure

Enforced by the server, not by the client. Each of these is a server-side check,
so removing the client or using the API directly does not bypass any of them:

- **Registration and login rate limits**, per IP, per endpoint.
- **Message size and attachment size limits**, enforced at upload rather than in the
  client.
- **An SSRF guard on link previews.** The server fetches posted URLs to build
  cards, so it refuses private, loopback and link-local addresses before making the
  request. Without it, posting a URL would let any member read the instance's own
  network through the server.
- **Password hashing** with bcrypt at a fixed cost, and a minimum password length
  checked at registration.
- **Session tokens** signed per instance with a secret the instance generates. The
  secret is never shared between instances and never has a default, so a
  self-hoster cannot accidentally run on someone else's signing key.
- **Two-factor authentication**, available per account. The TOTP secret is held
  server-side and encrypted at rest; it is never sent to the client.

Rate limit windows and upload ceilings are configuration. An operator tightening
them for a small community is expected; the defaults are a starting point and not
a claim about what any given instance permits.

## Authentication and account security

- Password is never stored or logged in plaintext, and there is no password
  recovery by email on instances that do not configure mail.
- Sessions are revocable from the account's own settings: a specific session, all
  other sessions, or all of them. A user who thinks their account is compromised
  can end it without an operator's help.
- There is no "remember me" that outlives the configured session lifetime, and no
  backdoor authentication path, for operators or anyone else.
- The official instance does not share its database, its secret, or its upload
  storage with any other instance, and does not permit an operator to read
  another's users.

## Data boundaries

An instance holds: accounts, profiles, communities, channels, messages,
attachments, memberships, roles, moderation reports, audit records, and device
sessions. That is the whole list.

Data does not leave the instance except when an operator configures it to, or when
a backup leaves the machine. Things that do leave it by default:

- **Email, if the instance is configured to send it.** Password reset, verification
  and notification mail go to the configured mail transport. An instance that sets
  mail to log mode sends nothing and prints it, which is what makes a local
  instance usable at all.
- **Link previews**, where a posted URL is fetched by the server to build a card.
  This is a server-side request to a third party and it is suppressible per
  message, and the suppression travels with the message rather than being a client
  setting.

Anything else is an operator decision: backups, a reverse proxy's access logs, an
S3 bucket's retention policy. Trycord cannot enumerate those, and an instance that
does not document them is an instance nobody can reason about.

## Payments

There are no payments. Trycord has no paid tier, no billing, no subscriptions and
no in-app purchases, and no code path that can take a card.

This is worth stating plainly because "open source chat app with payments" is a
common assumption and getting it wrong has consequences for a self-hoster
deciding what they are running. Donations, where they exist, are handled outside
the software by whoever runs them.

## Hosting provider dependencies

The official instance uses third-party infrastructure. So does every self-hosted
instance, and this is not a Trycord-specific risk — it is what running a service
on rented machines means.

The consequence for a community is that its continuity depends on a provider it
does not control and cannot substitute for. The mitigation is the one thing this
project is actually built around: the same software runs on the operator's own
hardware, and moving an instance is a deployment, not a migration.

Trycord has no contractual relationship with any hosting provider, and no ability
to compel one. Nothing on this page should be read as a claim about a provider's
practices or availability.

## Moderation transparency

Moderation tooling in the codebase, so this is checkable rather than claimed:

- Reporting on messages, users, communities, channels, DMs and attachments, with a
  category and free-text detail. A report is visible only to the reporter among
  ordinary users.
- A report queue with the statuses `OPEN`, `INVESTIGATING`, `RESOLVED`,
  `DISMISSED`.
- Bans, temporary and permanent, with an expiry where one is set.
- Message deletion is a **hard delete** — the row is removed from the database, not
  flagged. An author or a moderator deleting a message removes it. That matters for
  retention: there is no soft-delete copy for an operator to recover later.
- An appeal path, tied to a specific moderation action, with the statuses `OPEN`,
  `UNDER_REVIEW`, `APPROVED`, `DENIED`. Appeals land in the operator queue.
- Audit records. Report creation, enforcement and enforcement lifts are all
  written to an audit trail.
- An admin console covering reports, appeals and instance-level settings.

What is not here, stated so nobody has to guess: no automated classifiers, no
similarity scoring, no proactive scanning, and no transparency report generator.
The moderation a community receives is exactly the moderation its operator chose
to configure and staff.

## Self-hosted instances

This is the part that matters most, and it is the part most often misread.

**The operator of a self-hosted instance is solely responsible for it.** Not the
project, not the maintainers, not the software vendor — there is no vendor. An
operator is responsible for:

- The law that applies to them where they are, which this project cannot advise
  on and has not tried to.
- Moderating their own community, and staffing it.
- Responding to legal process and data-subject requests.
- Retention and deletion of their own data, including what their backups contain.
- Disclosures of anything the software itself sends to third parties on their
  configuration — mail transport, link previews, storage buckets, and anything a
  reverse proxy in front of it logs.
- The terms on which people use their instance, which may be nothing at all.

**The official instance's terms do not apply to any other instance.** They govern
the official instance only. An operator is free to run Trycord with different
terms, different moderation, or no published policy at all, and nothing in the
codebase requires otherwise.

**Self-hosting is the mitigation, not an escape.** Moving an instance elsewhere is
supported and is the recommended answer to almost every continuity problem here.
What cannot move is history: messages, accounts and bans are instance data, and an
operator leaving the official instance starts from their own backups or from
nothing.

## Policy against implementation

Where the code and this page disagree, one of the following is true, and each has
a different fix:

- The page is aspirational and the code does not do it. **That is a bug in the
  page.** It should be corrected in the same commit that adds the code, not
  after.
- The code does it and the page omits it. **That is a gap in the page.**
- Neither does it. **That is a planned feature and should be described as one.**

No item here is satisfied by the intention to build it. The claims above were
checked against the codebase and against the running official instance, and they
will be wrong the moment the code changes without this page being updated.
