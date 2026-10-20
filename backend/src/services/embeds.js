// Link previews.
//
// A URL in a message gets a small card: title, description, image, site. The
// fetch is the whole risk here, so it is narrow by construction - http and
// https only, no credentials in the URL, a hard timeout, a size cap, no
// redirects to a private address, and DNS resolved once and checked so a name
// that points at 127.0.0.1 cannot be used to read the instance's own network.
//
// Nothing about a message depends on this succeeding. An embed is extra
// information; a post that produces none is still a post, and a post whose
// preview fails shows the card as unavailable rather than failing the send.

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const { assertPublicHost, fetchHtml } = require('./netguard');
const jobs = require('./jobs');

const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024;
const MAX_DESCRIPTION = 400;
const MAX_CACHE = 200;

function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

function extractUrls(content) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"']+/gi;
  let m;
  while ((m = re.exec(String(content || ''))) && out.length < 3) {
    // Trailing punctuation is almost never part of the link.
    const cleaned = m[0].replace(/[.,;:!?)\]]+$/, '');
    const n = normalizeUrl(cleaned);
    if (n) out.push(n);
  }
  return [...new Set(out)].slice(0, 3);
}

// The document behind a link.
//
// The fetch is the whole risk, so it is done by the guard rather than by
// fetch(): the name is resolved and checked and the address that is
// connected to is the address that was checked, and a redirect is followed
// one hop at a time with every hop checked before it is fetched.
//
// `redirect: 'follow'` did neither. It followed the whole chain before
// anything was looked at, so a link to a public address that redirects to
// 127.0.0.1 was fetched from the instance's own network - the request was
// made, the side effect happened, and only the answer was then thrown away.
async function fetchHead(url) {
  const answer = await fetchHtml(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    accept: 'text/html,application/xhtml+xml',
    userAgent: 'TrycordBot/1.0 (+link preview)',
  });
  if (!answer.ok) {
    // A page that answered with something that is not HTML is still a link,
    // and the site name is worth keeping.
    if (answer.contentType) {
      return { kind: 'link', siteName: new URL(url).hostname };
    }
    return { error: answer.error };
  }
  return { html: answer.html, finalUrl: answer.finalUrl };
}

// The metadata parsers. Deliberately small and deliberately not a real HTML
// parser: they only read the handful of attributes a link preview is made of,
// they do not build a tree, and they cannot be made to execute anything from a
// page. Everything they return is length-capped by the caller before it is
// stored.
// The named entities that actually turn up in page titles and descriptions. The
// full HTML table is thousands of entries and none of them belong in a preview;
// leaving an unrecognised one as literal text is preferable to guessing at it.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  bull: '\u2022', middot: '\u00b7', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', deg: '\u00b0', eacute: '\u00e9', egrave: '\u00e8',
  agrave: '\u00e0', ccedil: '\u00e7', uuml: '\u00fc', ouml: '\u00f6',
  auml: '\u00e4', szlig: '\u00df', laquo: '\u00ab', raquo: '\u00bb',
  times: '\u00d7', divide: '\u00f7', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', para: '\u00b6',
  dagger: '\u2020', permil: '\u2030', prime: '\u2032', larr: '\u2190',
  rarr: '\u2192', harr: '\u2194', infin: '\u221e', ne: '\u2260',
};

function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    if (key.charAt(0) === '#') {
      const hex = key.charAt(1) === 'x';
      const code = parseInt(hex ? key.slice(2) : key.slice(1), hex ? 16 : 10);
      // Control characters and the replacement range are dropped rather than
      // emitted: a preview title is shown as text, and a codepoint that renders
      // as nothing is not worth carrying into the database.
      if (!Number.isFinite(code) || code < 32 || (code >= 0x7f && code < 0xa0)) return '';
      if (code > 0x10ffff) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return whole;
  });
}

// Attribute order is not fixed in the wild, so the tag is read whole and the
// attributes picked out of it rather than assuming property-then-content.
function attrsOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]));
  return out;
}

// First matching value across the names, in the order given: a page that
// declares both og:title and twitter:title should be read the way the first
// name says.
function meta(html, names) {
  // A quoted attribute value may itself contain ">", as og:title routinely
  // does when it carries markup. Matching the tag as "<meta" followed by
  // anything that is not a delimiter or a complete quoted string keeps
  // content="a > b" in one piece instead of truncating the tag mid-attribute.
  const tags = String(html || '').match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const tag of tags) {
    const a = attrsOf(tag);
    for (const field of ['property', 'name', 'itemprop']) {
      if (wanted.has(String(a[field] || '').toLowerCase()) && a.content) return a.content;
    }
  }
  return '';
}

