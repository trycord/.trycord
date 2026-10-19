// The entry point for `node --test tests/workflows/`.
//
// See the note in ../extensions/index.js: Node's test runner treats a
// directory named on the command line as a module to run, so a directory
// needs an entry point for that form of the command to work.

require('./workflows.test.js');
