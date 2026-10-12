// HTTP API delivery.
//
// This adapter carries no vendor. It knows how to POST a JSON message with a
// bearer token and read a response, because that is the shape almost every mail
// API shares, and everything that differs between vendors is configuration the
// operator supplies: the endpoint, the header names, and where each part of the
// message goes in the request body.
//
// The field mapping is what keeps a vendor out of the core. Instead of the code
// knowing that one company calls the recipient "to" and another nests it under
// "personalization", the administrator names the paths and the adapter fills
// them in. A vendor whose envelope differs is a set of mapping values, not a
// code change, and no route or screen in the application has to know it exists.
//
// Response handling is deliberately conservative. A 2xx is accepted, because
// every provider that accepts a message returns one, and the body is not
// interpreted beyond that: reading a status field out of an unknown vendor's
// response would mean guessing its contract, and guessing wrong here reports
// success for mail that was never sent.
//
// Only https is permitted for an endpoint that carries a bearer token. An
// operator testing against a local relay over http can point at 127.0.0.1, which
// is not a place a token can leave the machine anyway.
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function asString(value) {
  return value === undefined || value === null ? '' : String(value);
}

// Read one field out of the configuration. Trimming is right for everything except the
// auth prefix, where "Bearer" and "Bearer " are different header values and the missing
// space is what glues the scheme to the key.
function cfgValue(cfg, key) {
  const raw = cfg.get(key);
  if (raw === undefined || raw === null) return '';
  return key === 'mail.apiAuthPrefix' ? String(raw) : String(raw).trim();
}

// Build the request body by writing each mapped field at the path the operator
// named. Paths are dotted, so "personalization.to" becomes
// { personalization: { to: ... } }, which is what a nested envelope needs.
//
// A single element path ("to") addresses the top level. A path that collides
// with an existing object would overwrite it, so the merge refuses rather than
// quietly losing a field.
function place(target, path, value) {
  const parts = String(path).split('.').filter(Boolean);
  if (!parts.length) return false;
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (node[key] === undefined) node[key] = {};
    if (typeof node[key] !== 'object' || node[key] === null) return false;
    node = node[key];
  }
  const last = parts[parts.length - 1];
  if (node[last] !== undefined && typeof node[last] === 'object' && !Array.isArray(node[last])) return false;
  node[last] = value;
  return true;
}

