// The small pieces the extension console shares.
//
// The vocabulary is the server's: a review status, a signature status, an
// extension state and a capability name all come from the API, and this module
// only says how each one is written. Nothing is invented here - a value the
// console does not recognise is shown as itself rather than as a guess.

import { el } from '../../../packages/dom.js';
import { State } from '../../../packages/store.js';

// Whether the reader is an administrator of this instance. The policy, the
// installed list and every grant are an administrator's business, and the
// console does not offer a control the reader's own account cannot use.
export function isOperator() {
  return !!(State.user && State.user.isAdmin);
}

export function chip(text, tone) {
  return el('span', { class: 'chip' + (tone ? ' chip--' + tone : '') }, text);
}

export function reviewChip(status) {
  const value = String(status || 'unknown');
  if (value === 'approved') return chip('reviewed', 'on');
  if (value === 'rejected') return chip('rejected', 'warn');
  if (value === 'pending') return chip('awaiting review', 'quiet');
  return chip(value, 'quiet');
}

export function signatureChip(signature) {
  const status = signature && signature.status ? String(signature.status) : 'unsigned';
  if (status === 'verified') return chip('signed', 'on');
  if (status === 'invalid') return chip('signature is not good', 'warn');
  if (status === 'unsigned') return chip('unsigned', 'quiet');
  return chip(status, 'quiet');
}

export function extensionStateChip(state) {
  const value = String(state || '');
  if (value === 'enabled') return chip('enabled', 'on');
  if (value === 'disabled') return chip('disabled', 'quiet');
  if (value === 'removed') return chip('removed', 'warn');
  return chip(value, 'quiet');
}

export function workflowStateChip(state) {
  const value = String(state || '');
  if (value === 'active') return chip('active', 'on');
  if (value === 'paused') return chip('paused', 'quiet');
  if (value === 'disabled') return chip('disabled', 'quiet');
  return chip(value, 'quiet');
}

export function runStateChip(status) {
  const value = String(status || '');
  if (value === 'succeeded') return chip('succeeded', 'on');
  if (value === 'failed') return chip('failed', 'warn');
  if (value === 'awaiting_approval') return chip('waiting for an approval', 'warn');
  if (value === 'cancelled') return chip('cancelled', 'quiet');
  if (value === 'skipped') return chip('skipped', 'quiet');
  return chip(value, 'quiet');
}

// A capability name, written the way a person reads it. The name itself is
// always shown beside it: this is a reading of the server's own vocabulary,
// not a second vocabulary that could drift away from it.
export function capabilityLabel(capability) {
  return String(capability || '')
    .split('.')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' · ');
}

export function capabilityChip(capability, granted) {
  return el('span', { class: 'chip' + (granted ? ' chip--on' : ' chip--quiet') },
    capabilityLabel(capability));
}

// The list of capabilities a holder has, as a set.
export function grantedSet(list) {
  return new Set((Array.isArray(list) ? list : []).map((entry) => String(entry || '')));
}
