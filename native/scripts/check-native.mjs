#!/usr/bin/env node
/**
 * A static check over the native client.
 *
 * There is no toolchain in the room this was written in: no Xcode, no
 * Android SDK, no Gradle, no npm registry. So the check that can be run is
 * the one that does not need one: every JSON file parses, and every relative
 * import in the TypeScript sources resolves to a file that exists and
 * exports the names that are asked of it.
 *
 * It is not a compiler. It does not type-check, it does not know about
 * packages, and it does not know whether the code runs. What it does catch is
 * the mistakes that are cheap to make and expensive to find later: a renamed
 * file, a moved module, a typo in an import.
 *
 *   node native/scripts/check-native.mjs
 */

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const appRoot = join(root, 'app');

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'Pods',
  'build',
  '.git',
  '.gradle',
  'DerivedData',
  'coverage',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];

const problems = [];
let jsonFiles = 0;
let sourceFiles = 0;
let importsChecked = 0;

/**
 * Every file under the native client, skipping the directories that hold
 * build output or installed packages.
 */
function walk(directory, out = []) {
  let entries;
  try {
    entries = readdirSync(directory, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.watchmanconfig') {
      if (entry.isDirectory()) continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(full);
  }
  return out;
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isSource(file) {
  return SOURCE_EXTENSIONS.includes(extname(file));
}

function isJson(file) {
  return extname(file) === '.json';
}

/**
 * Resolves a relative specifier the way a bundler would: the file itself,
 * then the same name with each known extension, then its directory's index.
 */
function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  for (const extension of RESOLVE_EXTENSIONS) {
    candidates.push(base + extension);
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    candidates.push(join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there; try the next one.
    }
  }
  return null;
}

/**
 * The names a file exports.
 *
 * The file's own declarations, plus anything it re-exports. A file that
 * re-exports from a package - which cannot be read from here - accepts any
 * name, because the names it carries are not written in this repository.
 */
function collectExports(source, file, seen = new Set()) {
  const names = new Set();
  let reexportsEverything = false;

  if (seen.has(file)) return {names, reexportsEverything};
  seen.add(file);

  const declaration = [
    /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /export\s+type\s+([A-Za-z_$][\w$]*)/g,
    /export\s+enum\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of declaration) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      names.add(match[1]);
    }
  }

  const lists = [
    /export\s*\{([^}]*)\}/g,
    /export\s+type\s*\{([^}]*)\}/g,
  ];
  for (const pattern of lists) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      for (const part of match[1].split(',')) {
        const trimmed = part.trim().replace(/^type\s+/, '');
        if (!trimmed) continue;
        const asParts = trimmed.split(/\s+as\s+/);
        const exported = (asParts[1] || asParts[0]).trim();
        if (exported) names.add(exported);
      }
    }
  }

  const namespace = /export\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = namespace.exec(source)) !== null) {
    names.add(match[1]);
  }

  // `export * from './x'` carries the names of that file, so they are
  // followed rather than assumed.
  const star = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  while ((match = star.exec(source)) !== null) {
    if (!isRelative(match[1])) {
      reexportsEverything = true;
      continue;
    }
    const target = resolveSpecifier(file, match[1]);
    if (!target || !isSource(target)) {
      reexportsEverything = true;
      continue;
    }
    const inner = collectExports(readFileSync(target, 'utf8'), target, seen);
    for (const exported of inner.names) {
      if (exported !== 'default') names.add(exported);
    }
    if (inner.reexportsEverything) reexportsEverything = true;
  }

  if (/export\s+default\b/.test(source)) {
    names.add('default');
  }

  return {names, reexportsEverything};
}

/**
 * The names an import statement asks for.
 */
function collectRequested(clause) {
  const requested = [];
  // A type-only clause names types, not a default export.
  const text = clause.trim().replace(/^type\s+/, '');
  if (!text) return requested;

  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (namespace) requested.push(namespace[1]);

  const braces = /\{([\s\S]*)\}/.exec(text);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '');
      if (!trimmed) continue;
      const asParts = trimmed.split(/\s+as\s+/);
      const imported = asParts[0].trim();
      if (imported) requested.push(imported);
    }
  }

  const before = braces ? text.slice(0, text.indexOf('{')) : text;
  const defaultName = before.replace(/,/g, ' ').trim().split(/\s+/)[0];
  if (defaultName && /^[A-Za-z_$][\w$]*$/.test(defaultName)) {
    requested.push('default');
  }

  return requested;
}

const files = walk(appRoot);

for (const file of files) {
  const name = relative(root, file);

  if (isJson(file)) {
    jsonFiles += 1;
    try {
      JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${name}: is not valid JSON - ${error.message}`);
    }
    continue;
  }

  if (!isSource(file)) continue;
  sourceFiles += 1;

  const source = readFileSync(file, 'utf8');
  const statements = [];

  const importPattern = /import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    statements.push({clause: match[1], specifier: match[2]});
  }

  const sideEffect = /import\s*['"]([^'"]+)['"]/g;
  while ((match = sideEffect.exec(source)) !== null) {
    statements.push({clause: '', specifier: match[1]});
  }

  const exportFrom = /export\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  while ((match = exportFrom.exec(source)) !== null) {
    statements.push({clause: match[1], specifier: match[2]});
  }

  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requirePattern.exec(source)) !== null) {
    statements.push({clause: '', specifier: match[1]});
  }

  for (const statement of statements) {
    if (!isRelative(statement.specifier)) continue;
    importsChecked += 1;

    const target = resolveSpecifier(file, statement.specifier);
    if (!target) {
      problems.push(
        `${name}: imports "${statement.specifier}", which does not resolve to a file`,
      );
      continue;
    }

    // `export * as ns from './x'` names the whole module, so there is no
    // name to ask the target for.
    if (/^\*\s+as\s+/.test(statement.clause.trim())) continue;

    const requested = collectRequested(statement.clause);
    if (!requested.length) continue;
    if (!isSource(target)) continue;

    const targetSource = readFileSync(target, 'utf8');
    const {names, reexportsEverything} = collectExports(targetSource, target);
    if (reexportsEverything) continue;

    for (const wanted of requested) {
      if (wanted === 'default') {
        if (!names.has('default')) {
          problems.push(
            `${name}: imports the default of "${statement.specifier}", which has none`,
          );
        }
        continue;
      }
      if (!names.has(wanted)) {
        problems.push(
          `${name}: imports "${wanted}" from "${statement.specifier}", which does not export it`,
        );
      }
    }
  }
}

const lines = [
  'trycord native check',
  `  root: ${root}`,
  `  json files parsed: ${jsonFiles}`,
  `  source files scanned: ${sourceFiles}`,
  `  relative imports resolved: ${importsChecked}`,
];

if (problems.length) {
  lines.push(`  problems: ${problems.length}`);
  for (const problem of problems) lines.push(`    - ${problem}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(1);
}

lines.push('  problems: 0');
lines.push('  result: ok');
process.stdout.write(`${lines.join('\n')}\n`);
