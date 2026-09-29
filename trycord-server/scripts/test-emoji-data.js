// Validates the reaction picker's dataset and normalises it.
//
// Duplicates matter here more than they would in most data: the picker resolves
// a typed :shortcode: to an entry, so two entries sharing a name means which one
// wins depends on file order, and a duplicate char means the same reaction
// appears twice in the grid. Both are invisible until somebody notices the grid
// has a doubled row.
const fs = require('fs');
const path = require('path');

const FILE = 'E:/Projects/TryCore/.trycord/trycord-client/data/emoji.json';
const APPLY = process.argv.includes('--apply');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

const raw = fs.readFileSync(FILE, 'utf8');
let doc;
try {
  doc = JSON.parse(raw);
} catch (e) {
  console.log(' FAIL  the file is not valid JSON  -> ' + e.message);
  process.exit(1);
}

ok('it is valid JSON', true);
ok('it declares a version', typeof doc.version === 'string', String(doc.version));
ok('it has categories', Array.isArray(doc.categories) && doc.categories.length > 0, 'none');

const all = [];
for (const c of doc.categories) {
  if (!c.id || !c.label || !Array.isArray(c.emoji)) {
    ok('category ' + (c.id || '?') + ' is well formed', false, 'missing id/label/emoji');
    continue;
  }
  for (const e of c.emoji) all.push(Object.assign({ category: c.id }, e));
}
ok('every category is well formed', true);
ok('there is a usable number of entries', all.length > 150, 'only ' + all.length);

// Names are the contract: they are what a member types. So they must be
// unique, and in the shape Discord uses - lowercase, underscores, no colons.
const byName = new Map();
const dupNames = [];
for (const e of all) {
  if (byName.has(e.name)) dupNames.push(e.name + ' (' + byName.get(e.name) + ' and ' + e.category + ')');
  else byName.set(e.name, e.category);
}
ok('every name is unique', dupNames.length === 0, dupNames.slice(0, 6).join('; '));

const badName = all.filter((e) => !/^[a-z0-9_+-]+$/.test(e.name)).map((e) => e.name);
ok('names are shortcode shaped', badName.length === 0, badName.slice(0, 6).join(', '));

const byChar = new Map();
const dupChars = [];
for (const e of all) {
  if (byChar.has(e.char)) dupChars.push(e.char + ' (' + e.name + ' and ' + byChar.get(e.char) + ')');
  else byChar.set(e.char, e.name);
}
ok('every character appears once', dupChars.length === 0, dupChars.slice(0, 6).join('; '));

const badChar = all.filter((e) => typeof e.char !== 'string' || !e.char.length).map((e) => e.name);
ok('every entry has a character', badChar.length === 0, badChar.join(', '));

// A reaction is a character a member can actually see. Regional indicator pairs
// are two code points that render as one flag, and anything carrying a
// variation selector is asking for emoji presentation - which this project does
// not use, so a stray one is a bug waiting to render inconsistently.
const vs16 = all.filter((e) => e.char.includes('️')).map((e) => e.name);
ok('no entry carries an emoji variation selector', vs16.length === 0, vs16.join(', '));

const badKeywords = all.filter((e) => e.keywords !== undefined
  && (!Array.isArray(e.keywords) || e.keywords.some((k) => typeof k !== 'string'))).map((e) => e.name);
ok('keywords are string arrays where present', badKeywords.length === 0, badKeywords.slice(0, 4).join(', '));

const catIds = doc.categories.map((c) => c.id);
ok('category ids are unique', new Set(catIds).size === catIds.length, catIds.join(', '));
ok('category ids are slug shaped', catIds.every((id) => /^[a-z0-9_]+$/.test(id)), catIds.join(', '));

// The entries a reaction bar leans on, so a curation slip cannot remove them.
for (const must of ['thumbsup', 'heart', 'tada', 'joy', 'white_check_mark', 'x']) {
  ok('"' + must + '" is present', byName.has(must), 'missing');
}

console.log('\nemoji data: ' + pass + ' passed, ' + fail + ' failed, ' + all.length + ' entries');
process.exit(fail ? 1 : 0);
