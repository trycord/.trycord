# V2 audit and status

Work done on 2026-09-29. Verified with `npm test` in `trycord-server`:
**20 suites, 660 assertions, all passing.**

```
cd trycord-server
npm install
npm test
```

The runner boots a throwaway server and database, runs every suite, and removes
both afterwards. It never touches a real instance. `npm run check` is the faster
schema-only smoke test.

## What was fixed

### Data loss

`uploads.js` resolved the upload directory two levels up from `src/services/`,
which is `/app/trycord-server/uploads` in the image, while the Dockerfile and
compose file declared the volume at `/app/uploads`. Every avatar and attachment
on a Docker deploy was written outside the volume and destroyed on image
upgrade, while both the compose file and the docs promised the opposite. The
directory is now `UPLOAD_DIR`, set to `/app/uploads` in the image, so existing
volume mounts keep working.

### Supply chain

`trycord-desktop/updater.js` fetched release binaries from
`github.com/LanxTheShowmaker`, not `github.com/trycord`, and
`test-updater-safety.js` asserted that wrong owner, so the mismatch passed CI.
Anyone who installed the Windows build was one update away from pulling binaries
from an account this project does not control. Fixed in the updater, the test,
and the `repository`/`bugs`/`homepage` fields of both package manifests.

### Fresh MySQL could not start

`channel_permission_overrides` declared a foreign key to `channels` nine
statements before `channels` was created. InnoDB resolves keys at `CREATE` time,
so a new MySQL database failed with errno 150. Now declared after `channels`.

### `/api/search` was a 500 on MySQL

The `LIKE` clause used `ESCAPE '\'`; MySQL and MariaDB read the backslash as an
escape, terminating the string literal. The escaper now lives in `util.js` and
uses `ESCAPE '!'` everywhere, so `search.js` and `users.js` share one
implementation instead of two that disagreed. A rate limit was added, since
`LIKE '%q%'` is a full scan.

### Privilege escalation

`DELETE /roles/:roleId/assign/:userId` checked that the actor outranked the
*role* but never the *target*, so a Moderator could strip roles from an Admin.
It now requires membership and a target below the actor's rank. Self-removal
stays allowed, since it can only lower privilege.

### WebSocket

Three separate defects. The socket insert omitted `seq`, which is the column the
history cursor pages on, so anything posted over the socket was invisible to
later reads. `bufferedAmount` was never checked, so one non-reading socket grew
its buffer without bound and stalled delivery for its whole room. And sockets are
authorized only at upgrade, so a session revoked by password change,
`revoke-all`, `revoke-others` or logout stayed fully interactive. All three are
fixed; there is now one `deliver` helper and an 8 MB ceiling.

### Other

- Anonymous appeals were recorded against a user that might not exist, behind a
  comment describing a check the code did not perform.
- `/servers/by-code/:code` returned name, description and member count for
  private communities to any authenticated caller, unthrottled, against a
  32-bit code. Both it and `join/:code` are now rate limited.
- bcrypt cost 10, hard-coded in three places, below the current floor. Now
  `BCRYNC_COST`, default 12.
- `scripts/migrate.js` kept its own table list, which had fallen behind the
  schema by eight tables: bans, pins, reactions, mutes, announcements, both
  permission-override tables and community media were silently dropped. It now
  reads the list from the schema, runs in one transaction, and rolls back rather
  than leaving a half-populated target.

## What was added

### Testing

The E2E scripts could not be run as a suite. Seven of them hardcoded
`http://localhost:9971` and ignored `TRYCORD_TEST_URL`; one hardcoded the
WebSocket URL as well. All scripts share one in-process rate-limit bucket per
client address, so the 20/min registration limit was reached partway through any
run. Two suites also failed on a database that already held test users.

