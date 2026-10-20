// The client checks, in one place.
//
// Node's test runner is given a directory, and a directory is not a module it
// can run: it resolves it as one, so this file is what it finds. It imports
// every check beside it, so `node --test frontend/tests/` runs the lot and
// `node --test` from the repository root runs the same files beside it.
//
// The checks that live in a directory of their own are pointed at one by one.
// A directory is not a module the runner can search, so without this they are
// never run at all — and a check that is never run is not a check. They are
// pointed at before the checks beside them, so that one broken import cannot
// take them down with it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The directories that hold checks of their own. Each one is pointed at
// directly, because the runner will not search a directory for test files.
const DIRECTORIES = [
  'federation',
  'e2ee',
  'e2ee-mobile',
  'voice',
  'developer-ui',
  'extensions-ui',
  'workspace',
];

for (const name of DIRECTORIES) {
  const index = path.join(here, name, 'index.js');
  if (!fs.existsSync(index)) continue;
  await import(index);
}

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}

// The community settings checks live in a directory of their own too. They
// have no index of their own yet, so they are pointed at file by file.
const settings = path.join(here, 'community-settings');
if (fs.existsSync(settings)) {
  for (const name of fs.readdirSync(settings).sort()) {
    if (!name.endsWith('.test.js')) continue;
    await import(path.join(settings, name));
  }
}
