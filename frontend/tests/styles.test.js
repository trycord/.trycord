// Every class the client states has a rule in the stylesheet of the module
// that states it.
//
// A class with no rule is not an error the browser reports: the element is
// drawn with no styling for it, and the page looks as though the class was
// never there. That is why a control can look finished and be missing its
// shape, and why the check exists.
//
// The two modules have their own stylesheets - the desktop bundle and the
// mobile bundle - and a class in one is not a class in the other. A class
// named in the mobile module has to be in the mobile stylesheet.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MODULES, CLIENT, walk, relative, classLiterals, stylesheetClasses, read } from './helpers/source.js';

const STYLESHEETS = {
  desktop: path.join(CLIENT, 'css', 'app.css'),
  mobile: path.join(CLIENT, 'mobile', 'css', 'app.css'),
};

const SOURCES = {
  desktop: walk(MODULES.desktop),
  mobile: walk(MODULES.mobile),
};

function knownClasses(file) {
  return stylesheetClasses(fs.readFileSync(file, 'utf8'));
}

// A variant of a class - btn--primary, m-btn--ghost - stands on the class it
// varies. A stylesheet that rules the base but not the variant still styles
// it, so the base counts.
function isStyled(token, known) {
  if (known.has(token)) return true;
  const base = token.split('--')[0];
  return known.has(base);
}

for (const module of Object.keys(SOURCES)) {
  test('the ' + module + ' stylesheet is built', () => {
    assert.ok(fs.existsSync(STYLESHEETS[module]), relative(STYLESHEETS[module]) + ' does not exist');
    const css = fs.readFileSync(STYLESHEETS[module], 'utf8');
    assert.ok(css.length > 0, relative(STYLESHEETS[module]) + ' is empty');
  });

  test('every class the ' + module + ' module states has a rule', () => {
    const known = knownClasses(STYLESHEETS[module]);
    const missing = [];
    for (const file of SOURCES[module]) {
      for (const token of classLiterals(read(file))) {
        if (isStyled(token, known)) continue;
        missing.push(relative(file) + ' states "' + token + '"');
      }
    }
    assert.deepEqual(missing, [], 'classes with no rule in the ' + module + ' stylesheet:\n' + missing.join('\n'));
  });
}

test('the two modules keep their own stylesheets', () => {
  // The mobile bundle is the token library, the shared semantic layer and the
  // mobile module's own. None of the desktop module's furniture may be in it:
  // a class that is in both is one module's stylesheet learning about the
  // other.
  const mobile = knownClasses(STYLESHEETS.mobile);
  const desktopOnly = [
    'studio', 'studionav', 'studio-stage', 'gate-card', 'auth-page', 'pub-page',
    'paper', 'cfg-nav', 'cfg-stage', 'pageblock', 'dock-btn', 'rail-item',
    'msg-tools', 'composer-slot', 'inspector',
  ];
  const crossed = desktopOnly.filter((name) => mobile.has(name));
  assert.deepEqual(crossed, [], 'desktop classes in the mobile stylesheet:\n' + crossed.join('\n'));
});
