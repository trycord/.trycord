// Client-side checks that do not need a browser: the DOM helpers, the router's
// route table, and the accessibility contract they are supposed to uphold.
//
// The label association rule is the important one. A label with no `for` is
// invisible to a screen reader, and the majority of fields in this app are
// written in the implicit style, so the rule lives in el() and is checked here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

// A DOM good enough for el(): elements, attributes, children, querySelectorAll.
// Good enough to exercise the label rule and nothing more.
function makeEnv() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = {};
      this.className = '';
      this.id = '';
      this.parentElement = null;
      this.nodeType = 1;
      this.listeners = {};
      this.style = {};
      this.dataset = {};
    }
    get firstChild() { return this.children[0] || null; }
    append(...kids) {
      for (const k of kids.flat()) { k.parentElement = this; this.children.push(k); }
    }
    get children() { return this._children; }
    set children(v) { this._children = v; }
    removeChild(k) { this.children = this.children.filter((c) => c !== k); }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    hasAttribute(k) { return k in this.attributes; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    descendants() {
      const out = [];
      for (const c of this.children) {
        if (c.nodeType !== 1) continue;
        out.push(c);
        out.push(...c.descendants());
      }
      return out;
    }
    all(selector) {
      return this.descendants().filter((d) => d.matches(selector));
    }
    classList() { return String(this.className).split(/\s+/).filter(Boolean); }    matches(sel) {
      const parts = sel.match(/^(:not\(\[[^\]]+\]\)|[A-Za-z]+)/);
      if (!parts) return false;
      if (parts[1].startsWith(':')) {
        const attr = parts[1].slice(6, -2);
        return !this.hasAttribute(attr);
      }
      return this.tagName === parts[1].toUpperCase();
    }
    querySelectorAll(sel) {
      return this.descendants().filter((d) => d.matches(sel));
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    get textContent() { return this._text || ''; }
    set textContent(v) { this._text = v; }
  }
  class Text {
    constructor(t) { this.nodeType = 3; this.text = String(t); }
    get textContent() { return this.text; }
  }
  global.document = {
    createElement: (t) => new Node(t),
    createTextNode: (t) => new Text(t),
  };
  return { Node, Text };
}

const CLIENT = path.join(__dirname, '..', '..', 'trycord-client');

