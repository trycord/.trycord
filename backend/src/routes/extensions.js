// Extensions and workflows.
//
// One router, mounted at /api/extensions. The two halves are kept apart by
// the guard on each route rather than by the path:
//
//   The instance-wide extension policy - the registry the instance trusts,
//   the allowlist, whether unreviewed packages may be installed, whether a
//   signature is required, whether server-side extension code is allowed -
//   is the operator's decision and is behind adminGuard.
//
//   A workflow somebody owns is that person's business: they may create it,
//   run it, dry-run it, pause it and read its history with a plain session.
//
// The capability grants are the exception, and they are deliberately on the
// operator's side of the line: a workflow an ordinary member created runs
// with the capabilities that let it act as its owner and nothing more until
// an administrator grants more. Granting is how a member's workflow becomes
// able to do something they could not do by hand, so it is an administrator's
// decision and it is audited.
//
// The routes that name a fixed path come first. A route shaped '/:extensionId'
// would otherwise answer '/workflows' and '/events' as if they were the name
// of an extension.

const express = require('express');
const { fail, wrap } = require('../errors');
const auth = require('../middleware/auth');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const db = require('../db');
const extensions = require('../services/extensions');
const workflows = require('../services/workflows');
const engine = require('../services/workflows/engine');
const enforcement = require('../services/enforcement');

const router = express.Router();

// Whether the caller is an administrator. Used where the answer decides
// which of two things the caller may do.
async function isAdmin(userId) {
  try {
    return await enforcement.isPlatformAdmin(userId);
  } catch (e) {
    return false;
  }
}

// The instance-wide policy.
router.get('/policy', adminGuard, wrap(async (req, res) => {
  res.json({ policy: await extensions.policy() });
}));

router.put('/policy', adminGuard, wrap(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.registryMode !== undefined) {
    const mode = String(body.registryMode).trim().toLowerCase();
    if (!extensions.registry.MODES.includes(mode)) {
      return fail(res, 'VALIDATION_ERROR', 'the registry mode must be one of: ' + extensions.registry.MODES.join(', '));
    }
    patch.registryMode = mode;
  }
  if (body.registryUrl !== undefined) {
    patch.registryUrl = body.registryUrl ? String(body.registryUrl).slice(0, 512) : null;
  }
  if (body.allowlist !== undefined) {
    if (!Array.isArray(body.allowlist)) return fail(res, 'VALIDATION_ERROR', 'the allowlist must be a list of package ids');
    patch.allowlist = body.allowlist.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 500);
  }
  if (body.allowUnreviewed !== undefined) patch.allowUnreviewed = !!body.allowUnreviewed;
  if (body.requireSignature !== undefined) patch.requireSignature = !!body.requireSignature;
  if (body.allowTrusted !== undefined) patch.allowTrusted = !!body.allowTrusted;
  if (body.signingKeys !== undefined) {
    if (!body.signingKeys || typeof body.signingKeys !== 'object' || Array.isArray(body.signingKeys)) {
      return fail(res, 'VALIDATION_ERROR', 'the signing keys must be an object of key id to key');
    }
    patch.signingKeys = body.signingKeys;
  }
  res.json({ policy: await extensions.setPolicy(patch, req.user.id) });
}));

// The registry. Anyone signed in may look at what is on offer; only an
// administrator may install from it.
router.get('/registry', auth, wrap(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const result = await extensions.registry.list({ refresh });
  const policy = await extensions.policy();
  const entries = (result.entries || []).map((entry) => {
    const decision = extensions.registry.installability(entry, policy);
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      author: entry.author,
      maintainers: entry.maintainers,
      homepage: entry.homepage,
      requestedCapabilities: entry.requestedCapabilities,
      trusted: entry.trusted,
      reviewStatus: entry.reviewStatus,
      signature: entry.signature,
      installable: decision.allowed,
      reason: decision.reason,
      invalid: entry.invalid || null,
    };
  });
  res.json({
    registry: {
      source: result.source,
      available: result.available,
      error: result.error || null,
      stale: !!result.stale,
      extensions: entries,
    },
  });
}));

// One package, with everything the consent screen needs to show.
router.get('/registry/:packageId', auth, wrap(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const entry = await extensions.registry.get(req.params.packageId, { refresh });
  if (!entry) return fail(res, 'NOT_FOUND', 'the registry does not offer that package');
  const policy = await extensions.policy();
  const decision = extensions.registry.installability(entry, policy);
  res.json({
    package: {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      author: entry.author,
      maintainers: entry.maintainers,
      homepage: entry.homepage,
      entryPoint: entry.entryPoint,
      requestedCapabilities: entry.requestedCapabilities,
      trusted: entry.trusted,
      compatibility: entry.compatibility,
      dependencies: entry.dependencies,
      reviewStatus: entry.reviewStatus,
      signature: entry.signature,
      installable: decision.allowed,
      reason: decision.reason,
    },
  });
}));

