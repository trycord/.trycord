// Asserts public/template.html is a valid starter for the page editor, so it
// cannot quietly stop matching the contract the editor actually implements.
const fs = require('fs');
const path = require('path');

const t = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'template.html'), 'utf8');
const begin = t.indexOf('<!-- page:begin -->');
const end = t.indexOf('<!-- page:end -->');
const fields = t.match(/class="op-field" data-op="[^"]+"/g) || [];
const uniq = new Set(fields.map((f) => /data-op="([^"]+)"/.exec(f)[1]));

const checks = [
  ['is an HTML document', /^<!doctype html>/i.test(t)],
  ['declares a lang', /<html lang="[a-z-]+"/i.test(t)],
  ['has a title', /<title>[^<]+<\/title>/.test(t)],
  ['has a meta description', /name="description" content="[^"]{40,}"/.test(t)],
  ['links the stylesheet', t.includes('/css/site.css')],
  ['loads the site script', t.includes('/js/site.js')],
  ['has a skip link', t.includes('class="skip-link"')],
  ['has the primary nav', t.includes('id="site-nav"')],
  ['has the site footer', t.includes('site-footer')],
  ['has one main region', (t.match(/<main\b/g) || []).length === 1],
  ['has the page:begin marker', begin >= 0],
  ['has the page:end marker', end >= 0],
  ['begin precedes end', begin >= 0 && end > begin],
  ['main sits inside the markers', /<main[\s\S]*page:begin[\s\S]*page:end[\s\S]*<\/main>/.test(t)],
  ['at least three operator fields', fields.length >= 3],
  ['operator field keys are unique', uniq.size === fields.length],
  ['operator keys are slug-like', [...uniq].every((k) => /^[a-z0-9-]+$/.test(k))],
  ['placeholders are marked as such', /OPERATOR:/.test(t)],
  ['header is outside the markers', t.indexOf('<header') < begin],
  ['footer is outside the markers', t.indexOf('<footer') > end],
  ['documents the registration step', t.includes('pages.js')],
  ['warns that data-op is permanent', /permanent|stable/i.test(t)],
];

let pass = 0, fail = 0;
for (const [n, c] of checks) {
  if (c) pass++; else fail++;
  console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> unmet'));
}

// The template must not be registered as a live editable page: it is a starter,
// and registering it would put a page of placeholder text on the public site.
const pages = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'pages.js'), 'utf8');
const registered = /route:\s*'template'/.test(pages);
if (registered) { fail++; console.log(' FAIL  the template is not registered as a live page  -> it would be served'); }
else { pass++; console.log('  ok   the template is not registered as a live page'); }

console.log('\ntemplate: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
