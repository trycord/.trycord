// The pictures of a person and of a community.
//
// The rules the two shells share: a file is checked before it is sent, a
// picture is uploaded the moment it is chosen, and the face that was there
// is released so the new one is not drawn over it.
//
// The uploads themselves are the server's business, and the server's tests
// cover them. What is checked here is the part the browser owns: what is
// refused before an upload, and what the client does with the answer.

'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkImage } from '../packages/profileMedia.js';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a picture is checked before it is sent', async (t) => {
  await t.test('a picture of a type the server does not take is refused', () => {
    const file = { name: 'notes.pdf', type: 'application/pdf', size: 2048 };
    const checked = checkImage(file);
    assert.equal(checked.ok, false);
    assert.match(checked.reason, /PNG, JPEG, GIF or WebP/);
  });

  await t.test('a picture larger than the limit is refused, with the size', () => {
    const file = { name: 'huge.png', type: 'image/png', size: 12 * 1024 * 1024 };
    const checked = checkImage(file);
    assert.equal(checked.ok, false);
    assert.match(checked.reason, /limit/);
    assert.match(checked.reason, /12288 KB|12 MB|11796 KB/);
  });

  await t.test('a picture of the right kind and size is accepted', () => {
    const file = { name: 'me.png', type: 'image/png', size: 40 * 1024 };
    assert.deepEqual(checkImage(file), { ok: true, reason: '' });
  });

  await t.test('a file with no type is let through, because the server sniffs the bytes', () => {
    const file = { name: 'mystery', type: '', size: 40 * 1024 };
    assert.equal(checkImage(file).ok, true);
  });

  await t.test('no file at all is refused', () => {
    assert.equal(checkImage(null).ok, false);
  });
});

test('every surface that draws a face asks the same question', async (t) => {
  // The one place that decides what a picture reference means. A surface
  // that builds its own avatar path is a surface that shows a broken image
  // on the day the storage moves.
  await t.test('no module builds an avatar or a community icon path by hand', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/\/api\/attachments\/profile\/|'\/api\/servers\/media\//.test(text)) {
          offenders.push(path.relative(FRONTEND, full));
        }
      }
    };
    walk(path.join(FRONTEND, 'js'));
    walk(path.join(FRONTEND, 'mobile', 'js'));
    walk(path.join(FRONTEND, 'packages'));
    assert.deepEqual(offenders, [],
      'these modules build a picture path by hand instead of asking for one');
  });
});