function titleTag(html) {
  const m = /<title\b[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// Resolves a declared URL against the page it was declared on. Anything that
// is not http(s) after resolution is dropped here rather than later.
function absolute(raw, base) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const u = new URL(text, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch { return null; }
}

async function describe(url) {
  try {
    const got = await fetchHead(url);
    if (got.error) return { status: 'unavailable', kind: 'link' };
    if (got.html === undefined) {
      return { status: 'ok', kind: got.kind || 'link', siteName: got.siteName || null, title: null };
    }
    const finalUrl = got.finalUrl || url;
    const host = new URL(finalUrl).hostname;
    const desc = meta(got.html, ['og:description', 'twitter:description', 'description']);
    const title = meta(got.html, ['og:title', 'twitter:title']) || titleTag(got.html);
    // Both resolved through the guard: the page chose them, so they are input.
    const image = await publicMediaUrl(meta(got.html, ['og:image', 'twitter:image', 'twitter:image:src']), finalUrl);
    const video = await (async () => {
      const declared = meta(got.html, ['og:video:url', 'og:video', 'og:video:secure_url']);
      const direct = videoCandidate(declared, finalUrl) || videoCandidate(finalUrl, finalUrl);
      if (!direct) return null;
      try { await assertPublicHost(new URL(direct).hostname); } catch { return null; }
      return direct;
    })();
    return {
      status: 'ok',
      kind: video ? 'video' : (image ? 'image' : 'link'),
      siteName: meta(got.html, ['og:site_name']) || host.replace(/^www\./, ''),
      title: title ? title.slice(0, 300) : null,
      description: desc ? desc.slice(0, MAX_DESCRIPTION) : null,
      imageUrl: image,
      videoUrl: video,
    };
  } catch (e) {
    // A preview is never worth failing a message over.
    return { status: 'unavailable', kind: 'link' };
  }
}

// A page controls its own og:image, so the value it declares is untrusted input
// even though the page URL passed the guard. A host that resolves to a private
// address would otherwise be loaded by every reader's browser - a request to
// 169.254.169.254 or an intranet host, on behalf of everyone who opens the
// channel. Dropping the image leaves a perfectly good text card.
async function publicMediaUrl(raw, base) {
  if (!raw) return null;
  const abs = absolute(raw, base);
  if (!abs) return null;
  let u;
  try { u = new URL(abs); } catch { return null; }
  // Only https or http, and never credentials in the URL.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  try { await assertPublicHost(u.hostname); } catch { return null; }
  return u.toString();
}

// A video preview is only offered for a file that is already a video. There is
// no transcoding and no proxy here: the reader's browser loads the file from its
// own host, so anything that is not plainly a video is left as a link card
// rather than turned into a player.
const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)(?:$|\?)/i;
function videoCandidate(raw, base) {
  const abs = absolute(raw, base);
  if (!abs) return null;
  let u;
  try { u = new URL(abs); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!VIDEO_EXT.test(u.pathname + (u.search || ''))) return null;
  return u.toString();
}

// Store one link preview row: insert pending, then describe the URL and fill it in.
// Returns the shaped card, or null if the row already existed.
async function previewAndStore(keyCol, keyVal, url) {
  const id = uuid();
  const channelId = keyCol === 'message_id' ? keyVal : null;
  const dmConversationId = keyCol === 'dm_message_id' ? null : keyVal;
  const dmMessageId = keyCol === 'dm_message_id' ? keyVal : null;
  try {
    await db.run(
      'INSERT INTO message_embeds'
      + ' (id, message_id, dm_conversation_id, dm_message_id, url, status, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, channelId, dmConversationId, dmMessageId, url, 'pending', now()]
    );
  } catch { return null; }
  const info = await describe(url);
  await db.run(
    'UPDATE message_embeds SET site_name = ?, title = ?, description = ?, image_url = ?, video_url = ?, kind = ?, status = ? WHERE id = ?',
    [info.siteName || null, info.title || null, info.description || null,
      info.imageUrl || null, info.videoUrl || null, info.kind || 'link', info.status, id]
  );
  return shape({ id, url, ...info });
}

// Processes one durable backfill job: describe every URL in a message that
// does not already have an embed row. Retried with backoff by the job system,
// so a transient outage self-heals and a crashed worker never loses the work.
async function handleEmbedBackfill(payload) {
  const { keyCol, keyVal, urls } = payload || {};
  if (!keyCol || !keyVal || !Array.isArray(urls)) return;
  for (const url of urls) {
    const existing = await db.get(
      'SELECT id FROM message_embeds WHERE ' + keyCol + ' IS ? AND url = ?',
      [keyVal, url]
    );
    if (existing) continue;
    await previewAndStore(keyCol, keyVal, url);
  }
}

// Register the durable job type once the job system exists. Workers start only
// after boot, so no job can be claimed before its handler is registered.
jobs.register('embed_backfill', handleEmbedBackfill, {
  concurrency: 4,
  maxAttempts: 5,
  backoffMs: 1000,
});

// Queued rather than awaited by the caller: a slow or hostile URL must not
// delay a send. Sequential on purpose, so a message with three links makes three
// requests rather than three at once.
async function queue(scope, content) {
  const urls = extractUrls(content);
  if (!urls.length) return [];
  const target = scope && scope.kind === 'dm'
    ? { dmMessageId: scope.messageId, conversationId: scope.conversationId }
    : { messageId: scope && scope.messageId };
  // The duplicate check has to name the column the scope actually uses. Reading
  // message_id for a direct message matched any DM preview with the same URL,
  // whatever the message - so the second DM linking the same page produced no
  // card at all, and only on a database where an earlier one had already been
  // previewed. It passed in isolation and failed in a suite.
  const keyCol = target.dmMessageId ? 'dm_message_id' : 'message_id';
  const keyVal = target.dmMessageId || target.messageId || null;
  for (const url of urls) {
    const existing = await db.get(
      'SELECT id FROM message_embeds WHERE ' + keyCol + ' IS ? AND url = ?',
      [keyVal, url]
    );
    if (existing) continue;
    await previewAndStore(keyCol, keyVal, url);
  }
  // The cards for this one message, as a list. listForMessages() returns a map
  // keyed by id because a history read asks for many at once; queue() resolves
  // exactly one message, so handing back the map would leave callers reading
  // .length on an object.
  return (await listForMessages([target.dmMessageId || target.messageId], target.dmMessageId ? 'dm' : 'channel'))[target.dmMessageId || target.messageId] || [];
}

function shape(r) {
  return {
    url: r.url,
    siteName: r.site_name || null,
    title: r.title || null,
    description: r.description || null,
    imageUrl: r.image_url || null,
    videoUrl: r.video_url || null,
    kind: r.kind || 'link',
    status: r.status,
  };
}

async function listForMessages(messageIds, kind = 'channel') {
  const ids = (messageIds || []).slice(0, MAX_CACHE);
  if (!ids.length) return {};
  // Direct messages live in dm_messages, so the same lookup needs a different
  // column. The caller knows which surface it is reading.
  const col = kind === 'dm' ? 'dm_message_id' : 'message_id';
  const rows = await db.all(
    'SELECT * FROM message_embeds WHERE ' + col + ' IN ('
      + ids.map(() => '?').join(',') + ')',
    ids
  );
  const out = {};
  for (const r of rows) {
    const key = r[col];
    (out[key] = out[key] || []).push(shape(r));
  }
  return out;
}

// Called on a timer rather than per post: a webhook that failed once should
// still get its card when the site comes back, and a message posted while the
// network was down should eventually get one.
async function backfill(limit = 25) {
  // Channels only. Direct messages are skipped deliberately: they are private,
  // and sweeping every one of them to fetch a preview would turn a maintenance
  // timer into a reader of private history.
  const rows = await db.all(
    `SELECT m.id, m.content FROM messages m
     LEFT JOIN message_embeds e ON e.message_id = m.id
     WHERE e.id IS NULL AND m.content LIKE '%http%'
     ORDER BY m.created_at DESC LIMIT ?`, [limit]
  );
  for (const m of rows) await jobs.enqueue('embed_backfill', {
    keyCol: 'message_id', keyVal: m.id, urls: extractUrls(m.content)
  });
  return rows.length;
}

module.exports = {
  queue, listForMessages, backfill, extractUrls, normalizeUrl,
  shape, publicMediaUrl, VIDEO_EXT, meta, titleTag, absolute, decodeEntities,
};
