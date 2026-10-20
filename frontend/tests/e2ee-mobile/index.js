// The phone's encryption checks, in one place.
//
// Node's test runner is given a directory and resolves it as a module, so
// this file is what it finds when it is pointed at frontend/tests/e2ee-mobile.
// It imports every check beside it, so `node --test frontend/tests/e2ee-mobile/index.js`
// runs the lot.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
