# Extensions and workflows

What this document is: the extension model, the permission model, what
"running in a sandbox" means here in practice, the registry, and the workflow
engine. It is reference, not a plan.

Last verified: the extension and workflow suites pass against a running
instance (`backend/tests/extensions/`, `backend/tests/workflows/`). The
sandbox claims below are the ones the suite measures; where the suite cannot
prove something, this document says so rather than implying it.

## The model

An extension is a package. A package is a JSON document with:

| Field | Meaning |
|---|---|
| `id` | The package id. Lowercase letters, digits, dots, dashes and underscores. `trycord.welcome` is the shape. |
| `name`, `description` | What it is called and what it does. |
| `version` | `1.2.3`. Used for updates and rollbacks. |
| `author`, `maintainers` | Who wrote it and who looks after it. |
| `homepage` | Where it lives. |
| `entryPoint` | The name of the entry point, for the operator's benefit. |
| `capabilities` | The capabilities the package asks for. |
| `compatibility` | `{ "api": "3.0", "minInstance": "3.0.0", "maxInstance": null }`. |
| `dependencies` | `{ "other.package": "^1.0.0" }`. |
| `trusted` | Whether the package carries server-side code. |
| `reviewStatus` | `unreviewed`, `in-review`, `approved` or `rejected`. |
| `triggers` | What it reacts to and what it does. |
| `entry` | Server-side source. Only a `trusted` package may carry one. |

The extension API version is the major and minor of the application release
(`3.0` for this one). A package that targets another one is refused at
install time rather than installed and left to fail at its first step.

An installed extension is in one of these states: `installed`, `enabled`,
`disabled`, `failed`, `removed`. A package that is in the registry but not
installed is `available`, which is a registry state rather than an installed
one.

### What an extension actually is

An extension is one or more workflows. Each trigger in the manifest becomes a
workflow that the engine runs. There is no second execution model: an
extension's trigger is a workflow's trigger, and an extension's capabilities
are its workflows' capabilities.

That is deliberate. A declarative extension has no code in it at all, so
there is nothing to execute and nothing to contain.

## Capabilities

The catalogue is closed. A capability that is not in it cannot be requested,
granted or checked, so a package cannot name a permission the instance does
not understand and have it quietly treated as satisfied.

| Capability | Unlocks |
|---|---|
| `messages.read` | `channel.history` |
| `messages.write` | `message.post`, `reaction.add` |
| `members.read` | `member.count` |
| `members.write` | `member.role.add` |
| `webhooks.manage` | `webhook.notify` |
| `admin.read` | `instance.stats` |
| `workflows.run` | `workflow.run` |
| `storage.write` | `storage.put` |
| `federation.read` | `federation.status` |

`log` needs no capability. It writes a line into the run history and does
nothing else.

The permission model has three parts:

- **A package asks.** `capabilities` in the manifest is the request.
- **An operator answers.** The install request carries the capabilities that
  are granted. A capability the package did not ask for is refused, with the
  reason, rather than granted quietly.
- **Every call is checked.** The check is on the call, not on the install.
  Revoking a capability takes effect on the next call, without a restart.

A workflow somebody created runs with the capabilities that let it act as its
owner - `messages.read` and `messages.write`, which the owner can already do
by hand - and nothing else. Anything beyond that waits for an administrator,
who grants it on the workflow with `POST /api/extensions/workflows/:id/grants`.
The grant is recorded in the audit trail.

A workflow that belongs to an extension runs with the extension's grants, read
live from the extension's grant rows. An extension's grants are therefore the
workflows' grants, and a revoked extension capability stops its workflows on
their next call.

## The sandbox, and what it does not do

Server-side extension code is off by default. A package that is not marked
`trusted` cannot carry source at all, and the instance policy has to allow
trusted packages before one can be installed. Almost every extension never
needs it: the declarative path exists for exactly that reason.

A trusted package's source runs in `node:vm`, inside a worker thread, with a
restricted global and a budget. What is actually enforced:

- **A fresh context.** `require`, `process`, `fs` and the host's `globalThis`
  are not in it, and nothing in the context reaches them.
