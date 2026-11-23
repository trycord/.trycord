// The site's sign-in door.
//
// The application has its own gate for a deployment that serves it alone. On
// an instance that also serves the public website, the door lives at /login:
// one page, built from the site's own furniture, that asks the instance for a
// session and hands the token to the application.
//
// These checks are about the promises that are easy to break by accident: the
// form asks the server, the token is filed where the client reads it, and it
// never travels in a URL.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PUBLIC_DIR, REPO_DIR, read } = require('./helpers');

const LOGIN = read(path.join(PUBLIC_DIR, 'login.html'));
const SCRIPT = read(path.join(PUBLIC_DIR, 'js', 'login.js'));
const API = read(path.join(PUBLIC_DIR, 'js', 'public-api.js'));
const SITE = read(path.join(PUBLIC_DIR, 'js', 'site.js'));
const CSS = read(path.join(PUBLIC_DIR, 'css', 'site.css'));

test('the public site owns the sign-in page', () => {
  assert.match(LOGIN, /data-login-form/, 'there is no sign-in form');
  assert.match(LOGIN, /name="username"/, 'the form does not ask for a username');
  assert.match(LOGIN, /name="password"/, 'the form does not ask for a password');
  assert.match(LOGIN, /data-code-field/, 'there is no second-factor step');
  assert.match(LOGIN, /data-login-alert/, 'there is nowhere to say what went wrong');
  assert.match(LOGIN, /data-instance-name/, 'the page does not name the instance');
  assert.match(LOGIN, /<meta name="robots" content="noindex/,
    'a page that takes a password is offered to search engines');
  for (const script of ['/js/public-api.js', '/js/login.js', '/js/site.js']) {
    assert.ok(LOGIN.includes('src="' + script + '"'), 'the page does not load ' + script);
  }
});

test('the site keeps account routes on the site and resolves the app mount', () => {
  for (const target of ['/register', '/forgot']) {
    assert.ok(LOGIN.includes('href="' + target + '"'), 'the page has no link to ' + target);
  }
  for (const target of ['/app/']) {
    const index = LOGIN.indexOf('"' + target + '"');
    assert.notEqual(index, -1, 'the page has no link to ' + target);
    const open = LOGIN.lastIndexOf('<a ', index);
    const close = LOGIN.indexOf('>', index);
    const element = LOGIN.slice(open, close + 1);
    assert.match(element, /data-app-link/, target + ' is written without resolving the mount');
  }
});

