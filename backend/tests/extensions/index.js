// The entry point for `node --test tests/extensions/`.
//
// Node's test runner treats a directory named on the command line as a module
// to run rather than as a directory to search, so a directory needs an entry
// point for that form of the command to work at all. This is it: it loads
// the test files in this directory.
//
// The individual files are also found by the runner on its own when the
// whole tree is searched (`node --test` with no arguments), and they are
// then run in separate processes, which is the better arrangement when it is
// available.

require('./sandbox.test.js');
require('./lifecycle.test.js');
require('./registry.test.js');
