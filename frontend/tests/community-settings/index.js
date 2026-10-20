// The community settings checks, in one place.
//
// Node's test runner is given a directory and resolves it as a module, so this
// file is what it finds when it is pointed at frontend/tests/community-settings.
// It imports every check beside it, so `node --test
// frontend/tests/community-settings/index.js` runs the lot.
//
// The checks are about the console of a community: that every section draws
// and loads, that the settings are read back before they are written, that a
// failed save keeps what was typed, that the console asks before it loses
// something, that a secret is shown once, and that every route the server
// offers for configuring a community is reachable from here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
