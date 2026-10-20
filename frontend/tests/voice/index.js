// The voice checks, in one place.
//
// Node's test runner is given a directory and resolves it as a module, so this
// file is what it finds when it is pointed at frontend/tests/voice. It imports
// every check beside it, so `node --test frontend/tests/voice/index.js` runs
// the lot.
//
// The checks are about what an operator sees: which provider is in force, which
// fields belong to it, what a credential looks like, and what a connectivity
// check says.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
