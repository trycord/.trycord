// The module the document loads.
//
// main.js owns the boot; this file exists so the entry has the name the server
// and the checks expect, and so `ready` can be awaited without importing the
// whole graph twice.

import main, { ready } from './main.js';

export { ready };
export default main;
