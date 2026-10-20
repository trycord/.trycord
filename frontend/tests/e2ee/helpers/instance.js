// A running instance, and the client talking to it.
//
// The E2EE routes are mounted on an instance of the server's own, and the
// client is pointed at it over HTTP. That is the only way to prove that the
// client's requests are the requests the server accepts: everything else is a
// comparison of two implementations in the same process.
//
// The transport is the client's own request shape - a method, a path and a
// body - so the client's api.js is exercised as it is written.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '..', '..', '..', '..', 'backend');

const { startE2eeInstance } = require(path.join(BACKEND, 'tests/e2ee/instance.js'));
const { registerUser } = require(path.join(BACKEND, 'tests/helpers/instance.js'));

/**
 * Start an instance with the E2EE routes on it.
 */
export async function startInstance() {
  return startE2eeInstance();
}

/**
 * Register an account and return the API client signed in as it.
 */
export function register(instance, username) {
  return registerUser(instance, username);
}

/**
 * The client's transport, over an instance's API client.
 *
 * The errors are the client's own shape: a code, a message and a status, so
 * the code that switches on a refusal sees what it would see in a browser.
 */
export function transportFor(api) {
  return {
    async request(method, requestPath, options) {
      const opts = options || {};
      const call = api[method.toLowerCase()];
      const res = await call.call(api, requestPath, opts.body);
      if (!res.ok) {
        const detail = (res.data && res.data.error) || {};
        const error = new Error(detail.message || ('the request failed: ' + res.status));
        error.code = detail.code || ('HTTP_' + res.status);
        error.status = res.status;
        throw error;
      }
      return res.data;
    },
    async upload(uploadPath, formData) {
      const res = await api.post(uploadPath, formData);
      if (!res.ok) {
        const detail = (res.data && res.data.error) || {};
        const error = new Error(detail.message || ('the upload failed: ' + res.status));
        error.code = detail.code || ('HTTP_' + res.status);
        error.status = res.status;
        throw error;
      }
      return res.data;
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
