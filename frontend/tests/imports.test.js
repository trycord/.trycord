// The module boundaries.
//
// The client is three modules with a hard rule between them: the shared
// platform never imports a module, the desktop module never imports the
// mobile one, and the mobile module never imports the desktop one. A file that
// breaks the rule still loads in a browser - the import resolves - so nothing
// but a check keeps the modules apart.
//
// The check reads the files, because that is where the rule is written. It
// also resolves every specifier, so a file that names a module that is not
// there is caught here rather than as a blank screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MODULES, walk, relative, importSpecifiers, read } from './helpers/source.js';

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base + '.js', path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined; // relative, but not there
}

function moduleOf(file) {
  if (file.startsWith(MODULES.packages + path.sep)) return 'packages';
  if (file.startsWith(MODULES.desktop + path.sep)) return 'desktop';
  if (file.startsWith(MODULES.mobile + path.sep)) return 'mobile';
  return null;
}

const files = [
  ...walk(MODULES.packages),
  ...walk(MODULES.desktop),
  ...walk(MODULES.mobile),
];

test('the client is three modules with files in each', () => {
  assert.ok(files.length > 0, 'no client files were found');
  const counts = { packages: 0, desktop: 0, mobile: 0 };
  for (const file of files) counts[moduleOf(file)] += 1;
  assert.ok(counts.packages > 0, 'the shared platform has no files');
  assert.ok(counts.desktop > 0, 'the desktop module has no files');
  assert.ok(counts.mobile > 0, 'the mobile module has no files');
});

test('every local import resolves to a file that exists', () => {
  const broken = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(read(file))) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) {
        broken.push(relative(file) + ' imports "' + specifier + '", which is not a relative path');
      } else if (resolved === undefined) {
        broken.push(relative(file) + ' imports "' + specifier + '", which does not exist');
      }
    }
  }
  assert.deepEqual(broken, [], 'imports that do not resolve:\n' + broken.join('\n'));
});

test('no module imports another module', () => {
  // The modules are separate, with one sanctioned bridge: the phone shares the
  // desk's interaction modules (js/ui — the primitives, the encryption glue,
  // the menus) so there is one implementation and not two copies to keep
  // equal. A mobile import from anywhere else in the desk is still a crossing.
  const crossings = [];
  for (const file of files) {
    const from = moduleOf(file);
    for (const specifier of importSpecifiers(read(file))) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved) continue;
      const to = moduleOf(resolved);
      if (!to || to === from) continue;
      if (from === 'packages') { crossings.push(relative(file) + ' (packages) imports ' + relative(resolved) + ' (' + to + ')'); continue; }
      if (from === 'desktop' && to === 'mobile') { crossings.push(relative(file) + ' (desktop) imports ' + relative(resolved) + ' (mobile)'); continue; }
      if (from === 'mobile' && to === 'desktop' && !resolved.includes(path.join('js', 'ui') + path.sep)) {
        crossings.push(relative(file) + ' (mobile) imports ' + relative(resolved) + ' (desktop, outside the shared js/ui)');
      }
    }
  }
  assert.deepEqual(crossings, [], 'module boundaries crossed:\n' + crossings.join('\n'));
});

test('the shared platform holds no visual module', () => {
  // The platform is the non-visual half: it may not build a shell or a view.
  // A file that draws belongs to one of the two presentation modules.
  const offenders = [];
  for (const file of walk(MODULES.packages)) {
    const name = path.basename(file);
    if (/^(shell|view|component|presentation)/.test(name)) {
      offenders.push(relative(file));
    }
  }
  assert.deepEqual(offenders, [], 'visual files in the platform:\n' + offenders.join('\n'));
});
