// Checks that every module-level name a module uses has been imported or declared.
//
// Added after a refactor removed `import Api from` from every file in a directory
// rather than from the files that did not use it, leaving profile.js calling
// Api.* ten times with nothing imported. Every other check was green: the syntax is
// valid, the imports that remain all resolve, and the module parses. Only running
// the page finds that.
//
// The shape it looks for is deliberately narrow - a capitalised name in front of a
// dot - because in this client that is how a module or a singleton is reached
// (Api.something, State.me, Realtime.connect). A general "identifier used but not
// declared" pass produces hundreds of false positives from dynamic import()
// destructuring and object shorthand, which is not worth the noise.
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

  const reported = new Set();
  for (const m of code.matchAll(/(^|[^.\w$'"`])([A-Z][\w$]*)\s*\.\s*[a-z_$]/g)) {
    const name = m[2];
    if (bound.has(name) || BUILT_IN.has(name) || reported.has(name)) continue;
    reported.add(name);
    const line = code.slice(0, m.index).split('\n').length;
    problems.push([path.relative(JS, file), line, name]);
  }
}

if (problems.length) {
  console.error('singleton check FAILED - ' + problems.length + ' unbound name(s):');
  for (const [f, line, name] of problems) {
    console.error('  ' + f + ':' + line + '  ' + name + ' is used but never imported');
  }
  process.exit(1);
}
console.log('singleton check passed (' + files.length + ' modules, every Api./State. style name is bound)');