- **Code generation from strings is disabled.** `eval`, the `Function`
  constructor and the async and generator function constructors all throw
  inside the context. That closes the standard way out of a vm context:
  `globalThis.constructor.constructor('return process')()` reaches the outer
  realm's `Function`, which is not restricted, and without the rule it
  returns the host's `process`.
- **Every function the extension holds was created inside the context.** A
  function from the outer realm carries the outer `Function` constructor with
  it, so handing the context an outer function would undo the rule above.
  The API surface is therefore built inside the context and calls the host
  through a closure the extension cannot open.
- **Values cross the boundary as strings.** Requests and replies are JSON
  strings, parsed on the far side, so an object from the outer realm cannot
  carry the outer realm's constructors into the context.
- **A wall-clock deadline.** The whole run is bounded, including an entry
  point that is waiting for a call that will never be answered.
- **A memory ceiling.** The worker runs with `resourceLimits`, so an
  extension that allocates without bound is stopped by the runtime rather
  than by the instance running out of memory.
- **A call budget.** Every call the extension makes is counted on this side
  of the boundary, where the extension cannot reach the counter, and the run
  stops when the budget is gone.

What is **not** enforced, and cannot be with Node's own vm: this is not a
hardened jail. Node does not provide a security boundary between a vm
context and its host, and a determined attacker may find a route this
implementation has not closed. The mitigation is structural rather than
technical - server-side code is off by default, it needs an operator to
allow it, it is trusted code, and the declarative path exists so that most
extensions never need it.

`backend/tests/extensions/sandbox.test.js` proves the routes that are closed
are closed: `require`, `process`, `module` and the host's global are
unreachable, the constructor escape throws, a runaway loop is stopped at its
deadline, and a call budget is enforced. It does not prove the absence of
every possible escape, and this document does not claim it.

### The API an extension sees

```js
const answer = await trycord.call('message.post', {
  channelId: 'the-channel',
  content: 'hello',
});
```

`trycord.call` takes the name of an action and its parameters. The name is
checked against the action catalogue, the capability the action needs is
checked against the extension's grants, and the call is counted against the
budget. All three happen on the host's side of the boundary.

Errors arrive as `Error` objects whose message says what was refused. A
refused capability says so:

```
the workflow has not been granted the capability "messages.write"
```

`console.log`, `console.info`, `console.warn` and `console.error` exist and
write to the instance's log. `setTimeout` and `clearTimeout` exist with the
delay capped at a minute. The entry point is the body of an async function:
it may `await`, and its return value is the run's output. It must await its
own work - the sandbox is torn down when it returns.

## The registry

The registry is optional and mirrorable, and nothing in the instance depends
on it being reachable. A self-hosted instance with no registry still serves
messages, and a registry that is down costs the operator a package list and
nothing else.

Three sources, chosen in the instance policy:

| Mode | Where the packages come from |
|---|---|
| `disabled` | Nowhere. The registry is off. |
| `builtin` | The first-party directory shipped with the instance (`backend/src/services/extensions/builtin/registry.json`). |
| `mirror` | The operator's own registry: an HTTP(S) URL, or a local directory. |

A mirror directory holds either one `registry.json` containing a list, or one
file per package. A mirror URL is fetched with an eight-second timeout and a
size cap. The registry URL is operator-configured and is fetched server-side;
it is not restricted to public addresses, because a mirror is often on a
private network and the operator is trusted with the instance.

The last known copy is kept in the registry cache table. When a fetch fails,
the cached copy is still served and the failure is reported next to it, so an
operator looking at a list during an outage sees what they saw before and
knows why it might be old.

### Review status

Every package carries a review status: `unreviewed`, `in-review`, `approved`
or `rejected`. Only `approved` is installed by default. An operator who
trusts their own mirror can set `allowUnreviewed`, which admits `unreviewed`
and `in-review` packages; `rejected` is refused either way.

### Restricted mode

`allowlist` is a list of package ids. When it is not empty, only those
packages may be installed, and the listing says which of the others are
blocked and why. This is the mode an instance uses when it should install
from a mirror and nothing else.

