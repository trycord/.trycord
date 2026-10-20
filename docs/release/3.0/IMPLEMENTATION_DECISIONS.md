# Trycord 3.0 — decisions

The decisions that shaped the release, with what was considered instead. A
decision without its alternative is a preference, not a decision.

Last updated: 2026-10-20, branch `release/3.0.0`.

## The verification suite is a new instance per test, not a shared one

**Decided:** the harness starts an instance against a temporary SQLite
database on a free port, with its own uploads directory and its own signing
secret.

**Instead of:** the suite that used to live in `backend/scripts/check-*.js`,
which booted whole instances, rendered every route through jsdom, walked the
realtime gateway with live sockets and started a browser.

**Why:** the old suite was removed for a real reason — on a small host it was
the largest source of load, and the power-on hook that ran it on every boot
turned a restart into a storm of processes. But a product with no tests is a
product whose behaviour is whatever a reader believes. The answer is a suite
that does not cost what the old one cost, not the absence of one.

**What it cost to get right:** the instances are hermetic through
`DOTENV_CONFIG_PATH` rather than through `process.env`, because a leaked
`DB_HOST` from the machine's own `.env` would point a run at a live database.
Each instance gets its own signing secret, because a shared one would let
one instance accept another's tokens — which is exactly the property the
architecture says the secret is never shared for.

## The schema is versioned, and the baseline stays

**Decided:** the idempotent baseline schema pass stays exactly as it was, and
a migration ledger is added on top of it.

**Instead of:** replacing the baseline with a versioned runner, or leaving the
schema unversioned.

**Why:** the baseline is what makes the boot safe — every statement is "create
it if it is not there", so it can run on every start against a database of
any age. What it cannot do is record that a *data* transformation ran, or
refuse a database a newer build wrote to. The ledger does those two things,
and the baseline does the rest. One mechanism doing the other's job would
have meant either a boot that could not apply a migration, or a migration
system that could not be relied on for the schema.

## Four boot-breaking defects were caught by a test, not by a deployment

**Decided:** a schema-portability test that checks every declared column
against MySQL's reserved-word list.

**Instead of:** finding them on the live instance.

**Why:** SQLite accepts `key`, `trigger`, `rank` and `cursor` as column
names. MySQL does not. A schema that only ever ran against SQLite looks
perfect until the day it meets MySQL, and the failure is a boot that will not
start. The test is a static check that takes milliseconds, and it found four
of them — `key` and `trigger` in the extension tables, `rank` in the poll
ballots, `cursor` in the federation feed — before any of them reached
production.

**The lesson worth keeping:** the first version of the test split the DDL on
commas without stripping comments, and a comment containing a comma produced
a false positive. The test was wrong before the schema was. A check that
cries to be clever about the shape of the thing it checks will eventually
check the wrong thing.

## The dashboard's mode is a deployment fact, not a saved setting

**Decided:** `dashboard.mode` is in the deployment-owned list, so the console
shows it read-only and the environment decides it.

**Instead of:** an ordinary setting an administrator could save.

**Why:** the separate dashboard service has no database of its own. It cannot
read a saved value. If an administrator could save "separate" in the console
while the process kept running "bundled", the console would report a mode
that was not in force, and the two processes would disagree about which
deployment they were part of. The environment is the only thing both of them
can see.

## The separate dashboard is a separate process, and that is asserted

**Decided:** the separate service is started as its own process, and the test
asserts it has no database connection and no job worker — by looking at the
modules it loaded and at the database configuration it was started with.

**Instead of:** a module inside the main process, switched by a setting.

**Why:** the directive requires a dashboard that is "not a third core
backend", and the only way to be sure of that is to make it demonstrably not
one. A process that holds no database connection, runs no workers and owns no
sockets cannot become a second source of truth by accident. A module inside
the main process could.

## E2EE is X3DH and the Double Ratchet, over the primitives Node already has

