// A running instance, and the client talking to it.
//
// The E2EE routes are mounted on an instance of the server's own, and the
// client is pointed at it over HTTP. That is the only way to prove that the
// client's requests are the requests the server accepts: everything else is a
// comparison of two implementations in the same process.
//
// The transport is the client's own request shape - a method, a path and a
// body - so the client's api.js is exercised as it is written.
//
// The requests go out over node:http rather than over the global fetch,
// because the checks beside these ones replace the global fetch with a table
// of answers, and this one has to reach a real server.

import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '..', '..', '..', '..', 'backend');

const { startE2eeInstance } = require(path.join(BACKEND, 'tests/e2ee/instance.js'));

/**
 * Start an instance with the E2EE routes on it.
 */
export async function startInstance() {
  return startE2eeInstance();
}

/**
 * A request, over node:http.
 *
 * @returns {Promise<{status: number, headers: object, buffer: Buffer}>}
 */
function httpRequest(baseUrl, method, requestPath, options = {}) {
  const url = new URL(requestPath, baseUrl);
  const headers = Object.assign({}, options.headers || {});
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** The multipart body of a form, and the boundary that goes with it. */
async function multipartBody(formData) {
  const request = new Request('http://localhost/', { method: 'POST', body: formData });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type'),
  };
}

/**
 * A small HTTP client bound to one instance.
 *
 * It speaks the API the way the client does: a bearer token, the JSON error
 * envelope, and no hidden retries.
 */
export function apiClient(baseUrl, token) {
  const call = async (method, requestPath, body) => {
    const res = await httpRequest(baseUrl, method, requestPath, { body, token });
    const text = res.buffer.toString('utf8');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data, headers: res.headers };
  };
  return {
    baseUrl,
    get token() { return token; },
    setToken(next) { token = next; },
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    delete: (p, b) => call('DELETE', p, b),
    del: (p, b) => call('DELETE', p, b),
  };
}

/**
 * Register an account and return the client that is signed in as it.
 */
export async function register(instance, username) {
  const api = apiClient(instance.baseUrl);
  const res = await api.post('/api/auth/register', {
    username,
    password: 'correct-horse-battery',
    displayName: username,
    termsVersion: '1.0',
    privacyVersion: '1.0',
  });
  if (!res.ok) {
    const message = res.data && res.data.error ? res.data.error.message : JSON.stringify(res.data);
    throw new Error('register ' + username + ' failed: ' + res.status + ' ' + message);
  }
  const signed = apiClient(instance.baseUrl, res.data.token);
  signed.user = res.data.user;
  return signed;
}

/**
 * The client's transport, over an instance's API client.
 *
 * The errors are the client's own shape: a code, a message and a status, so
 * the code that switches on a refusal sees what it would see in a browser.
 */
export function transportFor(api) {
  const fail = (res, what) => {
    const detail = (res.data && res.data.error) || {};
    const error = new Error(detail.message || (what + ' failed: ' + res.status));
    error.code = detail.code || ('HTTP_' + res.status);
    error.status = res.status;
    return error;
  };
  return {
    async request(method, requestPath, options) {
      const opts = options || {};
      // The raw form is the bytes of a file: the client's own transport
      // answers with the body and the headers.
      if (opts.raw) {
        const res = await httpRequest(api.baseUrl, method, requestPath, { token: api.token });
        if (res.status >= 400) throw new Error('the file could not be read: ' + res.status);
        return { buffer: res.buffer, headers: res.headers };
      }
      const call = api[method.toLowerCase()];
      const res = await call.call(api, requestPath, opts.body);
      if (!res.ok) throw fail(res, 'the request');
      return res.data;
    },
    async upload(uploadPath, formData) {
      const form = await multipartBody(formData);
      const res = await httpRequest(api.baseUrl, 'POST', uploadPath, {
        token: api.token,
        body: form.body,
        headers: { 'Content-Type': form.contentType },
      });
      const text = res.buffer.toString('utf8');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.status < 200 || res.status >= 300) {
        const detail = (data && data.error) || {};
        const error = new Error(detail.message || ('the upload failed: ' + res.status));
        error.code = detail.code || ('HTTP_' + res.status);
        error.status = res.status;
        throw error;
      }
      return data;
    },
  };
}

/**
 * Every request the client made, and what was in it.
 *
 * The bodies are kept as they were sent, so a check can look for a private
 * half in them.
 */
export function recorder(transport) {
  const calls = [];
  const wrapped = {
    calls,
    async request(method, requestPath, options) {
      const opts = options || {};
      calls.push({
        method,
        path: requestPath,
        body: opts.body === undefined ? null : opts.body,
        form: opts.form ? opts.body : null,
      });
      return transport.request(method, requestPath, options);
    },
    async upload(uploadPath, formData) {
      calls.push({ method: 'POST', path: uploadPath, body: null, form: formData });
      return transport.upload(uploadPath, formData);
    },
  };
  return wrapped;
}