test('the token is filed under the API origin and never put in a URL', () => {
  assert.match(API, /TOKEN_PREFIX = 'trycord\.token\.'/,
    'the site does not use the application\'s token key');
  assert.match(API, /localStorage\.setItem\(TOKEN_PREFIX \+ originOf\(base\), value\)/,
    'the token is not filed under the origin that issued it');
  assert.match(API, /\/api\/auth\/login/, 'the site does not call the sign-in endpoint');
  assert.match(API, /\/api\/auth\/2fa\/verify/, 'the site cannot finish a second-factor sign-in');
  assert.match(SCRIPT, /rememberSession\(answer\.token\)/,
    'the sign-in response is not handed to the session store');
  assert.match(SCRIPT, /window\.location\.assign\(href\)/,
    'the reader is not sent into the application');
  assert.match(SCRIPT, /Api\.appHref\(/, 'the redirect does not resolve the application mount');
  assert.equal(/[?&]token=/.test(LOGIN + SCRIPT), false,
    'a token is written into an address');
});

test('a next address cannot leave this site', () => {
  assert.match(SCRIPT, /value\.charAt\(0\) !== '\/'/, 'a relative next target is accepted');
  assert.match(SCRIPT, /value\.slice\(0, 2\) === '\/\/'/, 'a protocol-relative next target is accepted');
  assert.match(SCRIPT, /Api\.appHref\(/, 'the next target is not resolved inside the application');
});

test('a signed-in reader is offered the app instead of a second form', () => {
  assert.match(SCRIPT, /Api\.signedIn\(\)/, 'the page never checks for an existing session');
  assert.match(SCRIPT, /form\.hidden = true/, 'the form is shown again to a signed-in reader');
  assert.match(SCRIPT, /data-switch/, 'there is no way to use another account');
  assert.match(SITE, /querySelectorAll\('\[data-signin\]'\)/,
    'the header does not recognise a signed-in reader');
  assert.match(SITE, /signedIn/, 'the header never asks whether there is a session');
  assert.match(SITE, /Open the app/, 'the signed-in action never becomes the app');
});

test('the server mounts /login as a public page, not a sitemap entry', () => {
  const server = read(path.join(REPO_DIR, 'backend', 'src', 'serve-client.js'));
  assert.match(server, /route: '\/login', file: 'login\.html', listed: false/,
    'the public page is not mounted, or is offered to search engines');
  assert.match(server, /p\.listed !== false/, 'the sitemap does not honour listed: false');
  assert.match(server, /Disallow: \/login/, 'robots.txt does not keep the door out of the index');
});

test('the sign-in page carries the site\'s composition and a visible focus', () => {
  assert.match(CSS, /\.login-grid\s*\{[\s\S]*?grid-template-columns/, 'the page has no two-plane layout');
  assert.match(CSS, /\.login-card\s*\{[\s\S]*?border-radius/, 'the form has no surface of its own');
  assert.match(CSS, /\.login-input:focus-visible[\s\S]*?outline: 2px solid var\(--color-accent\)/,
    'a field has no visible focus');
  assert.match(CSS, /@media \(max-width: 980px\)[\s\S]*?\.login-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/,
    'the composition does not become one column on a narrow screen');
});

/* ---- the script, executed -------------------------------------------------
   The checks above read the source. These run it, because "the form calls the
   endpoint" and "the form stores the token" are behaviour, not spelling. The
   page uses the platform's own DOM and fetch, so a small stand-in is enough,
   and every branch that can move the reader is exercised: a session, a second
   factor, a refusal, and a next target that tries to leave. */

function makeNode(name) {
  return {
    name,
    hidden: false,
    textContent: '',
    value: '',
    type: 'text',
    disabled: false,
    required: false,
    focused: false,
    attrs: Object.create(null),
    listeners: Object.create(null),
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    removeAttribute(key) { delete this.attrs[key]; },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
    },
    focus() { this.focused = true; },
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => new Promise((resolve) => setImmediate(resolve)));
}

async function loadLogin(options) {
  options = options || {};
  const form = makeNode('form');
  const username = makeNode('username');
  const password = makeNode('password');
  password.type = 'password';
  const code = makeNode('code');
  const codeField = makeNode('codeField');
  const alertBox = makeNode('alert');
  const submit = makeNode('submit');
  const toggle = makeNode('toggle');
  const already = makeNode('already');
  already.hidden = true;
  const switchButton = makeNode('switch');
  const continueLink = makeNode('continue');
  const instanceName = makeNode('instance');

  const fields = {
    '[data-login-alert]': alertBox,
    'input[name="username"]': username,
    'input[name="password"]': password,
    'input[name="code"]': code,
    '[data-code-field]': codeField,
    '[data-submit]': submit,
    '[data-password-toggle]': toggle,
  };
  form.querySelector = (selector) => fields[selector] || null;
  form.hidden = false;

  const top = {
    '[data-login-form]': form,
    '[data-already]': already,
    '[data-switch]': switchButton,
    '[data-continue]': continueLink,
  };
  const document = {
    querySelector(selector) { return top[selector] || null; },
    querySelectorAll(selector) {
      return selector === '[data-instance-name]' ? [instanceName] : [];
    },
  };

  const calls = { signIn: [], verify: [], stored: [], assigned: [], network: 0 };
  const api = {
    signIn: options.signIn || (async (body) => {
      calls.signIn.push(body);
      return { token: 'token-from-login', user: { id: 'u1' } };
    }),
    verifySecondFactor: options.verifySecondFactor || (async (body) => {
      calls.verify.push(body);
      return { token: 'token-from-code' };
    }),
    rememberSession: async (token) => {
      calls.stored.push(token);
      return options.storageWorks !== false;
    },
    signedIn: async () => options.signedIn === true,
    appBase: async () => '/app',
    appHref: async (route) => '/app/' + route,
    instance: async () => ({ name: 'Test Instance' }),
  };

  const search = options.search || '';
  const window = {
    location: {
      search,
      href: 'https://site.test/login' + search,
      assign(url) { calls.assigned.push(url); },
    },
    TrycordApi: api,
  };

  const context = vm.createContext({
    window,
    document,
    localStorage: {},
    fetch: async () => {
      calls.network += 1;
      throw new Error('the test did not expect a network request');
    },
    URL,
    URLSearchParams,
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
  vm.runInContext(read(path.join(PUBLIC_DIR, 'js', 'login.js')), context, { filename: 'login.js' });
  await settle();
  return {
    form, username, password, code, codeField, alertBox, submit, toggle,
    already, switchButton, continueLink, instanceName, calls, window,
  };
}

async function press(env) {
  await env.form.listeners.submit({ preventDefault() {} });
  await settle();
}

test('a successful sign-in stores the token and opens the app', async () => {
  const env = await loadLogin();
  assert.equal(env.instanceName.textContent, 'Test Instance', 'the instance is not named');
  env.username.value = 'ada';
  env.password.value = 'secret';
  await press(env);

  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.signIn)),
    [{ username: 'ada', password: 'secret' }]);
  assert.deepEqual(env.calls.stored, ['token-from-login'],
    'the token the instance returned was not handed to the session store');
  assert.deepEqual(env.calls.assigned, ['/app/'],
    'the reader was not sent into the app after signing in');
});

test('a next target stays inside the application at this instance', async () => {
  const direct = await loadLogin({ search: '?next=%2Fsettings%2Fsecurity' });
  direct.username.value = 'ada';
  direct.password.value = 'secret';
  await press(direct);
  assert.deepEqual(direct.calls.assigned, ['/app/settings/security']);

  const mounted = await loadLogin({ search: '?next=%2Fapp%2Fsettings' });
  mounted.username.value = 'ada';
  mounted.password.value = 'secret';
  await press(mounted);
  assert.deepEqual(mounted.calls.assigned, ['/app/settings'],
    'a next target that already carries the mount is not reduced to the route');

  for (const search of ['?next=%2F%2Fevil.example', '?next=https%3A%2F%2Fevil.example']) {
    const foreign = await loadLogin({ search });
    foreign.username.value = 'ada';
    foreign.password.value = 'secret';
    await press(foreign);
    assert.deepEqual(foreign.calls.assigned, ['/app/'],
      'a next target outside the site was followed: ' + search);
  }
});

test('a second-factor sign-in finishes before the token is stored', async () => {
  const env = await loadLogin({
    signIn: async (body) => {
      env.calls.signIn.push(body);
      return { mfaRequired: true, challengeToken: 'challenge-1' };
    },
  });
  env.username.value = 'ada';
  env.password.value = 'secret';
  await press(env);

  assert.equal(env.codeField.hidden, false, 'the second-factor field stayed hidden');
  assert.equal(env.submit.textContent, 'Verify and continue');
  assert.deepEqual(env.calls.stored, [], 'a token was stored before the second factor');
  assert.deepEqual(env.calls.assigned, []);

  env.code.value = ' 123 456 ';
  await press(env);
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.verify)),
    [{ challengeToken: 'challenge-1', code: '123456' }],
    'the code was not sent with the challenge the instance minted');
  assert.deepEqual(env.calls.stored, ['token-from-code']);
  assert.deepEqual(env.calls.assigned, ['/app/']);
});

