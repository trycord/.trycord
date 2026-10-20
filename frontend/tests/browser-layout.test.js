// The layout, measured in a real browser.
//
// The environment this runs in cannot reach the network from the browser - a
// navigation to any http:// address hangs - so the application cannot be
// driven against a live instance here. What can be driven is the layout
// system: the page is loaded from disk, the application's own stylesheet is
// applied, and the structures are built with the application's own element
// helper.
//
// So the check is about the things a screenshot shows: whether the heading
// and the description are on top of each other, whether a button is clipped
// by the card that holds it, whether the page scrolls sideways, and whether
// the working surface uses the width it is given.
//
// It is a real browser, real CSS, real pixels. It is not the application
// running against a live instance, and the report says so.
//
// The check is skipped, not failed, when there is no browser to run it in: a
// machine without Chromium is not a machine whose application is broken.
//
//   node scripts/browser-layout.mjs
//   node scripts/browser-layout.mjs --shots /tmp/shots

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.join(HERE, '..', 'scripts', 'browser-layout.mjs');
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

test('the layout is right in a real browser', { skip: fs.existsSync(CHROME) ? false : 'there is no browser to run it in' }, () => {
  const result = spawnSync(process.execPath, [SCANNER], {
    encoding: 'utf8',
    timeout: 300000,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, 0,
    'the layout is wrong in a real browser:\n' + output);
  assert.match(output, /width\(s\) measured in a real browser/,
    'the browser run did not say what it measured:\n' + output);
});
