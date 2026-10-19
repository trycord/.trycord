// Reading the client as source.
//
// Some of the checks are about what the files say rather than what they do:
// which module imports which, which page ids are bound, which class names are
// emitted. Those are read from the text, because that is what they are.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CLIENT = path.join(ROOT, 'frontend');

export const MODULES = {
  packages: path.join(CLIENT, 'packages'),
  desktop: path.join(CLIENT, 'js'),
  mobile: path.join(CLIENT, 'mobile', 'js'),
};

export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

export function relative(file) {
  return path.relative(ROOT, file);
}

// Every module specifier a file names, whatever form it is written in:
//   import x from '...'
//   import { a } from '...'
//   import '...'
//   export { a } from '...'
//   import('...')
const IMPORT_PATTERNS = [
  /\bimport\s+[^'";]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bexport\s+[^'";]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
];

export function importSpecifiers(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(source))) found.add(match[2]);
  }
  return Array.from(found);
}

// The class names a file states outright. A class assembled at runtime from a
// variable is not a name the file states, so only the literal parts are read.
const CLASS_PATTERNS = [
  /\b(?:class|className)\s*:\s*(['"])([^'"]*)\1/g,
];

export function classLiterals(source) {
  const found = new Set();
  for (const pattern of CLASS_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(source))) {
      for (const token of match[2].split(/\s+/)) {
        if (token) found.add(token);
      }
    }
  }
  return Array.from(found);
}

// The class names a stylesheet knows: every class selector in it.
export function stylesheetClasses(css) {
  const found = new Set();
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let match;
  while ((match = re.exec(css))) found.add(match[1]);
  return found;
}

export function read(file) {
  return fs.readFileSync(file, 'utf8');
}