### Signatures

Signing is optional and configurable, because most packages are not signed
and pretending otherwise would be a lie about the registry.

A package may carry:

```json
{ "signature": { "keyId": "key-1", "algorithm": "hmac-sha256", "value": "..." } }
```

Two algorithms, both from Node's own `crypto`:

- `hmac-sha256` - a shared secret the operator and the publisher both hold.
- `ed25519` - a public key the operator holds and the publisher keeps the
  private half of.

The signature covers a canonical form of the package document: object keys
sorted, arrays in order, and the signature member itself excluded. Two
documents that mean the same thing produce the same bytes.

The keys live in the policy:

```json
{ "signingKeys": { "key-1": { "type": "hmac-sha256", "secret": "..." } } }
```

With `requireSignature` on, a package whose signature is not `verified` is
refused. The status of every package is reported: `verified`, `failed`,
`unsigned` or `unverifiable` (no trusted key is configured for its key id).

**None of the packages shipped with the instance carry a signature.** The
first-party registry is marked `approved` because those packages ship with
the instance, not because they are signed. An instance that requires
signatures must point at a registry whose packages are signed.

## The lifecycle

Every action is audited. The audit trail is the repository's own
`audit_logs` table, and the actions are `EXTENSION_INSTALLED`,
`EXTENSION_ENABLED`, `EXTENSION_DISABLED`, `EXTENSION_UPDATED`,
`EXTENSION_ROLLED_BACK`, `EXTENSION_REMOVED`,
`EXTENSION_CAPABILITY_GRANTED`, `EXTENSION_CAPABILITY_REVOKED`,
`EXTENSION_POLICY_UPDATED`, and the `WORKFLOW_*` actions.

| Action | What it does |
|---|---|
| Install | Validates the package, checks the registry's rules, the compatibility declaration and the dependencies, stores the package and its first version, records the grants, and creates the workflows. The state becomes `installed` and the workflows are paused. |
| Enable | The state becomes `enabled` and the workflows are activated. |
| Disable | The state becomes `disabled` and the workflows are paused. The capabilities are not revoked, only unused. |
| Update | Installs a newer version from the registry. The previous version stays on disk. |
| Roll back | Restores the manifest and the code of an earlier version exactly as they were approved. |
| Remove | Revokes the capabilities, pauses the workflows, and marks the extension `removed`. The record stays: the audit trail and the run history still refer to it. |

### Dependencies

A dependency that is not installed, is installed at the wrong version, or is
installed but not enabled is a refusal, and the reason says which of those it
is. Installing a package that would close a dependency loop is refused too:
the dependency graph is walked before the install, and a cycle is reported
with the two packages that make it.

## Workflows

A workflow is a trigger, some conditions and some steps. It runs with a
capability grant set, it is bounded, and every run is recorded.

```json
{
  "name": "Answers a question",
  "trigger": { "type": "event", "event": "message.created" },
  "conditions": [{ "field": "content", "op": "contains", "value": "question" }],
  "steps": [
    { "type": "action", "action": "message.post",
      "params": { "channelId": "the-channel", "content": "here is an answer" } }
  ],
  "grants": ["messages.write"],
  "onError": "stop"
}
```

### Triggers

`event`, `manual` and `schedule`.

The event vocabulary is the one the application already uses. The realtime
gateway publishes `message`, `message_updated` and `dm:message`; the
outgoing webhook service publishes `message.created`, `member.joined` and
the rest of the domain vocabulary. Both spellings name the same thing, so
the alias table maps the realtime spelling onto the domain one:

| Canonical | Aliases |
|---|---|
| `message.created` | `message` |
| `message.updated` | `message_updated` |
| `message.deleted` | `message_deleted` |
| `message.reacted` | `message_reaction` |
| `dm.message.created` | `dm:message` |
| `member.joined` | |
| `member.left` | |
| `channel.created`, `channel.deleted` | |
| `role.created`, `role.updated`, `role.deleted` | |
| `command.created` | |
| `notification.created` | `notification` |
| `presence.updated` | `presence` |