`scripts/test-all.js` now boots a throwaway server and database per run, runs
`test-dm-reliability` first against a server without `RATE_LIMIT_MAX` because it
is the one suite that asserts a limit throttles, and the rest against a second
server with the ceiling lifted. `test-trustsafety` creates and promotes its own
admin instead of requiring a hand-made one. CI runs `npm test`, and the client
and desktop jobs moved from Node 20 to 22 to match `engines`.

New suites: `test-migration`, `test-storage`, `test-storage-migrate`,
`test-client-dom`, `test-gdpr-deletion`, `test-page-editor`.

### Storage

`src/services/storage/` is a driver interface with two drivers. `local` is the
default and needs nothing; `s3` works with any S3-compatible endpoint, with
SigV4 implemented against `node:crypto` so a self-hosted instance does not
install an AWS SDK. A bad `STORAGE_DRIVER` or a missing S3 credential stops the
server at boot instead of failing on someone's first upload.

Object keys encode the owner: `user/<userId>/<kind>/<id>`,
`community/<serverId>/<kind>/<id>`, `channel/<channelId>/attachment/<id>`. This
replaces the `pf-` and `sv-` filename prefixes, which did class isolation by
string match.

`scripts/storage-migrate.js` copies objects between drivers with `--dry-run`,
`--verify` and retry. It never modifies or deletes the source, and refuses to
copy a tree onto itself.

**Verification status:** the local driver and the migration tool are covered
end to end. The SigV4 signature is covered for determinism and for sensitivity
to region, object and expiry, but has **not** been run against a live endpoint.
Run `node scripts/storage-migrate.js --dry-run` against the target bucket before
switching a live instance over.

### GDPR account deletion

`Settings → Account → Delete my account` opens a request; an administrator
reviews it under `Admin → GDPR requests`, where it is always labelled
`REQUESTED BY GDPR`. The type is written by the server when the user asks, so an
administrator cannot create one or relabel one.

The account is **anonymised, not hard-deleted**: identity columns are cleared
and the row survives, because `audit_logs`, `moderation_actions` and
`appeals` reference the actor and `ON DELETE CASCADE` would destroy evidence of
what was done. Messages stay, attributed to a `deleted-…` account. An owned
community is transferred to its longest-standing member. Owned objects are
deleted through the storage service, so it works the same on disk and in a
bucket. Every transition is audited.

### Static page editor

`Admin → Pages` edits the six approved pages. The body is **structured blocks**,
not HTML: heading, paragraph, standfirst, list, callout, link, divider. There is
no HTML box and the server escapes every value, so an administrator cannot
inject a script into a legal page. `javascript:` and `data:` link targets are
rejected on save.

Drafts, preview, publish, unpublish, revision history and restore are all
supported. Restoring a revision creates a new one. Publishing a legal page
requires a typed confirmation. Until a page is published it is served from the
file in `public/`, so an instance that never uses the editor is unaffected.

### Accessibility

- `#view-root` was `aria-live="polite"`, so every route change and every one of
  the 76 chrome repaints re-read the whole page. Removed; a dedicated announcer
  region is set from `renderContextHeader`, the one place every screen already
  passes its title.
- 60 labels had no `for`, so they announced as unlabelled. The DOM factory now
  associates a label with the next control in its parent, and a test checks it.
- Six `for=` attributes pointed at ids that did not exist.
- Toasts were announced twice, by a live region and by `role="status"`.
- The Light theme's muted text was 3.77:1 on the page background and 2.78:1 on
  a card. Fixing it needed a change to the surfaces, not just the text: the
  elevated surface was too dark to carry three text tiers at AA. **Orthocord
  and Midnight also failed**, and were fixed. All six themes now pass, and
  `test-client-dom` checks every tier against every surface so it cannot regress.
- The mobile stylesheet raised nothing to a 44 px hit area and let three layouts
  overflow at 320–430 px. Fixed, with a guard.
- The skip link pointed at a landmark that is `display:none` on mobile. There is
  now one per shell, and CSS picks the live one.

### Public site

- `/instances-terms` was linked from all 13 footers and 404'd. So did
  `/trust-and-safety`, which was also linked from nowhere. Both now serve, and
  every page links all four legal pages.
