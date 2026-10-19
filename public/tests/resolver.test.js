// The API's address is resolved, not assumed.
//
// The defect this exists to catch: a public site and its API are not always
// the same origin. A page that asks for a relative '/api/...' reaches the
// site, which has no API, and the answer is a 404 that reads like a broken
// instance. The pages therefore resolve the address once and route every
// call through it.
//
// The checks are static, on the source, because that is what catches the
// regression: a path written into a fetch call is invisible in a running
// instance whose API happens to share the site's origin.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_DIR, read, functionBody } = require('./helpers');

const API_FILE = path.join(PUBLIC_DIR, 'js', 'public-api.js');
const STATUS_FILE = path.join(PUBLIC_DIR, 'js', 'status.js');
const COMMUNITIES_FILE = path.join(PUBLIC_DIR, 'js', 'communities.js');

function scriptFiles() {
  return fs.readdirSync(path.join(PUBLIC_DIR, 'js'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(PUBLIC_DIR, 'js', name));
}

test('public-api.js prefers the page\'s own answer for the API', () => {
  const source = read(API_FILE);
  assert.match(source, /meta\[name="trycord-api"\]/, 'the meta tag is not read');

  const body = functionBody(source, 'apiBase');
  assert.ok(body, 'apiBase is not a function in public-api.js');

  const metaAt = body.indexOf('fromMeta()');
  const fileAt = body.indexOf('backendJson()');
  assert.ok(metaAt !== -1, 'apiBase does not consult the meta tag');
  assert.ok(fileAt !== -1, 'apiBase has no fallback');
  assert.ok(metaAt < fileAt, 'apiBase falls back to the file before the meta tag');

  // The fallback order the site documents: the meta, then backend.json, then
  // the origin that served the page.
  assert.match(body, /location\.origin|siteOrigin\(\)/, 'apiBase has no last resort');
});

test('apiBase() resolves once and remembers the answer', () => {
  const body = functionBody(read(API_FILE), 'apiBase');
  assert.match(body, /if \(basePromise\) return basePromise;/,
    'apiBase does not memoise its answer');
  // Both paths must assign the promise, or the second call would start over.
  const assignments = body.match(/basePromise\s*=/g) || [];
  assert.ok(assignments.length >= 2,
    'apiBase does not store the answer on both paths: ' + assignments.length);
});

test('the resolver falls back cleanly when the meta tag is absent', () => {
  const body = functionBody(read(API_FILE), 'fromMeta');
  assert.ok(body, 'fromMeta is not a function');
  // No content, or content that is not an http(s) address, both mean "no
  // answer here" rather than an exception.
  assert.match(body, /return null/);
});

test('status.js asks the API for its health, not the site', () => {
  const source = read(STATUS_FILE);
  assert.match(source, /TrycordApi/, 'status.js does not use the site\'s resolver');
  assert.match(source, /apiBase/, 'status.js does not resolve the API address');

  // The two health endpoints are the instance's own. They have to be asked
  // for at the API's address.
  assert.match(source, /'\/health'/, 'status.js does not probe /health');
  assert.match(source, /'\/api\/health'/, 'status.js does not probe /api/health');

  // A relative probe is the defect itself.
  assert.doesNotMatch(source, /probe\('\/health'\)/, 'status.js probes /health relatively');
  assert.doesNotMatch(source, /probe\('\/api\/health'\)/, 'status.js probes /api/health relatively');
  assert.doesNotMatch(source, /fetch\('\/health'/, 'status.js fetches /health relatively');
  assert.doesNotMatch(source, /fetch\('\/api\/health'/, 'status.js fetches /api/health relatively');

  // The site is a separate question, and it is asked of the site's own origin.
  assert.match(source, /location\.origin/, 'status.js does not probe the site\'s own origin');
});

test('status.js still reads the status monitor', () => {
  const source = read(STATUS_FILE);
  assert.match(source, /status-monitor/, 'the monitor path is gone');
  assert.match(source, /status\.json/, 'the monitor report is not read');
});

test('communities.js resolves community icons against the API', () => {
  const source = read(COMMUNITIES_FILE);
  assert.match(source, /assetUrl/, 'communities.js does not resolve icon addresses');
  // The API returns a path. Using it as-is resolves it against the page.
  assert.doesNotMatch(source, /src:\s*server\.icon_url/,
    'communities.js uses the API-relative icon path verbatim');
});

test('no page script calls a relative API path', () => {
  const failures = [];
  for (const file of scriptFiles()) {
    const name = path.basename(file);
    const source = read(file);
    const relative = source.match(/fetch\(\s*['"`]\/api/g);
    if (relative) failures.push(name + ': fetches a relative /api path');
    if (/fetch\(\s*['"`]\/health/.test(source)) failures.push(name + ': fetches a relative /health path');
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('no page script hardcodes the application mount in a link', () => {
  const failures = [];
  for (const file of scriptFiles()) {
    const name = path.basename(file);
    const source = read(file);
    if (/(?:href|action)\s*[:=]\s*['"`]\/app/.test(source)) {
      failures.push(name + ': writes the application mount into a link');
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the application mount is looked for in one place only', () => {
  // The mount is a fact about the deployment, so exactly one file may look
  // for it: the resolver. Everywhere else it comes from the resolver.
  const mentioning = scriptFiles()
    .map((file) => path.basename(file))
    .filter((name) => read(path.join(PUBLIC_DIR, 'js', name)).includes('/app/'));
  assert.deepEqual(mentioning, ['public-api.js'],
    'the application mount is mentioned outside the resolver');
});

test('the resolver knows where the application is served from', () => {
  const source = read(API_FILE);
  assert.match(source, /appUrl/, 'the resolver does not read the instance\'s appUrl');
  assert.match(source, /function appBase\(/, 'there is no application base resolver');
  assert.match(source, /function appHref\(/, 'there is no way to build an address inside the application');

  // The address is read, not written down: a path in the markup would work on
  // one deployment and 404 on the next.
  const body = functionBody(source, 'appBase');
  assert.match(body, /backendJson\(\)/, 'the application base is not read from the instance');
  assert.doesNotMatch(body, /['"`]\/app['"`]/, 'the application base is hardcoded');
});
