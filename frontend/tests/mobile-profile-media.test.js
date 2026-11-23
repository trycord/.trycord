// The phone edits the reader's picture through the shared profile-media
// module: the same checks and previews the desk uses, from a sheet instead
// of the settings studio.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const you = fs.readFileSync(path.join(HERE, '..', 'mobile', 'js', 'views', 'you.js'), 'utf8');

test('the phone validates the picture before it is sent', () => {
  assert.ok(you.includes('checkImage'), 'the phone does not check the image before upload');
  assert.ok(you.includes('previewOf'), 'the phone shows no preview of the chosen picture');
});

test('the phone uploads and removes through the shared module', () => {
  assert.ok(you.includes('uploadProfilePicture'), 'the phone has no way to upload a picture');
  assert.ok(you.includes("uploadProfilePicture('avatar'"), 'the phone does not upload an avatar');
  assert.ok(you.includes('removeProfilePicture'), 'the phone has no way to take the picture off');
});
