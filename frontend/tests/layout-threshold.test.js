// The layout rules that the stylesheet and the script have to agree on.
//
// A threshold in one place and not the other is a sidebar that is visible in
// one half of the application and not the other - and the threshold that
// decides whether the place column is a column or a panel over the stage is
// exactly such a number.
//
// The one that bit was 1080: a laptop screen and not a phone screen. A
// browser at 125% or 150% zoom turns an ordinary 1366-pixel laptop into
// something narrower than that, so the sidebar disappeared for a reader who
// had done nothing except make the text bigger.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..');

function read(relative) {
  return fs.readFileSync(path.join(CLIENT, relative), 'utf8');
}

test('the narrow-window threshold is the same number in the script and the stylesheet', () => {
  // The threshold is declared once, in the file that owns it.
  //
  // The frame owns it: the nav toggle's behaviour depends on it, and the
  // shell imports the frame, so the number cannot live in the shell without
  // the two importing each other. The check therefore looks for the
  // declaration wherever it is, and then insists there is exactly one of it.
  const sources = {
    'js/shell.js': read('js/shell.js'),
    'js/shell/frame.js': read('js/shell/frame.js'),
  };
  const styles = read('css/shell.css');

  const declarations = [];
  for (const [file, source] of Object.entries(sources)) {
    const found = [...source.matchAll(/export const NARROW_WIDTH = (\d+);/g)];
    for (const match of found) declarations.push({ file, width: Number(match[1]) });
  }
  assert.equal(declarations.length, 1,
    'the threshold is declared more than once, or not at all: '
    + declarations.map((d) => d.file + ':' + d.width).join(', '));
  const width = declarations[0].width;

  // The script asks the question with that number.
  const asking = Object.entries(sources).filter(([, source]) =>
    new RegExp("'\\(max-width: ' \\+ NARROW_WIDTH \\+ 'px\\)'").test(source));
  assert.equal(asking.length, 1,
    'the question is asked in ' + asking.length + ' places; it is asked once');

  // The stylesheet draws the line with the same number.
  const queries = [...styles.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  assert.ok(queries.includes(width),
    'the stylesheet does not use the number the script declares: it has '
    + queries.join(', ') + ' and the script has ' + width);

  // And there is only one narrow-window query, so there is one line to keep
  // in step.
  assert.equal(queries.length, 1,
    'the stylesheet has more than one narrow-window query: ' + queries.join(', '));
});

test('the threshold leaves a stage a conversation can be read in', () => {
  const script = read('js/shell/frame.js') + read('js/shell.js');
  const declared = /export const NARROW_WIDTH = (\d+);/.exec(script);
  assert.ok(declared, 'the script does not declare the threshold it uses');
  const width = Number(declared[1]);

  // The rail, the column and a readable stage have to fit. These are the
  // widths the token layer declares, so the check is against the real
  // numbers rather than against a guess.
  const tokens = read('css/tokens.css');
  const rail = /--rail-w:\s*(\d+)px/.exec(tokens);
  const column = /--context-w:\s*(\d+)px/.exec(tokens);
  assert.ok(rail, 'the token layer does not declare the width of the rail');
  assert.ok(column, 'the token layer does not declare the width of the column');
  const railWidth = Number(rail[1]);
  const columnWidth = Number(column[1]);

  // A conversation needs about 480 pixels to be readable: a name, an avatar
  // and a sentence.
  const stage = 480;
  const stageAtThreshold = width - railWidth - columnWidth;
  assert.ok(stageAtThreshold >= stage,
    'the column is still a column at ' + width + ' pixels, which leaves the '
    + 'stage ' + stageAtThreshold + ' pixels - too narrow to read a '
    + 'conversation in');
});
