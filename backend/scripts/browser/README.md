# Browser checks

Everything in this directory drives Chromium over the DevTools protocol directly
(`cdp.mjs`, no driver library, so there is no install step and it does not care which
Chromium is on the machine). The failures worth catching are a document that loads but
cannot paint, a route that resolves to the wrong view, a control that throws - none of
which a `fetch` can see.

| file | what it does |
| --- | --- |
| `shots.mjs` | photographs every surface at eight widths |
| `layout.mjs` | asserts measurements at three widths, from a dumped DOM |
| `sidebar.mjs` | asserts sidebar rows navigate, and each sidebar describes the page beside it |
| `cdp.mjs` | the DevTools protocol client: `launch`, `waitForServer`, `signedIn` |
| `bridge.mjs` | injects the client bundle a measured page needs, for `layout.mjs` |

## Photographs

`shots.mjs` fails when a surface renders an error card instead of a page, because an
error card photographs tidily: correct layout, no overflow, nothing visually wrong. A
page that threw can otherwise sit there being mistaken for a finished design.

```
npm run check:shots                 # throwaway backend, every surface, writes ./shots/
node scripts/browser/shots.mjs      # against a server you already started
node scripts/browser/shots.mjs home settings   # only the named surfaces
```

`check:shots` starts its own backend on a free port with a disposable SQLite file and
stops it afterwards. It sets `DB_CLIENT` as well as `DB_FILE`, always: the repository's
`.env` sets `DB_CLIENT` twice and the last one wins, so a `DB_FILE` on its own resolves
to the live remote database. That is not theoretical.

Widths, where the browser works:

    360x740   small phone
    390x844   phone
    834x1112  tablet
    1280x720  small laptop
    1440x900  laptop
    1920x1080 desktop
    2560x1440 wide
    3440x1440 ultrowide

jsdom covers structure: that pages render, routes resolve, controls have accessible
names, navigation composes. It has no layout engine, so it cannot tell you a sidebar is
260px wide or that two things overlap. That is what this directory is for.

## Measuring

`layout.mjs` reads a DOM dumped by `check-render.js` rather than driving a browser
itself, so the browser only has to be present for the geometry pass:

```
node scripts/check-render.js --emit-dom /tmp/dom
node scripts/browser/layout.mjs /tmp/dom
```

## Starting a server by hand

`shots.mjs` and `sidebar.mjs` want a server already running. A SQLite instance is enough
and leaves your real database alone:

```sh
cd backend
DB_CLIENT=sqlite DB_FILE=/tmp/tc-test.db PORT=9975 HOST=127.0.0.1 \
UPLOAD_DIR=/tmp/tc-uploads MAIL_MODE=log \
JWT_SECRET=<32+ random hex> SERVER_HOST_TYPE=express \
  node src/server.js &
```

Every instance must supply its own signing secret - there is no default and the official
one is never shared - and the host type must be stated explicitly.

`MAIL_MODE=log` matters. Without it the local `.env` turns on SMTP email verification,
every account stays unverified, and the suites fail for reasons that look like product
faults.

## It will tell you it cannot run, and pass

Some environments have a Chromium that starts, attaches over CDP, evaluates JavaScript
happily - and then never completes an http request. The page sits on `about:blank`
forever. Screenshots of it are 800x600 rectangles of nothing.

On such a machine the run prints SKIPPED and exits 0. Trycord was not exercised and did
not fail. That distinction matters: a check that reports a broken product when the
machine cannot run the browser is a check people learn to ignore, and then it is worse
than no check at all.

Verify which you are getting by looking for the SKIPPED line, not for a green tick. To
confirm it is the browser rather than the application:

```sh
chromium --headless=new --user-data-dir=$(mktemp -d) \
  --dump-dom 'data:text/html,<b>ok</b>'      # renders
chromium --headless=new --user-data-dir=$(mktemp -d) \
  --dump-dom http://127.0.0.1:9975/backend.json   # empty: the fault
```

If the `data:` URL renders and the `http:` one does not, it is the browser.

These suites are local only. There is no pipeline that runs them on every push, on
purpose: a repository that ships a browser-driving workflow to every self-hoster is a
repository that asks each of them to keep a Chromium around for a test they did not ask
for. Run them yourself, or wire up your own workflow that does the same thing.

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

Two habits worth keeping.

**Assert on the DOM, not on a screenshot.** `page.eval` returning a measurement is
evidence; a picture is a hint.

**Clear storage before signing in.** An existing session makes `/register` redirect away,
which reads exactly like the form failing to render.