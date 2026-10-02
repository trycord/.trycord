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
const { isPrivateAddress, assertPublicHost } = require('./netguard');

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

async function fetchHead(url) {
  const u = new URL(url);
  await assertPublicHost(u.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // Ask for HTML and nothing else. Without this a link to a large binary
        // would be pulled into this process just to be thrown away.
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'TrycordBot/1.0 (+link preview)',
      },
    });
    if (!r.ok) return { error: 'http ' + r.status };
    // A redirect can land on a private host, so the final URL is re-checked.
    await assertPublicHost(new URL(r.url).hostname);
    const type = String(r.headers.get('content-type') || '');
    if (!/text\/html|application\/xhtml/i.test(type)) return { kind: 'link', siteName: new URL(r.url).hostname };
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch { /* already finished */ }
    return { html: Buffer.concat(chunks.map(Buffer.from)).toString('utf8'), finalUrl: r.url };
  } finally {
    clearTimeout(timer);
  }
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
    const image = meta(got.html, ['og:image', 'twitter:image', 'twitter:image:src']);
    const desc = meta(got.html, ['og:description', 'twitter:description', 'description']);
    const title = meta(got.html, ['og:title', 'twitter:title']) || titleTag(got.html);
    return {
      status: 'ok',
      kind: image ? 'image' : 'link',
      siteName: meta(got.html, ['og:site_name']) || host.replace(/^www\./, ''),
      title: title ? title.slice(0, 300) : null,
      description: desc ? desc.slice(0, MAX_DESCRIPTION) : null,
      imageUrl: image ? absolute(image, finalUrl) : null,
    };
  } catch (e) {
    // A preview is never worth failing a message over.
    return { status: 'unavailable', kind: 'link' };
  }
}

// Queued rather than awaited by the caller: a slow or hostile URL must not
// delay a send. Sequential on purpose, so a message with three links makes three
// requests rather than three at once.
async function queue(scope, content) {
  const urls = extractUrls(content);
  if (!urls.length) return [];
  const target = scope && scope.kind === 'dm'
    ? { dmMessageId: scope.messageId, conversationId: scope.conversationId }
    : { messageId: scope && scope.messageId };
  for (const url of urls) {
    const existing = await db.get(
      'SELECT id FROM message_embeds WHERE message_id IS ? AND url = ?',
      [target.messageId || null, url]
    );
    if (existing) continue;
    const id = uuid();
    try {
      await db.run(
        'INSERT INTO message_embeds'
        + ' (id, message_id, dm_conversation_id, dm_message_id, url, status, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, target.messageId || null, target.conversationId || null,
          target.dmMessageId || null, url, 'pending', now()]
      );
    } catch { continue; }
    const info = await describe(url);
    await db.run(
      'UPDATE message_embeds SET site_name = ?, title = ?, description = ?, image_url = ?, kind = ?, status = ? WHERE id = ?',
      [info.siteName || null, info.title || null, info.description || null,
        info.imageUrl || null, info.kind || 'link', info.status, id]
    );
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
  for (const m of rows) await queue({ kind: 'channel', messageId: m.id }, m.content);
  return rows.length;
}

module.exports = {
  queue, listForMessages, backfill, extractUrls, normalizeUrl,
  shape,
};
