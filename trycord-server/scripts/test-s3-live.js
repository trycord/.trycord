// Live S3-compatibility check.
//
// The unit tests in test-storage.js prove the SigV4 implementation is
// self-consistent. They cannot prove an actual server accepts it, because a
// signature that is wrong in exactly the way both the signer and the test agree
// on will still verify against itself. Only a real endpoint settles it.
//
// This is therefore opt-in and never runs in CI: it needs a reachable bucket
// and it writes to it. Credentials come from the environment and are never
// stored here.
//
//   set S3_LIVE=1
//   set S3_ENDPOINT=http://127.0.0.1:8333
//   set S3_REGION=us-east-1
//   set S3_BUCKET=trycord-live-check
//   set S3_ACCESS_KEY_ID=...
//   set S3_SECRET_ACCESS_KEY=...
//   node scripts/test-s3-live.js
//
// Targets SeaweedFS, MinIO, R2, Backblaze and Amazon S3 alike - anything that
// speaks the same REST API. The bucket is created if absent and is not removed.
const storage = require('../src/services/storage');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

// Same shape the real server uses, so the driver is initialised exactly as it
// would be in production rather than through a test-only shortcut.
storage.reset();
process.env.STORAGE_DRIVER = 's3';
storage.init();

const cfg = {
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
};

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
const amzDate = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function signingKey(dateStamp, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + cfg.secretAccessKey, dateStamp), region), service), 'aws4_request');
}

// The driver has no create-bucket call, which is correct: a running instance
// never creates buckets. This script has to, so it signs the request with the
// same primitives the driver uses.
async function ensureBucket() {
  const u = new URL(cfg.endpoint);
  u.pathname = '/' + cfg.bucket;
  const payloadHash = sha256('');
  const stamp = amzDate(new Date());
  const scope = `${stamp.slice(0, 8)}/${cfg.region}/s3/aws4_request`;
  const host = u.host;
  const canonical = ['PUT', '/' + cfg.bucket, '', `host:${host}\n`, 'host', payloadHash].join('\n');
  const sts = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(stamp.slice(0, 8), cfg.region, 's3'))
    .update(sts, 'utf8').digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=host, Signature=${sig}`;
  const res = await fetch(u, { method: 'PUT', headers: { host, 'x-amz-date': stamp, 'x-amz-content-sha256': payloadHash, authorization: auth } });
  // 409 means it already exists, which is the normal case on a re-run.
  return res.ok || res.status === 409;
}

(async () => {
  const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !process.env[k]);
  if (process.env.S3_LIVE !== '1') {
    console.log('SKIP  live S3 check (set S3_LIVE=1 to run against a real endpoint)');
    process.exit(0);
  }
  if (missing.length) {
    console.error('missing env: ' + missing.join(', '));
    process.exit(1);
  }

  console.log('endpoint ' + cfg.endpoint + '  bucket ' + cfg.bucket + '  region ' + cfg.region);
  ok('bucket is creatable or already present', await ensureBucket(), 'could not create bucket');

  const key = 'channel/livecheck/attachment/' + crypto.randomUUID();
  const body = Buffer.from('trycord live s3 check\n' + new Date().toISOString());

  const put = await storage.put(key, body, 'text/plain');
  ok('put returns size', put && put.size === body.length, JSON.stringify(put));
  ok('exists() is true after put', await storage.exists(key), 'exists returned false');

  const back = await storage.get(key);
  ok('get returns the exact bytes', back && back.equals(body), 'length ' + (back && back.length));

  const chunks = [];
  for await (const c of storage.createReadStream(key)) chunks.push(c);
  ok('streamed read matches', Buffer.concat(chunks).equals(body), 'streamed length ' + Buffer.concat(chunks).length);

  // Binary payload: text can round-trip through a buggy encoding by accident.
  const bin = crypto.randomBytes(64 * 1024);
  const bkey = key + '.bin';
  await storage.put(bkey, bin, 'application/octet-stream');
  const binBack = await storage.get(bkey);
  ok('64KB binary payload round-trips byte for byte', binBack && binBack.equals(bin), 'length ' + (binBack && binBack.length));
  await storage.delete(bkey);

  // Keys with spaces and unicode must survive canonical encoding on both the
  // signing path and the request path; a mismatch here is signature-only.
  const oddKey = 'channel/live check/attachment/' + crypto.randomUUID() + ' a b ünïcode.png';
  await storage.put(oddKey, body, 'image/png');
  const oddBack = await storage.get(oddKey);
  ok('key with spaces and unicode round-trips', oddBack && oddBack.equals(body), 'null');
  await storage.delete(oddKey);

  const listed = await storage.list('channel/livecheck/');
  ok('list(prefix) finds the object', Array.isArray(listed) && listed.some((o) => o.key === key), JSON.stringify(listed));

  const url = storage.signedUrl(key, 60);
  ok('signedUrl produces a presigned URL', typeof url === 'string' && url.includes('X-Amz-Signature'), String(url));
  const viaUrl = await fetch(url);
  ok('presigned URL is accepted unauthenticated', viaUrl.ok, 'status ' + viaUrl.status);
  ok('presigned URL returns the same bytes', Buffer.from(await viaUrl.arrayBuffer()).equals(body), 'mismatch');

  await storage.delete(key);
  ok('exists() is false after delete', !(await storage.exists(key)), 'still present');
  const gone = await storage.get(key);
  ok('get() returns null for a missing key', gone === null, 'got ' + (gone && gone.length));
  await storage.delete(key);
  ok('deleting a missing key is not an error', true);

  console.log('\npass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