- 20 occurrences of a malformed `</spanhref="/"` across 10 pages, a duplicated
  `</main>`, and a duplicated footer link.
- `site.css` had an appended block that overrode the entire palette, leaving the
  original dead. Folded into one palette. All 15 hex values are now tokens, and
  `--accent-2` was removed as unused.
- The status page conveyed state by text only; `--ok` and `--err` were dead
  tokens. It now sets a state, so it is announced and coloured.
- `site.js` never marked a nav item current on the homepage, and never matched
  when a page was served as a file.

The legal pages remain **templates**, deliberately: the parts describing the
software are accurate, and the parts that depend on the operator are marked
`OPERATOR` and highlighted on the page. There are no bracket placeholders left
anywhere in `public/`, and `test-client-dom` fails if one reappears.

## Repo and branches

| Branch | Verdict |
|---|---|
| `main` | authoritative |
| `cloudflare-branch` | **keep.** Holds the only unmerged work that matters: `wrangler.jsonc`, `cloudflare/worker.js`, a non-mutating `build-pages.sh`, the `home.html` → `welcome.html` rename, the missing `/instances-terms` and `/trust-and-safety` routes, and corrected public HTML. Its 12 unmerged commits are not superseded by main. |
| `client` | stale, divergent fork. Its client tree predates the per-page split on main (`pages-workspace.js` where main has 8 files). 40 unmerged commits, all superseded. Safe to delete after confirming nothing private is on it. |
| `server` | stale subset of main, 27 unmerged commits, every hunk a removal. Safe to delete. |

`.gitignore` had a bare `*.md` rule, which silently untracked
`docs/selfhosting.md` — the only operator deployment guide. Removed. The two
~109 MB release binaries were untracked: they were most of a 656 MB `.git`, and
`release-desktop.yml` already publishes them to GitHub Releases. `trycordlogo.png`
(980 KB, referenced by nothing) and a third copy of the login background were
deleted. No secret was ever committed; all of history was checked.

## Still open

- **Routing V2.** Every client URL carries a raw server UUID. Public slugs
  separate from internal ids are not implemented.
- **Client design system.** Four menu/overlay implementations, two modals (one
  hand-rolled with no focus trap), four avatar renderers, two user-action lists
  that have already drifted apart, and ~230 inline `btn` literals with no
  factory. `.btn` is one system and works, so this is consolidation, not a
  rewrite.
- **Client dead code.** About 30 unused symbols, including the entire mobile
  drawer in `presentation.js` (its target element ids do not exist in
  `index.html`), `showPopover` (148 lines, zero callers) and `mentionify`.
  About 13% of CSS rules are dead.
- **Message links are broken.** `msgLink()` produces a URL the router cannot
  parse, so "Copy message link" yields a link that does not load.
- **Reporting has a false success path.** `openReportDialog` is called with the
  wrong argument shape in two places, so the API call is skipped and the user
  is told the report was filed.
- **DM messages cannot be edited or deleted** from the UI: the callbacks are
  passed inside the message object rather than through `opts`.
- **No storage quota.** One member with `SEND_MESSAGES` can write 8 MB × 30/min
  to the disk.
- **`users.email` uniqueness** is only guaranteed on a freshly created MySQL
  table; a database created by an older build can lack the constraint.
- **`servers` has no indexes** and discovery runs a full scan with two
  correlated counts per row.
- **A timed-out member** can still edit and delete their own messages, and remove
  their own reactions, because those three routes do not check the timeout.
- **No 2FA and no login lockout.** Login is rate limited per IP but has no
  per-account counter.
- **`broadcastServer` runs one membership query per online member per event**,
  which is the main realtime scalability hazard.
- **Asset duplication.** Three byte-identical copies each of the logo PNG, the
  ICO and the login background across `public/assets`, `trycord-client/assets`
  and `trycord-desktop/build` — about 4 MB of redundancy.
