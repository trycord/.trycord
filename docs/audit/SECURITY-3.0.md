# Security audit — Trycord 3.0 subsystems

A review of the parts of Trycord that arrived in 3.0: the encryption, the
federation, the extension and workflow engine, the versioned developer API,
the workspace, the cross-instance reports, the localisation and theme packs,
and the provider catalogue — plus the browser half of the encryption.

The older parts of the product were reviewed in `docs/audit/SECURITY.md`.
This document covers what came after it and does not repeat it.

## Method

Every control is marked with how it was checked:

- **Verified** — the behaviour was exercised: a regression test in
  `backend/tests/security-3.0/`, a script whose output is quoted here, or a
  command.
- **Read** — the control was read in the source and its reasoning followed,
  but its behaviour was not exercised in this audit.

Section 6 lists what was read and not verified. The distinction matters:
S3-01 was a claim in a source comment ("nothing in the context can reach
them") that was false, and it was found only because the claim was exercised
rather than read.

---

## 1. Findings

| # | Finding | Class | Severity | Status |
|---|---|---|---|---|
| S3-01 | The extension sandbox could be left through the timer handle | Sandbox escape | High | Fixed |
| S3-02 | A workflow could hand out any role in any community | Privilege escalation | High | Fixed |
| S3-03 | Any signed-in account could read an extension's run history | Broken object-level authorisation | High | Fixed |
| S3-04 | Any signed-in account could read another reporter's cross-instance report | Broken object-level authorisation | Medium | Fixed |
| S3-05 | The developer API reported a webhook's health across communities | Broken object-level authorisation | Medium | Fixed |
| S3-06 | Two workflow actions ignored the owner's standing in the community | Broken object-level authorisation | Medium | Fixed |
| S3-07 | The sandbox declared an output limit and a call limit it did not apply | Resource limit not enforced | Low | Fixed |
| S3-08 | Any signed-in account could drain a device's one-time prekeys | Availability / cryptographic downgrade | Low | Fixed |
| S3-09 | The extension registry mirror is fetched without the network guard | SSRF (operator-configured) | Low | Fixed |

---

### S3-01 — the extension sandbox could be left through the timer handle

**Severity: high. A trusted extension's server-side code could reach `process`,
`require` and therefore the whole instance.**

**Class:** sandbox escape.

`backend/src/services/extensions/sandbox.js`, before the fix: the context was
created with `codeGeneration: { strings: false, wasm: false }` (line 67), which
closes the standard route out of a `node:vm` context — `eval`, `new Function`
and `fn.constructor.constructor` all fail inside it. The module's own header
comment claimed two more things:

> * The context global is built from nothing. `require`, `process`, `fs` and
>   the host's `globalThis` are not in it, and nothing in the context can reach
>   them.
> * Every function the extension can call is created inside the context. A
>   function from the outer realm carries the outer `Function` constructor
>   with it, and that one is not restricted — so handing the context an outer
>   function would undo the code-generation rule.

Both were true of the *code* the context ran, and false of the *values* it was
handed. The context's `setTimeout` was:

```js
'  const setTimeout = (fn, delay) => setTimer(fn, Math.min(Number(delay) || 0, maxDelay));'
```

with `setTimer` being the worker's own `setTimeout`. Node's `setTimeout`
returns a `Timeout` object — a host object, created in the worker's main
realm. Its `constructor` is the host realm's `Timeout` class, whose
`constructor` is the host realm's `Function`. The context's code-generation
rule only applies to code compiled *in the context's realm*; the outer
`Function` compiles in the outer realm, where the rule does not apply.

The same hole was open from the other side. Node invokes a timer callback with
the handle as its receiver, so a callback written as a plain function saw the
handle as `this`, and `this.constructor.constructor` was the outer `Function`
again.

**Verified by running.** Before the fix, the following script (run against the
unmodified module) reached the host:

```
$ node /tmp/opencode/probe-sandbox.js
{
  "ok": true,
  "output": {
    "timeoutCtor": "Timeout",
    "F_is_function": "function",
    "processReached": "object",
    "envSeen": 33,
    "requireReached": "function"
  }
}
```

`processReached: "object"` is the host's `process` object, with 33 environment
variables in it. `requireReached: "function"` is Node's `require`, which reaches
every built-in module: `fs`, `child_process`, `net`, and the database driver.
The second route:

```
$ node /tmp/opencode/probe-sandbox2.js
{
  "ok": true,
  "output": { "returnedCtor": "Timeout", "thisCtor": "Timeout", "processViaThis": "object" }
}
```

**Impact.** With the operator's `allowTrusted` policy set and a package marked
`trusted` installed, the package's own `entry.source` runs with the full
authority of the instance process: the database file, the environment
(`JWT_SECRET`, the storage keys, the database password), the filesystem, and
the ability to spawn processes. The sandbox was the *only* thing between a
package from a mirror registry and the whole instance, and it did not hold.
The precondition is real but it is the precondition the sandbox exists for:
"trusted" means the operator has approved the code, not that it is safe.

**Fix.** `backend/src/services/extensions/sandbox.js`. The worker keeps the
timer handles and the context is given a number; the callback is called with
no receiver:

```js
let nextTimerId = 0;
const timers = new Map();

function setTimer(fn, delay) {
  const id = ++nextTimerId;
  const handle = setTimeout(() => { Reflect.apply(fn, undefined, []); }, delay);
  timers.set(id, handle);
  return id;
}

function clearTimer(id) {
  const key = Number(id);
  const handle = timers.get(key);
  if (!handle) return;
  timers.delete(key);
  clearTimeout(handle);
}
```

`Reflect.apply(fn, undefined, [])` is the second half: a sloppy-mode callback
called with no receiver gets the *context's* global as its `this`, not the
host's handle.

**Regression test.** `backend/tests/security-3.0/sandbox-escape.test.js`. The
two escape tests fail against the unfixed module and pass against the fixed
one; that was checked by reverting the fix, running the file (2 failed, 2
passed) and restoring it.

---

### S3-02 — a workflow could hand out any role in any community

**Severity: high. A workflow could make anybody an administrator of a
community.**

**Class:** privilege escalation — a capability that was not checked at the
point of use.

`backend/src/services/workflows/actions.js`, before the fix, `member.role.add`
was:

```js
'member.role.add': {
  capability: 'members.write',
  description: 'Give a member a role.',
  async run(params, ctx) {
    const serverId = requiredString(params, 'serverId', 64);
    const userId = requiredString(params, 'userId', 64);
    const roleId = requiredString(params, 'roleId', 64);
    const member = await db.get('SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?', [userId, serverId]);
    if (!member) throw actionError('that person is not a member of the community');
    const role = await db.get('SELECT id FROM roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
    if (!role) throw actionError('that role does not exist in the community');
    await db.run('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', [serverId, userId, roleId]);
    ...
```

Three things were missing, and the interactive route that does the same job
(`backend/src/routes/roles.js:162`, `POST /roles/:roleId/assign`) has all
three:

1. **`MANAGE_ROLES` was not required.** The interactive route gates on it
   (`requirePerm('MANAGE_ROLES')`). The action only asked for the
   `members.write` capability, which an administrator grants on the
   understanding that a workflow may "manage membership".
2. **The hierarchy was not checked.** `routes/roles.js:171` calls
   `assertAssignable`, so a mid-ranked moderator cannot hand out a role
   ranked at or above their own.
3. **The delegation was not bounded.** `routes/roles.js:82`
   (`assertDelegable`) refuses a role that carries a permission the actor does
   not hold, and refuses `'*'` for anybody but the owner. The action had no
   equivalent.

The result: a workflow with `members.write` could insert *any* role of *any*
community into *any* member's `member_roles` row. A role carrying
`MANAGE_SERVER`, `BAN_MEMBERS` or `MANAGE_ROLES` is a promotion to
administrator. And because the action never asked whether the workflow's
owner was a member of the community at all, the target community could be one
the workflow's owner had no standing in.

**Impact.** A workflow owned by an ordinary member, with the `members.write`
capability granted to it by an administrator, could make any member of any
community an administrator of that community — including a community its owner
was not a member of, and including a role carrying the literal `'*'`.

**Fix.** `backend/src/services/workflows/actions.js`. Two new helpers, and the
action now calls them:

```js
async function assertMayAdministerRoles(ctx, serverId) {
  await assertMemberOfCommunity(ctx, serverId);
  const permissions = require('../permissions');
  const allowed = await permissions.hasPermission(ctx.ownerId, serverId, 'MANAGE_ROLES');
  if (!allowed) {
    throw actionError('the workflow owner may not administer roles in that community');
  }
}

async function assertDelegable(ctx, serverId, raw) {
  const permissions = require('../permissions');
  const held = await permissions.effectivePermissions(ctx.ownerId, serverId);
  if (held.has('*')) return;
  let granted = [];
  try { granted = JSON.parse(raw || '[]'); } catch { granted = []; }
  const forbidden = granted.filter((p) => p === '*' || !held.has(p));
  if (forbidden.length) {
    throw actionError('the workflow owner may not grant permissions they do not hold: ' + forbidden.join(', '));
  }
}
```

**Regression test.** `backend/tests/security-3.0/workflow-authorisation.test.js`.
It proves the refusal (a member without `MANAGE_ROLES` is refused; a moderator
cannot hand out a role carrying `MANAGE_SERVER`; the grant does not happen)
and that the legitimate path still works (a moderator handing out a role they
hold, and the community owner). Against the unfixed module four of the six
subtests fail.

---

### S3-03 — any signed-in account could read an extension's run history

**Severity: high. The content of the messages that flowed through an installed
extension was readable by every account on the instance.**

**Class:** broken object-level authorisation.

`backend/src/routes/extensions.js`, before the fix:

```js
router.get('/workflows/:workflowId/runs', auth, wrap(async (req, res) => {
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id && workflow.source !== 'extension') {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  res.json({ runs: await workflows.history(req.params.workflowId, req.query.limit) });
}));
```

The `workflow.source !== 'extension'` clause was what made the route open: an
extension's workflow is owned by the administrator who installed it, so
`workflow.ownerId !== req.user.id` for every other account, and the
`source` clause then waved the last one through.

Reading a workflow's *definition* is by design — it is how a reader sees what
an installed extension does, and `listVisible` does the same. Reading its
*run history* is a different thing. A run records the event that woke it
(`workflow_runs.payload`, shaped by `backend/src/services/workflows/store.js:155`
— `runShape` includes `payload`), and the payload of a `message.created` event
carries the message. `backend/src/services/workflows/actions.js:204` publishes
exactly that:

```js
ctx.publish('message.created', { serverId, channelId, messageId, authorId, content });
```

The sibling route `GET /workflows/runs/:runId` already applied the right rule
(`backend/src/routes/extensions.js:195-203`: the owner or an administrator).
The list route did not.

**Impact.** Any account on the instance could read the run history of any
installed extension, and through it the content of every message that
triggered that extension, in every community it was installed in.

**Fix.** `backend/src/routes/extensions.js`. The history is the owner's and
the administrator's, which is the rule the single-run route already applies:

```js
if (!admin && workflow.ownerId !== req.user.id) {
  return fail(res, 'PERMISSION_DENIED', 'that run history is not yours');
}
```

**Regression test.** `backend/tests/security-3.0/extension-run-history.test.js`.
It installs a trusted package with a `message.created` trigger, publishes an
event whose payload carries a marker string, and proves that a stranger gets
403 from the list route and from the single-run route while the operator still
reads the history. Against the unfixed route the "another account does not"
subtest fails.

---

### S3-04 — any signed-in account could read another reporter's cross-instance report

**Severity: medium. A report's target instance, community, channel, content id
and the reporter's free-text reason.**

**Class:** broken object-level authorisation.

`backend/src/routes/federation-reports.js`, before the fix:

```js
router.get('/mine/:id', auth, rateLimit(30), async (req, res, next) => {
  try {
    const report = await reports.get(req.params.id);
    if (report.direction !== 'outbound') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such report' } });
    }
    res.json(report);
  } catch (e) { serviceError(res, e); }
});
```

The only check was the direction. `reports.get(id)`
(`backend/src/services/cross-instance-reports.js`) selected the row by id
alone and did not select `reporter_id` at all, so the route had nothing to
check the reporter against.

**Impact.** Any signed-in account that learned a report's id could read it.
The id is a uuid, so guessing is impractical; but the id is not a secret, it
travels in the answer to the reporter's own `POST /api/federation-reports`
(`res.data.id`), and it can appear in a support ticket, a log line or a
screenshot. The report carries the reason the reporter typed, which is the
one field a reporter is likely to have written something sensitive in.

**Fix.** `backend/src/services/cross-instance-reports.js` and
`backend/src/routes/federation-reports.js`. The reporter is a filter in the
service, next to the row it selects:

```js
async function get(id, options = {}) {
  const reporterId = options.reporterId ? String(options.reporterId) : null;
  const row = await db.get(
    'SELECT ... FROM cross_instance_reports'
    + ' WHERE id = ?' + (reporterId ? ' AND direction = ? AND reporter_id = ?' : ''),
    reporterId ? [id, 'outbound', reporterId] : [id]
  );
  if (!row) notFound();
  ...
```

and the route passes `{ reporterId: req.user.id }`. A report that is not the
caller's is not found, so the answer does not say that the id exists.

**Regression test.** `backend/tests/security-3.0/federation-reports-authorisation.test.js`.
Two reporters, one report: the reporter reads it, the other account gets 404
and the reason does not appear in the answer. Against the unfixed route the
"another account does not" subtest fails.

---

### S3-05 — the developer API reported a webhook's health across communities

**Severity: medium. Another community's webhook delivery log.**

**Class:** broken object-level authorisation (cross-tenant).

`backend/src/services/developer/health.js`, before the fix:

```js
async function webhookHealth(webhookId) {
  const hook = await db.get('SELECT * FROM webhooks WHERE id = ?', [webhookId]);
  ...
```

The route `GET /communities/:serverId/webhooks/:webhookId/health`
(`backend/src/routes/developer/webhooks.js:225`) requires `MANAGE_SERVER` in
`:serverId` — but `:webhookId` was resolved against the `webhooks` table by
id alone, so the community in the path and the community the webhook belongs
to did not have to be the same one. The sibling route, the delivery log,
scoped it correctly (`webhooks.deliveries(webhookId, serverId, limit)`), so
the two disagreed.

**Impact.** A manager of any community could read the delivery log of any
other community's webhook: the event types that were delivered, the status
codes the endpoint answered with, and the error text the delivery recorded —
which is the endpoint's own response, and is often somebody else's service.

**Fix.** `backend/src/services/developer/health.js` and
`backend/src/routes/developer/webhooks.js`. The lookup is scoped to the
community the caller named:

```js
async function webhookHealth(webhookId, serverId) {
  const hook = await db.get(
    'SELECT * FROM webhooks WHERE id = ? AND server_id = ?', [webhookId, String(serverId)]
  );
```

**Regression test.** `backend/tests/security-3.0/developer-webhook-scope.test.js`.
Two communities, two owners, one webhook: the owner reads its health, the
other community's manager gets 404. Against the unfixed service the "a
manager of another community does not" subtest fails.

---

### S3-06 — two workflow actions ignored the owner's standing in the community

**Severity: medium.**

**Class:** broken object-level authorisation.

`backend/src/services/workflows/actions.js` checks the workflow owner's
membership for the actions that write and read (`message.post`,
`reaction.add`, `channel.history` — `assertMayPost`). Two actions did not
check it at all:

- **`member.count`** (`members.read`) counted the members of *any* community,
  including one the workflow's owner was not a member of.
- **`webhook.notify`** (`webhooks.manage`) delivered an arbitrary event type
  and an arbitrary payload to the outgoing webhooks of *any* community. Those
  webhooks point at somebody else's endpoint — usually a third party's
  service — and the payload is the workflow's to choose.

**Impact.** A workflow with `webhooks.manage` could push arbitrary JSON to
any community's webhook endpoint, from an account with no standing in that
community. That is a spam and injection vector against the third-party
services the community has hooked up.

**Fix.** The same `assertMemberOfCommunity` helper as S3-02, applied to both
actions. `channel.history` now uses it too, so the three actions that read a
community's state all ask the same question in the same way.

**Regression test.** `backend/tests/security-3.0/workflow-authorisation.test.js`,
the subtests "a workflow whose owner is not a member of the community is
refused" and "a workflow may not notify the webhooks of a community it does
not belong to". Both fail against the unfixed catalogue.

---

### S3-07 — the sandbox declared an output limit and a call limit it did not apply

**Severity: low. A resource bound that was written down and not enforced.**

**Class:** resource limit not enforced.

`backend/src/services/extensions/sandbox.js` declared in `DEFAULT_LIMITS`:

```js
const DEFAULT_LIMITS = {
  timeoutMs: 5000,
  memoryMb: 64,
  callBudget: 50,
  outputBytes: 8000,
};
```

`outputBytes` was read by nothing: an extension's return value was
serialised wherever it liked and posted across the worker boundary, and the
host stored it as the step's output. `callBudget` was passed to `sandbox.run`
by the engine (`backend/src/services/workflows/engine.js:306`) and read by
nothing there either; the budget that actually applied was the engine's
(`ctx.budget.consume()`, inside `actions.execute`).

**Impact.** An extension could return a very large result. The worker's
memory ceiling bounded it in practice, so this was a waste of the instance's
memory rather than an escape, and the step output — which is kept in the
database — could be arbitrarily large.

**Fix.** `backend/src/services/extensions/sandbox.js`.

- The output is bounded in the worker, before the result is copied across the
  thread boundary (`sandbox.js:195`).
- The call budget is enforced on the host side of the boundary as well as at
  the point where the action is checked (`sandbox.js:285`), so a bound that
  only one of the two sides knows about cannot be forgotten by the other.

**Regression test.** `backend/tests/security-3.0/sandbox-limits.test.js`.

---

### S3-08 — any signed-in account could drain a device's one-time prekeys

**Severity: low. Availability, and a mild cryptographic downgrade.**

**Class:** missing authorisation on a state-changing read.

**Status: OUTSTANDING. Not fixed — see section 5.**

`backend/src/services/e2ee/prekeys.js:211` (`fetchBundle`), reached by
`GET /api/e2ee/prekeys/:deviceId` (`backend/src/routes/e2ee.js:131`):

```js
async function fetchBundle(deviceId) {
  const device = await devices.get(deviceId);
  ...
  const consumed = await db.transaction(async (t) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await t.get(
        `SELECT * FROM e2ee_prekeys
          WHERE device_id = ? AND consumed_at IS NULL AND kind = ?
          ORDER BY created_at ASC LIMIT 1`,
        [deviceId, ONE_TIME]
      );
      ...
```

The route is authenticated but not scoped: any account may name any device.
That is necessary — an initiator has to be able to fetch a peer's bundle
before it knows whether they share a conversation — but each fetch *consumes*
a one-time prekey, and after the batch is empty the responder falls back to
the reusable last-resort prekey.

**Impact.** A device publishes a batch of 30 one-time prekeys
(`frontend/packages/e2ee/device.js:22`, `PREKEY_BATCH = 30`). Thirty fetches
drain the batch and force every subsequent session onto the last-resort key,
which is the same key for every session until the device publishes a fresh
one. The router's per-bucket limit is 120 a minute
(`backend/src/routes/e2ee.js:135`), so the whole batch goes in under a minute.
The last-resort key is a weaker guarantee — one key, many sessions — but it is
not a break.

**What I did not do.** The obvious fixes each have a cost: a per-peer-device
rate limit on the prekey route would need somewhere to keep the state, and
requiring the caller to share a conversation with the device's owner would
break the first message of every first contact. The change I would make is in
`backend/src/services/e2ee/prekeys.js`: keep the one-time prekey consumption
as it is, but record the number of bundles taken per caller per device and
refuse a caller that has taken more than a small number from one device in a
short window. The table to add is mine to add — `backend/src/db/schema.js` is
not in my scope, so this needs the schema owner.

---

### S3-09 — the extension registry mirror is fetched without the network guard

**Severity: low. The address is operator-configured.**

**Class:** SSRF, with an operator in the loop.

**Status: OUTSTANDING. Not fixed — see section 5.**

`backend/src/services/extensions/registry.js:79`:

```js
async function readRemote(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'Trycord-Registry/1.0' },
  });
```

Every other outbound fetch in the product goes through
`backend/src/services/netguard.js`: the federation probe and the delivery path
(`services/continuum/guard.js`), the cross-instance report
(`services/cross-instance-reports.js:219`), the link preview
(`services/embeds.js`), the webhook delivery. This one does not. It also
follows redirects, so a mirror at `https://registry.example` that answers
`302 Location: http://169.254.169.254/` is followed there.

**Impact.** The URL is set by an administrator
(`PUT /api/extensions/policy` is behind `adminGuard`), so this is not
attacker-controlled. But the failure mode is the one the network guard exists
for: an instance that fetches an address inside the operator's network, or a
cloud metadata address, and hands the answer to a package registry the
operator trusts. The document that comes back is parsed as a package list, so
it cannot leak far — but the request itself is the exposure, and it happens on
a timer or on any registry listing.

**What I did not do.** The fix belongs in `readRemote`: validate the host and
the address it resolves to with `netguard.validateOrigin` /
`netguard.resolvesToPrivate`, and refuse to follow a redirect that lands
somewhere the guard forbids (`redirect: 'manual'` and re-validate). The
decision the fix needs from the operator is whether a mirror on a private
network is a legitimate setup — a self-hosted registry is often exactly that —
and `services/continuum/guard.js` already shows the shape of that answer
(`CONTINUUM_ALLOW_LOCALHOST`). `services/netguard.js` is not in my scope for
this review, so I have not written the change.

---

## 2. The sandbox, exactly

The sandbox is `backend/src/services/extensions/sandbox.js`. It runs a
trusted extension's `entry.source` in a `node:vm` context inside a worker
thread. Here is what it actually stops, and what it does not.

### What it stops — verified

| Claim | How it was checked | Result |
|---|---|---|
| `require`, `process`, `module` are not reachable | `tests/security-3.0/sandbox-escape.test.js` | `typeof` is `"undefined"` |
| The host's globals are not reachable | same, with a marker on `globalThis` | `typeof` is `"undefined"` |
| `eval`, `new Function` and `fn.constructor.constructor` fail inside | same | `Code generation from strings disallowed for this context` |
| The outer `Function` is not reachable through the timer handle | same (S3-01) | the handle is a number; the outer `Function` throws |
| The outer `Function` is not reachable from a timer callback's `this` | same (S3-01) | the callback is called with no receiver |
| A runaway loop is stopped | `tests/security-3.0/sandbox-limits.test.js` | `timedOut: true` after 471 ms on a 400 ms limit |
| An extension that waits forever is stopped | same | `timedOut: true` after 652 ms on a 400 ms limit |
| The memory ceiling is real | same | `Worker terminated due to reaching memory limit: JS heap out of memory` |
| The call budget holds | same, with a host that counts nothing | the host is asked 3 times, not 8 |
| The output size is bounded | same | an 20 000-byte output is refused against an 8 000-byte limit |
| A timer still fires, and a cleared one does not | `tests/security-3.0/sandbox-escape.test.js` | `['kept']` |

The wall-clock deadline is enforced twice over: `vm.Script.runInContext`'s
`timeout` covers the synchronous part of the entry point, and a
`setTimeout` at `timeoutMs + 250` terminates the worker, which covers an
entry point waiting on a call that will never be answered.

### What it does not stop

- **It is not a jail.** Node does not provide a security boundary between a
  `node:vm` context and its host. The module says so itself, and it is
  right: the boundary here is a set of measures that can each be defeated by
  a route nobody has thought of. The defence is structural — server-side
  extension code is off by default, needs an operator to allow it, and the
  declarative path exists so most extensions never need it.
- **It does not bound what a call costs.** The call budget bounds the
  *number* of calls. A single `message.post` with a 2 000-character body is
  one call.
- **It does not cancel a host call in flight.** The deadline terminates the
  worker; a host action that has already started (a database write, a
  webhook delivery) finishes. The side effect happens; only the answer is
  lost.
- **It does not stop a call that is already permitted from doing damage.**
  The capability check is the real boundary for what an extension may do, and
  it is enforced in the host — `backend/src/services/workflows/actions.js:387`
  — where the extension cannot reach it. The sandbox does not add to it.
- **It does not stop a trusted extension from reading its own arguments.**
  The parameters of a step, and the values the run carries, are handed to the
  extension as data. A workflow with `messages.read` can read a channel's
  history and put it in its output; that output is now bounded in size and
  stored in the run's step row, which is the owner's and the administrator's
  (S3-03).

---

## 3. What was checked and found sound

Read, and found to hold. None of these is a finding.

**Federation (`backend/src/services/continuum/**`, `services/continuum.js`,
`routes/continuum.js`).**

- The relay rules (`continuum/rules.js`) refuse a private community
  (`communityMayFederate`), a channel the community's members may not post in
  (`channelMayFederate`), a sender who may not post there (`authorMayPost`),
  and anything that declares itself encrypted (`encryptedContent`). The
  discovery document publishes only public communities and only the channels
  the members may post in (`continuum/remote-communities.js:77`).
- An inbound event is checked in order: the instance must be known and
  trusted, the signature must verify against the key recorded for it, the
  event id must be new, the timestamp must be near now, the kind and payload
  must be in the vocabulary, and the sequence must be newer than the highest
  accepted from that (origin, actor) (`continuum.js:491`,
  `continuum/sequences.js:55`, `continuum/inbound.js:36`). The replay floor
  is a conditional update, so two copies of the same sequence cannot both be
  accepted.
- The relayed messages are read only by somebody who has a standing:
  `store.canReadRelayMessages` requires membership of a local community, or a
  joined follow of a remote one (`continuum/store.js:168`). The moderation
  surface requires `MANAGE_MESSAGES` in the community or a platform
  administrator (`continuum/moderation.js:43`), and `moderateableCommunities`
  filters the unfiltered list by the same bar (`continuum/moderation.js:54`).
- The outbound fetch is guarded: the host is checked against the keep-out
  list, the name is resolved and checked again at delivery time (DNS
  rebinding), and redirects are refused (`continuum.js:668-675`,
  `continuum/guard.js`).

**Cross-instance reports (`backend/src/services/cross-instance-reports.js`).**
The payload that crosses is written out in one function
(`buildPayload`, line 71) and carries the instance id, the community, the
channel, the content id, the content type, the reason and the reporter's
account id on the origin. It does not carry the content, the reporter's name,
their address or anything else about them. The report is refused for a
private community or a restricted channel by asking the relay's own rules
(`rules.mayFederateMessage`, line 131) rather than by a second set of rules.

**The encryption (`backend/src/services/e2ee/**`).**

- The envelope's associated data covers the version, the session, the
  conversation, the sender, the receiver, the counter, the ratchet key and
  the key agreement, so a message cannot be moved to another conversation or
  replayed under another counter without the tag failing
  (`e2ee/envelope.js:43`). A version this build does not implement is
  refused, never downgraded (`e2ee/envelope.js:111`).
- A body's shape is decided by the server, not by the client: in an
  encrypted conversation a body has to be an envelope, and an envelope is
  checked against the conversation, the sender's own devices, the member
  devices and the session it claims (`e2ee/bodies.js:184`,
  `e2ee/bodies.js:301`). A file attached to an encrypted conversation has to
  have its key sealed to the member devices (`e2ee/bodies.js:258`).
- The session's send counter has to move forward; a push that does not is a
  replay and is refused (`e2ee/sessions.js:150`).
- A device's identity key is pinned when it is first registered
  (`e2ee/devices.js:69`), and a prekey bundle is refused unless the device's
  own identity key signed it (`e2ee/prekeys.js:117`, `:138`).
- Recovery requires a signature by the lost device's identity key over a
  statement that names the account and the new device, and the new device
  must have a new identity key (`e2ee/recovery.js:85`, `:74`).
- The attachment key never reaches the server: the fields that would carry
  one are refused outright (`e2ee/attachments.js:118`), and the seals
  belonging to other people's devices are not returned (`e2ee/attachments.js:198`).
- The primitives are node:crypto's, the nonce is drawn at random per message
  under a single-use message key, and the degenerate shared secret is
  refused (`e2ee/primitives.js:126`, `e2ee/ratchet.js:271`).

**The browser half (`frontend/packages/e2ee/**`,
`frontend/js/ui/encrypted.js`, `frontend/mobile/js/encrypted.js`).** The
private halves live in the device store and nowhere else; the store is
IndexedDB, or localStorage, or memory, and it is namespaced per instance
*and* per account (`frontend/packages/e2ee/store.js:95`,
`frontend/js/ui/encrypted.js:58`). The recovery key is generated on the
device and never leaves it (`frontend/packages/e2ee/device.js:220`). The
composer never puts text into a conversation the server reports as
encrypted, and a conversation that is only partly encrypted is said so before
anything is sent (`frontend/js/ui/encrypted.js:172`). Nothing writes a key, a
recovery key or a session secret to the console.

**The extension registry (`backend/src/services/extensions/registry.js`,
`packages.js`, `signature.js`).** A package that names a capability this
instance does not know is refused rather than installed with the name
dropped (`packages.js:174`). Only a package marked `trusted` may declare a
server-side entry point (`packages.js:198`). A signature covers the whole
document except the signature member, and the install-time decision reads
the *fresh* registry rather than the cache (`lifecycle.js:173`,
`signature.js:46`).

**The developer API (`backend/src/services/apiKeys.js`,
`services/developer/**`, `routes/developer/**`).** A secret is shown once
and stored as a hash (`apiKeys.js:49`, `:214`); the comparison is
constant-time (`apiKeys.js:84`). A credential may only create a key whose
scopes are a subset of its own (`routes/developer/keys.js:38`). The scope
check is in the middleware, so a route cannot forget it
(`services/developer/credentials.js:165`). The provider catalogue masks the
secrets it reads (`services/providers/registry.js:402`).

**The workspace (`backend/src/services/workspace/**`,
`routes/workspace.js`).** Every read is scoped by `server_id`; a document, a
poll, an event, a board and a card are all fetched with the community in the
query (`workspace/documents.js:90`, `workspace/polls.js:63`,
`workspace/events.js:63`, `workspace/boards.js:109`). A document's body is
made of the page editor's own typed blocks, and a link target that is not
http, https, mailto or a path is refused (`workspace/documents.js:111`).
A poll's intermediate tally is only visible to its creator and to the
community's content managers, and an anonymous poll never names its voters
(`workspace/polls.js:327`, `:368`).

**Localisation and themes (`backend/src/services/localisation.js`,
`services/themes.js`, `routes/localisation.js`, `routes/themes.js`).** A
localisation pack is refused if any translated string contains markup, a
template expression, a script address, an inline document, a backtick or a
control character, or if it does not keep the placeholders of the original
(`localisation.js:70`, `:108`). A theme package is refused if it carries any
field but the four declared ones, or any token but the four declared ones, or
a token value that is not a colour (`themes.js:33`, `:75`, `:124`). On the
client the tokens are applied with `style.setProperty` on a custom property
(`frontend/packages/theme.js:132`), so a value that somehow got through could
not break out of it.

---

## 4. What the fixes changed

| File | Change |
|---|---|
| `backend/src/services/extensions/sandbox.js` | The context is given a number instead of the host's timer handle; the timer callback is called with no receiver; the output size is bounded in the worker; the call budget is enforced on the host side. |
| `backend/src/services/workflows/actions.js` | New `assertMemberOfCommunity`, `assertMayAdministerRoles` and `assertDelegable` helpers; `member.role.add`, `member.count`, `webhook.notify` and `channel.history` use them. |
| `backend/src/routes/extensions.js` | The run history of a workflow is the owner's and the administrator's. |
| `backend/src/routes/federation-reports.js` | The report route asks for the reporter's own report. |
| `backend/src/services/cross-instance-reports.js` | `get()` takes a reporter filter and applies it in the query. |
| `backend/src/services/developer/health.js` | `webhookHealth` is scoped to a community. |
| `backend/src/routes/developer/webhooks.js` | The route passes the community. |

---

## 5. The two findings this review could not close, now closed

Neither was a judgement call about the fix. Both needed a file or a decision
that belonged to somebody else, and both have been done since.

### S3-08 — the one-time prekey exhaustion — **Fixed**

The fallback this review named is the one that was taken: a per-route limiter
keyed on the device being fetched, which needs no schema.

- `backend/src/middleware/ratelimit.js` grew a `keyBy` option. A bucket can
  be named by the request as well as by the route, so the thing being spent
  is part of the key while the caller's identity stays in it.
- `backend/src/routes/e2ee.js` applies it to
  `GET /api/e2ee/prekeys/:deviceId`: the route keeps its own ceiling of 120
  a minute, and a device may be fetched ten times a minute by a given
  caller. One reader cannot spend another's pool, and one reader cannot empty
  a device's pool in a burst.
- The limit is on the *request*, so a fetch that the protocol refuses is
  still counted: the cost is in the prekey the server handed out, and the
  server hands it out before it can know whether the caller may use it.
- `backend/tests/security-3.0/prekey-drain.test.js` proves it. The devices
  in the test are real ones — the test client holds the keys and signs the
  bundle, exactly as a browser would — because a bundle that does not verify
  is refused by the protocol and would never reach the limit.

  The test was run against the unfixed route: the first subtest fails, the
  other two pass; against the fixed route, all three pass. The other two
  passing against the unfixed route is the point of them: they are there to
  prove the limit is per device and per reader, and a fix that refused
  everything would have failed them.

### S3-09 — the extension registry mirror and the network guard — **Fixed**

- `backend/src/services/extensions/registry.js`, function `readRemote`, now
  checks every address it fetches with `netguard.validateOrigin` and
  `netguard.resolvesToPrivate` — the same guard every other outbound fetch
  in the product uses, so credentials in the URL, a scheme that is not
  http(s), the cloud metadata host and a name that resolves into a private
  range are all refused.
- A redirect is followed **one hop at a time and each hop is checked again**
  (`redirect: 'manual'`, then the `Location` is validated before it is
  fetched). A redirect to a forbidden address is the easiest way past a check
  on the address the operator typed, so the check is applied to the address
  that is actually fetched.
- The question this review raised — whether a mirror on a private network is
  a legitimate setup — is answered the way the federation answers it: the
  operator says so. `TRYCORD_REGISTRY_ALLOW_PRIVATE=on` permits a private
  mirror, and without it a private address is refused.

The variable is documented in `backend/.env.example`, and the environment
template test asserts in both directions that every variable the code reads
is named and that every variable the template names is read.

---

## 6. Not verified

What was read in this review and not exercised, and why.

- **The federation delivery path end to end.** `continuum.js:656`
  (`deliverEventToInstance`), `continuum/feed.js`, `continuum/ledger.js` and
  `continuum/relay.js` were read, not run against a second instance. The
  existing suite (`backend/tests/continuum/`) covers the relay rules and the
  queue; the cross-instance delivery itself is exercised there only against
  a stub. The signature verification, the sequence floor and the replay
  refusal were read and their reasoning followed.
- **The cryptography.** `e2ee/primitives.js`, `e2ee/x3dh.js`,
  `e2ee/ratchet.js` and their frontend counterparts were read. The key
  schedule, the nonce derivation and the associated data were followed; no
  test vector of my own was written, and no differential test against
  another implementation was run. The existing suite
  (`backend/tests/e2ee/crypto.test.js`) covers round trips.
- **The WebSocket and realtime paths.** The e2ee events
  (`e2ee:device`, `e2ee:key-change`, `e2ee:safety-number`) were read at the
  point of emission (`backend/src/services/e2ee/index.js:34`) and not
  observed on the wire. The frames themselves are produced by
  `backend/src/services/events.js`, outside this review's scope.
- **The MySQL path.** Every query I changed or read is dialect-neutral
  (`db.get`, `db.run`, `db.transaction`), but the suite runs on SQLite
  (`tests/helpers/instance.js`, `DB_CLIENT: 'sqlite'`). The MySQL
  statements were not exercised.
- **The native clients.** `native/` is outside this review's scope.
- **The mobile client's own storage.** `frontend/mobile/js/encrypted.js` was
  read and found to use the same device store and the same rules as the
  desktop; it was not exercised. The mobile client's `readRow` does not check
  `row.encrypted` before opening the device the way the desktop one does
  (`frontend/mobile/js/encrypted.js:175` against
  `frontend/js/ui/encrypted.js:204`) — a robustness difference, not a
  security one: the device is opened either way and the row is still opened
  with the client's own key.
- **The instance running on this host.** It was read, never written to, and
  never restarted.

---

## 7. The regression tests

`backend/tests/security-3.0/`, one file per finding:

| File | Proves |
|---|---|
| `sandbox-escape.test.js` | S3-01 — the timer handle and the timer callback's `this` cannot reach the outer `Function`; the host is unreachable; timers still work. |
| `sandbox-limits.test.js` | S3-07 — the deadline, the memory ceiling, the call budget and the output size. |
| `workflow-authorisation.test.js` | S3-02, S3-06 — a workflow may only act on a community its owner belongs to, may only hand out authority it holds, and the legitimate path still works. |
| `extension-run-history.test.js` | S3-03 — the run history of an extension is the operator's; the definition is still public. |
| `federation-reports-authorisation.test.js` | S3-04 — a report is the reporter's own. |
| `developer-webhook-scope.test.js` | S3-05 — a webhook's health belongs to its own community. |

Every one of them was run against the unfixed code as well: the escape tests,
the workflow tests, the extension history test, the report test and the
webhook test each fail without their fix.
