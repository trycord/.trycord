# Browser checks

Real-browser checks for the client. A screenshot proves a page drew; these
assert that it drew the right thing, from the server, as a signed-in person.

Everything here drives Chromium over the DevTools protocol directly
(`cdp.mjs`, no dependencies). That is deliberate: the failures worth catching
are a document that loads but cannot paint, a route that resolves to the wrong
view, a control that throws — none of which a `fetch` can see.

## Running one

The server under test has to be running first. A SQLite instance is enough and
leaves your real database alone:

```sh
cd trycord-server
DB_CLIENT=sqlite DB_FILE=/tmp/tc-test.db PORT=9975 HOST=127.0.0.1 \
UPLOAD_DIR=/tmp/tc-uploads MAIL_MODE=log SECRET=testsecret0123456789abcdef \
  node src/server.js &
```

`MAIL_MODE=log` matters. Without it the local `.env` turns on SMTP email
verification, every account stays unverified, and the suites fail for reasons
that look like product faults.

Then, from this directory:

```sh
node t-sidebar.mjs
```

## Writing one

```js
import { launch, waitForServer, signedIn } from './cdp.mjs';

const B = 'http://127.0.0.1:9975';
let pass = 0, fail = 0;

const ok = (name, condition, detail) => { /* ... */ };

await waitForServer(B + '/api/health');
const page = await launch({ width: 1440, height: 900 });
try {
  const { serverId } = await signedIn(page, B, { seedCommunity: true });
  // ...assert on the rendered DOM
} finally {
  await page.close();
}
process.exit(fail ? 1 : 0);
```

Two habits worth keeping:

**Assert on the DOM, not on a screenshot.** `page.eval` returning a measurement
is evidence; a picture is a hint.

**Clear storage before signing in.** An existing session makes `/register`
redirect away, which reads exactly like the form failing to render.

## The suites

| file | what it covers |
| --- | --- |
| `t-sidebar.mjs` | sidebar rows navigate, and each sidebar describes the page beside it |
| `t-origin-boot.mjs` | the backend origin serves the whole client; the API stays an API |
| `t-theme.mjs` | the Custom Theme Studio: guided controls, CSS validation, persistence, reset |
| `t-layout.mjs` | layout measurements across every size the project supports |
| `t-ui.mjs` | the feature surfaces, driven end to end |