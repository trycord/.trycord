// The deployment environment, as a file.
//
// The process reads .env once at boot (see server.js): the file lives beside
// package.json, or wherever DOTENV_CONFIG_PATH puts it. This module is the one
// place that writes it back: a Configuration save made with the environment in
// authority lands here, a reset removes its line again. Everything else is
// preserved byte for byte - the comments, the blank lines, the ordering, and
// any key this module was never asked about.
//
// The file is parsed minimally on purpose. The writer matches a line that
// starts `KEY=` for the exact key it was given and replaces that line; a file
// it cannot read or write is reported and nothing is written, rather than a
// half-rewrite being presented as a save.

const fs = require('fs');
const path = require('path');

// Where the file is, resolved exactly the way server.js resolves it: the
// explicit DOTENV_CONFIG_PATH when the deployment names one, otherwise .env in
// the working directory - which is the directory npm start runs from.
function envPath() {
  return process.env.DOTENV_CONFIG_PATH
    ? path.resolve(process.env.DOTENV_CONFIG_PATH)
    : path.resolve(process.cwd(), '.env');
}

// A missing file reads as empty, because a first save on an install that has
// not created one yet writes a fresh file rather than failing.
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    throw unwritable(p, 'could not be read: ' + (e.message || e.code));
  }
}

// A value is written bare when it is unambiguous, and double-quoted when it is
// not: quoting is what keeps a trailing space inside a header prefix - the one
// thing a bare value cannot survive - and duplicates how dotenv reads the value
// back, so what a save writes is what the next boot reads.
function serialiseValue(value) {
  const text = String(value);
  if (text === '') return '';
  const safe = text.trim() === text && !/["\\\r\n]/.test(text);
  if (safe) return text;
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n') + '"';
}

// Turn `KEY=value` into a whole line. Applied when the save processes a batch,
// so the file is read once and written once however many keys changed.
function lineFor(key, value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? key + '=' + serialiseValue(value)
    : null;
}

function findLine(lines, key) {
  const pattern = new RegExp('^' + key + '=(?:.*)$');
  return lines.findIndex((line) => pattern.test(line));
}

// Insert or replace the keys' lines, preserving every other line, and write
// the result atomically-ish: a temporary file and a rename, so an interrupted
// write leaves the previous file rather than a truncated one.
function upsert(p, entries) {
  const wanted = [];
  for (const [key, value] of entries) {
    const line = lineFor(key, value);
    if (!line) throw unwritable(p, 'a setting has an environment name that cannot be written to the file: ' + key);
    wanted.push(line);
  }

  let lines = readText(p).split('\n');
  for (const keyed of wanted) {
    const key = keyed.slice(0, keyed.indexOf('='));
    const at = findLine(lines, key);
    if (at !== -1) lines[at] = keyed;
    else lines.push(keyed);
  }

  let out = lines.join('\n');
  if (out !== '' && !out.endsWith('\n')) out += '\n';
  try {
    fs.writeFileSync(p + '.tmp', out, 'utf8');
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    try { fs.unlinkSync(p + '.tmp'); } catch { /* nothing to clean up */ }
    throw unwritable(p, 'could not be written: ' + (e.message || e.code));
  }
  return out;
}

// Remove the keys' lines. A key the file does not name is already as the reset
// wants it, so removing an absent key succeeds.
function remove(p, keys) {
  let lines = readText(p).split('\n');
  let touched = false;
  for (const key of keys) {
    const at = findLine(lines, key);
    if (at !== -1) { lines.splice(at, 1); touched = true; }
  }
  if (!touched) return lines.join('\n');
  let out = lines.join('\n');
  if (out !== '' && !out.endsWith('\n')) out += '\n';
  try {
    fs.writeFileSync(p + '.tmp', out, 'utf8');
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    try { fs.unlinkSync(p + '.tmp'); } catch { /* nothing to clean up */ }
    throw unwritable(p, 'could not be written: ' + (e.message || e.code));
  }
  return out;
}

function unwritable(p, message) {
  const e = new Error('The environment file at ' + p + ' ' + message
    + '. Nothing was changed in the deployment.');
  e.code = 'ENV_FILE_UNWRITABLE';
  return e;
}

module.exports = {
  envPath, serialiseValue, upsert, remove,
};
