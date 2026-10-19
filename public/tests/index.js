// The entry point for `node --test public/tests/`.
//
// Node 22 resolves a directory given to the test runner to a single module
// rather than searching it, so the directory needs an entry that asks for the
// test files by name. Without this, the command reports one failed test
// called "public/tests" and runs nothing at all.

'use strict';

require('./links.test.js');
require('./resolver.test.js');
require('./resolver-behaviour.test.js');
require('./status.test.js');
require('./directory.test.js');
require('./legal.test.js');
require('./demo.test.js');
require('./site.test.js');
