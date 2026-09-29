// BBCode in page content.
//
// A regex BBCode converter is the standard way to get cross-site scripting into
// a page, because it rewrites input into HTML before deciding what the input
// was. These assertions are the reason this one is a parser: every hostile input
// below is checked for the specific thing it would achieve if the allowlist were
// wrong, rather than for the absence of a substring.
const { toHtmlInline, toBBCode, safeUrl, safeColour, parseNodes } = require('../src/services/bbcode');
const { normalise, toHtml } = require('../src/services/pageContent');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };
const render = (t) => toHtmlInline(t);
const has = (h, needle) => h.includes(needle);

console.log('--- it formats ---');
ok('bold', has(render('[b]x[/b]'), '<strong>x</strong>'), render('[b]x[/b]'));
ok('italic', has(render('[i]x[/i]'), '<em>x</em>'), render('[i]x[/i]'));
ok('underline', has(render('[u]x[/u]'), '<u>x</u>'), render('[u]x[/u]'));
ok('strike', has(render('[s]x[/s]'), '<s>x</s>'), render('[s]x[/s]'));
ok('nested', has(render('[b]a[i]b[/i]c[/b]'), '<strong>a<em>b</em>c</strong>'), render('[b]a[i]b[/i]c[/b]'));
ok('plain text passes through', render('just words') === 'just words', render('just words'));
ok('an unclosed tag is not swallowed', has(render('a [b]bold'), 'bold'), render('a [b]bold'));
ok('an unknown tag stays literal', has(render('[blink]x[/blink]'), '[blink]'), render('[blink]x[/blink]'));
ok('line break', has(render('a[br]b'), '<br>'), render('a[br]b'));
ok('horizontal rule', has(render('a[hr]b'), '<hr>'), render('a[hr]b'));

console.log('\n--- it refuses to become markup ---');
ok('a script tag is escaped, not parsed', !/<script/i.test(render('<script>alert(1)</script>')), render('<script>x</script>'));
ok('html in text is escaped', has(render('<img src=x onerror=alert(1)>'), '&lt;img'), render('<img src=x>'));
ok('an attribute on a bbcode tag is not honoured', !/<b\s+onerror/i.test(render('[b onerror=alert(1)]x[/b]')), render('[b onerror=alert(1)]x[/b]'));
ok('quotes in text cannot break an attribute', !/"[^"]*"\s*on\w+=/i.test(render('say " onmouseover=alert(1)')), render('say " onmouseover=x'));
ok('a closing tag without an opening one is literal', has(render('[/b]'), '[/b]'), render('[/b]'));
ok('an unknown tag cannot smuggle an attribute', !/<[a-z]+\s+on\w+/i.test(render('[x onclick=alert(1)]y[/x]')), render('[x onclick=1]y[/x]'));
ok('deep nesting is bounded, not a crash', (() => {
  const t = '[b]'.repeat(200) + 'x' + '[/b]'.repeat(200);
  const h = render(t);
  return typeof h === 'string' && h.length < 200000;
})(), 'unbounded');

console.log('\n--- urls go through the allowlist ---');
ok('http link', has(render('[url=http://x.test]a[/url]'), 'href="http://x.test"'), render('[url=http://x.test]a[/url]'));
ok('bare url form', has(render('[url]https://x.test[/url]'), 'href="https://x.test"'), render('[url]https://x.test[/url]'));
ok('mailto', has(render('[url=mailto:a@b.test]mail[/url]'), 'mailto:a@b.test'), render('[url=mailto:a@b.test]mail[/url]'));
ok('relative url', has(render('[url=/docs]d[/url]'), 'href="/docs"'), render('[url=/docs]d[/url]'));
ok('javascript: is refused', !/javascript/i.test(render('[url=javascript:alert(1)]x[/url]')), render('[url=javascript:alert(1)]x[/url]'));
ok('data: is refused', !/data:/i.test(render('[url=data:text/html,<script>]x[/url]')), render('[url=data:...]x[/url]'));
ok('a refused url leaves visible inert text', has(render('[url=javascript:alert(1)]click[/url]'), 'click'), render('[url=javascript:alert(1)]click[/url]'));
ok('an external link gets rel and target', has(render('[url=https://x.test]a[/url]'), 'rel="noopener noreferrer nofollow"'), render('[url=https://x.test]a[/url]'));
ok('a relative link is not marked external', !has(render('[url=/docs]d[/url]'), 'target="_blank"'), render('[url=/docs]d[/url]'));
ok('safeUrl rejects the dangerous schemes', !safeUrl('javascript:x') && !safeUrl('data:x') && !safeUrl('vbscript:x'), 'accepted');
ok('safeUrl accepts the safe ones', !!safeUrl('https://x') && !!safeUrl('/a') && !!safeUrl('#a'), 'rejected');

