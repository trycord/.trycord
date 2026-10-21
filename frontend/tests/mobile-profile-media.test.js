import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, waitFor } from './helpers/dom-stub.js';

const dom = installDomStub();
dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const { State } = await import('../packages/store.js');
const { renderSettings } = await import('../mobile/js/views/settings.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

test('dismissing the mobile image cropper cancels the pending upload', async () => {
  let bitmapCloses = 0;
  globalThis.createImageBitmap = async () => ({
    width: 800,
    height: 600,
    close() { bitmapCloses += 1; },
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('a dismissed crop should not upload');
  };
  State.user = { username: 'ada', displayName: 'Ada' };

  const view = renderSettings({ page: { id: 'settings', label: 'Profile' } });
  view.onMount();

  const input = find(view.node, (node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'file')[0];
  const upload = find(view.node, (node) => node.tagName === 'BUTTON' && node.textContent === 'Upload photo')[0];
  assert.ok(input, view.node.textContent);
  assert.ok(upload, view.node.textContent);

  input.files = [new Blob(['picture'], { type: 'image/png' })];
  input.dispatch('change');
  assert.equal(upload.disabled, true, 'the upload stays busy while the cropper is open');

  const scrim = await waitFor(() => document.body.querySelector('.m-scrim'));
  assert.ok(scrim, 'the cropper sheet opened');
  scrim.click();
  await waitFor(() => upload.disabled === false);

  assert.equal(requests, 0, 'closing the cropper does not upload the unapproved image');
  assert.equal(bitmapCloses, 1, 'the decoded image is released when the sheet closes');
});