A workflow names one of these. An event that is not in the list is refused
when the workflow is saved.

An event reaches the engine through `services/workflows/engine.js#publish`.
The instance's own event sources call that function; the HTTP route
`POST /api/extensions/events` is the same door, and it is what lets an
operator drive a workflow by hand.

### Conditions

A condition is a field path, an operator and a value. There is no expression
language and nothing is evaluated as code.

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `notContains`,
`in`, `exists`.

The values a condition reads are the event payload, the run's own facts and
the output of the steps that have already run. Every condition has to hold;
the run history says which one did not.

### Steps

A step is an action or an approval. Parameters may contain `{{path}}`
placeholders, which are substituted from those same values: `{{serverId}}`,
`{{content}}`, `{{steps.0.output.count}}`. A placeholder that names a path
that is not there is left as written, so a message containing braces is not
silently emptied.

An approval step pauses the run. The run's status becomes
`awaiting_approval` and it carries on when somebody decides:

```
POST /api/extensions/workflows/runs/:runId/approve
{ "approved": true, "comment": "go ahead" }
```

An approval with `approvers: ["admin"]` needs a platform administrator; one
with a list of user ids needs one of them.

### Loop prevention

A workflow is never woken by its own output. The origin marker travels with
an event - which run produced it, and how many hops it is from the original
- and a workflow whose id matches the origin is skipped. The skip is recorded
as a run with the status `skipped` and the reason, so the history shows that
the engine saw the event and decided not to act on it.

The hop budget is the second line of defence, for a cycle that goes through
several workflows: a run may be at most `maxDepth` hops from the original
(three by default), and a run past that is skipped as well.

### Idempotency

A run's key is derived from the workflow, the trigger and an idempotency
key. For an event, the idempotency key is the event's `id` if it has one and
a hash of its contents if it does not; so the same event published twice is
the same event, and the second attempt resolves to the run that already
happened instead of doing the work again.

The message a run posts carries the run key as its client nonce, and the
unique index on `(channel_id, client_nonce)` is what makes a repeated
attempt resolve to the message that was already written.

An event published twice with the same payload and no `id` is treated as the
same event. Give an event an `id` when two genuinely different occurrences
of the same thing should be two runs.

### Bounds

| Bound | Default |
|---|---|
| Runs per window | 30 per 60 minutes |
| Run duration | 30 seconds |
| Child runs per run | 5 |
| Hops from the original event | 3 |
| Steps per workflow | 50 |

A run that reaches its duration limit fails with the reason. A run that
reaches its run budget is refused before it does anything; nothing happened,
so there is no run to record.

### Failure

A failing step is recorded with the reason. What happens next is the
workflow's own `onError`:

- `stop` (the default) - the run stops and its status is `failed`.
- `continue` - the run carries on, and its status is `partial`.

A run that had a failing step is never reported as succeeded.

### Versions and dry runs

A workflow's version goes up when it is changed, and every run records the
version and the definition it ran, so the history stays readable after the
workflow has been edited.

A dry run evaluates the conditions and describes the steps without doing any
of them. No message is posted, no capability is spent, and every step is
recorded as `planned`:

```
POST /api/extensions/workflows/:id/dry-run
```

The answer carries the plan: the action, the capability it would need and
what it does.

### Schedules

A workflow with a schedule trigger (`{ "type": "schedule", "everyMs": 300000 }`)
runs every five minutes or whatever the interval is. The schedule is
idempotent - the time a run was due is its run key, so a repeated tick runs
it once.

The schedule is driven by the job system. The instance registers the job
kind at boot:

```js
const workflows = require('./services/workflows');
jobs.register('workflow.schedule', workflows.handleScheduleTick, { concurrency: 1 });
workflows.startScheduler();
```

`startScheduler()` checks that the kind is registered before it enqueues
anything, so an instance that has not wired it up does not fill its job queue
with jobs that can only fail.

## The API