test('a refusal is announced and keeps the reader on the form', async () => {
  const env = await loadLogin({
    signIn: async () => {
      const failure = new Error('We could not sign you in. Check the details and try again.');
      failure.code = 'AUTH_REQUIRED';
      throw failure;
    },
  });
  env.username.value = 'ada';
  env.password.value = 'secret';
  await press(env);

  assert.equal(env.alertBox.hidden, false, 'the refusal is not announced');
  assert.match(env.alertBox.textContent, /could not sign you in/);
  assert.equal(env.alertBox.getAttribute('data-tone'), 'error');
  assert.equal(env.password.focused, true, 'the field to correct is not focused');
  assert.deepEqual(env.calls.assigned, []);
  assert.deepEqual(env.calls.stored, []);
});

test('a browser that blocks storage is told, rather than losing the session', async () => {
  const env = await loadLogin({ storageWorks: false });
  env.username.value = 'ada';
  env.password.value = 'secret';
  await press(env);

  assert.equal(env.alertBox.hidden, false);
  assert.match(env.alertBox.textContent, /blocked local storage/,
    'a blocked store is silently treated as success');
  assert.deepEqual(env.calls.assigned, [], 'the app was opened without a stored session');
});

test('an existing session is offered the app, and another account is one click away', async () => {
  const env = await loadLogin({ signedIn: true });
  assert.equal(env.form.hidden, true, 'the form is still shown to a signed-in reader');
  assert.equal(env.already.hidden, false, 'the session panel is not shown');
  assert.equal(env.continueLink.getAttribute('href'), '/app/',
    'the way into the app does not resolve the mount');

  await env.switchButton.listeners.click();
  assert.equal(env.form.hidden, false, 'the form cannot be reached to switch accounts');
  assert.equal(env.already.hidden, true);
  assert.equal(env.username.focused, true);
});

