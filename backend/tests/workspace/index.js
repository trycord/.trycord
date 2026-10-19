// The workspace suite, as one entry point.
//
// `node --test tests/workspace/` hands the runner a path, and the runner
// runs the path it is given as a file. A directory resolves to its index.js,
// so this file is what that command ends up running: it loads every suite in
// this directory.
//
// The suites are ordinary test files as well, and
// `node --test "tests/workspace/*.test.js"` runs each of them in its own
// process, which is the better way to run them when something is failing.

'use strict';

require('./documents.test');
require('./boards.test');
require('./events.test');
require('./polls.test');
require('./spaces.test');
