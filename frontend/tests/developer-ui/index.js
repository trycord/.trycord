// The developer console checks, in one place.
//
// The directory is not a module the runner can search, so this file is what it
// finds when it is pointed at frontend/tests/developer-ui, and it imports every
// check beside it. The same two lines in frontend/tests/index.js put these
// checks in the whole run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
