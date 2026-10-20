// The end-to-end encryption checks, in one place.
//
// Node's test runner is given a directory and resolves it as a module, so
// this file is what it finds when it is pointed at frontend/tests/e2ee. It
// imports every check beside it, so `node --test frontend/tests/e2ee/index.js`
// runs the lot.
//
// The checks that need a server start one of their own: the instance is the
// server's, with the E2EE routes on it, and the client talks to it over
// HTTP. That is the only way to prove that the client's requests are the
// requests the server accepts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
