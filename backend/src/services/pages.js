// Static page editor: the administrative side of the public legal pages.
//
// A page has a draft body and, once published, a published body. Visitors see
// the published body; the file in public/ is the fallback until a page has ever
// been published, so an instance that never touches the editor behaves exactly
// as it did before. That matters because these pages ship as templates: a
// self-hoster is expected to replace them with their own policy, and the editor
// is how they do that without editing files on disk.
//
// Revisions are append-only. Restoring one creates a new revision, so the
// history of what was published, in what order, by whom, is never rewritten.
const db = require('../db');
const { now, uuid } = require('../util');
const content = require('./pageContent');
const enforcement = require('./enforcement');

// The only routes an administrator may edit. Anything not listed here is served
// from disk and cannot be changed through the app.
const EDITABLE = [
  { route: 'terms', file: 'terms.html', title: 'Terms of Service', legal: true },
  { route: 'privacy', file: 'privacy.html', title: 'Privacy Policy', legal: true },
  { route: 'instances-terms', file: 'instances-terms.html', title: 'Official instance terms', legal: true },
  { route: 'trust-and-safety', file: 'trust-and-safety.html', title: 'Trust & Safety', legal: true },
  { route: 'support', file: 'support.html', title: 'Support', legal: false },
  { route: 'security', file: 'security.html', title: 'Security', legal: false },
];

const EDITABLE_ROUTES = EDITABLE.map((p) => p.route);

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('page not found');
  e.code = 'NOT_FOUND';
  throw e;
}

function known(route) {
  const p = EDITABLE.find((x) => x.route === String(route));
  if (!p) bad('that page cannot be edited here', 'NOT_FOUND');
  return p;
}

function parse(body) {
  try {
    return JSON.parse(body || '[]');
  } catch {
    return [];
  }
}

// The body a visitor is served: the published one while the page is
// published, the draft one otherwise. A page that has been taken down has a
// published body still in the row, and that body is no longer what the page
// says - so the status decides, not the presence of the column.
function effectiveBody(row, draft) {
  if (row && row.status === 'PUBLISHED') return parse(row.published_body);
  return draft || [];
}

function toPublic(row) {
  if (!row) return null;
  const draft = parse(row.draft_body);
  const published = parse(row.published_body);
  const inForce = effectiveBody(row, draft);
  return {
    route: row.route,
    title: row.title,
    // The description of the page, read from the body that is in force. The
    // body is the authority, so the metadata and the page cannot disagree.
    // The column holds a copy of the same answer for a reader that wants it
    // without parsing the body.
    description: content.descriptionOf(inForce),
    legal: !!row.legal,
    status: row.status,
    hasDraft: draft.length > 0,
    hasPublished: published.length > 0,
    draft: draft,
    published: published,
    // Shown in the console so an operator can see, without opening the page,
    // which parts of their policy are still the shipped template.
    outstandingFields: content.operatorFields(inForce),
    draftAuthor: row.draft_author,
    draftAt: row.draft_at,
    publishedAuthor: row.published_author,
    publishedAt: row.published_at,
  };
}

// An untouched page still has to be openable in the editor, so a route that has
// never been saved reads as an empty draft rather than 404ing. Opening it and
// saving creates the row.
function placeholder(p) {
  return {
    route: p.route,
    title: p.title,
    description: '',
    legal: p.legal,
    status: 'UNTOUCHED',
    hasDraft: false,
    hasPublished: false,
    draft: [],
    published: [],
    outstandingFields: [],
    draftAuthor: null,
    draftAt: null,
    publishedAuthor: null,
    publishedAt: null,
  };
}

async function get(route) {
  const p = known(route);
  const row = await db.get('SELECT * FROM pages WHERE route = ?', [p.route]);
  return row ? toPublic(row) : placeholder(p);
}

async function list() {
  const rows = await db.all('SELECT * FROM pages ORDER BY route');
  const byRoute = new Map(rows.map((r) => [r.route, toPublic(r)]));
  // Every editable page appears, even one that has never been saved, so the
  // console lists the full set rather than only what someone has touched.
  return EDITABLE.map((p) => byRoute.get(p.route) || placeholder(p));
}

async function ensureRow(route) {
  const p = known(route);
  const existing = await db.get('SELECT * FROM pages WHERE route = ?', [p.route]);
  if (existing) return existing;
  const id = uuid();
  await db.run(
    'INSERT INTO pages (id, route, title, status, legal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, p.route, p.title, 'UNTOUCHED', p.legal ? 1 : 0, now()]
  );
  return db.get('SELECT * FROM pages WHERE route = ?', [p.route]);
}

