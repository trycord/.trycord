// Checks that every name a module calls or reaches through a dot has been imported
// or declared somewhere in that file.
//
// Added after a refactor removed `import Api from` from every file in a directory
// rather than from the files that did not use it, leaving profile.js calling Api ten
// times with nothing imported. Every other check was green: the syntax is valid, the
// imports that remained all resolved, and the module parsed. Only running the page
// finds that. A second break of the same family followed - a splitter filtered a
// helper out of an export list and then emitted only the export list, so the
// sessions page called loadSessions() that did not exist - which is why this now
// also looks at plain function calls and not only at Capitalised.name.
//
// The earlier general version of this produced hundreds of false positives from
// dynamic import() destructuring. The noise here is controlled by scanning comments
// with a real tokenizer (strip-comments.js), binding every declaration and parameter
// at any depth, and allowing the language and the browser through by name.
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './strip-comments.js';

// ES module, so no __dirname. The repo root is two levels up from trycord-server.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const JS = path.resolve(HERE, '..', '..', 'trycord-client', 'js');

// The language and the browser. Without these the check is 79 lines of noise.
const BUILT_IN = new Set([
  'Object','Array','String','Number','Boolean','Symbol','BigInt','Math','JSON','Date','RegExp',
  'Promise','Map','Set','WeakMap','WeakSet','Proxy','Reflect','Error','TypeError','RangeError',
  'SyntaxError','ReferenceError','EvalError','URIError','Function','Intl','ArrayBuffer',
  'DataView','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array',
  'Int32Array','Uint32Array','Float32Array','Float64Array','URL','URLSearchParams',
  'Headers','Request','Response','FormData','Blob','File','FileReader','TextEncoder',
  'TextDecoder','AbortController','WebSocket','EventSource','Event','CustomEvent','MessageChannel',
  'fetch','CSS','Image','HTMLElement','Element','Node','NodeList','DOMParser','XMLHttpRequest',
  'crypto','performance','navigator','window','document','location','history','localStorage',
  'sessionStorage','console','setTimeout','clearTimeout','setInterval','clearInterval',
  'requestAnimationFrame','cancelAnimationFrame','queueMicrotask','structuredClone','SVGElement','SVGPathElement','MutationObserver','ResizeObserver','IntersectionObserver','Notification','Storage','Location','History',
]);

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
};
walk(JS);

const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  // Comments and string bodies go, via a scanner rather than a regex. See
  // strip-comments.js for the two regex attempts that ate this codebase.
  const code = stripComments(src);

  // Everything this file brought in, or declared.
  const bound = new Set();
  for (const m of code.matchAll(/import\s+([^;'"]+?)\s+from/g)) {
    const braces = m[1].match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const as = part.trim().split(/\s+as\s+/);
        bound.add((as[1] || as[0] || '').trim());
      }
    }
    const def = m[1].replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    for (const d of def.split(/\s+/)) if (d && d !== '*' && d !== 'as') bound.add(d);
  }
  for (const m of code.matchAll(/\b(?:function|class)\s+([A-Z][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Z][\w$]*)/g)) bound.add(m[1]);

  // Also bind every declaration and parameter at any depth, since a helper defined
  // inside a function is still a helper.
  for (const m of code.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.split(':').map((x) => x.trim());
      bound.add((bits[1] || bits[0] || '').replace(/=.*$/, '').trim());
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) bound.add(part.split('=')[0].trim());
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) bound.add(t);
    }
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  // Named imports pulled out by a dynamic import() are real bindings too.
  for (const m of code.matchAll(/import\s*\(\s*['"][^'"]+['"]\s*\)\s*\.then\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) bound.add(part.split(':')[0].trim());
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)\.then\s*\(\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) bound.add(part.split(':')[0].trim());
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*await\s*import/g)) {
    bound.add(m[1]);
  }
  // Object keys and labels are not references.
  bound.add('arguments');

  const reported = new Set();
  const note = (name, at) => {
    if (bound.has(name) || BUILT_IN.has(name) || reported.has(name)) return;
    reported.add(name);
    const line = code.slice(0, at).split('\n').length;
    problems.push([path.relative(JS, file), line, name]);
  };

  for (const m of code.matchAll(/(^|[^.\w$'"`])([A-Z][\w$]*)\s*\.\s*[a-z_$]/g)) note(m[2], m.index);

  // Deliberately not checking plain lowercase calls. It was tried: 64 findings
  // across 60 modules, of which the ones in the account tree were a false positive
  // about window.prompt and two about a name in prose. Real ones were found and
  // fixed - but a gate that reports 64 to catch 3 does not get run, and the two
  // checks that do run (the boot probe and the per-surface fault detector) execute
  // the application, which is what actually catches this.


}

if (problems.length) {
  console.error('unbound-reference check FAILED - ' + problems.length + ' unbound name(s):');
  for (const [f, line, name] of problems) {
    console.error('  ' + f + ':' + line + '  ' + name + ' is used but never imported');
  }
  process.exit(1);
}
console.log('unbound-reference check passed (' + files.length + ' modules, every Api./State. style name is bound)');
