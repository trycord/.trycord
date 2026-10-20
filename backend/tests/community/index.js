// The checks of a directory of their own.
//
// The runner resolves a directory as a module, so a directory of checks needs
// an index of its own - and the whole run reaches it through the one index
// at the top of the suite.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
