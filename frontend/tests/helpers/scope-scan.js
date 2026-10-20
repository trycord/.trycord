// Reading the client's scope.
//
// An identifier used in a function that is not in scope anywhere is a fault
// that only shows when that line runs: the file parses, the module loads, the
// page works, and the fault appears the first time the button is pressed.
// `node --check` cannot see it - it reads syntax, not names - and neither can
// a check that imports every module, because the import succeeds.
//
// This reads the scope of every module in the client with a real parser and
// reports the identifiers that resolve to nothing: a bare name that is not a
// global, not an import, not a parameter and not a local declaration.
//
// The parser is optional. If it is not installed the check says so plainly
// and stops, rather than reporting a client it never read as clean. To
// install it:
//
//   cd frontend && npm install --no-save acorn acorn-walk eslint-scope
//
// and to run the scan by hand:
//
//   node frontend/tests/helpers/scope-scan.js

import fs from 'node:fs';
import path from 'node:path';

// The names the platform provides. A file that uses one of these is using
// something the runtime has, not something it forgot to declare.
export const GLOBALS = new Set([
  'window', 'document', 'console', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'URL', 'URLSearchParams', 'crypto',
  'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'Event',
  'FormData', 'Blob', 'File', 'FileReader', 'Headers', 'Request', 'Response',
  'AbortController', 'TextEncoder', 'TextDecoder', 'TextDecoderStream',
  'TextEncoderStream', 'structuredClone', 'queueMicrotask', 'performance',
  'Image', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver',
  'atob', 'btoa', 'globalThis', 'undefined', 'NaN', 'Infinity', 'self',
  'matchMedia', 'getComputedStyle', 'requestIdleCallback', 'scrollTo',
  'scrollBy', 'alert', 'confirm', 'prompt', 'top', 'parent', 'frames',
  'Intl', 'Date', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Symbol', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'BigInt', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'process', 'Buffer', '__dirname', '__filename',
  // The DOM the browser adds to the window.
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLAnchorElement', 'Document',
  'DocumentFragment', 'EventTarget', 'DOMParser', 'XMLSerializer',
  'XMLHttpRequest', 'WebSocket', 'MutationObserver', 'Range', 'Selection',
  'SVGElement', 'CSSStyleSheet', 'ShadowRoot', 'Text', 'Comment', 'Attr',
  'NodeList', 'HTMLCollection', 'DOMTokenList', 'URLPattern',
  // The error types the language has.
  'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
]);

// The names Node and the browser add to a module's top level.
export const MODULE_GLOBALS = new Set(['globalThis']);

/**
 * Load the parser, or say that it is not there.
 *
 * @returns {Promise<object|null>} the parser, or null when it is not installed
 */
export async function loadParser() {
  try {
    const acorn = await import('acorn');
    const eslintScope = await import('eslint-scope');
    return {
      acorn: acorn.default && acorn.default.parse ? acorn.default : acorn,
      eslintScope: eslintScope.default && eslintScope.default.analyze
        ? eslintScope.default
        : eslintScope,
    };
  } catch {
    return null;
  }
}

/**
 * Every .js file under a directory.
 *
 * @param {string} dir the directory to walk
 * @returns {string[]} the files
 */
export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * The names a module could not resolve.
 *
 * Two things are looked for: a name that resolves to nothing at all, and a
 * name that is read before the `let` or `const` that declares it - which is
 * a fault of the same kind, thrown when the line runs.
 *
 * @param {object} parser the parser, from loadParser()
 * @param {string} file the file to read
 * @returns {Array<object>} the findings: { kind, name, line, column, scope }
 */
export function scanFile(parser, file) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parser.acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    ranges: true,
    allowHashBang: true,
  });
  const manager = parser.eslintScope.analyze(ast, {
    ecmaVersion: 2022,
    sourceType: 'module',
    optimistic: false,
    ignoreEval: true,
    nodejsScope: false,
    globalReturn: false,
  });

  const findings = [];
  const seen = new Set();
  const record = (kind, name, line, column, scope) => {
    const key = kind + ':' + name + ':' + line + ':' + column;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, name, line, column, scope });
  };

  for (const scope of manager.scopes) {
    // A name the scope cannot resolve at all: it is not a global, not an
    // import, not a parameter and not a local declaration.
    for (const reference of scope.references) {
      if (reference.resolved) continue;
      const name = reference.identifier.name;
      if (GLOBALS.has(name) || MODULE_GLOBALS.has(name)) continue;
      const line = reference.identifier.loc ? reference.identifier.loc.start.line : 0;
      const column = reference.identifier.loc ? reference.identifier.loc.start.column : 0;
      record('unresolved', name, line, column, scope.type);
    }

    // A name read before the declaration that gives it its value. A `var` and
    // a function are hoisted, so they are not faults; a `let`, a `const` and a
    // class are not, and reading one of them first throws.
    for (const variable of scope.variables) {
      const definition = variable.defs && variable.defs[0];
      if (!definition) continue;
      const hoisted = definition.type === 'FunctionName'
        || (definition.type === 'Variable' && definition.parent.kind === 'var');
      if (hoisted) continue;
      if (!definition.name || !definition.name.loc) continue;
      const declaredAt = definition.name.loc.start.line;
      for (const reference of scope.references) {
        if (reference.resolved !== variable) continue;
        // Only a reference written in this scope itself: a reference inside a
        // function that is called later is not a fault.
        if (reference.from !== scope) continue;
        const line = reference.identifier.loc ? reference.identifier.loc.start.line : 0;
        if (line >= declaredAt) continue;
        const column = reference.identifier.loc ? reference.identifier.loc.start.column : 0;
        record('before-declaration', variable.name, line, column, scope.type);
      }
    }
  }
  return findings;
}

/**
 * Scan every module under the given directories.
 *
 * @param {object} parser the parser, from loadParser()
 * @param {string[]} dirs the directories to walk
 * @returns {Array<object>} the findings, each with a file and a line
 */
export function scanTree(parser, dirs) {
  const findings = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      for (const finding of scanFile(parser, file)) {
        findings.push(Object.assign({ file }, finding));
      }
    }
  }
  return findings;
}

// Run from the command line: read the tree and print what could not be
// resolved. The exit code is the number of findings, so a shell can use it.
if (process.argv[1] && process.argv[1].endsWith('scope-scan.js')) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const client = path.resolve(here, '..', '..');
  const parser = await loadParser();
  if (!parser) {
    console.log('The parser is not installed. Run:');
    console.log('  cd frontend && npm install --no-save acorn acorn-walk eslint-scope');
    process.exit(2);
  }
  const dirs = [
    path.join(client, 'js'),
    path.join(client, 'mobile', 'js'),
    path.join(client, 'packages'),
  ];
  const findings = scanTree(parser, dirs);
  for (const finding of findings) {
    console.log(
      path.relative(client, finding.file) + ':' + finding.line + ':' + finding.column
      + '  ' + finding.name + '  (' + finding.kind + ', in a ' + finding.scope + ')'
    );
  }
  console.log(findings.length + ' finding(s)');
  process.exit(findings.length ? 1 : 0);
}
