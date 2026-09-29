// S3-compatible driver. Works with Amazon S3, Cloudflare R2, MinIO, Backblaze
// and anything else that speaks the S3 REST API, because only the endpoint and
// region change. SigV4 is implemented here against node:crypto rather than
// pulling in an AWS SDK: the signing algorithm is fixed and small, and a
// self-hosted instance should not have to install a megabyte of SDK to keep
// avatars.
//
// Verification status: the signature is a pure function of its inputs and is
// covered by tests/test-storage.js for determinism, region/service sensitivity
// and payload-hash binding. It has not been exercised against a live endpoint
// in this repository, so run the storage migration tool in --dry-run against
// the target bucket before switching STORAGE_DRIVER for a real instance.
const crypto = require('crypto');
const { Readable } = require('stream');

let cfg = null;

function init(config) {
  cfg = config;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

function amzDate(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// S3 wants each path segment percent-encoded, with '/' left alone, and it does
// not want the encoding applied twice.
function uriEncode(str, encodeSlash) {
  let out = '';
  for (const ch of str) {
    if (ch === '/' && !encodeSlash) out += '/';
    else if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function hostFor() {
  if (cfg.forcePathStyle) return new URL(cfg.endpoint).host;
  const u = new URL(cfg.endpoint);
  return cfg.bucket + '.' + u.host;
}

// Canonical path: /bucket/key for path style, /key for virtual-host style.
function canonicalPath(key) {
  const encoded = uriEncode(key, false);
  return cfg.forcePathStyle ? '/' + uriEncode(cfg.bucket, true) + '/' + encoded : '/' + encoded;
}

function urlFor(key) {
  const u = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) {
    u.pathname = '/' + cfg.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  } else {
    u.host = cfg.bucket + '.' + u.host;
    u.pathname = '/' + key.split('/').map(encodeURIComponent).join('/');
  }
  return u;
}

function signingKey(dateStamp, region, service) {
  const kDate = hmac('AWS4' + cfg.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function credentialScope(dateStamp) {
  return `${dateStamp}/${cfg.region}/s3/aws4_request`;
}

// Shared by header-signed requests and presigned URLs.
function buildCanonicalRequest({ method, key, query, headers, payloadHash }) {
  const canonicalHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .map((h) => {
      const v = Object.keys(headers).find((k) => k.toLowerCase() === h);
      return `${h}:${String(headers[v]).trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(';');
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
    .join('&');
  return [
    method,
    canonicalPath(key),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
}

function sign({ method, key, query, headers, payloadHash, date }) {
  const d = date || new Date();
  const stamp = amzDate(d);
  const scope = credentialScope(stamp);
  const canonicalRequest = buildCanonicalRequest({ method, key, query, headers, payloadHash });
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(stamp.slice(0, 8), cfg.region, 's3'))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return { stamp, scope, signature, canonicalRequest, stringToSign };
}

function baseHeaders(payloadHash, stamp) {
  return {
    host: hostFor(),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  };
}

// The signed header set must contain exactly the x-amz-date that is sent, so
// the headers are built first and the signer reads them back.
function signHeaders(method, key, query, extraHeaders, payloadHash) {
  const date = new Date();
  const stamp = amzDate(date);
  const headers = { ...baseHeaders(payloadHash, stamp), ...(extraHeaders || {}) };
  const { scope, signature } = sign({ method, key, query, headers, payloadHash, date });
  const signedList = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(';');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedList}, Signature=${signature}`;
  return headers;
}

async function put(k, buffer, contentType) {
  const payloadHash = sha256(buffer);
  const extra = contentType ? { 'content-type': contentType } : {};
  const headers = signHeaders('PUT', k, {}, extra, payloadHash);
  const res = await fetch(urlFor(k), { method: 'PUT', headers, body: buffer });
  if (!res.ok) throw new Error(`S3 put failed (${res.status}): ${await res.text()}`);
  return { size: buffer.length, etag: res.headers.get('etag') };
}

async function get(k) {
  const headers = signHeaders('GET', k, {}, {}, 'UNSIGNED-PAYLOAD');
  const res = await fetch(urlFor(k), { method: 'GET', headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`S3 get failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function createReadStream(k) {
  return Readable.from(
    (async function* () {
      const headers = signHeaders('GET', k, {}, {}, 'UNSIGNED-PAYLOAD');
      const res = await fetch(urlFor(k), { method: 'GET', headers });
      if (!res.ok) throw new Error(`S3 get failed (${res.status})`);
      for await (const chunk of res.body) yield chunk;
    })()
  );
}

async function delete_(k) {
  const headers = signHeaders('DELETE', k, {}, {}, 'UNSIGNED-PAYLOAD');
  const res = await fetch(urlFor(k), { method: 'DELETE', headers });
  // A missing object is the desired end state, so 404 is not a failure.
  if (!res.ok && res.status !== 404) {
    throw new Error(`S3 delete failed (${res.status}): ${await res.text()}`);
  }
}

async function exists(k) {
  const headers = signHeaders('HEAD', k, {}, {}, 'UNSIGNED-PAYLOAD');
  const res = await fetch(urlFor(k), { method: 'HEAD', headers });
  return res.ok;
}

async function list(prefix) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2' };
    if (prefix) query.prefix = prefix;
    if (token) query['continuation-token'] = token;
    const headers = signHeaders('GET', '', query, {}, 'UNSIGNED-PAYLOAD');
    const res = await fetch(listUrl(query), { method: 'GET', headers });
    if (!res.ok) throw new Error(`S3 list failed (${res.status}): ${await res.text()}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
      out.push({ key: m[1], size: Number(m[2]) });
    }
    const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    token = t ? t[1] : null;
  } while (token);
  return out;
}

function listUrl(query) {
  const u = new URL(cfg.endpoint);
  const encoded = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
    .join('&');
  u.pathname = cfg.forcePathStyle ? '/' + cfg.bucket : '/';
  u.search = encoded ? '?' + encoded : '';
  if (!cfg.forcePathStyle) u.host = cfg.bucket + '.' + u.host;
  return u;
}

// Presigned GET. The bucket stays private: access is granted per object, per
// expiry, and only to a caller who already passed the route's own check.
function signedUrl(k, expiresInSeconds) {
  const seconds = Math.min(Math.max(parseInt(expiresInSeconds, 10) || 300, 1), 604800);
  const date = new Date();
  const stamp = amzDate(date);
  const scope = credentialScope(stamp);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': cfg.accessKeyId + '/' + scope,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(seconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const headers = { host: hostFor() };
  const { signature } = sign({
    method: 'GET', key: k, query, headers, payloadHash: 'UNSIGNED-PAYLOAD', date,
  });
  query['X-Amz-Signature'] = signature;
  const u = urlFor(k);
  u.search = Object.keys(query)
    .sort()
    .map((q) => `${uriEncode(q, true)}=${uriEncode(query[q], true)}`)
    .join('&');
  return u.toString();
}

module.exports = { init, put, get, createReadStream, delete: delete_, exists, list, signedUrl, name: 's3' };