**Decided:** X25519, Ed25519, HKDF-SHA256, AES-256-GCM and PBKDF2 from
Node's own `crypto`. No new dependency.

**Instead of:** a purpose-built library, or a hand-rolled primitive.

**Why:** the directive is explicit that a novel primitive is not acceptable
and that established libraries are. Node's `crypto` is OpenSSL, and the four
primitives the Signal design needs are all in it. A dependency would have
brought its own supply chain, its own licence and its own version to audit,
for no cryptographic gain.

**What this does not solve:** an independent review. The implementation is
from-scratch and has had no external audit, and the self-review says so in
those words. The review gate in the release contract is not met, and the
release must not claim it is.

## The native client is React Native, and it is not verified

**Decided:** React Native (bare) for both iOS and Android, with the API
contracts, the design tokens and the domain types shared with the web client
and the interface entirely its own.

**Instead of:** Capacitor, or Compose Multiplatform, or a responsive web page.

**Why:** Capacitor's interface is web content, and the repository already has
a purpose-built mobile web module — wrapping it would be a second skin for
something that exists. Compose Multiplatform is the strongest fit for
"independent native experience" but is a much larger surface to author
correctly with no toolchain to check it. React Native is the most widely
maintained way to get real native views on both platforms from one codebase,
and its platform modules are the real ones.

**What this does not solve:** the toolchain. There is no JDK, Gradle, Android
SDK, Xcode or macOS here, so the client was written and checked for internal
consistency, and it was **not compiled, run or put on a device**. The release
gate asks for build and runtime evidence. It does not exist, and the client
is not marked complete.

## The page editor has one content model, and it is the server's

**Decided:** the editor edits the server's typed blocks, and its source mode
is a two-way projection of them.

**Instead of:** a richer model of the editor's own.

**Why:** the server's `pageContent` module is what validates a page and what
renders a published one. A second model would mean two validators and two
renderers, and a document that survived the editor and arrived at the
published page different from what the editor showed. The source mode is
therefore a projection of the blocks, not a separate document format — which
is why blocks → source → blocks returns the same list.

**What this does not solve:** the directive's editor list names images,
tables, quotations and code blocks. The server's vocabulary has no image and
no table, so the editor refuses them with the line they are on rather than
offering something the published page would not honour. Quotations and code
travel the way the legacy BBCode carries them. The gap is real and is
recorded as one.

## The community tree's management lives in one module

**Decided:** the channel and category operations live in
`frontend/js/community/manage.js`, and both the tree and the settings page
use them.

**Instead of:** implementing them in the tree, and leaving the settings page
with its own copy.

**Why:** they are the same operations. Two copies would eventually disagree
about what a channel name is, about what creating one does, and about which
of them is offered to whom — and the disagreement would show up as a
control that works in one place and not the other.

## The push registry is real; the push transport is not

**Decided:** the device registry, its API and the account-deletion cleanup
are implemented, the feature is off by default, and the endpoint refuses an
instance that has push switched off.

**Instead of:** accepting a registration on an instance that will never use
it, and telling a reader that notifications work.

**Why:** the directive forbids a feature that is not implemented being
presented as one. A registry that stores a device token and nothing else is
a partial feature, and the honest way to present a partial feature is to
refuse the registration rather than quietly accept it. What is missing — the
transport to Apple's and Google's servers, which needs credentials the
operator holds — is named in the capability inventory.

## The legal documents are rewritten, and the version numbers did not change

**Decided:** eleven documents rewritten as original prose, with 53 operator
placeholders that are never invented, a visible review marker on every
document that carries them, and `TERMS_VERSION` left at 1.0.

**Instead of:** bumping the version to 1.1 with the rewrite.

**Why:** the version is what an account's acceptance is recorded against. A
rewrite that did not change the substance of the terms does not need a new
version, and bumping it would have made every existing account's recorded
acceptance stale — for a change that is mostly a change of wording. The
review markers say plainly that the documents need a lawyer's eye before they
are presented as binding.
