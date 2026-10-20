// The extension and workflow endpoints.
//
// The shared client does not carry these routes yet, so they are called here
// through the shared request helper - the same one the page editor uses for
// the routes it needs and the shared client does not have.
//
// Every path is the one the server publishes and every body is the one the
// route reads. Nothing is cached and nothing is rewritten on the way: the
// server decides what an operator may see, and this module only asks.

import { request } from '../../../packages/api.js';

const ROOT = '/api/extensions';

function id(value) {
  return encodeURIComponent(String(value || ''));
}

// -- the instance-wide policy ------------------------------------------------

export function readPolicy() {
  return request('GET', ROOT + '/policy');
}

export function writePolicy(patch) {
  return request('PUT', ROOT + '/policy', { body: patch });
}

// -- the registry ------------------------------------------------------------

export function readRegistry(options) {
  const opts = options || {};
  return request('GET', ROOT + '/registry' + (opts.refresh ? '?refresh=1' : ''));
}

export function readPackage(packageId) {
  return request('GET', ROOT + '/registry/' + id(packageId));
}

// -- the installed extensions ------------------------------------------------

export function readInstalled() {
  return request('GET', ROOT + '/installed');
}

export function readExtension(extensionId) {
  return request('GET', ROOT + '/' + id(extensionId));
}

export function installExtension(body) {
  return request('POST', ROOT + '/install', { body });
}

export function enableExtension(extensionId) {
  return request('POST', ROOT + '/' + id(extensionId) + '/enable');
}

export function disableExtension(extensionId) {
  return request('POST', ROOT + '/' + id(extensionId) + '/disable');
}

export function updateExtension(extensionId, body) {
  return request('POST', ROOT + '/' + id(extensionId) + '/update', { body: body || {} });
}

export function rollbackExtension(extensionId, version) {
  return request('POST', ROOT + '/' + id(extensionId) + '/rollback', { body: { version } });
}

export function removeExtension(extensionId, reason) {
  return request('DELETE', ROOT + '/' + id(extensionId), { body: { reason: reason || null } });
}

export function grantCapability(extensionId, capability, reason) {
  return request('POST', ROOT + '/' + id(extensionId) + '/grants', {
    body: { capability, reason: reason || null },
  });
}

export function revokeCapability(extensionId, capability, reason) {
  return request('DELETE', ROOT + '/' + id(extensionId) + '/grants/' + id(capability), {
    body: { reason: reason || null },
  });
}

// -- the workflows -----------------------------------------------------------

export function readWorkflows() {
  return request('GET', ROOT + '/workflows');
}

export function readWorkflow(workflowId) {
  return request('GET', ROOT + '/workflows/' + id(workflowId));
}

export function runWorkflow(workflowId, body) {
  return request('POST', ROOT + '/workflows/' + id(workflowId) + '/run', { body: body || {} });
}

export function dryRunWorkflow(workflowId, body) {
  return request('POST', ROOT + '/workflows/' + id(workflowId) + '/dry-run', { body: body || {} });
}

export function pauseWorkflow(workflowId) {
  return request('POST', ROOT + '/workflows/' + id(workflowId) + '/pause');
}

export function resumeWorkflow(workflowId) {
  return request('POST', ROOT + '/workflows/' + id(workflowId) + '/resume');
}

export function readWorkflowRuns(workflowId) {
  return request('GET', ROOT + '/workflows/' + id(workflowId) + '/runs');
}

export function readRun(runId) {
  return request('GET', ROOT + '/workflows/runs/' + id(runId));
}

export function approveRun(runId, body) {
  return request('POST', ROOT + '/workflows/runs/' + id(runId) + '/approve', { body: body || {} });
}

export function grantWorkflowCapability(workflowId, capability, reason) {
  return request('POST', ROOT + '/workflows/' + id(workflowId) + '/grants', {
    body: { capability, reason: reason || null },
  });
}

export function revokeWorkflowCapability(workflowId, capability, reason) {
  return request('DELETE', ROOT + '/workflows/' + id(workflowId) + '/grants/' + id(capability), {
    body: { reason: reason || null },
  });
}
