// The legal pages have to be publishable, honest, and safe to publish.
//
// Four things are checked here:
//
//   1. The six pages the administrator can edit still carry the markers the
//      editor replaces, and the pages it cannot edit still do not pretend to.
//   2. No legal page names a legal identity that nobody supplied. The pages
//      are templates: the operator's name, jurisdiction and contacts are
//      placeholders until an operator fills them in, and a template that
//      invents a company is a template that will be published as a lie.
//   3. The prohibition on child sexual abuse material is present, explicit,
//      and covers the ways such material actually reaches an instance.
//   4. Any page carrying operator placeholders says, on its face, that it
//      needs a lawyer before it is presented as binding.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_DIR, REPO_DIR } = require('./helpers');

// The routes the administrator may edit, and the pages behind them. Read from
// the server's own list so the two cannot disagree.
const EDITABLE = (() => {
  const source = fs.readFileSync(path.join(REPO_DIR, 'backend', 'src', 'services', 'pages.js'), 'utf8');
  const out = [];
  const pattern = /\{\s*route:\s*'([^']+)',\s*file:\s*'([^']+)'/g;
  let m;
  while ((m = pattern.exec(source))) out.push({ route: m[1], file: m[2] });
  assert.ok(out.length, 'the editable page list could not be read');
  return out;
})();

const LEGAL_PAGES = [
  'terms.html',
  'privacy.html',
  'instances-terms.html',
  'trust-and-safety.html',
  'support.html',
  'security.html',
  'guidelines.html',
  'community-guidelines.html',
  'federation-policy.html',
  'cookies.html',
  'licenses.html',
];

// The pages whose content is the acceptable-use statement. The prohibition
// has to be in all of them, because they are read by different people.
const ACCEPTABLE_USE_PAGES = [
  'terms.html',
  'guidelines.html',
  'trust-and-safety.html',
  'community-guidelines.html',
  'federation-policy.html',
];

const REVIEW_MARKER = 'Legal review required before publication';

function page(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

test('the editable pages still carry the markers the editor replaces', () => {
  for (const { route, file } of EDITABLE) {
    const html = page(file);
    assert.ok(html.includes('<!-- page:begin -->'),
      file + ' has lost its page:begin marker, so publishing would replace nothing');
    assert.ok(html.includes('<!-- page:end -->'),
      file + ' has lost its page:end marker, so publishing would replace nothing');
    assert.ok(html.indexOf('<!-- page:begin -->') < html.indexOf('<!-- page:end -->'),
      file + ' has its markers the wrong way round');
    assert.ok(route.length > 0);
  }
});

test('the pages the editor cannot edit do not claim to be editable', () => {
  const editableFiles = new Set(EDITABLE.map((p) => p.file));
  for (const name of LEGAL_PAGES) {
    if (editableFiles.has(name)) continue;
    const html = page(name);
    assert.ok(!html.includes('<!-- page:begin -->'),
      name + ' carries an editable region but is not in the editable list');
  }
});

test('no legal page invents a legal identity', () => {
  // Each of these is a claim about who the operator is. The operator supplies
  // it, in a field, after they have looked at it.
  const forbidden = ['Ltd', 'LLC', 'Inc.', 'GmbH', 'S.A.', 'registered in', 'company number'];
  const failures = [];
  for (const name of LEGAL_PAGES) {
    const html = page(name);
    for (const pattern of forbidden) {
      const at = html.toLowerCase().indexOf(pattern.toLowerCase());
      if (at !== -1) {
        failures.push(name + ': mentions "' + pattern + '"');
      }
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the child safety prohibition is explicit on every page that states the rules', () => {
  for (const name of ACCEPTABLE_USE_PAGES) {
    const html = page(name);
    assert.match(html, /child sexual abuse material/i,
      name + ' does not name the prohibition');
    // The prohibition has to be a prohibition, not a mention.
    assert.match(html, /prohibit/i,
      name + ' mentions child sexual abuse material without prohibiting it');
  }
});

test('the prohibition covers the ways such material actually arrives', () => {
  for (const name of ['terms.html', 'guidelines.html', 'trust-and-safety.html']) {
    const html = page(name).toLowerCase();
    assert.match(html, /attachment|file/, name + ' does not cover files or attachments');
    assert.match(html, /bot/, name + ' does not cover bots');
    assert.match(html, /integration|extension/, name + ' does not cover integrations');
    assert.match(html, /federat/, name + ' does not cover federation');
  }
});

test('running an instance is not an exception to the prohibition', () => {
  for (const name of ['terms.html', 'guidelines.html', 'trust-and-safety.html']) {
    const html = page(name);
    assert.match(html, /does not create an exception|not exempt|no exception/i,
      name + ' does not say that hosting an instance is not an exception');
  }
});

test('every page with operator placeholders marks them for review', () => {
  const failures = [];
  for (const name of LEGAL_PAGES) {
    const html = page(name);
    if (!/class="op-field"/.test(html)) continue;
    if (!html.includes(REVIEW_MARKER)) {
      failures.push(name + ': carries operator placeholders but does not say it needs legal review');
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('operator placeholders are marked up the way the editor expects', () => {
  for (const name of LEGAL_PAGES) {
    const html = page(name);
    const fields = html.match(/<span class="op-field"[^>]*>/g) || [];
    for (const field of fields) {
      assert.match(field, /data-op="[a-z0-9-]+"/,
        name + ': an operator field has no stable data-op name: ' + field);
    }
    // The editor looks for the all-caps prefix to know a field is still empty.
    for (const value of html.match(/<span class="op-field"[^>]*>([^<]*)<\/span>/g) || []) {
      assert.match(value, />OPERATOR:/,
        name + ': an operator field does not carry the OPERATOR prefix: ' + value);
    }
  }
});

test('the pages say who to write to', () => {
  // The address fields used to be empty, waiting for an operator to fill
  // them in, and the hosted site published them that way. They name the
  // project's contact points now, and a page must not go back to an empty
  // address field.
  const emptyAddress = /OPERATOR:\s*(the (address|contact)[^<]{0,60})/i;
  for (const name of LEGAL_PAGES) {
    const html = page(name);
    const at = html.search(emptyAddress);
    assert.equal(at, -1, name + ' has an empty address field: '
      + html.slice(at, at + 90).replace(/\s+/g, ' '));
  }
});

test('the version lines match the server\'s legal versions', () => {
  const legal = fs.readFileSync(path.join(REPO_DIR, 'backend', 'src', 'legal.js'), 'utf8');
  const terms = /TERMS_VERSION:\s*'([^']+)'/.exec(legal);
  const privacy = /PRIVACY_VERSION:\s*'([^']+)'/.exec(legal);
  const updated = /LEGAL_UPDATED:\s*'([^']+)'/.exec(legal);
  assert.ok(terms && privacy && updated, 'the legal versions could not be read');

  for (const [name, version] of [['terms.html', terms[1]], ['privacy.html', privacy[1]]]) {
    const html = page(name);
    assert.ok(html.includes('<code>' + version + '</code>'),
      name + ' does not show version ' + version);
    assert.ok(html.includes(updated[1]),
      name + ' does not show the template revision date ' + updated[1]);
  }
});