Mounted at `/api/extensions`.

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/extensions/policy` | administrator |
| `PUT` | `/api/extensions/policy` | administrator |
| `GET` | `/api/extensions/registry` | any account |
| `GET` | `/api/extensions/registry/:packageId` | any account |
| `GET` | `/api/extensions/installed` | administrator |
| `POST` | `/api/extensions/install` | administrator |
| `GET` | `/api/extensions/:extensionId` | administrator |
| `POST` | `/api/extensions/:extensionId/enable` | administrator |
| `POST` | `/api/extensions/:extensionId/disable` | administrator |
| `POST` | `/api/extensions/:extensionId/update` | administrator |
| `POST` | `/api/extensions/:extensionId/rollback` | administrator |
| `DELETE` | `/api/extensions/:extensionId` | administrator |
| `POST` | `/api/extensions/:extensionId/grants` | administrator |
| `DELETE` | `/api/extensions/:extensionId/grants/:capability` | administrator |
| `GET` | `/api/extensions/workflows` | any account |
| `POST` | `/api/extensions/workflows` | any account |
| `GET` | `/api/extensions/workflows/:workflowId` | the owner, or an administrator |
| `PUT` | `/api/extensions/workflows/:workflowId` | the owner, or an administrator |
| `POST` | `/api/extensions/workflows/:workflowId/run` | the owner, or an administrator |
| `POST` | `/api/extensions/workflows/:workflowId/dry-run` | the owner, or an administrator |
| `POST` | `/api/extensions/workflows/:workflowId/pause` | the owner, or an administrator |
| `POST` | `/api/extensions/workflows/:workflowId/resume` | the owner, or an administrator |
| `GET` | `/api/extensions/workflows/:workflowId/runs` | the owner, or an administrator |
| `POST` | `/api/extensions/workflows/:workflowId/grants` | administrator |
| `DELETE` | `/api/extensions/workflows/:workflowId/grants/:capability` | administrator |
| `GET` | `/api/extensions/workflows/runs/:runId` | the owner, or an administrator |
| `POST` | `/api/extensions/workflows/runs/:runId/approve` | the approver |
| `POST` | `/api/extensions/events` | administrator |

Errors use the instance's envelope: `{ "error": { "code": "...", "message":
"..." } }`.

An install names the capabilities it grants. The list is the consent, and an
install without it is refused:

```
POST /api/extensions/install
{ "id": "trycord.welcome", "grants": ["members.read", "messages.write"] }
```

## Where things live

| | |
|---|---|
| The tables | `backend/src/db/tables/extensions.js` - one module, because an extension and its workflows are one concern. |
| The capability catalogue | `backend/src/services/extensions/capabilities.js`. |
| The package format | `backend/src/services/extensions/packages.js` - validation, compatibility, version ranges. |
| The registry | `backend/src/services/extensions/registry.js` - the sources, the cache, the installability rules. |
| Signatures | `backend/src/services/extensions/signature.js`. |
| The sandbox | `backend/src/services/extensions/sandbox.js` - the vm context, the worker, the limits. |
| The bridge | `backend/src/services/extensions/bridge.js` - the host side of the sandbox, where the capability check happens. |
| The lifecycle | `backend/src/services/extensions/lifecycle.js`. |
| The engine | `backend/src/services/workflows/engine.js` - the run loop, the origin marker, the budgets. |
| The actions | `backend/src/services/workflows/actions.js` - the catalogue and the capability each one needs. |
| The trigger vocabulary | `backend/src/services/workflows/triggers.js`. |
| The schedules | `backend/src/services/workflows/schedule.js`. |
| The routes | `backend/src/routes/extensions.js`. |
| The tests | `backend/tests/extensions/`, `backend/tests/workflows/`. |

## What an operator has to wire

Two things, both in the backend's boot:

```js
// the router
app.use('/api/extensions', require('./routes/extensions'));

// the schedule
const workflows = require('./services/workflows');
jobs.register('workflow.schedule', workflows.handleScheduleTick, { concurrency: 1 });
workflows.startScheduler();
```

The tables are in `backend/src/db/tables/extensions.js` and belong in the
schema's group list.
