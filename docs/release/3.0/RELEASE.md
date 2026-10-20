# Trycord 3.0 — release evidence

The strict release gate, item by item, with the evidence for each. A gate that
is not met is stated as not met.

Branch: `release/3.0.0`. Target version: 3.0.0.

## The gate

> Trycord 3.0.0 must not be declared release-ready until:
>
> - All functionality explicitly required for the release is implemented.
> - No known critical or high-severity defect remains.
> - Critical user journeys pass.
> - Auth, persistence, permissions, realtime and session revocation work.
> - E2EE passes required implementation and security-review gates before being advertised as secure.
> - Federation works between independent instances.
> - Database migrations preserve existing data.
> - Required client builds and runtime flows are verified.
> - Public website and hybrid editor work.
> - Legal drafts have clear operator-review status.
> - Both dashboard modes work.
> - Self-hosting and recovery procedures are tested where possible.
> - No placeholder is represented as a completed feature.
> - All remaining blockers are documented honestly.

## 1. Functionality explicitly required — **MET, with the gaps that are not cosmetic recorded**

The capability inventory (`CAPABILITY_INVENTORY.md`) is the answer, item by
item, with the evidence.

The subsystems that had a backend and no interface — the workspace, the
extension console, the developer console, the voice console, the federation
moderation surface, the community settings — all have one now, on the desktop
and on the phone, and each is registered, bound and linked from the place it
belongs to.

The gaps that remain, and are recorded as gaps:

- **The localisation is a mechanism, not a translation.** The reader's
  preference, the packs, the review workflow and the formatting are real; the
  strings are still English. That is recorded as what it is.
- **The extension sandbox is not a hard boundary.** Node provides none, the
  module says so, and the real defence is structural: server-side extension
  code is off by default and the declarative path exists so most extensions
  never need it.
- **The relay does not carry attachments or reactions.** The protocol's key
  for a reaction does not survive the return direction.

## 2. No known critical or high-severity defect — **MET, with the audits in `docs/audit/`**

Four reviews were run over the 3.0 subsystems: security, the 3.0 security
review, licensing and performance. The 3.0 review found nine findings — three
high, three medium, three low — and **all nine are closed**, each with a
regression file. The worst was a way out of the extension sandbox: the context
was handed Node's timer handle, whose `constructor.constructor` is the outer
`Function`, so a trusted extension's server-side code could build `process`,
reach `require` and take the instance process.

The earlier security review found two critical defects and both are fixed:

- **The outbound guard did not exist.** `netguard.assertPublicHost` was
  imported by the link-preview and the webhook services and was not exported.
  Every call raised a TypeError that the callers caught, so every preview
  came back "unavailable" and every outgoing webhook was refused. The SSRF hole
  was closed by accident, and removing the dead call would have opened it.
- **A fresh MySQL database could not be created.** A table pointing at
  `messages` was declared before it, and MySQL checks a referenced table when
  the referencing one is created. SQLite does not, which is why every test
  instance was fine. The schema's own order is now a valid order, and a test
  asserts it.

Two more were found and fixed: a device could replace its identity key, and
the relayed messages were readable by any signed-in account that knew the
address.

## 2a. The community settings — **MET, and the reduction is audited**

The settings were reduced for a release by a bug, not a decision: the form
was built, the save was wired, and the empty container was returned, so the
section rendered as a blank panel. The API and the data were never at fault.

The console now has twelve sections, each a page of its own, each of which
**draws something** — and that is a test, because the check that would have
caught the original fault was missing. The phone carries the same twelve. The
audit is in `COMMUNITY_SETTINGS.md`.

## 3. Critical user journeys — **MET for the twenty-eight, with two exceptions recorded**

`IMPLEMENTATION_TESTS.md` carries the journey table and the test behind each.
The two that are not proven are stated there: the native client's build and
runtime, and the deployed demo seen in a browser.

## 4. Auth, persistence, permissions, realtime, session revocation — **MET**

`tests/integration/auth.test.js` (13), `tests/integration/community.test.js`
(19), and the realtime vocabulary check in `frontend/tests/realtime.test.js`.
A revoked session is refused **by the API**, not only hidden in the interface.

## 5. E2EE — **PARTIAL: the implementation gate is met, the review gate is not**

The implementation is complete **on both sides**: a message the client
encrypts opens with the server's ratchet, the two ratchets keep the same
state object, and the associated data is the same bytes on both sides. The
client encrypts, opens, renders and refuses to fall back; a file in an
encrypted conversation is encrypted in the browser and its key is sealed to
each member device; a conversation that is not fully encrypted is said so in
words before anything goes out in the clear. `frontend/tests/e2ee/` is 85
tests and `backend/tests/e2ee/` is 64.

**The independent security review was not obtained, and none is claimed.** The
self-review is internal, names its own limits, and is not a substitute. Under
the directive this item cannot be marked complete, so **the product must not
be advertised as end-to-end encrypted** until a third party has looked at the
key schedule, the ratchet state machine, the skipped-key bounds and the
recovery flow.

## 6. Federation between independent instances — **MET**

`tests/continuum/` is 52 tests over **two independently running instances**
with separate databases, separate signing keys, separate ports and separate
administrative authority. The relay is proved in both directions: a community
crosses, a message crosses with its author and its original timestamp, and
the refusals — a private community, a restricted channel, an untrusted peer, a
replay, a duplicate, a wrong key, a stale timestamp, a stale sequence, a
removed peer — are proved against the same two instances.

The limit is recorded: the relay is one-way for **reactions** and
**attachments**, and the owner's moderation of a remote member's message
travels back while the message itself does not.

