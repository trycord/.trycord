// The phone's own test furniture.
//
// The screen draws with `el()`, opens sheets that trap focus, and asks the
// overlay manager for a frame before it draws one. The stub in
// ../helpers/dom-stub.js is enough of a document to draw into; what it does not
// have is that frame, and without it a sheet never opens.

import { installDomStub } from '../helpers/dom-stub.js';

/** A document the phone can draw into, and the frame the overlays ask for. */
export function installPhoneStub() {
  const stub = installDomStub();
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  }
  return stub;
}

/**
 * A clean document.
 *
 * The checks in this directory share one process, so the document and the
 * phone's storage are shared too: a sheet left open by one check would be
 * found by the next. This clears the document between checks.
 */
export function resetPhone() {
  document.body.replaceChildren();
  return document;
}

/** Every node under a node, in the order the document has them. */
export function order(node, out = []) {
  out.push(node);
  for (const child of node.children || []) order(child, out);
  return out;
}

/** Every node under a node that matches. */
export function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

/** The button that says exactly this. */
export function buttonWithText(root, text) {
  return find(root, (node) => node.tagName === 'BUTTON' && (node.textContent || '').trim() === text)[0] || null;
}

/** The button that carries this label. */
export function buttonWithLabel(root, label) {
  return find(root, (node) => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === label)[0] || null;
}

/** The sheet that was opened last, or null. */
export function lastDialog(root) {
  const found = find(root, (node) => {
    const role = node.getAttribute ? node.getAttribute('role') : null;
    return role === 'dialog' || role === 'alertdialog';
  });
  return found[found.length - 1] || null;
}

/** The form the screen drew, or null. */
export function formOf(root) {
  return find(root, (node) => node.tagName === 'FORM')[0] || null;
}

/** The form that holds a given field, or null. */
export function formFor(root, field) {
  return find(root, (node) => node.tagName === 'FORM' && node.contains(field))[0] || null;
}

/** The field that carries this label, or null. */
export function fieldWithLabel(root, label) {
  return find(root, (node) => node.tagName === 'INPUT' && node.getAttribute('aria-label') === label)[0] || null;
}

/**
 * Where a piece of text sits in the document, in the order the document has
 * it. The deepest node that says it is the one that says it.
 */
export function positionOf(root, pattern) {
  const nodes = order(root);
  let at = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    if (pattern.test(nodes[i].textContent || '')) at = i;
  }
  return at;
}

export default {
  installPhoneStub, resetPhone, order, find, buttonWithText, buttonWithLabel, lastDialog,
  formOf, formFor, fieldWithLabel, positionOf,
};
