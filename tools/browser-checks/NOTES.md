# Where Trycord stands

Written at the end of this session so the next one starts from facts rather
than from the conversation.

## Repository

Two repos, both clean and pushed:

- `trycord/.trycord` — the product. Server, client, desktop, docs, `public/`,
  and now `tools/browser-checks/`.
- `trycord/.trycord-cloudflare` — the Cloudflare deployment. `dist/` verified
  53/53 at `.trycord@cb74aa3`; nothing has changed client-side since.

`cloudflare-branch` was deleted from the product repo. It was a stale fork:
every file on it was an *older* version of what the CF repo already had
(`worker.js` 68 lines vs 103, `verify-dist.js` 85 vs 273, `build-pages.sh` 42
vs 17), and merging it would have reintroduced the `status !== 404` fallback
bug and the `/` → `/index.html` redirect loop.

Commit authorship was rewritten so nothing is attributed to `claude
<noreply@anthropic.com>` or `opencode <opencode@local>`. Verified by mirror
clone: every object, every ref, zero occurrences. GitHub's cached contributor
graph takes its own time to catch up.

## Tests

The browser suites cannot run right now. See the blocker below.

Still runnable:

```sh
cd trycord-server
npm run check          # 49 tables, 74 indexes, 18 client segments
npm run check:client   # 50/50 modules parse, all relative imports resolve
```

CF: `node build.js <full-sha>` then `node verify-dist.js` (53/53). `build.js`
needs a full SHA or `main`; a short SHA fails on a cold clone. It caches in
`.build/src`, so `rm -rf .build/src` before rebuilding after a force-push.

### The browser blocker

**Headless Chromium on this machine fetches no `http://` URL at all.**

- `--dump-dom` on a `data:` URL renders correctly.
- `--dump-dom` on `http://127.0.0.1:9975/` returns empty.
- So does a two-line node server on another port, and `http://localhost/`.
- Chromium 152.0.7977.82 on Debian trixie.
- `Target.createTarget` reports success, the target list shows the right URL,
  and the execution context still reports `about:blank`.

No proxy is configured anywhere (env, gsettings, Chromium prefs). The network
layer confirms requests going out (`NetworkDelegate::NotifyBeforeURLRequest`),
so the request leaves and the response never lands.

This is an environment fault, not a product one. It blocked verifying the two
sidebar fixes, which are therefore statically checked only: no double-slash
`navigate` remains, the new `homeContext` is wired through `sidebarContext` and
`renderPlaceNavigation`, and it uses only names `shell.js` already imports.

Worth trying when convenient: a fresh Chromium build, or `--headless=old` with
an explicit `--remote-debugging-port` and `--user-data-dir`.

## Server

```sh
DB_CLIENT=sqlite DB_FILE=/tmp/tc-test.db PORT=9975 HOST=127.0.0.1 \
UPLOAD_DIR=/tmp/tc-uploads MAIL_MODE=log SECRET=testsecret0123456789abcdef \
  node src/server.js &
```

`MAIL_MODE=log` matters: without it the local `.env` turns on SMTP email
verification and every account stays unverified.

Never write to the real `.env`. It is untracked, 7,856 bytes, and predates this
session.

## Fixed this session

1. **Self-hosting** — a self-hoster's client was authenticating against
   `api.trycord.dev` while sitting on their own API, because `backend.json`
   outranks the serving origin. The server now repoints it.
2. **Icon sizing** — `icon()` replaced the `ui-icon` base class instead of
   adding to it, so the settings disclosure caret lost its only size rule and
   rendered 712px wide.
3. **Schema** — the `attachments_v2` rebuild create was unguarded, so a boot
   interrupted mid-rebuild failed permanently on the next one.
4. **Sidebar rows did nothing** — `navigate('/' + path)` on an already-absolute
   path produced `//friends`, which `pushState` rejects with a SecurityError.
5. **`/home` described itself as Direct messages** while showing a
   cross-community feed.

## Open findings

1. `/home`'s activity rows leave ~260px of dead space before the timestamp at
   1440, because the row stretches the full region.
2. The roles page is thin — a count, a paragraph, and a button to the
   hierarchy, in a 900px viewport.
3. Duplicate channel names are indistinguishable in the sidebar. The API
   allows them deliberately (`slugs.js`: a collision must never block
   someone). The fix belongs in the UI.
4. No theme documentation. `docs/` has `selfhosting.md` and `v2-audit.md`.
5. `.env` declares `DB_CLIENT` twice, `sqlite` then `mysql`. Whichever loader
   reads last wins.
6. Conversation measure is 1600px / ~208 characters at 3440. A previous
   session chose this deliberately, so it is a judgement call, not a bug.

## Do not "fix" these

**Avatar tints.** An earlier note here called the generated avatar colours
"off-palette" and proposed narrowing them to the ember family. That was wrong
and the change was reverted. `AVATAR_COLORS` is deliberately theme-neutral and
deliberately varied: two thirds of it is cool hues, and it matches no theme's
accent. That is the design. A varied set is how two people are told apart at a
glance, and tying it to the accent would make every avatar look like the
accent and destroy that distinction.

It also would not have been the community's to decide. An operator who has
chosen their own accent through the Custom Theme Studio does not get orange
avatars imposed on them by shared code.

**Ember is one theme, not the product's identity.** The identity is that a
community controls its own space, including its own look. Hardening shared
surfaces toward the ember palette would quietly remove a control the product
exists to offer.

The correct response to "an avatar looks loud next to ember" is a question
about the default theme's harmony — not a global palette change.

## The principle, applied

When choosing between two implementations, ask whether it still makes sense
for someone running their own Trycord instance. `trycord.dev` is one instance,
not the definition of the ecosystem. Instance-specific values must stay
instance-specific — accents, instance name, legal documents, branding,
moderation policy, feature availability.

## Queued, in the order asked for

1. Finish the UI work above.
2. De-AI pass over the entire codebase (§8, §14, §29).
3. Repository coherence pass: one home per feature, no migration debris.
4. Desktop packaging: `.exe`, `.AppImage`, and the rest.