// The extensions this instance has installed.
// GET /api/extensions/capabilities - the capability catalogue.
//
// The vocabulary of what an extension or a workflow may be allowed to do.
//
// It is published because a client cannot invent it: the descriptions live
// here, in the same place the permission is enforced, so a screen that
// described a capability from its own copy would eventually describe it
// wrongly. A grant picker that cannot see the catalogue has to ask an
// administrator to type a name they may not know, and the server refuses
// the name it does not know with a reason that is less useful than a list.
//
// The list is public to a signed-in account, because knowing what a thing
// may ask for is not the same as being allowed to ask for it. Every grant
// is still checked at the point of use.
router.get('/capabilities', auth, wrap(async (req, res) => {
  res.json({ capabilities: extensions.capabilities.catalogue() });
}));

router.get('/installed', adminGuard, wrap(async (req, res) => {
  res.json({ extensions: await extensions.installed() });
}));

// Install a package. The body has to say which capabilities are granted:
// that is the consent, and an install without it is refused.
router.post('/install', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const body = req.body || {};
  const packageId = String(body.id || body.packageId || '').trim();
  if (!packageId) return fail(res, 'VALIDATION_ERROR', 'the package to install is required');
  if (!Array.isArray(body.grants)) {
    return fail(res, 'VALIDATION_ERROR',
      'the capabilities to grant must be listed: read the package first and answer with the capabilities you agree to give it');
  }
  const result = await extensions.lifecycle.install({
    packageId,
    version: body.version ? String(body.version) : null,
    grants: body.grants,
    actorId: req.user.id,
  });
  res.status(201).json({
    extension: result.extension,
    requested: result.requested,
    granted: result.granted,
    refused: result.refused,
    signature: result.signature,
  });
}));

// ---- workflows ------------------------------------------------------------

// The workflows the caller may see: their own, and the ones an extension
// owns.
router.get('/workflows', auth, wrap(async (req, res) => {
  const admin = await isAdmin(req.user.id);
  res.json({ workflows: await workflows.listVisible(req.user.id, admin) });
}));

router.post('/workflows', auth, wrap(async (req, res) => {
  const body = req.body || {};
  const admin = await isAdmin(req.user.id);
  const result = await workflows.create(body, req.user.id, { asAdmin: admin });
  res.status(201).json({ workflow: result.workflow, grants: result.grants });
}));

// A single run, with its steps. Declared before the workflow routes so that
// '/workflows/runs/...' is not read as a workflow called 'runs'.
router.get('/workflows/runs/:runId', auth, wrap(async (req, res) => {
  const detail = await workflows.runDetail(req.params.runId);
  if (!detail) return fail(res, 'NOT_FOUND', 'that run does not exist');
  const workflow = await db.get('SELECT owner_id FROM workflows WHERE id = ?', [detail.run.workflowId]);
  const admin = await isAdmin(req.user.id);
  if (!admin && (!workflow || workflow.owner_id !== req.user.id)) {
    return fail(res, 'PERMISSION_DENIED', 'that run is not yours');
  }
  res.json(detail);
}));

// Give or refuse an approval a run is waiting for.
router.post('/workflows/runs/:runId/approve', auth, wrap(async (req, res) => {
  const body = req.body || {};
  const result = await engine.decideApproval(
    req.params.runId,
    { approved: body.approved === true, comment: body.comment ? String(body.comment).slice(0, 500) : null },
    req.user.id,
    isAdmin
  );
  if (!result.ok) return fail(res, 'PERMISSION_DENIED', result.reason);
  res.json(result);
}));

router.get('/workflows/:workflowId', auth, wrap(async (req, res) => {
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id && workflow.source !== 'extension') {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  res.json({ workflow });
}));

router.put('/workflows/:workflowId', auth, wrap(async (req, res) => {
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  const result = await workflows.update(req.params.workflowId, req.body || {}, req.user.id, { asAdmin: admin });
  res.json({ workflow: result.workflow, grants: result.grants });
}));

router.post('/workflows/:workflowId/run', auth, rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const body = req.body || {};
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  const result = await workflows.runNow({
    workflowId: req.params.workflowId,
    payload: body.payload || {},
    dryRun: false,
    idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey).slice(0, 64) : null,
    actorId: req.user.id,
  });
  res.json({ run: result });
}));

router.post('/workflows/:workflowId/dry-run', auth, rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const body = req.body || {};
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  const result = await workflows.dryRun({
    workflowId: req.params.workflowId,
    payload: body.payload || {},
    idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey).slice(0, 64) : null,
  });
  res.json(result);
}));

router.post('/workflows/:workflowId/pause', auth, wrap(async (req, res) => {
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  res.json({ workflow: await workflows.pause(req.params.workflowId, req.user.id) });
}));