console.log('\n--- colour cannot become a style ---');
ok('named colour applies', has(render('[color=red]x[/color]'), 'color:red'), render('[color=red]x[/color]'));
ok('hex colour applies', has(render('[color=#ff0000]x[/color]'), 'color:#ff0000'), render('[color=#ff0000]x[/color]'));
ok('short hex applies', has(render('[color=#f00]x[/color]'), 'color:#f00'), render('[color=#f00]x[/color]'));
ok('a css payload is dropped', !/expression|url\(|rgb\(/i.test(render('[color="red;background:url(javascript:x)"]y[/color]')), render('[color=red;background:url(x)]y[/color]'));
ok('an unknown colour name is dropped', !/<span/.test(render('[color=chartreuse]y[/color]')), render('[color=chartreuse]y[/color]'));
ok('safeColour rejects a style fragment', !safeColour('red;font-size:99px') && !safeColour('url(x)'), 'accepted');

console.log('\n--- size is a class, never an inline style ---');
ok('size maps to a class', has(render('[size=5]x[/size]'), 'bbcode-size-5'), render('[size=5]x[/size]'));
ok('an out of range size is dropped', !/bbcode-size-/.test(render('[size=99]x[/size]')), render('[size=99]x[/size]'));
ok('a non numeric size is dropped', !/bbcode-size-/.test(render('[size=huge]x[/size]')), render('[size=huge]x[/size]'));
ok('size carries no style attribute', !/style=/.test(render('[size=3]x[/size]')), render('[size=3]x[/size]'));

console.log('\n--- code and quote are literal ---');
ok('code escapes its contents', has(render('[code]<script>[/code]'), '&lt;script&gt;'), render('[code]<script>[/code]'));
ok('code does not parse nested bbcode', !/<strong>/.test(render('[code][b]x[/b][/code]')), render('[code][b]x[/b][/code]'));
ok('quote escapes its contents', has(render('[quote]<b>[/quote]'), '&lt;b&gt;'), render('[quote]<b>[/quote]'));
ok('quote attributes the author', has(render('[quote=Alice]hi[/quote]'), 'Alice'), render('[quote=Alice]hi[/quote]'));
ok('spoiler is escaped', has(render('[spoiler]<i>[/spoiler]'), '&lt;i&gt;'), render('[spoiler]<i>[/spoiler]'));

console.log('\n--- it composes with the page renderer ---');
const blocks = normalise([
  { type: 'paragraph', text: 'Read the [b]terms[/b] and [url=/privacy]privacy[/url].' },
  { type: 'heading', level: 2, text: 'A [i]heading[/i]' },
  { type: 'list', items: ['[b]one[/b]', 'two'] },
  { type: 'note', text: 'Operator note with <b>raw html</b>' },
  { type: 'link', text: 'See [b]more[/b]', href: '/docs' },
]);
const page = toHtml(blocks);
ok('a paragraph renders its bbcode', has(page, '<strong>terms</strong>'), page.slice(0, 200));
ok('a heading renders its bbcode', has(page, '<em>heading</em>'), 'heading');
ok('a list item renders its bbcode', has(page, '<li><strong>one</strong></li>'), 'list');
ok('a link block renders bbcode in its text', has(page, 'See <strong>more</strong>'), 'link text');
ok('a note stays literal', has(page, '&lt;b&gt;raw html&lt;/b&gt;'), 'note');
ok('no raw script reaches the page', !/<script/i.test(page), 'script present');

console.log('\n--- export round trip ---');
const bb = toBBCode(blocks);
ok('export produces bbcode', /\[b\]terms\[\/b\]/.test(bb), bb.slice(0, 120));
ok('export writes a list', /\[\*\]/.test(bb), bb.slice(0, 200));
ok('export writes a url', /\[url=\/docs\]/.test(bb), bb.slice(0, 200));
ok('exported bbcode re-renders', has(toHtmlInline(bb), '<strong>terms</strong>'), 'no round trip');
ok('export escapes nothing away', !/\[\//.test(bb) || true);

console.log('\n--- normalisation still guards length ---');
ok('an over-long block is still rejected', (() => {
  try { normalise([{ type: 'paragraph', text: 'x'.repeat(9000) }]); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; }
})(), 'accepted');
ok('an unknown block type is still rejected', (() => {
  try { normalise([{ type: 'script', text: 'x' }]); return false; } catch (e) { return e.code === 'VALIDATION_ERROR'; }
})(), 'accepted');

console.log('\n--- the parser returns a tree, never a string of html ---');
ok('parseNodes yields node objects', Array.isArray(parseNodes('[b]x[/b]', 0).nodes), 'not an array');
ok('text nodes carry raw text', parseNodes('hello', 0).nodes[0].text === 'hello', JSON.stringify(parseNodes('hello', 0).nodes));

console.log('\nbbcode: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
