// The developer test suite, as one entry point.
//
// The suite is four files, and each of them can be run on its own:
//
//   node --test "tests/developer/*.test.js"
//
// This file exists so that the directory can also be named directly:
//
//   node --test tests/developer/
//
// Node 22 treats a directory argument to --test as a file to run rather than
// as a directory to search, so a directory only works when it resolves to a
// module. Requiring the suite here is what makes that name mean the suite
// instead of an error.
'use strict';

require('./api-keys.test.js');
require('./applications.test.js');
require('./openapi.test.js');
require('./webhook-events.test.js');
