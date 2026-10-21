// A narrower sweep for the null-dereference class.
//
// A property read on a value that may be null: `a.b.c` where `a` is a
// parameter the caller may not have supplied. The depth matters: `a.b` on a
// parameter is usually safe (the caller passed an object), but `a.b.c` reads
// a property of a property, and the middle one may be missing.
//
// Vendor code is left out: it is not this client's code and it is not what
// the reader sees.

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walkAst from 'acorn-walk';

const client = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = [path.join(client, 'js'), path.join(client, 'mobile', 'js'), path.join(client, 'packages')];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function guardedIn(body, name) {
  let guarded = false;
  walkAst.simple(body, {
    LogicalExpression(node) {
      if (node.operator === '&&' && node.left.type === 'Identifier' && node.left.name === name) guarded = true;
    },
    ConditionalExpression(node) {
      const test = node.test;
      if (test.type === 'Identifier' && test.name === name) guarded = true;
      if (test.type === 'LogicalExpression' && test.left.type === 'Identifier' && test.left.name === name) guarded = true;
    },
    IfStatement(node) {
      const test = node.test;
      if (test.type === 'Identifier' && test.name === name) guarded = true;
      if (test.type === 'UnaryExpression' && test.argument.type === 'Identifier' && test.argument.name === name) guarded = true;
      if (test.type === 'LogicalExpression' && test.left.type === 'Identifier' && test.left.name === name) guarded = true;
    },
  });
  return guarded;
}

// The chain of property reads on an identifier: a.b.c is depth 2.
function chainDepth(node) {
  let depth = 0;
  let current = node;
  while (current && current.type === 'MemberExpression') {
    depth += 1;
    current = current.object;
  }
  return current && current.type === 'Identifier' ? depth : 0;
}

// The identifier a chain of property reads starts from.
function chainBase(node) {
  let current = node;
  while (current && current.type === 'MemberExpression') current = current.object;
  return current && current.type === 'Identifier' ? current.name : null;
}

const findings = [];
for (const dir of dirs) {
  for (const file of walk(dir)) {
    if (file.includes(path.join('packages', 'vendor'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true });
    } catch { continue; }

    const functions = [];
    walkAst.simple(ast, { Function(node) { functions.push(node); } });

    for (const fn of functions) {
      const body = fn.body;
      if (!body || body.type !== 'BlockStatement') continue;
      const params = fn.params.filter((p) => p.type === 'Identifier').map((p) => p.name);
      if (!params.length) continue;
      for (const param of params) {
        if (guardedIn(body, param)) continue;
        walkAst.simple(body, {
          MemberExpression(node) {
            if (node.optional) return;
            const base = chainBase(node);
            if (!base || base !== param) return;
            if (chainDepth(node) < 2) return;
            findings.push({
              file: path.relative(client, file),
              line: node.loc.start.line,
              text: source.split('\n')[node.loc.start.line - 1].trim(),
            });
          },
        });
      }
    }
  }
}

const seen = new Set();
for (const f of findings) {
  const key = f.file + ':' + f.line + ':' + f.text;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(f.file + ':' + f.line + '  ' + f.text);
}
console.log(findings.length + ' candidate(s)');
