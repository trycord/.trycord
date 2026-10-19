// The client checks, in one place.
//
// Node's test runner is given a directory, and a directory is not a module it
// can run: it resolves it as one, so this file is what it finds. It imports
// every check beside it, so `node --test frontend/tests/` runs the lot and
// `node --test` from the repository root runs the same files directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
