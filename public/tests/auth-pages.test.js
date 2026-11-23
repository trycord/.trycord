// The rest of the public account gate.
//
// Sign-in is checked on its own. These are the four screens behind it:
// creating an account, asking for a recovery link, applying a reset, and
// confirming an address. They share one script because they share one rule:
// the public site talks to the same endpoints as the application, stores the
// session in the same place, and never mints or invents a token.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PUBLIC_DIR, REPO_DIR, read } = require('./helpers');

const PAGES = {
  register: read(path.join(PUBLIC_DIR, 'register.html')),
  forgot: read(path.join(PUBLIC_DIR, 'forgot.html')),
  reset: read(path.join(PUBLIC_DIR, 'reset-password.html')),
  verify: read(path.join(PUBLIC_DIR, 'verify-email.html')),
};
const SCRIPT = read(path.join(PUBLIC_DIR, 'js', 'auth-pages.js'));
const API = read(path.join(PUBLIC_DIR, 'js', 'public-api.js'));
const SERVER = read(path.join(REPO_DIR, 'backend', 'src', 'serve-client.js'));
const CSS = read(path.join(PUBLIC_DIR, 'css', 'site.css'));

test('the public site owns every account page', () => {
  const expected = {
    register: ['data-register-form', 'name="username"', 'name="password"',
      'data-legal-accepted', 'data-legal-versions', 'data-register-alert'],
    forgot: ['data-forgot-form', 'name="email"', 'data-forgot-alert', 'data-forgot-result'],
    reset: ['data-reset-form', 'name="password"', 'name="confirm"',
      'data-reset-alert', 'data-reset-invalid', 'data-reset-done'],
    verify: ['data-verify-status', 'data-verify-actions', 'data-verify-resend'],
  };

  for (const [name, markers] of Object.entries(expected)) {
    const html = PAGES[name];
    assert.match(html, new RegExp('data-auth-page="' + name + '"'),
      name + ' is not the page the script expects');
    for (const marker of markers) {
      assert.ok(html.includes(marker), name + ' is missing ' + marker);
    }
    assert.match(html, /<meta name="robots" content="noindex/,
      name + ' is offered to search engines');
    for (const script of ['/js/public-api.js', '/js/auth-pages.js', '/js/site.js']) {
      assert.ok(html.includes('src="' + script + '"'), name + ' does not load ' + script);
    }
  }

  // The address of a one-time link is not a search result, and the page does
  // not send the token onward in a referrer header either.
  for (const name of ['reset', 'verify']) {
    assert.match(PAGES[name], /<meta name="referrer" content="no-referrer">/,
      name + ' can leak a one-time token through its referrer');
  }
});

test('the account pages stay on the public site', () => {
  for (const name of ['register', 'forgot']) {
    const target = '/' + name;
    assert.ok(PAGES.register.includes('href="' + target + '"')
      || PAGES.forgot.includes('href="' + target + '"'),
    'the gate has no link back to ' + target);
  }
  assert.ok(PAGES.reset.includes('href="/forgot"'), 'an invalid reset has no way back');
  assert.ok(PAGES.verify.includes('href="/login'), 'a verification result has no way to sign in');
  assert.equal(/href="\/app\/(register|forgot|reset-password|verify-email)"/.test(
    Object.values(PAGES).join('\n')), false,
  'an account page still sends the reader into the application gate');
  assert.equal(/[?&]token=/.test(Object.values(PAGES).join('\n') + SCRIPT), false,
    'a token is written into a query string');
});

test('the server mounts the account pages and keeps their tokens out of metadata', () => {
  for (const [route, file] of [
    ['/register', 'register.html'],
    ['/forgot', 'forgot.html'],
    ['/reset-password', 'reset-password.html'],
    ['/verify-email', 'verify-email.html'],
  ]) {
    assert.ok(SERVER.includes("route: '" + route + "', file: '" + file + "', listed: false"),
      route + ' is not a noindex public route');
    assert.ok(SERVER.includes("Disallow: " + route),
      'robots.txt does not keep ' + route + ' out of the index');
  }

  assert.match(SERVER, /app\.get\('\/reset-password\/:token', publicPage\('reset-password\.html', '\/reset-password'\)\)/,
    'the reset token route is not mounted, or it is canonicalised with the token in it');
  assert.match(SERVER, /app\.get\('\/verify-email\/:token', publicPage\('verify-email\.html', '\/verify-email'\)\)/,
    'the verification token route is not mounted, or it is canonicalised with the token in it');
  assert.match(SERVER, /canonicalRoute \|\| req\.path/,
    'the canonical address no longer prefers the tokenless route');
});

