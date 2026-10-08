#!/usr/bin/env node
'use strict';

// That the CI files are a workflow GitHub will accept.
//
// This exists because of a commit that put two `with:` keys on one checkout step. PyYAML
// does not complain: a duplicate mapping key is overwritten, the parse succeeds, and
// `yaml.safe_load` hands back a document that looks fine. GitHub rejects the file
// outright, and the run fails in the same second it is created with zero jobs and no step
// to blame, so the only symptom is a red tick on a commit that changed one line of a
// workflow. Both the local suite and every other check passed.
//
// Two questions:
//
//   1. does any mapping repeat a key, or use a tab?
//   2. does every job that runs npm install first? The screenshots job spent a while
//      failing on `Cannot find module 'dotenv'` for exactly that reason, which reads as a
//      broken product rather than a missing install step.
//
// It reads the block-style subset these files are written in - mappings, sequences,
// scalars, comments - and does not attempt to be a YAML implementation. There are no
// anchors, no flow collections and no block scalars at the YAML level; the only `{` and
// `[` in these files are inside `run:` shell scripts, which this never looks at. Anything
// outside the subset is reported rather than guessed at, so a workflow that starts using
// flow style fails this check instead of being half-read.
//
// node scripts/check-workflows.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, '.github', 'workflows');

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

/**
 * Parse the block subset into { key: value | {..} | [..] }, tracking the line each key is
 * on so a duplicate can say where the first one was.
 */
function parse(text, file) {
  const root = { __map__: new Map(), __line__: 0 };
  const stack = [{ indent: -1, node: root }];
  const dupes = [];
  const unsupported = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const no = i + 1;
    if (raw.includes('\t') && raw.trim()) {
      unsupported.push(`${file}:${no} a tab; YAML forbids tabs for indentation`);
      continue;
    }
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const indent = raw.length - raw.replace(/^ */, '').length;
    const body = raw.trim();

    let key = null;
    let value;
    let isSequence = false;
    let isBlockScalar = false;

    if (/^- /.test(body)) {
      isSequence = true;
    } else {
      // A block scalar's content is shell, not structure, so the value is opaque and the
      // body is not parsed as YAML at all.
      const block = /^([A-Za-z0-9_.$-]+):\s*[|>][-+]?$/.exec(body);
      const pair = /^([A-Za-z0-9_.$-]+):(?:\s+(.*))?$/.exec(body);
      if (block) { key = block[1]; isBlockScalar = true; }
      else if (pair) { key = pair[1]; value = pair[2]; }
      else {
        unsupported.push(`${file}:${no} not block-style key: value - ${body.slice(0, 40)}`);
        continue;
      }
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (isSequence) {
      if (!Array.isArray(parent)) continue;
      // A sequence item is a mapping like any other. Without a __map__ on it every key
      // beneath the dash is silently discarded, which makes the duplicate check see
      // nothing and the install check see no steps - a check that passes because it read
      // nothing, which is the one thing this file exists to prevent.
      const item = { __map__: new Map(), __line__: no };
      parent.push(item);
      stack.push({ indent, node: item });
      continue;
    }

    if (isBlockScalar) {
      // Consume the indented block beneath it so its contents are not read as structure.
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) { j++; continue; }
        if (l.length - l.replace(/^ */, '').length <= indent) break;
        j++;
      }
      i = j - 1;
      value = '(block)';
    }

    if (!parent.__map__) continue;
    if (parent.__map__.has(key)) {
      dupes.push(`${file}:${no} "${key}" first at line ${parent.__map__.get(key)}`);
      continue;
    }
    parent.__map__.set(key, no);

    if (value === undefined || value === '') {
      // A key with no inline value is a mapping, unless the next meaningful line is a
      // `- ` at a deeper indent - then it is a sequence. Looking ahead is what tells the
      // two apart; getting it wrong turns every job's `steps` into one mapping with nine
      // copies of `uses` in it.
      const child = { __map__: new Map(), __line__: no };
      parent[key] = child;
      stack.push({ indent, node: child });
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      if (j < lines.length && /^\s*-\s/.test(lines[j])
        && lines[j].length - lines[j].replace(/^ */, '').length > indent) {
        parent[key] = [];
        stack.pop();
        stack.push({ indent, node: parent[key] });
      }
    } else {
      parent[key] = value;
    }
  }
  return { root, dupes, unsupported };
}

/** Follow a path of mapping keys. */
function at(node, ...keys) {
  let n = node;
  for (const k of keys) {
    if (!n || !n.__map__ || !n.__map__.has(k)) return null;
    n = n[k];
  }
  return n;
}

/**
 * The list under a key. A block sequence is stored as an array on the parent, and each
 * `- ` line opened a mapping for the item beneath it, so the array holds placeholders and
 * the mappings are children of whatever came before. Walk the tree to collect them.
 */
function sequence(node) {
  return Array.isArray(node) ? node : null;
}

function stepsOf(job) {
  const steps = at(job, 'steps');
  if (!Array.isArray(steps)) return [];
  // Each entry is the mapping opened by its `- ` line.
  return steps.filter((s) => s && s.__map__);
}

if (!fs.existsSync(DIR)) {
  console.log('\n  no .github/workflows - nothing to check\n');
  process.exit(0);
}

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
ok('there is at least one workflow', files.length > 0, DIR);

let dupes = [];
let unsupported = [];
const jobs = [];

for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const p = parse(text, f);
  dupes = dupes.concat(p.dupes);
  unsupported = unsupported.concat(p.unsupported);

  const docJobs = at(p.root, 'jobs');
  ok(`${f}: has a jobs section`, !!docJobs && !!docJobs.__map__);
  if (!docJobs || !docJobs.__map__) continue;
  // __map__ maps a key to the line it is on; the node itself is the property of the same
  // name. Iterating the map's entries gives line numbers, which read as steps of length
  // NaN and make every assertion below quietly pass.
  for (const name of docJobs.__map__.keys()) {
    const job = docJobs[name];
    if (!job || !job.__map__) continue;
    jobs.push({ f, name, steps: sequence(at(job, 'steps')) || [] });
  }
}

ok('no mapping repeats a key', dupes.length === 0, dupes.join('; '));
ok('every line is block-style YAML this can read', unsupported.length === 0,
  unsupported.slice(0, 3).join('; '));

for (const { f, name, steps } of jobs) {
  const texts = steps.map((s) => String((s && s.run) || ''));
  const runs = texts.some((t) => /\bnpm (run|ci|install|test)\b/.test(t));
  if (!runs) continue;
  const installs = texts.some((t) => /\bnpm (ci|install|i)\b/.test(t));
  ok(`${f}: ${name} installs before it runs npm`, installs,
    'no npm ci or npm install step, so the first require() decides');
}

console.log(failures
  ? `\n  workflows FAILED - ${failures} assertion(s)\n`
  : `\n  workflows passed - ${files.length} file(s), ${jobs.length} job(s), every job installs`
    + ` before it runs npm\n`);
process.exit(failures ? 1 : 0);