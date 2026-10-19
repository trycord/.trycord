# The developer sandbox

The supported way to exercise the API against a disposable instance. It is
the same harness the repository's own tests use, so an example that works here
works in a test and the other way round.

## What it gives you

`backend/tests/helpers/instance.js` starts an instance that belongs to the
run and to nothing else:

- its own SQLite database file, in its own directory
- its own port, on the loopback interface
- its own uploads directory
- its own signing secret, so a token from one run is not accepted by another
- no mail, no federation, no discovery, no third-party fetches

The run does not touch the instance the machine is serving, and it leaves
nothing behind: the directory is removed when the instance stops.

```js
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

const instance = await startInstance();
try {
  const ada = await registerUser(instance, 'ada');
  const me = await apiClient(instance.baseUrl, ada.token).get('/api/users/me');
  console.log(me.data.username);   // ada
} finally {
  await instance.stop();
}
```

| Helper | What it does |
| --- | --- |
| `startInstance(options)` | starts an instance; `options.env` adds environment, `options.dir` chooses where the files go, `options.port` chooses the port |
| `apiClient(baseUrl, token)` | a small HTTP client: a bearer token, the JSON error envelope, no hidden retries |
| `registerUser(instance, username)` | registers an account and returns a client signed in as it |
| `freePort()` | a port nothing is listening on |

The instance answers on `instance.baseUrl`. The versioned API is mounted at
`instance.baseUrl + '/api/v1'`.

## Exercising the versioned API

The versioned router is mounted by `server.js`. A sandbox that has not got it
mounted can mount it itself - the test helper
`backend/tests/developer/helpers/developer.js` does exactly that, and puts
the mount in front of the API 404 handler so the routes are reachable:

```js
const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('./developer/helpers/developer');

const instance = await startInstance();
try {
  const base = await ensureVersionedApi(instance);   // http://127.0.0.1:PORT/api/v1
  const ada = await registerUser(instance, 'ada');

  const created = await apiClient(base, ada.token).post('/keys', {
    name: 'sandbox key',
    scopes: ['keys:read'],
  });
  console.log(created.data.key.id, created.data.secret);

  const withKey = await apiClient(base, created.data.secret).get('/keys');
  console.log(withKey.status);   // 200
} finally {
  await instance.stop();
}
```

`ensureVersionedApi` probes the instance first: if the server already mounts
the versioned router, it uses it as it is and mounts nothing.

## The repository's own developer tests

```
cd backend
node --test "tests/developer/*.test.js"
```

| File | What it proves |
| --- | --- |
| `tests/developer/api-keys.test.js` | a key's secret is returned once, the scope check refuses a key that lacks a scope, a revoked key stops working, a rotation ends the old secret, the per-key limit is enforced, and one account cannot reach another's key |
| `tests/developer/applications.test.js` | an application is created with a token and a credential, the token posts in the application's name, rotating it ends the old one, revoking it burns it, and an application cannot administer credentials |
| `tests/developer/openapi.test.js` | the document is served, is valid JSON, and agrees with the routes the router registers in both directions |
| `tests/developer/webhook-events.test.js` | the envelope has the documented shape, and a subscriber receives it |

## Running the whole surface by hand

The instance is an ordinary server, so the surface can be driven with curl as
well:

```sh
cd backend
node -e "
const { startInstance } = require('./tests/helpers/instance');
startInstance({ port: 9971 }).then((i) => {
  console.log('sandbox on', i.baseUrl);
  console.log('register with: curl -s -X POST ' + i.baseUrl + '/api/auth/register'
    + ' -H \"content-type: application/json\"'
    + ' -d \'{\"username\":\"ada\",\"password\":\"correct-horse-battery\",'
    + '\"displayName\":\"Ada\",\"termsVersion\":\"1.0\",\"privacyVersion\":\"1.0\"}\'');
});
"
```

Then, in another shell:

```sh
curl -s http://127.0.0.1:9971/api/v1/openapi.json | head -40
curl -s http://127.0.0.1:9971/api/v1/scopes
```

## What the sandbox is not

- It is not a production instance: mail is off, discovery is off, and the
  database is a file in a temporary directory.
- It does not send mail, so anything that needs a verification email has to
  use the test-only route the harness enables (`ALLOW_TEST_HOOKS`, which the
  harness sets and the server warns about at boot).
- It serves the real client tree, so a browser can be pointed at it.
