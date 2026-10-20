// The workspace checks, in one place.
//
// Node's test runner is given a directory and resolves it as a module, so this
// file is what it finds when it is pointed at frontend/tests/workspace. It
// imports every check beside it, so `node --test frontend/tests/workspace/index.js`
// runs the lot.
//
// The checks are about the collaboration workspace: the spaces that narrow what
// a member may see, the documents with their revisions and their conflicts,
// the boards with their lanes and their cards, the events with their answers
// and their attendance, and the polls with their ballots and their results.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const name of fs.readdirSync(here).sort()) {
  if (!name.endsWith('.test.js')) continue;
  await import(path.join(here, name));
}
