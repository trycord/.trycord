#!/usr/bin/env node
'use strict';

// The desktop shell, and the one rule it has to keep.
//
// trycord-desktop/ was removed per the repository cleanup directive. The desktop
// frontend now lives at frontend/js/shell.js and frontend/css/shell.css.
//
// This check verifies that the shell entry point exists, references the canonical
// brand symbol URL, and uses canonical token colors.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const shellJs = read(path.join(REPO, 'frontend', 'js', 'shell.js')) || '';
const shellCss = read(path.join(REPO, 'frontend', 'css', 'shell.css')) || '';

ok('the desktop shell entry point exists',
  shellJs.length > 0,
  'no frontend/js/shell.js');

ok('the shell references the canonical brand symbol',
  shellJs.indexOf('brandSymbolUrl') !== -1,
  'frontend/js/shell.js does not reference brandSymbolUrl');

ok('the shell CSS uses canonical token colors',
  shellCss.indexOf('var(--tc-brand') !== -1 && shellCss.indexOf('var(--tc-bg-deep') !== -1,
  'frontend/css/shell.css does not use canonical token colors');

ok('the shell sets the brand typeface',
  shellCss.indexOf('var(--tc-font-sans)') !== -1,
  'frontend/css/shell.css does not reference --tc-font-sans');

console.log(failures
  ? `\n  desktop shell check FAILED - ${failures} surface(s) off the canonical set\n`
  : '\n  desktop shell check passed - the shell draws from trycord-assets\n');
process.exitCode = failures ? 1 : 0;
