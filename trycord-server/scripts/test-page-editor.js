// Static page editor, end to end: the workflow an administrator actually does,
// plus the boundaries that matter.
//
// The content model is the security boundary. A page body is typed blocks, and
// the renderer decides what each one becomes, so an administrator cannot store
// a script tag or a javascript: URL and have a visitor execute it. That is
// asserted directly rather than assumed.
const API = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // The body can only be read once, so it is captured as text and parsed from
  // that rather than by calling res.json() as well.
  // Read once. Public pages are a few kilobytes, so the whole document is kept:
  // assertions about the shell need the end of the file, not just the head.
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, json, text };
}

const H1 = (t) => ({ type: 'heading', level: 2, text: t });
const P = (t) => ({ type: 'paragraph', text: t });
const LIST = (items) => ({ type: 'list', ordered: false, items });

(async () => {
  const legal = (await call('GET', '/api/legal')).json;
  async function mkuser(prefix) {
    const u = prefix + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 900);
    const r = await call('POST', '/api/auth/register', null, {
      username: u, password: 'secret123',
      termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion,
    });
    if (r.status !== 200) throw new Error('register failed: ' + r.status);
    await call('POST', '/api/test/self-verify', r.json.token);
    return { name: u, token: r.json.token, id: r.json.user.id };
  }
  let adm = await call('POST', '/api/auth/login', null, { username: 'tsadmin', password: 'secret123' });
  if (adm.status !== 200) {
    await call('POST', '/api/auth/register', null, {
      username: 'tsadmin', password: 'secret123',
      termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion,
    });
    adm = await call('POST', '/api/auth/login', null, { username: 'tsadmin', password: 'secret123' });
  }
  const admin = adm.json.token;
  ok('platform admin available', !!admin);
  const stranger = await mkuser('pgUser');

  console.log('the editor is admin-only');
  let r = await call('GET', '/api/admin/pages', stranger.token);
  ok('a non-admin cannot list pages', r.status === 401 || r.status === 403);
  r = await call('GET', '/api/admin/pages', null);
  ok('an anonymous caller cannot list pages', r.status === 401 || r.status === 403);
  r = await call('GET', '/api/admin/pages', admin);
  ok('an admin can list pages', r.status === 200);
  const editable = ['terms', 'privacy', 'instances-terms', 'trust-and-safety', 'support', 'security'];
  ok(`all ${editable.length} approved pages are listed`, editable.every((x) => r.json.some((p) => p.route === x)));
  ok('legal pages are flagged as legal', r.json.find((p) => p.route === 'terms').legal === true);
  ok('a page never saved is reported UNTOUCHED', r.json.some((p) => p.status === 'UNTOUCHED'));

  console.log('an unknown route is refused');
  r = await call('GET', '/api/admin/pages/../../../etc/passwd', admin);
  ok('a path traversal in the route is refused', r.status === 404 || r.status === 400);
  r = await call('GET', '/api/admin/pages/features', admin);
  ok('a non-editable page is refused', r.status === 404);

  console.log('the content model refuses anything but typed blocks');
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: 'not an array' });
  ok('a non-array body is refused', r.status === 400);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: [{ type: 'script', code: 'x' }] });
  ok('an unknown block type is refused', r.status === 400);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: [{ type: 'paragraph' }] });
  ok('an empty paragraph is refused', r.status === 400);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: [{ type: 'list', items: [] }] });
  ok('an empty list is refused', r.status === 400);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: [{ type: 'link', text: 'x', href: 'javascript:alert(1)' }] });
  ok('a javascript: link is refused', r.status === 400);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: [{ type: 'link', text: 'x', href: 'data:text/html,<script>1</script>' }] });
  ok('a data: link is refused', r.status === 400);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { body: [{ type: 'paragraph', text: 'x'.repeat(9000) }] });
  ok('an over-long paragraph is refused', r.status === 400);

  console.log('a hostile paragraph is escaped, not executed');
  r = await call('PUT', '/api/admin/pages/privacy', admin, {
    title: 'Privacy Policy',
    body: [
      H1('Our privacy policy'),
      P('<script>alert(1)</script> and <img src=x onerror=alert(2)>'),
      LIST(['<b>bold</b>', 'plain']),
    ],
  });
  ok('a draft with hostile text is stored', r.status === 200);
  r = await call('PUT', '/api/admin/pages/privacy', admin, { preview: true, body: [{ type: 'paragraph', text: '<script>alert(1)</script>' }] });
  ok('preview renders', r.status === 200);
  ok('preview escapes the script tag', !r.json.html.includes('<script>'));
  ok('preview escapes the angle brackets', r.json.html.includes('&lt;script&gt;'));
  r = await call('PUT', '/api/admin/pages/privacy', admin, {
    preview: true,
    body: [{ type: 'paragraph', text: 'x' }, { type: 'link', text: 'Docs', href: 'https://example.com/a?b=1&c=2' }],
  });
  ok('an http link is allowed', r.status === 200);
  ok('the link target is attribute-escaped', r.json.html.includes('&amp;c=2'));

  console.log('publishing a legal page needs an explicit confirmation');
  r = await call('POST', '/api/admin/pages/privacy/publish', admin, { confirm: 'yes' });
  ok('a wrong confirmation is refused', r.status === 400);
  r = await call('POST', '/api/admin/pages/privacy/publish', admin, {});
  ok('no confirmation is refused', r.status === 400);
  r = await call('POST', '/api/admin/pages/privacy/publish', stranger.token, { confirm: 'privacy' });
  ok('a non-admin cannot publish', r.status === 401 || r.status === 403);
  r = await call('POST', '/api/admin/pages/privacy/publish', admin, { confirm: 'privacy' });
  ok('the right confirmation publishes', r.status === 200 && r.json.status === 'PUBLISHED');
  ok('publication is timestamped', !!r.json.publishedAt);

  console.log('the published page is what a visitor sees');
  const pub = await call('GET', '/privacy');
  ok('the public page renders', pub.status === 200);
  ok('the published heading is served', pub.text.includes('Our privacy policy'));
  ok('the file shell is preserved', pub.text.includes('<footer'));
  ok('the file shell header is preserved', pub.text.includes('site-header'));
  ok('the hostile paragraph is escaped in the served page', pub.text.includes('&lt;script&gt;'));
  ok('no raw script tag from content reaches the page', !/<script>alert\(1\)<\/script>/.test(pub.text));

  console.log('a page nobody edited is served from disk');
  const untouched = await call('GET', '/trust-and-safety');
  ok('the untouched page still renders', untouched.status === 200);
  ok('it still contains its original content', untouched.text.includes('Trust'));
  r = await call('GET', '/api/admin/pages/trust-and-safety', admin);
  ok('it is still reported UNTOUCHED, not published', r.status === 200 && r.json.status === 'UNTOUCHED');
  ok('it has no published body', r.json.hasPublished === false);
  // The marker comment stays in the served file; what must not happen is the
  // file's own body being replaced by a published one.
  ok('the file shell is served intact', untouched.text.includes('</html>'));

  console.log('revisions');
  r = await call('GET', '/api/admin/pages/privacy/revisions', admin);
  ok('revisions are listed', r.status === 200);
  ok('saving and publishing produced revisions', r.json.length >= 2);
  ok('revisions are newest first', r.json.length < 2 || r.json[0].revision > r.json[1].revision);
  const first = r.json[r.json.length - 1];

  r = await call('PUT', '/api/admin/pages/privacy', admin, {
    title: 'Privacy Policy', body: [H1('Rewritten policy')],
  });
  ok('a further edit saves', r.status === 200);
  r = await call('GET', '/api/admin/pages/privacy', admin);
  ok('the draft is the new text', r.json.draft.some((b) => b.text === 'Rewritten policy'));
  const live = await call('GET', '/privacy');
  ok('the visitor still sees the published text', live.text.includes('Our privacy policy'));

  r = await call('POST', `/api/admin/pages/privacy/revisions/${first.revision}/restore`, admin);
  ok('a revision can be restored', r.status === 200);
  r = await call('GET', '/api/admin/pages/privacy', admin);
  ok('the draft is the restored text', r.json.draft.some((b) => b.text === 'Our privacy policy'));
  r = await call('GET', '/api/admin/pages/privacy/revisions', admin);
  ok('restoring adds a revision rather than removing one', r.json.length >= 3);
  ok('the restored revision is still in history',
    r.json.some((x) => x.revision === first.revision));

  r = await call('POST', '/api/admin/pages/privacy/revisions/9999/restore', admin);
  ok('restoring a missing revision is a 404', r.status === 404);

  console.log('unpublish');
  r = await call('POST', '/api/admin/pages/privacy/unpublish', admin);
  ok('unpublish succeeds', r.status === 200 && r.json.status === 'DRAFT');
  r = await call('POST', '/api/admin/pages/privacy/unpublish', admin);
  ok('unpublishing twice is refused', r.status === 409);
  const back = await call('GET', '/privacy');
  ok('the file is served again after unpublishing', back.text.includes('OPERATOR'));

  console.log('operator fields are surfaced');
  r = await call('GET', '/api/admin/pages/privacy', admin);
  ok('the console can list unfilled operator fields', Array.isArray(r.json.outstandingFields));
  r = await call('GET', '/api/admin/pages/security', admin);
  ok('a page with no operator fields reports none', r.json.outstandingFields.length === 0);

  console.log('audit trail');
  for (const action of ['PAGE_DRAFT_SAVED', 'PAGE_PUBLISHED', 'PAGE_UNPUBLISHED', 'PAGE_REVISION_RESTORED']) {
    r = await call('GET', '/api/admin/audit?action=' + action, admin);
    ok(`${action} is audited`, r.status === 200 && r.json.length >= 1);
    ok(`${action} names the page`, r.json.length >= 1 && r.json[0].target_type === 'page');
  }

  console.log(`\npage-editor: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
