// Nothing prints "null".
//
// A view that renders a conditional - a banner, a button that is only there
// sometimes, a fact that is only there for some people - used to print the
// word "null" where a person expected nothing, because the DOM's own methods
// turn a null argument into the text "null".
//
// The rule is "null means absent", and it is put where the methods are, so
// that every view is right by construction rather than by remembering.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { el } = await import('../packages/dom.js');

test('nothing prints "null"', async (t) => {
  await t.test('a conditional child is absent, not the word', () => {
    const node = el('div', {}, el('span', {}, 'Here'), null, undefined, false);
    assert.equal(node.textContent, 'Here');
    assert.equal(node.textContent.indexOf('null'), -1);
  });

  await t.test('the DOM is told what a null means', () => {
    // The platform's own method, used directly.
    const node = el('div', {});
    node.replaceChildren(el('span', {}, 'Here'), null, undefined);
    assert.equal(node.textContent, 'Here');
  });

  await t.test('so is the way content is added', () => {
    const node = el('div', {});
    node.append(el('span', {}, 'Here'), null);
    assert.equal(node.textContent, 'Here');
  });

  await t.test('an empty child is not an empty string either', () => {
    // A false is how a view says "this is not here", and it is not the text
    // "false" either.
    const node = el('div', {}, false, true, 0, '');
    assert.equal(node.textContent, '0');
  });

  await t.test('a value that is zero is a value', () => {
    // Zero is not absent. A count of zero is a fact, and a page that says
    // nothing when the count is zero is hiding it.
    const node = el('div', {}, String(0));
    assert.equal(node.textContent, '0');
  });
});