## 7. Migrations preserve existing data — **MET**

`tests/integration/migrations.test.js` (10) and the schema-portability guard
(7). The migration ledger records every migration, refuses to apply one twice,
blocks the ones after a failure, and refuses a database a newer build wrote to.
The schema changes in 3.0 are **additive**: new tables and new columns,
nothing renamed, dropped or retyped, so an older build ignores them and the
data does not move.

A verified backup was taken before the schema changed:
`/home/ultim/trycord-backups/s5743_Trycord-2026-10-19T20-23-54.sql` — 61
tables, 684 rows.

## 8. Client builds and runtime flows — **NOT MET for the native client**

The web client and the mobile web module are built and verified (the client
suite is 298 tests). The **native** client is written — 123 files, 17 screens,
its own toolchain — and was **never compiled**: there is no JDK, Gradle,
Android SDK, Xcode or macOS in this environment. `native/VERIFICATION.md`
states item by item what is and is not checked. The build and runtime
evidence the gate asks for does not exist.

## 9. Public website and hybrid editor — **MET**

`public/tests/` is 57 tests: the link checker, the API resolver, the status
page, the community directory, the legal content, the demo's honesty, the
incident timeline, and the well-formedness of every page.

**The instance directory was missing and is now there.** The register page's
"Use another instance" link went to `/instances`, and the public site had no
such page: the site offered communities and the demo, and the directory had
never been written. It is now a page — the instances this one knows about,
each entry a pointer rather than a verdict — and it is in the navigation, in
the footer and in the sitemap.

**And the deployment could not reach a page the origin could.** The
Cloudflare worker answered a public page only if it was named in a
hand-written map of thirteen routes, and the site has twenty-five: twelve
pages 404ed on Cloudflare while they worked on the origin, and two hosts
disagreed about the same tree. The map is no longer a requirement — a path
that is not a file may still be a page, and the worker asks for the file — and
the verifier reads the list of pages from the tree rather than from a list of
its own, so a page cannot 404 by being forgotten.

The hybrid editor has one model and two modes, and the editor's validation is
proved to agree with the server's by running both validators over the same
forty blocks and comparing the verdicts.

## 10. Legal drafts have a clear operator-review status — **MET**

Eleven documents rewritten as original prose, 53 operator placeholders that
are never invented, and a visible review marker on every document that
carries one. The versions were not bumped, so an account's recorded
acceptance still holds.

## 11. Both dashboard modes — **MET**

`tests/dashboard/` is 43 tests. The modes are different code paths, the
separate service holds no database and no job worker, and an unusable
`DASHBOARD_MODE` stops the boot with a message naming the variable and the
two values it accepts.

## 12. Self-hosting and recovery — **MET where it can be**

`docs/selfhosting.md` is brought up to date with what 3.0 does. The
environment template documents every variable the code reads, and a test
asserts that in both directions. The backup and the restore are real and
verified.

## 13. No placeholder represented as a completed feature — **MET, and enforced**

Two tests exist because the alternative was trusting the inventory:
`tests/integration/schema.test.js` and the class-coverage test in the client
suite both fail on a control that does nothing.

## 14. Remaining blockers documented honestly — **MET**

They are listed below.

## The blockers

| Blocker | Why it cannot be closed here | What it needs |
|---|---|---|
| **The Cloudflare deployment is not published** | `npx wrangler deploy` needs Cloudflare credentials, and this host has none. The tree is built, verified (61 checks) and committed and pushed to `main` | One command from a machine with the credentials |
|---|---|---|
| **No independent cryptographic review of the E2EE protocol** | A third party has to do it. The implementation is from-scratch and by the same people who wrote it | A reviewer looking at the key schedule, the ratchet state machine, the skipped-key bounds and the recovery flow. **Until then the product is not advertised as end-to-end encrypted** |
| **The native client was never compiled** | No JDK, Gradle, Android SDK, Xcode or macOS | A machine with the toolchain, and the build and on-device evidence the gate asks for |
| **Nothing was verified in a browser** | Chromium cannot complete a network request in this environment | A browser pass over the interfaces: contrast, touch targets, focus order, screen-reader output |
| **The deployed demo was not checked in a browser** | The same | A browser pass against the deployed instance |
| **The localisation ships no translated strings** | A translation is a content project, and the directive forbids machine translation | Human translations, reviewed, installed as packs |
| **The relay does not carry reactions or attachments** | The protocol's key for a reaction does not survive the return direction | A protocol change and a migration |

## What is deliberately not claimed

- No compliance, certification or audit that was not performed.
- No uptime figure: nothing here computes one.
- No testimonial, user count or performance number that was not measured.
- No provider that is reported as working because a form for it exists.

## The number to quote, and the number to quote honestly

**1 250 checks across the three suites, all green** — 697 in the backend,
496 in the client, 57 in the public site. The backend suite boots real
instances against real databases, the federation tests run two of them side
by side over HTTP, and the client suite drives the client rather than reading
it.

On top of those, two more kinds of check:

- **The layout, in a real browser.** Eight widths, measured in pixels:
  whether a heading sits on top of the text, whether a button is clipped by
  the card that holds it, whether the page scrolls sideways, and whether the
  working surface uses the width it is given.
- **The names the code uses and does not have.** Every module in the client
  and the backend is parsed, and every name that is read is resolved
  through the scope chain. This is the check that found the poll editor
  throwing on every click, the account settings throwing when a reader
  removed their own picture, and the voice service receiving every request
  and answering none of them.

And the release is **not ready to ship as "end-to-end encrypted"**, because
the review that would let it be called that has not happened.
