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
UPLOAD_DIR=/tmp/tc-uploads MAIL_MODE=log \
JWT_SECRET=<32+ random hex> SERVER_HOST_TYPE=express \
  node src/server.js &
```

Every instance must supply its own signing secret — there is no default and the
official one is never shared — and the host type must be stated explicitly.

`MAIL_MODE=log` matters. Without it the local `.env` turns on SMTP email
verification, every account stays unverified, and the suites fail for reasons
that look like product faults.

Then, from this directory:

```sh
node t-sidebar.mjs
```

CI runs `t-sidebar.mjs` on every push (`.github/workflows/check.yml`, the
`browser` job).

## If every suite fails the same way

```
Error: chromium accepted the tab but never navigated to http://127.0.0.1:9975/.
```

That is the driver telling you the browser never fetched anything, which is an
environment fault rather than a product one. Some builds of Chromium on some
machines open the tab, issue the request, and leave the execution context on
`about:blank`. To tell the two apart:

```sh
chromium --headless=new --user-data-dir=$(mktemp -d) \
  --dump-dom 'data:text/html,<b>ok</b>'      # renders
chromium --headless=new --user-data-dir=$(mktemp -d) \
  --dump-dom http://127.0.0.1:9975/backend.json   # empty: the fault
```

If the `data:` URL renders and the `http:` one does not, it is the browser and
not the application.

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

| file | what it covers | in CI |
| --- | --- | --- |
| `t-sidebar.mjs` | sidebar rows navigate, and each sidebar describes the page beside it | yes |
| `verify-these.md` | fixes made without a browser, and how to check them by hand | — |

Suites written earlier in the project and not yet restored to this directory:
origin-boot (the backend origin serving the whole client), theme (the Custom
Theme Studio), layout (measurements at every supported size) and ui (the feature
surfaces end to end). They were lost with `/tmp` and are worth rewriting against
`cdp.mjs` — the helper it exports (`waitForServer`, `signedIn`) is what they
each need, and re-adding them is what keeps that file honest.