(async () => {
  makeEnv();
  // ui.js imports config.js, which touches localStorage on load; stub the
  // globals it reads so the module can be imported outside a browser.
  global.localStorage = {
    _v: {},
    getItem(k) { return this._v[k] ?? null; },
    setItem(k, v) { this._v[k] = String(v); },
    removeItem(k) { delete this._v[k]; },
  };
  global.window = { location: { protocol: 'https:', hostname: 'trycord.test', hash: '' } };
  global.requestAnimationFrame = (fn) => fn();

  const ui = await import(pathToFileUrl(path.join(CLIENT, 'js', 'ui.js')));

  console.log('escaping');
  ok('escapes angle brackets', ui.esc('<script>') === '&lt;script&gt;');
  ok('escapes quotes', ui.esc('"') === '&quot;');
  ok('escapes null as empty', ui.esc(null) === '');

  console.log('label association');
  const { el } = ui;
  const field = el('div', { class: 'field' },
    el('label', {}, 'Username'),
    el('input', { class: 'input', type: 'text' }));
  const label = field.children[0];
  const input = field.children[1];
  ok('an implicit label gets a for', !!label.getAttribute('for'));
  ok('the for points at the control', label.getAttribute('for') === input.id);
  ok('the control is given an id', !!input.id);

  const explicit = el('div', {},
    el('label', { for: 'reg-email' }, 'Email'),
    el('input', { id: 'reg-email', type: 'email' }));
  ok('an explicit for is left alone', explicit.children[0].getAttribute('for') === 'reg-email');
  ok('an existing id is not overwritten', explicit.children[1].id === 'reg-email');

  const select = el('div', { class: 'field' },
    el('label', {}, 'Role'),
    el('select', { class: 'input' }));
  ok('a select is associated too', select.children[0].getAttribute('for') === select.children[1].id);

  const noControl = el('div', { class: 'field' }, el('label', {}, 'Just a label'));
  ok('a label with no control is untouched', noControl.children[0].getAttribute('for') === null);

  const two = el('div', {},
    el('label', {}, 'A'),
    el('input', { type: 'text' }),
    el('label', {}, 'B'),
    el('textarea', {}));
  ok('two fields in one node both resolve',
    two.children[0].getAttribute('for') === two.children[1].id
    && two.children[2].getAttribute('for') === two.children[3].id);
  ok('generated ids are unique', two.children[1].id !== two.children[3].id);

  console.log('links are built in one place');
  // A link built inline as '#/server/' + id silently pins the URL to the UUID
  // form forever, which is how readable slugs never reached the address bar.
  // Nothing outside the helper should know the route shape.
  const jsDir = path.join(CLIENT, 'js');
  const linkFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  const inline = [];
  for (const f of linkFiles) {
    if (f === 'links.js' || f === 'router.js') continue;
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    if (src.includes("'#/server/'") || src.includes('"#/server/"')) inline.push(f);
  }
  ok('no module builds a community link by hand', inline.length === 0, 'still inline in: ' + inline.join(', '));

  // The helper must exist and be imported by the entry graph, or the guards
  // above pass while every link silently stays on the UUID form.
  const linksSrc = fs.readFileSync(path.join(jsDir, 'links.js'), 'utf8');
  ok('links.js exists and offers both forms',
    linksSrc.includes('export function serverPath') && linksSrc.includes('export function channelPath'), 'missing exports');
  ok('links.js falls back to the id when no slug is known',
    linksSrc.includes('|| String(id)') || linksSrc.includes('|| String(channelId)'), 'no id fallback');
  const importers = linkFiles.filter((f) => f !== 'links.js' &&
    fs.readFileSync(path.join(jsDir, f), 'utf8').includes("from './links.js'"));
  ok('the sidebar imports the helper', importers.includes('shell.js'), importers.join(', '));
  ok('the router still understands the legacy form',
    fs.readFileSync(path.join(jsDir, 'router.js'), 'utf8').includes("parts[0] === 'server'"), 'legacy branch gone');
  ok('the router understands the slug form',
    fs.readFileSync(path.join(jsDir, 'router.js'), 'utf8').includes("parts[0] === 'c'"), 'no /c/ branch');

  console.log('two-factor is reachable from the UI');
  // The server returns a challenge instead of a token when the factor is on.
  // If the login form does not branch on that it stores undefined and leaves the
  // member signed out with no explanation, and the account is unreachable
  // through the app at all.
  const publicSrc = fs.readFileSync(path.join(jsDir, 'pages-public.js'), 'utf8');
  ok('login branches on the second factor', /mfaRequired/.test(publicSrc), 'no branch');
  ok('a code step is rendered', /secondFactorStep/.test(publicSrc), 'no step');
  ok('the code is submitted to the verify endpoint', /twoFactorVerify/.test(publicSrc), 'no verify call');
  ok('a recovery code is acknowledged as single-use', /usedRecoveryCode/.test(publicSrc), 'not surfaced');
  const acctSrc = fs.readFileSync(path.join(jsDir, 'pages-account.js'), 'utf8');
  ok('security settings offer setup and disable', /twoFactorSetup/.test(acctSrc) && /twoFactorDisable/.test(acctSrc), 'missing');
  ok('recovery codes can be re-issued', /twoFactorRecoveryCodes/.test(acctSrc), 'missing');
  ok('the security tab renders the 2FA section', /renderTwoFactorSection\(body\)/.test(acctSrc), 'not mounted');

  console.log('one design system, not several');
  // There were two menu implementations: the rich one in ui.js and a thinner
  // dropdown in shell.js that knew nothing about submenus, disabled items or
  // Escape. Whichever a member happened to open behaved differently, so a
  // second implementation appearing again is the regression to catch.
  
  const shellSrc = fs.readFileSync(path.join(jsDir, 'shell.js'), 'utf8');
  const menuSrc = fs.readFileSync(path.join(jsDir, 'ui.js'), 'utf8');
  ok('no module defines a second menu system',
    !/function dropdownPanel|function buildDropdown/.test(shellSrc + menuSrc), 'a second menu builder exists');
  ok('the anchored menu is exported from ui.js', /export function attachMenu/.test(menuSrc), 'missing attachMenu');
  ok('the anchored menu is used by the shell', /attachMenu\(trigger/.test(shellSrc), 'not adopted');
  ok('dropdown CSS is gone', !fs.readFileSync(path.join(CLIENT, 'css', 'app.css'), 'utf8').includes('ctx-dropdown'), 'orphan rules remain');
  ok('menu icons are styled on the unified menu',
    /\.pop-item__icon/.test(fs.readFileSync(path.join(CLIENT, 'css', 'app.css'), 'utf8')), 'no icon style');

  // components.js owns avatar rendering. A second hand-built one means the
  // authenticated image fetch and its blob revoke have been re-derived, and a
  // fix to either will apply in one place and not the other.
  const acctForAvatar = fs.readFileSync(path.join(jsDir, 'pages-account.js'), 'utf8');
  ok('no module builds an avatar outside components.js',
    linkFiles.filter((f) => f !== 'components.js' &&
      /el\('span', \{ class: 'avatar/.test(fs.readFileSync(path.join(jsDir, f), 'utf8'))).length === 0, 'a second renderer');
  ok('the profile preview uses the shared avatar', /avatar\(shown/.test(acctForAvatar), 'still hand-built');

  // The button factory exists to make type="button" the default, so a button
  // dropped into a form cannot submit it by accident.
  ok('a button factory is exported', /export function btn\(/.test(menuSrc), 'missing btn()');
  ok('the factory defaults to a non-submitting type', /type \|\| \(opts\.submit \? 'submit' : 'button'\)/.test(menuSrc), 'no default');
  ok('dialogs use the factory', /btn\('Cancel'/.test(menuSrc), 'still inline');

  console.log('every client module parses');
  // `node --check foo.js` reports success for a .js file that contains `import`
  // statements even when the body has a duplicate declaration, so the checks
  // run against it are worthless. A duplicate `const` in router.js shipped
  // through a green suite and took the whole app down on load, because the
  // server tests exercise the API and never parse the client.
  //
  // The extension is the fix: .mjs forces module parsing, which does report it.
  // Verified before relying on it - the same body fails as .mjs and passes as .js.
  const parseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-parse-'));
  const broken = [];
  for (const f of fs.readdirSync(path.join(CLIENT, 'js')).filter((x) => x.endsWith('.js'))) {
    const tmp = path.join(parseDir, f.replace(/\.js$/, '.mjs'));
    fs.copyFileSync(path.join(CLIENT, 'js', f), tmp);
    const r = require('child_process').spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.status !== 0) {
      const first = String(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'parse error';
      broken.push(f + ': ' + first.trim());
    }
  }
  fs.rmSync(parseDir, { recursive: true, force: true });
  ok('all client modules parse as ES modules', broken.length === 0, broken.slice(0, 4).join(' | '));

  console.log('a11y contract in the markup');
  const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
  ok('the view region is not a live region', !/id="view-root"[\s\S]{0,80}aria-live/.test(html));
  ok('the modal root is not an assertive region', !/id="modal-root"[\s\S]{0,80}aria-live/.test(html));
  ok('a route announcer exists', html.includes('id="route-announcer"'));
  ok('the announcer is polite', /id="route-announcer"[\s\S]{0,160}aria-live="polite"/.test(html));
  ok('the toast root is still polite', /id="toast-root"[\s\S]{0,120}aria-live="polite"/.test(html));
  ok('a skip link exists', html.includes('class="skip-link'));
  ok('a skip link per shell', html.includes('skip-link--desktop') && html.includes('skip-link--mobile'));
  ok('the desktop skip link targets the desktop landmark',
    /skip-link--desktop" href="#trycord-main"/.test(html));
  ok('the mobile skip link targets the mobile landmark',
    /skip-link--mobile" href="#mobile-main"/.test(html));
  ok('both landmarks exist',
    html.includes('id="trycord-main"') && html.includes('id="mobile-main"'));

  const css = fs.readFileSync(path.join(CLIENT, 'css', 'app.css'), 'utf8');

  console.log('touch targets');
  ok('a minimum hit area token exists', /--t-hit:\s*44px/.test(css));
  // There is more than one block at this breakpoint, so the mobile rules are
  // collected across all of them rather than assuming a single block.
  const mobileBody = [...css.matchAll(/@media \(max-width: 599px\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join('\n');
  ok('the mobile breakpoint block exists', mobileBody.length > 0);
  for (const sel of ['.btn.sm', '.react-pill', '.role-pill', '.user-controls__btn', '.nav-toggle', '.msg-hoverbar button']) {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ok(`mobile stylesheet raises ${sel}`, new RegExp(escaped + '\\s*[,{]').test(mobileBody));
  }
  ok('mobile stylesheet unwraps the action bars off the message text',
    /\.msg-hoverbar[\s\S]*?position:\s*static/.test(mobileBody));
  ok('mobile stylesheet stops list rows overflowing', /\.card--list--row\s*\{\s*grid-template-columns:\s*1fr/.test(mobileBody));
  ok('mobile stylesheet lets toolbars wrap', /\.community-manager__toolbar\s*\{\s*flex-wrap:\s*wrap/.test(mobileBody));
  ok('the mobile skip link is the one shown', /\.skip-link--desktop\s*\{\s*display:\s*none/.test(mobileBody));

  const uiSrc = fs.readFileSync(path.join(CLIENT, 'js', 'ui.js'), 'utf8');
  ok('toasts do not double-announce', !/class: 'toast ' \+ kind, role: 'status'/.test(uiSrc));

  console.log('the public site');
  const PUBLIC = path.join(CLIENT, '..', 'public');
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));

  // The legal pages ship as templates, and the unfilled parts are marked
  // .op-field. Bracket placeholders are not a supported form: they are easy to
  // miss on a rendered page and impossible for the editor to target.
  const bracketish = /\[&nbsp;|\[\s\s\s*\]|\[date\b|\[version\b|\[Set \b|\[List \b|\[State \b|\[Summarize \b|\[Describe \b|\[Insert \b|\[If data\b|operator contact|privacy contact —|Draft placeholder/;
  const stray = [];
  for (const f of pages) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(new RegExp(bracketish.source, 'g'))) {
      const line = src.slice(0, m.index).split('\n').length;
      stray.push(`${f}:${line} ${m[0].trim()}`);
    }
  }
  ok('no unfilled bracket placeholders remain on any public page', stray.length === 0);
  for (const s of stray) console.log(`       ${s}`);

  // Every page carries the three legal links and a Trust & Safety link, and the
  // footer brand is well formed.
  const legalLinks = ['/terms', '/privacy', '/instances-terms', '/trust-and-safety'];
  const badFooters = [];
  for (const f of pages) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const link of legalLinks) {
      if (!src.includes(`href="${link}"`)) badFooters.push(`${f} missing ${link}`);
    }
    if (src.includes('</spanhref')) badFooters.push(`${f} has a malformed brand tag`);
  }
  ok('every page links all four legal pages and has a valid brand tag', badFooters.length === 0);
  for (const s of badFooters) console.log(`       ${s}`);

  // The six editable pages declare the region the editor replaces.
  const editable = ['terms', 'privacy', 'instances-terms', 'trust-and-safety', 'support', 'security'];
  const noRegion = editable.filter((f) => {
    const src = fs.readFileSync(path.join(PUBLIC, f + '.html'), 'utf8');
    return (!src.includes('<!-- page:begin -->')) || (!src.includes('<!-- page:end -->'))
      || src.indexOf('<!-- page:begin -->') > src.indexOf('<!-- page:end -->');
  });
  ok('every editable page declares one well-ordered page region', noRegion.length === 0);
  for (const f of noRegion) console.log(`       ${f}.html`);

  const siteCss = fs.readFileSync(path.join(PUBLIC, 'css', 'site.css'), 'utf8');
  ok('an operator field is visibly marked', /\.op-field\s*\{/.test(siteCss));
  const siteJs = fs.readFileSync(path.join(PUBLIC, 'js', 'site.js'), 'utf8');
  ok('site.js normalises both clean and .html routes', /\.html\$/i.test(siteJs));
  ok('the homepage can mark itself current', !/here !== '\/'/.test(siteJs));

  console.log('route query parsing');
  const clientFiles = fs.readdirSync(path.join(CLIENT, 'js')).filter((f) => f.endsWith('.js'));
  const routerSrc = fs.readFileSync(path.join(CLIENT, 'js', 'router.js'), 'utf8');
  ok('the hash query is split off before the path', /indexOf\('\?'\)/.test(routerSrc));
  ok('query params are decoded', /URLSearchParams/.test(routerSrc));
  ok('a message permalink passes the message id through',
    /focusMessage:\s*query\.m/.test(routerSrc));

  const convSrc = fs.readFileSync(path.join(CLIENT, 'js', 'pages-conversation.js'), 'utf8');
  ok('renderChannel accepts options', /renderChannel\(container, serverId, channelId, opts/.test(convSrc));
  ok('a focused message is located by its data attribute',
    /data-message-id/.test(convSrc) && /focusMessage/.test(convSrc));
  ok('an unfound permalink message says so', /older than the loaded history/.test(convSrc));

  console.log('a report is never falsely reported as sent');
  const uiSrcAll = fs.readFileSync(path.join(CLIENT, 'js', 'ui.js'), 'utf8');
  ok('the dialog refuses to open without a target and a handler',
    /if \(!targetType \|\| !targetId \|\| typeof onSubmit !== 'function'\)/.test(uiSrcAll));
  ok('the submit handler is called unconditionally',
    /await onSubmit\(\{ targetType, targetId, category, extra \}\)/.test(uiSrcAll));
  // Call sites only: the definition in ui.js is not a call.
  const reportCalls = [...clientFiles].flatMap((f) => {
    const src = fs.readFileSync(path.join(CLIENT, 'js', f), 'utf8');
    if (f === 'ui.js') return [];
    return [...src.matchAll(/openReportDialog\(\{([\s\S]{0,300}?)\n\s*\}\)/g)].map((m) => [f, m[1]]);
  });
  ok(`every report dialog call site was found (${reportCalls.length})`, reportCalls.length >= 3);
  for (const [f, body] of reportCalls) {
    ok(`  ${f}: targetType + targetId`, /targetType:/.test(body) && /targetId:/.test(body));
    ok(`  ${f}: an onSubmit handler`, /onSubmit:/.test(body));
  }
  ok('the search-hit report no longer uses the old argument names',
    !/openReportDialog\(\{\s*kind:/.test(convSrc));

  console.log('message row actions');
  const compSrc = fs.readFileSync(path.join(CLIENT, 'js', 'components.js'), 'utf8');
  ok('messageRow reads its actions from opts', /opts\.onDelete/.test(compSrc) && /opts\.onEdit/.test(compSrc));
  const dmsSrc = fs.readFileSync(path.join(CLIENT, 'js', 'pages-dms.js'), 'utf8');
  ok('the DM renderer passes actions through opts, not the message',
    /\}, \{\s*meId:/.test(dmsSrc));
  ok('no DM renderer smuggles callbacks inside a message object',
    !/onDelete:[\s\S]{0,200}?\}\);/.test(dmsSrc.replace(/\}, \{\s*meId:[\s\S]*/, '')));

  console.log('every dangling label for= is resolved');
  const declaredIds = new Set();
  const forRefs = [];
  for (const f of linkFiles) {
    const src = fs.readFileSync(path.join(CLIENT, 'js', f), 'utf8');
    for (const m of src.matchAll(/id:\s*'([^']+)'/g)) declaredIds.add(m[1]);
    for (const m of src.matchAll(/for:\s*'([^']+)'/g)) forRefs.push([f, m[1]]);
  }
  for (const m of html.matchAll(/id="([^"]+)"/g)) declaredIds.add(m[1]);
  const dangling = forRefs.filter(([, id]) => !declaredIds.has(id));
  ok(`no label points at a missing id (${forRefs.length} checked)`, dangling.length === 0);
  for (const [f, id] of dangling) console.log(`       ${f}: for="${id}"`);

  console.log('text contrast in every theme');
  // css is already loaded above.
  const relLum = (hex) => {
    const h = hex.replace('#', '');
    const ch = [0, 2, 4]
      .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => {
    const l1 = relLum(a);
    const l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  // Each theme block, in declaration order, with the palette it defines.
  const blocks = [];
  const blockRe = /(:root|html\[data-theme="[^"]+"\])\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const vars = {};
    for (const v of m[2].matchAll(/(--t-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[v[1]] = v[2];
    if (vars['--t-txt']) blocks.push({ name: m[1], vars });
  }
  ok('found the theme blocks', blocks.length >= 5);

  const TEXT_TIERS = ['--t-txt', '--t-txt2', '--t-mut'];
  const SURFACES = ['--t-pg', '--t-base', '--t-base2', '--t-elev'];
  for (const block of blocks) {
    const bad = [];
    for (const tier of TEXT_TIERS) {
      for (const surface of SURFACES) {
        const t = block.vars[tier];
        const s = block.vars[surface];
        if (!t || !s) continue;
        const r = ratio(t, s);
        if (r < 4.5) bad.push(`${tier} on ${surface} = ${r.toFixed(2)}`);
      }
    }
    ok(`${block.name}: every text tier clears 4.5:1 on every surface`, bad.length === 0);
    for (const b of bad) console.log(`       ${b}`);
  }

  // The tiers must stay visually distinct, or "muted" stops meaning anything.
  // Direction depends on the theme: on a dark theme brighter text is the
  // stronger tier, so the three are compared as a sorted set rather than in
  // a fixed order. High contrast deliberately collapses the top two tiers.
  for (const block of blocks) {
    if (block.name.includes('high-contrast')) continue;
    const vals = TEXT_TIERS.map((t) => block.vars[t]).filter(Boolean).map(relLum).sort((a, b) => a - b);
    if (vals.length < 3) continue;
    const gaps = [vals[1] - vals[0], vals[2] - vals[1]];
    const distinct = gaps.every((g) => g >= 0.03);
    ok(`${block.name}: the three tiers are visually distinct`, distinct);
    if (!distinct) {
      console.log(`       relative luminance ${vals.map((v) => v.toFixed(3)).join(', ')}`);
    }
  }

  console.log(`\nclient-dom: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

function pathToFileUrl(p) {
  return 'file:///' + p.split(path.sep).join('/').replace(/^\/+/, '');
}