module.exports = {
  id: 'api',
  label: 'HTTP API',
  summary: 'Deliver by posting JSON to an HTTPS endpoint. The field mapping below adapts it to any mail API.',

  settings: [
    { key: 'mail.apiEndpoint', env: 'MAIL_API_ENDPOINT', label: 'Endpoint URL', placeholder: 'https://api.example.com/v1/messages' },
    { key: 'mail.apiKey', env: 'MAIL_API_KEY', label: 'API key', secret: true, placeholder: 'the credential from your mail provider' },
    { key: 'mail.apiAuthHeader', env: 'MAIL_API_AUTH_HEADER', label: 'Auth header', placeholder: 'Authorization' },
    { key: 'mail.apiAuthPrefix', env: 'MAIL_API_AUTH_PREFIX', label: 'Auth prefix', placeholder: 'Bearer ' },
    { key: 'mail.apiFromField', env: 'MAIL_API_FROM_FIELD', label: 'From field', placeholder: 'from' },
    { key: 'mail.apiToField', env: 'MAIL_API_TO_FIELD', label: 'Recipient field', placeholder: 'to' },
    { key: 'mail.apiSubjectField', env: 'MAIL_API_SUBJECT_FIELD', label: 'Subject field', placeholder: 'subject' },
    { key: 'mail.apiTextField', env: 'MAIL_API_TEXT_FIELD', label: 'Plain text field', placeholder: 'text' },
    { key: 'mail.apiHtmlField', env: 'MAIL_API_HTML_FIELD', label: 'HTML field', placeholder: 'html' },
  ],

  secrets: ['mail.apiKey'],

  defaults: {
    'mail.apiAuthHeader': 'Authorization',
    'mail.apiAuthPrefix': 'Bearer ',
    'mail.apiFromField': 'from',
    'mail.apiToField': 'to',
    'mail.apiSubjectField': 'subject',
    'mail.apiTextField': 'text',
    'mail.apiHtmlField': 'html',
  },

  validateConfig(cfg) {
    const problems = [];
    const endpoint = cfgValue(cfg, 'mail.apiEndpoint');

    if (!endpoint) {
      problems.push('an endpoint URL is required');
    } else {
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        url = null;
        problems.push('the endpoint URL is not a valid URL');
      }
      if (url) {
        if (!['https:', 'http:'].includes(url.protocol)) {
          problems.push('the endpoint must be an http or https URL');
        } else if (url.protocol === 'http:') {
          // A bearer token in cleartext to anything but the local machine is the
          // case this blocks. 127.0.0.1 and ::1 are exempt because a developer
          // pointing at a local relay is not sending the key anywhere.
          const host = url.hostname.replace(/^\[|\]$/g, '');
          if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
            problems.push('the endpoint must use https unless it points at localhost');
          }
        }
      }
    }

    const header = cfgValue(cfg, 'mail.apiAuthHeader');
    // Node rejects a header name containing anything outside this set, and the
    // failure would otherwise arrive as an opaque TypeError at send time.
    if (header && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
      problems.push('the auth header name contains characters that are not valid in a header');
    }
    if (header && !cfg.getSecret('mail.apiKey')) {
      problems.push('an auth header is set but no API key is stored');
    }

    for (const key of ['mail.apiToField', 'mail.apiSubjectField']) {
      if (!cfgValue(cfg, key)) problems.push(key + ' must name where the value goes in the request');
    }
    for (const key of ['mail.apiFromField', 'mail.apiTextField', 'mail.apiHtmlField']) {
      if (!cfgValue(cfg, key)) problems.push(key + ' must name where the value goes in the request');
    }

    return { ok: problems.length === 0, problems };
  },

  // Assembles the request. Split out from send() so check() sends the same body
  // rather than a different shape that happens to be accepted.
  build(cfg, message) {
    const body = {};
    const mappings = [
      ['mail.apiFromField', cfg.from()],
      ['mail.apiToField', message.to],
      ['mail.apiSubjectField', message.subject],
      ['mail.apiTextField', message.text],
      ['mail.apiHtmlField', message.html],
    ];
    for (const [key, value] of mappings) {
      const path = cfgValue(cfg, key);
      if (!path) continue;
      if (value === undefined || value === null) continue;
      if (!place(body, path, value)) {
        throw new Error('the field mapping ' + key + ' collides with another mapped field');
      }
    }
    return body;
  },

  // One request. Resolves with the status and a truncated body, and never throws
  // on a non-2xx: the caller decides what a given status means, because that is
  // the part that differs between providers and is configured, not hardcoded.
  makeRequest(cfg, message) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(cfgValue(cfg, 'mail.apiEndpoint'));
      } catch {
        reject(new Error('the endpoint URL is not a valid URL'));
        return;
      }

      const body = Buffer.from(JSON.stringify(this.build(cfg, message)), 'utf8');
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': body.length,
        'User-Agent': 'Trycord',
      };

      const header = cfgValue(cfg, 'mail.apiAuthHeader');
      const key = cfg.getSecret('mail.apiKey');
      if (header && key) {
        headers[header] = cfgValue(cfg, 'mail.apiAuthPrefix') + key;
      }

      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            // A provider that answers with a large body should not be able to
            // exhaust memory here, and nothing below needs more than the first
            // few kilobytes of a response.
            if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
          });
          res.on('end', () => resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        }
      );

      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy(new Error('the request timed out'));
      });
      req.on('error', (e) => {
        // A transport error can carry the hostname and occasionally the path.
        // It is reduced to a code so a key in a URL never reaches a log.
        reject(new Error('the endpoint could not be reached (' + ((e && e.code) || 'network_error') + ')'));
      });
      req.end(body);
    });
  },

  async sendMessage(cfg, message) {
    const v = this.validateConfig(cfg);
    if (!v.ok) throw new Error(v.problems.join('; '));

    const res = await this.makeRequest(cfg, message);
    if (res.status < 200 || res.status >= 300) {
      let detail = '';
      try {
        const parsed = JSON.parse(res.body);
        detail = String(parsed.message || parsed.error || parsed.detail || '').slice(0, 200);
      } catch {
        detail = String(res.body || '').trim().slice(0, 200);
      }
      throw new Error('the provider answered ' + res.status + (detail ? ': ' + detail : ''));
    }

    let id = null;
    try {
      const parsed = JSON.parse(res.body);
      if (parsed && typeof parsed === 'object') {
        const candidate = parsed.id || parsed.message_id || parsed.messageId;
        if (typeof candidate === 'string' || typeof candidate === 'number') id = String(candidate);
      }
    } catch { /* a body that is not JSON still means accepted */ }

    return { delivered: true, id };
  },

  async checkConnection(cfg) {
    const v = this.validateConfig(cfg);
    if (!v.ok) return { ok: false, detail: v.problems.join('; ') };

    const to = cfg.pending('testRecipient');
    if (!to) return { ok: false, detail: 'a recipient address is required for a real delivery check' };

    try {
      const out = await this.sendMessage(cfg, {
        to,
        subject: 'Trycord configuration check',
        text: 'This instance is configured to deliver mail over an HTTP API. If you are reading it, the configuration works.',
        html: undefined,
      });
      return { ok: true, detail: 'the provider accepted the message' + (out.id ? ' (' + out.id + ')' : '') };
    } catch (e) {
      return { ok: false, detail: e && e.message ? e.message : String(e) };
    }
  },
};
