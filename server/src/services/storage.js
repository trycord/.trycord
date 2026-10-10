// Storage drivers: local disk, and S3-compatible object storage.
//
// Three methods - put, get, remove - because that is the whole of what media actually
// needs, and a driver is where the difference between a directory and a bucket lives.
// Everything above this file is identical either way, so an operator switching from disk
// to MinIO changes configuration rather than code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const local = {
  name: 'local',
  async put(key, buffer) {
    const file = path.join(config.uploadDir, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  },
  async get(key) {
    return fs.readFileSync(path.join(config.uploadDir, key));
  },
  async remove(key) {
    try { fs.unlinkSync(path.join(config.uploadDir, key)); } catch { /* already gone */ }
  },
};

// SigV4, hand-rolled. It is about eighty lines and it removes a dependency that would be
// larger than the module it serves, and hand-rolling it keeps the request path auditable
// in one place.
const s3 = {
  name: 's3',

  _cfg() {
    const region = config.s3.region || 'us-east-1';
    const endpoint = (config.s3.endpoint || '').replace(/\/+$/, '');
    if (!endpoint) throw new Error('S3_ENDPOINT must be set when STORAGE_DRIVER=s3');
    if (!config.s3.bucket) throw new Error('S3_BUCKET must be set when STORAGE_DRIVER=s3');
    if (!config.s3.accessKeyId || !config.s3.secretAccessKey) {
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set when STORAGE_DRIVER=s3');
    }
    return { region, endpoint, ...config.s3 };
  },

  _sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); },

  _hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); },

  _signingKey(secret, date, region) {
    const kDate = this._hmac('AWS4' + secret, date);
    const kRegion = this._hmac(kDate, region);
    const kService = this._hmac(kRegion, 's3');
    return this._hmac(kService, 'aws4_request');
  },

  // One signed request. The canonical form is what SigV4 specifies; path style rather
  // than virtual-host style, because that is what MinIO and most self-hosted endpoints
  // expect.
  async _request(method, key, { body } = {}) {
    const cfg = this._cfg();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = this._sha256(body || Buffer.alloc(0));

    const host = new URL(cfg.endpoint).host;
    const canonicalUri = '/' + [encodeURIComponent(cfg.bucket), ...key.split('/').map(encodeURIComponent)].join('/');
    const canonicalQuery = '';
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, this._sha256(canonicalRequest)].join('\n');

    const signingKey = this._signingKey(cfg.secretAccessKey, dateStamp, cfg.region);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
      method,
      headers: {
        Authorization: authorization,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        ...(body ? { 'Content-Length': String(body.length) } : {}),
      },
      body: body || undefined,
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`object storage refused ${method}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  },

  async put(key, buffer, mime) {
    const res = await this._request('PUT', key, { body: buffer });
    if (res) await res.arrayBuffer().catch(() => null);
    return true;
  },

  async get(key) {
    const res = await this._request('GET', key);
    if (!res) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  },

  async remove(key) {
    await this._request('DELETE', key);
    return true;
  },
};

// The configured driver. Chosen once at startup and never re-read, so a mid-session
// change of STORAGE_DRIVER cannot leave half the objects on one backend and half on
// another.
function selectDriver() {
  const driver = String(config.storageDriver || 'local').toLowerCase();
  if (driver === 's3') return s3;
  if (driver === 'local') return local;
  throw new Error(`unsupported STORAGE_DRIVER "${driver}". Supported: local, s3`);
}

module.exports = { selectDriver, local, s3 };