async function saveDraft({ route, title, body, actorId }) {
  const row = await ensureRow(route);
  const blocks = content.normalise(body);
  const pageTitle = String(title || row.title).trim().slice(0, 128) || row.title;
  const ts = now();
  const rev = await nextRevision(row.id);
  // The description follows the body in force: while the page is published
  // that is the published body, so a draft that changes the standfirst does
  // not change what the page is described as until it is published. The
  // column is a copy of that answer for a reader that wants it without
  // parsing the body; the body stays the authority.
  const staysPublished = row.status === 'PUBLISHED';
  const description = content.descriptionOf(staysPublished ? parse(row.published_body) : blocks);
  await db.transaction(async (t) => {
    await t.run(
      'UPDATE pages SET title = ?, description = ?, draft_body = ?, draft_author = ?, draft_at = ?, status = ? WHERE id = ?',
      [pageTitle, description, JSON.stringify(blocks), actorId, ts,
        staysPublished ? 'PUBLISHED' : 'DRAFT', row.id]
    );
    await t.run(
      'INSERT INTO page_revisions (id, page_id, revision, body, title, state, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuid(), row.id, rev, JSON.stringify(blocks), pageTitle, 'DRAFT', actorId, ts]
    );
  });
  await enforcement.audit(actorId, 'PAGE_DRAFT_SAVED', 'page', row.route, null);
  return get(route);
}

async function nextRevision(pageId) {
  const row = await db.get('SELECT COALESCE(MAX(revision), 0) AS m FROM page_revisions WHERE page_id = ?', [pageId]);
  return (row ? Number(row.m) : 0) + 1;
}

// Publishing a legal page is irreversible in practice and immediately visible to
// everyone, so the caller has to confirm by typing the route.
async function publish({ route, actorId, confirm }) {
  const row = await ensureRow(route);
  if (String(confirm) !== String(route)) {
    bad('type the page route to confirm publishing', 'VALIDATION_ERROR');
  }
  const draft = parse(row.draft_body);
  if (!draft.length) bad('there is no draft to publish', 'CONFLICT');

  const ts = now();
  const rev = await nextRevision(row.id);
  const description = content.descriptionOf(draft);
  await db.transaction(async (t) => {
    await t.run(
      'UPDATE pages SET status = ?, description = ?, published_body = ?, published_author = ?, published_at = ? WHERE id = ?',
      ['PUBLISHED', description, row.draft_body, actorId, ts, row.id]
    );
    await t.run(
      'INSERT INTO page_revisions (id, page_id, revision, body, title, state, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuid(), row.id, rev, row.draft_body, row.title, 'PUBLISHED', actorId, ts]
    );
  });
  await enforcement.audit(actorId, 'PAGE_PUBLISHED', 'page', row.route, null);
  return get(route);
}

async function unpublish({ route, actorId }) {
  const row = await ensureRow(route);
  if (row.status !== 'PUBLISHED') bad('this page is not published', 'CONFLICT');
  // The page falls back to its draft, so the description follows it there.
  const description = content.descriptionOf(parse(row.draft_body));
  await db.run(
    'UPDATE pages SET status = ?, description = ? WHERE id = ?',
    ['DRAFT', description, row.id]
  );
  await enforcement.audit(actorId, 'PAGE_UNPUBLISHED', 'page', row.route, null);
  return get(route);
}

// The revision numbers that are in force: the one that was published, and the
// one that is the current draft. A page has at most one of each, and the list
// says which they are so an operator does not have to work it out from the
// dates.
async function currentRevisions(pageId) {
  const row = await db.get(
    'SELECT MAX(CASE WHEN state = \'PUBLISHED\' THEN revision END) AS published,'
    + ' MAX(CASE WHEN state = \'DRAFT\' THEN revision END) AS draft'
    + ' FROM page_revisions WHERE page_id = ?',
    [pageId]
  );
  return {
    published: row && row.published != null ? Number(row.published) : null,
    draft: row && row.draft != null ? Number(row.draft) : null,
  };
}