test('the account script uses the API surface, not a second protocol', () => {
  for (const endpoint of ['/api/auth/register', '/api/auth/forgot-password',
    '/api/auth/reset-password', '/api/auth/verify-email']) {
    assert.ok(API.includes("'" + endpoint + "'"), 'the site cannot call ' + endpoint);
  }
  assert.match(SCRIPT, /Api\.register\(/, 'registration is not sent to the API');
  assert.match(SCRIPT, /Api\.forgotPassword\(/, 'recovery is not sent to the API');
  assert.match(SCRIPT, /Api\.resetPassword\(/, 'the reset is not sent to the API');
  assert.match(SCRIPT, /Api\.verifyEmail\(/, 'verification is not sent to the API');
  assert.match(SCRIPT, /readToken\('reset-password'\)/, 'the reset token is not read from its path');
  assert.match(SCRIPT, /readToken\('verify-email'\)/, 'the verification token is not read from its path');
  assert.match(SCRIPT, /termsVersion: legal\.termsVersion/, 'the legal version is guessed rather than read');
  assert.match(SCRIPT, /privacyVersion: legal\.privacyVersion/, 'the privacy version is guessed rather than read');
  assert.match(SCRIPT, /Api\.rememberSession\(answer\.token\)/,
    'a session returned by the API is not kept');
  assert.equal(/localStorage\.setItem/.test(SCRIPT), false,
    'the account script writes a second session store of its own');
});

test('the legal acceptance has a surface and a visible focus', () => {
  assert.match(CSS, /\.login-legal\s*\{[\s\S]*?grid-template-columns: 20px minmax\(0, 1fr\)/,
    'the legal acceptance has no readable checkbox layout');
  assert.match(CSS, /\.login-legal input\[type="checkbox"\][\s\S]*?accent-color/,
    'the acceptance checkbox does not use the site accent');
  assert.match(CSS, /\.login-legal-meta\.is-missing[\s\S]*?color: var\(--color-warning\)/,
    'an unavailable legal version is not marked');
});

/* ---- the script, executed -------------------------------------------------
   The page bodies are static; the promises are behavioural. This stand-in is
   deliberately small: it gives the script the handful of nodes it asks for,
   then presses the button the reader presses. */

function makeNode(name) {
  return {
    name,
    hidden: false,
    textContent: '',
    value: '',
    type: 'text',
    disabled: false,
    required: false,
    checked: false,
    href: '',
    focused: false,
    attrs: Object.create(null),
    classes: Object.create(null),
    listeners: Object.create(null),
    classList: {
      add(key) { this.owner.classes[key] = true; },
      remove(key) { delete this.owner.classes[key]; },
    },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
    },
    focus() { this.focused = true; },
  };
}

function makePage(nodes) {
  const page = makeNode('page');
  page.getAttribute = (key) => (key === 'data-auth-page' ? page.kind : null);
  page.querySelector = (selector) => nodes.top[selector] || nodes.formField(selector) || null;
  return page;
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(() => new Promise((resolve) => setImmediate(resolve)));
}

async function loadAuth(kind, options) {
  options = options || {};
  const calls = { register: [], forgot: [], reset: [], verify: [], resend: [], stored: [], assigned: [] };
  const formFields = Object.create(null);
  const make = (name) => {
    const node = makeNode(name);
    node.classList.owner = node;
    return node;
  };

  const form = make('form');
  form.querySelector = (selector) => formFields[selector] || null;
  if (kind === 'register') {
    for (const name of ['username', 'displayName', 'email', 'password', 'confirm']) {
      formFields['input[name="' + name + '"]'] = make(name);
    }
    formFields['[data-legal-accepted]'] = make('accepted');
  } else if (kind === 'forgot') {
    formFields['input[name="email"]'] = make('email');
  } else if (kind === 'reset') {
    for (const name of ['password', 'confirm']) formFields['input[name="' + name + '"]'] = make(name);
  }

  const top = Object.create(null);
  for (const name of [
    'data-register-form', 'data-register-closed', 'data-register-done',
    'data-register-done-title', 'data-register-done-text', 'data-register-continue',
    'data-register-signout', 'data-register-alert', 'data-approval-note',
    'data-email-optional', 'data-email-hint', 'data-legal-versions', 'data-legal-retry',
    'data-submit-note', 'data-submit', 'data-password-toggle',
    'data-forgot-form', 'data-forgot-alert', 'data-forgot-submit', 'data-forgot-result',
    'data-forgot-result-note', 'data-reset-form', 'data-reset-invalid',
    'data-reset-invalid-text', 'data-reset-done', 'data-reset-done-text',
    'data-reset-alert', 'data-reset-submit', 'data-verify-status', 'data-verify-actions',
    'data-verify-app', 'data-verify-login', 'data-verify-resend', 'data-verify-note',
  ]) {
    top['[' + name + ']'] = make(name);
  }
  top['[data-register-form]'] = form;
  top['[data-forgot-form]'] = form;
  top['[data-reset-form]'] = form;
  for (const name of ['data-register-closed', 'data-register-done', 'data-forgot-result',
    'data-reset-invalid', 'data-reset-done', 'data-verify-actions', 'data-verify-app',
    'data-verify-login', 'data-verify-resend']) {
    top['[' + name + ']'].hidden = true;
  }

  const page = makePage({ top, formField: (selector) => formFields[selector] });
  page.kind = kind;

  const instanceName = make('instance');
  const appLinks = [top['[data-register-continue]'], top['[data-verify-app]']];
  const document = {
    querySelector(selector) { return selector === '[data-auth-page]' ? page : null; },
    querySelectorAll(selector) {
      if (selector === '[data-instance-name]') return [instanceName];
      if (selector === '[data-app-link]') return appLinks;
      return [];
    },
    getElementById() { return null; },
  };

  const api = {
    legal: options.legal || (async () => ({ termsVersion: '1.0', privacyVersion: '1.0' })),
    instance: options.instance || (async () => ({ name: 'Test Instance', registration: { enabled: true } })),
    register: async (body) => {
      calls.register.push(body);
      return options.register ? options.register(body) : { token: 'new-token' };
    },
    forgotPassword: async (body) => {
      calls.forgot.push(body);
      return { ok: true, message: 'If an account exists for that email, you will receive a password reset link.' };
    },
    resetPassword: async (body) => {
      calls.reset.push(body);
      return options.reset ? options.reset(body) : { token: 'reset-token' };
    },
    verifyEmail: async (body) => {
      calls.verify.push(body);
      return options.verify ? options.verify(body) : { ok: true };
    },
    verifyEmailResend: async (body) => {
      calls.resend.push(body);
      return options.resend ? options.resend(body) : { ok: true };
    },
    rememberSession: async (token) => {
      calls.stored.push(token);
      return options.storageWorks !== false;
    },
    clearSession: async () => true,
    signedIn: async () => options.signedIn === true,
    me: async () => options.me || { email: null },
    appBase: async () => '/app',
    appHref: async (route) => '/app/' + route,
  };

  const window = {
    location: {
      pathname: options.pathname || '/',
      search: '',
      assign(url) { calls.assigned.push(url); },
    },
    TrycordApi: api,
  };

  const context = vm.createContext({
    window,
    document,
    localStorage: {},
    TextEncoder: global.TextEncoder,
    Promise,
    Error,
    String,
    Array,
    Object,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
  });
  vm.runInContext(SCRIPT, context, { filename: 'auth-pages.js' });
  await settle();
  return { form, top, page, instanceName, calls, window };
}

async function press(env) {
  await env.form.listeners.submit({ preventDefault() {} });
  await settle();
}

test('a registration reads the legal versions and keeps the returned session', async () => {
  const env = await loadAuth('register');
  const fields = env.form.querySelector('input[name="username"]');
  const accepted = env.form.querySelector('[data-legal-accepted]');

  assert.equal(env.top['[data-submit]'].disabled, true,
    'the form can be submitted before the terms are accepted');
  accepted.checked = true;
  accepted.listeners.change({});
  assert.equal(env.top['[data-submit]'].disabled, false,
    'a complete acceptance did not enable the form');

  env.form.querySelector('input[name="username"]').value = 'ada';
  env.form.querySelector('input[name="displayName"]').value = 'Ada';
  env.form.querySelector('input[name="email"]').value = 'ada@example.test';
  env.form.querySelector('input[name="password"]').value = 'correct-horse-battery';
  env.form.querySelector('input[name="confirm"]').value = 'correct-horse-battery';
  await press(env);

  const body = env.calls.register[0];
  assert.equal(body.username, 'ada');
  assert.equal(body.termsVersion, '1.0', 'the version in force was not sent');
  assert.equal(body.privacyVersion, '1.0', 'the privacy version in force was not sent');
  assert.deepEqual(env.calls.stored, ['new-token'], 'the session from registration was not kept');
  assert.deepEqual(env.calls.assigned, ['/app/'], 'the new account was not handed to the app');
});

test('a registration that waits for approval keeps the reader and says why', async () => {
  const env = await loadAuth('register', {
    instance: async () => ({ name: 'Test Instance', registration: { enabled: true, approvalRequired: true } }),
    register: async () => ({ token: 'pending-token', pendingApproval: true }),
  });
  const accepted = env.form.querySelector('[data-legal-accepted]');
  accepted.checked = true;
  accepted.listeners.change({});
  env.form.querySelector('input[name="username"]').value = 'ada';
  env.form.querySelector('input[name="password"]').value = 'correct-horse-battery';
  env.form.querySelector('input[name="confirm"]').value = 'correct-horse-battery';
  await press(env);

  assert.equal(env.form.hidden, true, 'the form stayed open after the account was made');
  assert.equal(env.top['[data-register-done]'].hidden, false, 'there is no waiting state');
  assert.match(env.top['[data-register-done-text]'].textContent, /administrator/,
    'the waiting state does not explain the approval');
  assert.deepEqual(env.calls.assigned, [], 'a waiting account was opened as if it were ready');
  assert.deepEqual(env.calls.stored, ['pending-token'], 'the waiting session was not kept');
});

test('recovery is generic and announces the same result either way', async () => {
  const env = await loadAuth('forgot');
  env.form.querySelector('input[name="email"]').value = 'somebody@example.test';
  await press(env);

  assert.deepEqual(env.calls.forgot, [{ email: 'somebody@example.test' }]);
  assert.equal(env.form.hidden, true);
  assert.equal(env.top['[data-forgot-result]'].hidden, false);
  assert.match(env.top['[data-forgot-result-note]'].textContent, /If an account exists/);
});

test('a reset reads its token from the path and finishes in one request', async () => {
  const env = await loadAuth('reset', { pathname: '/reset-password/token-123' });
  env.form.querySelector('input[name="password"]').value = 'a-new-long-password';
  env.form.querySelector('input[name="confirm"]').value = 'a-new-long-password';
  await press(env);

  assert.deepEqual(env.calls.reset, [{
    token: 'token-123',
    newPassword: 'a-new-long-password',
    confirmPassword: 'a-new-long-password',
  }]);
  assert.deepEqual(env.calls.stored, ['reset-token']);
  assert.deepEqual(env.calls.assigned, ['/app/']);
});

test('a reset without a token never calls the API', async () => {
  const env = await loadAuth('reset', { pathname: '/reset-password' });
  assert.equal(env.form.hidden, true, 'the form was shown without a token');
  assert.equal(env.top['[data-reset-invalid]'].hidden, false);
  assert.match(env.top['[data-reset-invalid-text]'].textContent, /missing its token/);
  assert.deepEqual(env.calls.reset, []);
});

test('a second factor survives a reset without being handed a session', async () => {
  const env = await loadAuth('reset', {
    pathname: '/reset-password/token-123',
    reset: async () => ({ mfaRequired: true, challengeToken: 'challenge-1' }),
  });
  env.form.querySelector('input[name="password"]').value = 'a-new-long-password';
  env.form.querySelector('input[name="confirm"]').value = 'a-new-long-password';
  await press(env);

  assert.equal(env.top['[data-reset-done]'].hidden, false);
  assert.deepEqual(env.calls.stored, [], 'a reset skipped the second factor');
  assert.deepEqual(env.calls.assigned, [], 'a reset opened the app without the second factor');
});

test('a verification confirms the token and offers the right next step', async () => {
  const env = await loadAuth('verify', { pathname: '/verify-email/token-456', signedIn: false });
  assert.deepEqual(env.calls.verify, [{ token: 'token-456' }]);
  assert.equal(env.top['[data-verify-status]'].getAttribute('data-tone'), 'success');
  assert.equal(env.top['[data-verify-login]'].hidden, false,
    'a signed-out reader is not offered sign-in');
  assert.equal(env.top['[data-verify-app]'].hidden, true,
    'a signed-out reader is sent to an app with no session');
  assert.equal(env.top['[data-verify-actions]'].hidden, false);
});

test('an expired verification can be resent by a signed-in reader', async () => {
  const failure = new Error('This verification link is no longer valid. Request a new one.');
  failure.code = 'AUTH_REQUIRED';
  const env = await loadAuth('verify', {
    pathname: '/verify-email/expired',
    signedIn: true,
    me: { email: 'ada@example.test' },
    verify: async () => { throw failure; },
  });

  assert.equal(env.top['[data-verify-status]'].getAttribute('data-tone'), 'error');
  assert.equal(env.top['[data-verify-app]'].hidden, false);
  assert.equal(env.top['[data-verify-resend]'].hidden, false);
  assert.match(env.top['[data-verify-resend]'].textContent, /ada@example\.test/);

  env.top['[data-verify-resend]'].listeners.click();
  await settle();
  assert.deepEqual(env.calls.resend, [{ email: 'ada@example.test' }]);
  assert.equal(env.top['[data-verify-status]'].getAttribute('data-tone'), 'success');
  assert.equal(env.top['[data-verify-resend]'].hidden, true);
});

test('a reset that lost its token can still be asked for again', () => {
  assert.ok(PAGES.reset.includes('href="/forgot"'),
    'the invalid state does not offer a new link');
  assert.match(SCRIPT, /showInvalid\(messageOf\(error/,
    'a refused token is not shown in the invalid state');
});