router.post('/workflows/:workflowId/resume', auth, wrap(async (req, res) => {
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  if (!admin && workflow.ownerId !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'that workflow is not yours');
  }
  res.json({ workflow: await workflows.resume(req.params.workflowId, req.user.id) });
}));

router.get('/workflows/:workflowId/runs', auth, wrap(async (req, res) => {
  const workflow = await workflows.get(req.params.workflowId);
  if (!workflow) return fail(res, 'NOT_FOUND', 'that workflow does not exist');
  const admin = await isAdmin(req.user.id);
  // The run history is the owner's business and the administrator's, and it is
  // the same rule the single-run route already applies.
  //
  // An extension's workflow *definition* may be read by anybody - that is the
  // design - but its history is not: a run records the event that woke it,
  // and the payload of a message event carries the message. Leaving this open
  // would make every message in a community with an extension installed
  // readable by any signed-in account.
  if (!admin && workflow.ownerId !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'that run history is not yours');
  }
  res.json({ runs: await workflows.history(req.params.workflowId, req.query.limit) });
}));

// Granting a capability to a workflow is an administrator's decision, even
// when the workflow belongs to somebody else.
router.post('/workflows/:workflowId/grants', adminGuard, wrap(async (req, res) => {
  const body = req.body || {};
  const capability = String(body.capability || '').trim();
  if (!capability) return fail(res, 'VALIDATION_ERROR', 'the capability to grant is required');
  res.json({ workflow: await workflows.grant(req.params.workflowId, capability, req.user.id, body.reason || null) });
}));

router.delete('/workflows/:workflowId/grants/:capability', adminGuard, wrap(async (req, res) => {
  res.json({
    workflow: await workflows.revoke(
      req.params.workflowId,
      String(req.params.capability),
      req.user.id,
      (req.body || {}).reason || null
    ),
  });
}));

// Publish an event into the workflow engine.
//
// This is the door an event source comes through: the instance's own event
// sources call the same function, and this route is what lets an operator
// drive a workflow by hand without waiting for one of those events.
router.post('/events', adminGuard, rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  if (!type) return fail(res, 'VALIDATION_ERROR', 'the event type is required');
  const result = await engine.publish(type, body.payload || {}, { await: true });
  if (!result.event) return fail(res, 'VALIDATION_ERROR', result.ignored || 'that is not an event this instance publishes');
  res.json(result);
}));

// ---- one extension --------------------------------------------------------
//
// These come last: a path shaped '/:extensionId' answers anything with one
// segment, so the fixed paths above have to be registered first.

router.get('/:extensionId', adminGuard, wrap(async (req, res) => {
  const detail = await extensions.detail(req.params.extensionId);
  if (!detail) return fail(res, 'NOT_FOUND', 'that extension is not installed');
  res.json({ extension: detail });
}));

router.post('/:extensionId/enable', adminGuard, wrap(async (req, res) => {
  const result = await extensions.lifecycle.enable(req.params.extensionId, req.user.id);
  res.json({ extension: result.extension });
}));

router.post('/:extensionId/disable', adminGuard, wrap(async (req, res) => {
  const result = await extensions.lifecycle.disable(req.params.extensionId, req.user.id);
  res.json({ extension: result.extension });
}));

router.post('/:extensionId/update', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const body = req.body || {};
  const result = await extensions.lifecycle.update(
    req.params.extensionId,
    body.version ? String(body.version) : null,
    req.user.id
  );
  res.json({ extension: result.extension });
}));

router.post('/:extensionId/rollback', adminGuard, rateLimit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.version) return fail(res, 'VALIDATION_ERROR', 'the version to roll back to is required');
  const result = await extensions.lifecycle.rollback(req.params.extensionId, String(body.version), req.user.id);
  res.json({ extension: result.extension });
}));

router.delete('/:extensionId', adminGuard, wrap(async (req, res) => {
  const body = req.body || {};
  const result = await extensions.lifecycle.remove(req.params.extensionId, req.user.id, body.reason || null);
  res.json({ extension: result.extension });
}));

router.post('/:extensionId/grants', adminGuard, wrap(async (req, res) => {
  const body = req.body || {};
  const capability = String(body.capability || '').trim();
  if (!capability) return fail(res, 'VALIDATION_ERROR', 'the capability to grant is required');
  const grant = await extensions.lifecycle.grant(req.params.extensionId, capability, req.user.id, body.reason || null);
  res.json({ grant });
}));

router.delete('/:extensionId/grants/:capability', adminGuard, wrap(async (req, res) => {
  const revoked = await extensions.lifecycle.revoke(
    req.params.extensionId,
    String(req.params.capability),
    req.user.id,
    (req.body || {}).reason || null
  );
  res.json({ grant: revoked });
}));

module.exports = router;