async function revisions({ route, limit } = {}) {
  const row = await ensureRow(route);
  const cap = Math.min(parseInt(limit, 10) || 50, 200);
  // The body travels with the revision, because a revision list that cannot
  // be compared against another revision is a list of dates. It is a list of
  // whole documents, so it is bounded by the cap above rather than by the
  // size of one document.
  const rows = await db.all(
    'SELECT r.id, r.revision, r.title, r.state, r.author_id, r.created_at, r.body'
    + ' FROM page_revisions r WHERE r.page_id = ? ORDER BY r.revision DESC LIMIT ' + cap,
    [row.id]
  );
  const current = await currentRevisions(row.id);
  return rows.map((r) => ({
    id: r.id,
    revision: Number(r.revision),
    title: r.title,
    state: r.state,
    authorId: r.author_id,
    createdAt: r.created_at,
    body: parse(r.body),
    // Which one is the page as it is published, and which one is the draft
    // being worked on now.
    isPublished: current.published != null && Number(r.revision) === current.published,
    isDraft: current.draft != null && Number(r.revision) === current.draft,
  }));
}

// Restoring writes the old body back as the current draft and records a new
// revision. Nothing is deleted: the revision being restored is still in history.
async function restore({ route, revision, actorId }) {
  const row = await ensureRow(route);
  const rev = await db.get('SELECT * FROM page_revisions WHERE page_id = ? AND revision = ?', [row.id, Number(revision)]);
  if (!rev) notFound();
  const ts = now();
  const next = await nextRevision(row.id);
  // The description follows the body in force, the same way it does when a
  // draft is saved: a published page is still described by what it publishes.
  const staysPublished = row.status === 'PUBLISHED';
  const description = content.descriptionOf(staysPublished ? parse(row.published_body) : parse(rev.body));
  await db.transaction(async (t) => {
    await t.run(
      'UPDATE pages SET description = ?, draft_body = ?, draft_author = ?, draft_at = ?, status = ? WHERE id = ?',
      [description, rev.body, actorId, ts, staysPublished ? 'PUBLISHED' : 'DRAFT', row.id]
    );
    await t.run(
      'INSERT INTO page_revisions (id, page_id, revision, body, title, state, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuid(), row.id, next, rev.body, rev.title, 'DRAFT', actorId, ts]
    );
  });
  await enforcement.audit(actorId, 'PAGE_REVISION_RESTORED', 'page', row.route, null);
  return get(route);
}

// What changed between two revisions.
//
// The comparison is a report about the content: which blocks were added, which
// were removed and which were rewritten. It is not a rendered diff, because
// how two revisions are shown is the client's decision, and a server that
// answered with markup would be deciding it for everybody.
async function compareRevisions({ route, from, to }) {
  const row = await ensureRow(route);
  const fromRevision = revisionNumber(from);
  const toRevision = revisionNumber(to);
  if (fromRevision === null || toRevision === null) {
    bad('a comparison needs two revision numbers', 'VALIDATION_ERROR');
  }
  const older = await db.get(
    'SELECT * FROM page_revisions WHERE page_id = ? AND revision = ?', [row.id, fromRevision]
  );
  const newer = await db.get(
    'SELECT * FROM page_revisions WHERE page_id = ? AND revision = ?', [row.id, toRevision]
  );
  if (!older) notFound();
  if (!newer) notFound();
  const report = content.compare(parse(older.body), parse(newer.body));
  return {
    route: row.route,
    from: revisionMeta(older),
    to: revisionMeta(newer),
    titleChanged: older.title !== newer.title,
    added: report.added,
    removed: report.removed,
    changed: report.changed,
    unchanged: report.unchanged,
    summary: {
      added: report.added.length,
      removed: report.removed.length,
      changed: report.changed.length,
      unchanged: report.unchanged,
    },
  };
}

function revisionMeta(row) {
  return {
    revision: Number(row.revision),
    title: row.title,
    state: row.state,
    authorId: row.author_id,
    createdAt: row.created_at,
  };
}

// The rendered body a visitor should see, or null when the page has never been
// published and the file on disk should be served instead.
async function publishedHtml(route) {
  const row = await db.get('SELECT published_body FROM pages WHERE route = ? AND status = ?', [
    String(route), 'PUBLISHED',
  ]);
  if (!row) return null;
  return content.toHtml(parse(row.published_body));
}

module.exports = {
  EDITABLE,
  EDITABLE_ROUTES,
  list,
  get,
  saveDraft,
  publish,
  unpublish,
  revisions,
  restore,
  compareRevisions,
  publishedHtml,
};
