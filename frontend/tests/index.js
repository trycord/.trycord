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

// The federation checks live in a directory of their own: the directory is not
// a module the runner can search, so it is pointed at directly.
await import(path.join(here, 'federation', 'index.js'));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}

// The encryption checks live in a directory of their own, so the runner is
// pointed at it: the directory is not a module the runner can search.
await import(path.join(here, 'e2ee', 'index.js'));

// The phone's encryption checks live in a directory of their own, for the same
// reason.
await import(path.join(here, 'e2ee-mobile', 'index.js'));
