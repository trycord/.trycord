// The Continuum tests, as one entry point.
//
// `node --test tests/continuum/` asks the runner for a directory, and on this
// version of Node a directory argument is resolved as a module rather than
// searched. This file is what that resolution finds: it loads the three test
// files, which register their tests with the runner.
//
// The repository's own suite is run by a glob (`tests/**/*.test.js`), which
// does not match this file, so each test file still runs in its own process
// there.

'use strict';

require('./relay.test.js');
require('./queue.test.js');
require('./permissions.test.js');
