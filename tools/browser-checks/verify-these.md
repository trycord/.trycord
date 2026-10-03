# Verify these

Fixes made while this machine's browser was unusable, so they were correct by
construction and static checks only. CI now runs the sidebar ones on every push
and they are green; the rest are still unverified in a browser.

**Already verified in CI** (36/36 on `2418ef0`, job `Browser checks`):

- **Sidebar rows navigate** — every row on `/friends` and `/notifications`
  exists, throws nothing, stays on this origin, and resolves to a real route.
- **`/home` describes itself as Home** — not Direct messages, lists all three
  places, and the sidebar title matches the page title.
- **The root path behaves like `/home`.**

Still worth a human look, because no check covers them yet.

## Verify these three

### 1. `icon()` no longer drops the `ui-icon` class — `2f44c90`

An icon that passed a `class` had the base class **replaced** rather than
added, so it lost the only rule giving it a size and grew to fill its
container. The community settings disclosure caret rendered **712px wide**.

Where to look: `trycord-client/js/shell.js` → **Settings**, desktop width. The
caret should be a small rotated chevron at the right of the section header.

Also confirm nothing else grew: any icon that should be ~15–21px.

### 2. Sidebar rows navigate — `9cc30e4` — **verified in CI**

Rows were calling `navigate('/' + path)` on a path that already began with a
slash, producing `//friends`, which resolves as a protocol-relative URL and is
refused by `pushState` with a `SecurityError`. **The buttons did nothing.**

Where to look: `/friends` → click *All friends* and *Add friend*.
`/notifications` → *All notifications*. Each should navigate, and the console
should be clean.

### 3. `/home` has a sidebar that describes Home — `9cc30e4` — **verified in CI**

`/home` fell through to the direct-messages context, so the sidebar next to a
full activity feed read **"Direct messages"** and **"No conversations yet"**.

Where to look: `/home`. The sidebar should be titled **Home** and list
Direct messages, Friends, Notifications, Discover communities, Create a
community.

### 4. Activity feed timestamps sit with their text — `59f61b4`

A row is a flex line, so the timestamp was pushed to the far edge — at 1440 an
author name sat near x=430 and "just now" at x=1300.

Where to look: `/home` at 1440 and again at 2560. The gap between the message
text and its timestamp should now be modest, and the feed centred.

### 5. The attachments rebuild survives an interrupted boot — `5cb56e1`

`attachments_v2` was created without `IF NOT EXISTS` and without dropping a
leftover, so a boot interrupted between the create and the rename failed
permanently on every boot afterwards.

Already verified three ways: three consecutive boots against one database file,
49 tables each time, no scratch table left. Nothing further needed unless you
want to force the interrupted case by killing the server mid-migration.

## Remaining here

Two suites written earlier were lost with `/tmp` and are worth restoring
against `cdp.mjs`: **origin-boot** (the backend origin serving the whole
client while the API stays an API) and **theme** (the Custom Theme Studio's
guided controls, CSS validation, persistence and reset). Both caught real
faults when they last ran, and neither has run since.

## If you get a browser back

```
cd trycord-server
DB_CLIENT=sqlite DB_FILE=/tmp/tc-test.db PORT=9975 HOST=127.0.0.1 \
UPLOAD_DIR=/tmp/tc-uploads MAIL_MODE=log SECRET=<32+ random hex> \
  node src/server.js &

cd ../tools/browser-checks && node t-sidebar.mjs
```

`t-sidebar.mjs` covers items 2 and 3 above and fails loudly on either. The
uncommitted-draft icon check in this directory covers item 1.

## Also worth a look while you are in there

Two findings were reported, then found to be wrong. Both are recorded because
the wrong conclusion is more useful than none:

- The "thin roles page" is not thin. It renders the full editor; the screenshot
  was of a community with one seeded `@everyone` role.
- The avatar palette is deliberately varied and theme-neutral. It was **not**
  narrowed to the ember family; that change was reverted.