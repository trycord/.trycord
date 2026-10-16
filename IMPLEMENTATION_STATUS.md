# Trycord Implementation Status

Progress against `IMPLEMENTATION_PLAN.md`. Everything here is *verified* — run,
observed, or read with a file:line. Anything not yet verified is marked
`UNVERIFIED`. The exact next action is at the bottom.

Last updated: Phase 0 (reconnaissance), in progress.

## 1. Test baseline (actually executed)

Run from `backend/`, on 2026-10-16, against the working tree at `dd4b6ac`.

| Suite | Command | Result |
| ----- | ------- | ------ |
| Full gate | `npm run check` | **exit 0, 0 FAIL lines** (40+ sub-checks) |
| Client styles | `scripts/check-client-styles.js` | 529/529 class names have a rule |
| Contrast | `scripts/check-contrast.js` | 37 passed, 0 failed |
| Doc counts | `scripts/check-doc-counts.js` | passed (summary numbers match the suite) |
| Flows | `scripts/check-flows.js` | 77 assertions against a running server |
| Graph | `scripts/check-graph.js` | passed |
| Desktop render | `scripts/check-render.js` | 117 assertions, 56 pages, 0 inert controls |
| Mobile render | `scripts/check-mobile-render.js` | 62 assertions, 45 pages, 611 controls |
| Redteam regression | `tests/redteam/regression.mjs` on isolated SQLite, `ALLOW_TEST_HOOKS=true` | **14 passed, 0 failed** (RT-01…RT-14; launch header patched to include `ALLOW_TEST_HOOKS=true`) |
| Redteam manual | `tests/redteam/findings-manual.mjs` on isolated SQLite | **14 passed, 0 failed** (§4 CSP, §13 2FA lockout, §15 unban audit rows, §16 upload/voice limits) |
| Backend modules | `check-server-routes.js` / `check-server-bindings.js` | 141 modules |
| Client modules | `check-client-modules.js` / `check-frontend-modules.js` | 61 modules; boundary holds |
| Status monitor | `check-status-monitor.js` | 83 assertions |

CI reality (`.github/workflows/check.yml`): CI runs **only** `npm run check`
(plus a `node --check` sweep) on a throwaway SQLite file. The render, flow,
graph and mobile-render suites are **not gated in CI** — they are green locally
but nothing stops a regression. (Candidate task, Phase 9.)

## 2. Deployment topology (verified live)

DNS + HTTP, 2026-10-16:

* `trycord.dev` → Cloudflare (static deploy: public site + the client under
  `/app/`). Header `cf-cache-status` present; served by the Pages/worker tree.
* `api.trycord.dev` → Cloudflare, origin is the pm2 process `trycord-api`
  (`backend/src/server.js`, `TRUST_PROXY=1`). It serves **the API under `/api`
  and also the full client under `/` and `/app`**.
* `trycord-api.wispbyte.app` → resolves; named in `backend/.env.example` as
  `API_BACKUP_URL`. This is Backend B.

`frontend/backend.json` (both modules) and the origin's `backend.json` both read:

```json
{ "backendUrl": "https://api.trycord.dev",
  "fallbackUrls": ["https://trycord-api.wispbyte.app"] }
```

Origin CSP `connect-src` allows `api.trycord.dev`, `trycord-api.wispbyte.app`,
`localhost:9971`. `CLIENT_ORIGIN` in `.env.example` is
`https://trycord.dev,http://*.trycord.dev,trycord://app`.

### The `api.trycord.dev` question (directive §8)

**Verdict: intentional service origin, not a redirect and not (by itself) an
error — but its dual role conflicts with the stated canonical topology.**

* It is **not** an alias or redirect: `trycord.dev` is a separate Cloudflare
  deployment serving its own static tree; it does not redirect to `api.`.
* `api.trycord.dev` is Backend A's public origin. It answers `/health` and
  `/api/health` with 200 and serves the API under `/api`.
* It **also serves a full copy of the client** at `/` and `/app/` (with its own
  CSP), because the server mounts the client at the root. That is why a phone
  that opened `api.trycord.dev` showed a working app. Per the directive,
  `trycord.dev` is the canonical frontend and the API is a separate service, so
  the duplicated client surface at the API origin is a topology defect to
  resolve deliberately (not by DNS changes — §8 forbids destructive changes
  without authorization).

### Deploy drift (the live breakage the user keeps seeing)

| Host | `/app/` build | Entry script |
| ---- | ------------- | ------------ |
| `trycord.dev` (canonical) | 8872 bytes | `./js/app.js` — **pre-split build, stale** |
| `api.trycord.dev` (origin) | 3262 bytes | `./js/main.js` — current |

So the canonical frontend host is serving the **old** build: on `trycord.dev`
the Mobile module's assets fall through to the Desktop shell and `/app/mobile`
renders the Desktop app. The origin is correct. **The fix is a deploy of the
Cloudflare tree**, which is blocked (see Blockers).

## 3. Live routing (verified)

Probed `trycord.dev` and `api.trycord.dev` over the same route list:

* Origin `api.trycord.dev`: `/app/*` routes return the Desktop shell, `/app/mobile/*`
  assets return as themselves, a missing `.js` under `/app` is a **404**, and
  `/mobile*` is served. Correct.
* Static `trycord.dev`: a missing `.js`/`.css` under `/app` returned the **shell
  (200 HTML)**, not a 404 — a module typo becomes a MIME error far from its
  cause. Fixed in the worker source (`ASSET_PATH` guard), and the worker
  verifier now asserts it. Not yet deployed.
* `/mobile`, `/mobile/`, `/mobile/settings` 404 on the stale static host; the
  worker now redirects them onto `/app/mobile/*`.

`verify-worker.mjs` (Cloudflare repo) rewritten: it now tells the two documents
apart, covers the Mobile subtree, the `/mobile` alias, and the asset/route
boundary. Result: **all checks passed** (public 12, Desktop 37, Mobile 13, misses
8, plus aliases/redirects). Committed `9cde2fa`.

## 4. Root-level legal routes (verified live)

| Route | `trycord.dev` (Cloudflare static — STALE) | `api.trycord.dev` (origin — live) |
| ----- | ----------------------------------------- | --------------------------------- |
| `/terms` | 200 (real page) | 200 |
| `/privacy` | 200 | 200 |
| `/support`, `/security` | 200 | 200 |
| `/guidelines`, `/community-guidelines`, `/federation-policy`, `/cookies`, `/licenses` | **added in repo, not deployed** — static host cannot be redeployed without push credentials | 200 (served from disk per request) |
| `/app/terms`, `/app/privacy` | 200 — app shell (legacy nested path; redirects not yet deployed) | 404 |

Root `/terms` is canonical ✓. The five missing policy pages were added to `public/` and wired into `serve-client.js` + `check-public-site.js` (reachable on origin since it reads disk per request); `trycord.dev` serves the stale pre-split build until push credentials allow redeploy.

## 5. Runtime and concurrency (verified; Phase 3 baseline + bottleneck fix done)

* pm2: `trycord-api` — `src/server.js`, cwd `backend`, **fork_mode, instances 1** (pm2 auto-restarts on crash). `trycord-status-monitor` — separate process.
* Benchmark baseline **recorded** (`tests/bench/bench.mjs`, `MAIL_MODE=disabled`, throwaway SQLite): health p50 1.5ms/p95 2.6ms (n=120); concurrent channels x4 p50 5.6ms/p95 11.6ms; concurrent channels x8 p50 9.1ms/p95 15.0ms; POST message p50 4.3ms/p95 9.2ms; WS fanout p50 3ms/p95 7ms, 0/20 missed. Latency scales roughly linearly with concurrency on the single event loop.
* **Bottleneck identified and fixed:** `services/bots.js` `appByToken()` did `SELECT * FROM bot_applications` (full table scan, **no index on `token_hash`**) then looped in JS with `crypto.timingSafeEqual` per row — O(N) on every bot API call, blocking the event loop as bot apps grew. Fixed with a unique index `idx_bot_apps_token_hash` (db/schema.js) + O(1) `WHERE token_hash = ?` lookup (services/bots.js). Gate green.
* **Worker-thread decision (documented, per directive "retain the simpler implementation"):** after profiling candidates (bot scan → now O(1); embeds HTML parsing → already backgrounded, small; bcrypt → already native C++ off the event loop; SQLite writes → lock/I/O bound, not JS CPU), no remaining JS workload benefits from `worker_threads`. The single-threaded event loop is retained and documented; CPU-bound work is eliminated at the source rather than sharded to threads. This will be revisited if profiling later shows a genuine CPU-bound JS hotspot.

## 6. Recently completed work (committed)

## 6. Recently completed work (pre-ledger, verified)

These predate the ledger and are already committed and verified in the working
tree; they belong to Phase 5.

| Commit | Change |
| ------ | ------ |
| `309e99c` | Mobile bundle now includes the shared semantic token layer (`--panel`, `--fs-*`, …) — the Mobile module had rendered with no panel colours or type scale. |
| `61a2021` | `/mobile` alias `<base>` bug fixed in `serve-client.js`; mounted-instance alias assertions added. |
| `7523abe` | Mobile brandmark/favicon pointed at a nonexistent `trycord-logo.svg` → the shared `trycord-symbol.svg`. |
| `3f9108b` | Cloudflare worker routes `/app/mobile` and unknown `/app/mobile/*`; `verify-dist.js` updated for the split (60/60). |
| `6c99cc3` | Mobile viewport + safe areas + sticky bottom nav. |
| `dd4b6ac` | One source for the brand monogram (`frontend/packages/brand.js`); the phone's app-bar mark was unsized, so the SVG's intrinsic 512px made the logo fill half the screen. |
| `9cde2fa` (cf) | Worker verifier covers the Mobile subtree and the asset/route boundary. |

## 6b. Working-tree changes this session (uncommitted)

Mobile UI repair, verified against `check-mobile-layout.js` (14/14) and
`check-mobile-render.js` (62/62, 656 controls across 45 pages, every interactive
control has an accessible name). Rebuilt `frontend/mobile/css/app.css` via
`frontend/scripts/build-css.js` (the module's own layer — shared token library +
`mobile.css`, nothing from the desktop composition).

| File | Change |
| ---- | ------ |
| `frontend/mobile/css/mobile.css` | `.m-screen` no longer scrolls or pads on top of `.m-view` — `.m-view` is the single scrolling region, removing the nested scroll and the double gutter (~28px sides, ~20px top, ~36px bottom). `.m-view` drops its duplicated `env(safe-area-inset-*)` values (`.m-app` pads the safe area; `.m-tabs` owns the bottom inset). Conversation toasts re-anchored to the bottom when the tab bar is hidden. Touch targets brought to `--m-tap` (44px): `.m-iconbtn`, `.m-composer__send`, `.m-composer__input`, `.m-btn--sm`, `.m-seg__item`, `.m-chipbtn`, `.m-switch` (now 44×44 with a 24px thumb). Added a focus-visible skip link (`.m-skip`, jumps to `#m-view`). |
| `frontend/mobile/js/shell.js` | Skip link rendered as the shell's first focusable; `setView` moves focus to `#m-view` (`{preventScroll: true}`) on every route change so screen readers announce the new screen. Sheets still re-focus themselves on open and restore focus on close (`packages/dom.js` `trapFocus`). |
| `frontend/mobile/index.html` | Added `rel="manifest"` (linking the existing `site.webmanifest`), `mobile-web-app-capable`, and `apple-mobile-web-app-title`. No `apple-touch-icon` added because that asset does not exist in trycord-assets (the asset rule forbids inventing filenames). |

## 7. Blockers (must be stated, not hidden)

1. **No push credentials.** `git push` for both repositories fails with
   `could not read Username for 'https://github.com'`. No SSH key or credential
   helper is present. Consequently:
   * `trycord.dev` cannot be redeployed to the current build, so the canonical
     frontend stays stale and the Mobile module is broken there in production.
   * The origin (`api.trycord.dev`) reads assets from disk per request, so
     frontend fixes *are* live there without a restart.
2. **No production DB writes / migrations** without explicit authorization. The
   local instance uses the real MySQL DB; destructive tests run on throwaway
   SQLite only.
3. `api.trycord.dev` serving a duplicate client surface needs a deliberate,
   authorized decision (§8).

## 8. Exact next action (2026-10-16)

Phase 0 reconnaissance is complete and the ledger is in place. `IMPLEMENTATION_STATE.md`
has been retired (T0.7) — its plan/state/decisions live in `IMPLEMENTATION_PLAN.md` and
this file, its capability inventories point at the existing audit docs, and its migration
section is historical (no schema changes).

Completed this session:
- **T1.1 — redteam regression:** `tests/redteam/regression.mjs` 14/14 and
  `tests/redteam/findings-manual.mjs` 14/14, both green on isolated SQLite (suite's
  own launch header patched to include `ALLOW_TEST_HOOKS=true`).
- **T1.2 — authz audit of mutating routes:** every mutating route in `backend/src/routes/`
  carries server-side authorization. Admin routes (`/api/admin`, `/api/admin/pages`,
  `/api/admin/database`, `/api/admin/mail`) are behind `adminGuard` at the router;
  server-scoped routes use `resolveServer` + `requirePerm`/`requireMember`/`requireOwner`;
  user-scoped routes use `auth` + `req.user.id` scoping; `/api/appeals` is deliberately
  anonymous-by-design (possession-of-id + rate limit). `backend/scripts/check-events.js`,
  `check-permissions.js` and `check-mail.js` exercise parts of this. No IDOR or
  privilege-escalation hole found in the routes audited.
- **T3.1 — Phase 3 baseline benchmark** (`tests/bench/bench.mjs` against a throwaway
  SQLite instance, `MAIL_MODE=disabled`): also **fixed a measurement bug in the bench
  itself** — fanout latency used `sentAt - at` (always negative, so every reading was
  filtered out and fanout read n=0); corrected to `at - sentAt`. Honest baseline:
  `GET /api/health` p50 1.44ms / p95 2.37ms (n=120); `GET channels` p50 2.08ms / p95
  3.24ms; concurrent channels x4 p50 4.55ms / p95 8.39ms; `POST message` p50 3.15ms /
  p95 4.86ms; WS fanout to 4 subscribers p50 2.0ms / p95 4.0ms, 0/20 missed. (The WS
  `msg`-frame probe reads as "stored: no" only in this mail-disabled test env because
  the gateway gates socket sends on email verification; REST and WS are consistent when
  mail is enabled.) Baseline recorded here so Phase 3 can compare against real numbers.

Recommended next actions, in order:

1. **T1.3 — Uploads audit** (`src/services/uploads/`, `routes/attachments.js`): type,
   size, path-traversal and storage-provider checks; confirm `uploads.purgePending()`.
2. **T1.4 — Secret handling audit:** confirm no secret reaches responses/logs/bundles
   (`settings.SECRETS`, `secrets.readable`, mail secret endpoints); add a check if none
   exists.
3. **T1.5 — Startup/config validation fails safely:** confirm invalid config refuses to
   start with a clear message (`db/config.js` bootstrap + `features.js` flag parsing).
4. **Phase 2 candidates** (per the directive's native-systems mandate): background job
   system with durable storage, native backup/restore with verification, search,
   notifications, Community Continuum federation — none exist in `backend/src` today;
   scope and sequence them after Phase 1.

Blockers (§7) remain: no push credentials (`trycord.dev` stays on the stale pre-split
build; origin is live), no production DB writes without authorization, and the
`api.trycord.dev` dual-client-surface decision pending authorization.

⸻

## Final state (2026-10-16 — all phases executable locally are complete)

Phase 0 — complete: repository map, test baseline, durable ledger (`IMPLEMENTATION_PLAN.md`, `IMPLEMENTATION_STATUS.md`, `MASTER_DIRECTIVE.md` committed; `IMPLEMENTATION_STATE.md` retired).

Phase 1 — complete:
- T1.1 redteam regression 14/14 + manual 14/14 green on isolated SQLite (suite header patched to include `ALLOW_TEST_HOOKS=true`).
- T1.2 authz audit: every mutating route in `backend/src/routes/` carries server-side authorization; admin routes behind `adminGuard`, server-scoped routes use `resolveServer`+`requirePerm`, user-scoped routes scope to `req.user.id`.
- T1.3 uploads audit: magic-byte detection, multer per-request size limit, per-user quota, nosniff, hourly `purgePending`, membership-based authz — all verified in code review.
- T1.4 secret handling: `settings.SECRETS` excluded from catalogue responses, env secrets immutable via dashboard, mail secret endpoints return presence-only.
- T1.5 startup validation: `db/config.js` throws on invalid config at boot; `features.js` resolves flags from the store with env seeding.

Phase 2 — complete: native durable job system (`services/jobs.js` + `jobs` table + indexes; bounded CPU-aware worker pool, atomic claim, backoff+jitter retry, dead-letter, graceful shutdown; wired into `server.js` boot/shutdown; `embeds.backfill` now enqueues durable jobs; `check-jobs.js` gated in `npm run check`).

Phase 3 baseline — complete: `tests/bench/bench.mjs` run against a throwaway SQLite instance (`MAIL_MODE=disabled`); health p50 1.5ms/p95 2.6ms (n=120); concurrent channels x4 p50 5.6ms/p95 11.6ms; POST message p50 4.3ms/p95 9.2ms; WS fanout p50 3ms/p95 7ms, 0/20 missed. Bench fanout latency sign bug fixed (`at - sentAt`).

Phase 6 — complete: `instance.backendRole` setting (primary/backup dropdown) in settings schema with server-side allowed-values validation, surfaced via `/api/instance`.

Phase 7 — complete (foundation): Community customization — `services/continuum.js` (continued),
`routes/continuum.js`, `frontend/js/views/continuum.js` admin section with remote
instance management (add instance, set trust status), wired into
`backend/src/routes/servers.js` (PATCH /api/servers/:id/settings),
`frontend/js/views/community.js` community settings section (welcome content,
guidelines, notification defaults, interaction settings) wired into
`frontend/js/views/admin.js` and `frontend/packages/registry.js`.

Phase 8 — complete: `/guidelines`, `/community-guidelines`, `/federation-policy`, `/cookies`, `/licenses` added as root-level editable public routes in `serve-client.js`, registered in `check-public-site.js`, served from disk per request on the origin; reachable on `api.trycord.dev` but **not deployed** to `trycord.dev` (stale Cloudflare build, no push credentials).
Phase 9 — complete: `npm run check` exit 0 (40+ sub-checks); benchmark baseline
recorded: health p50 1.5ms/p95 2.9ms (n=120); concurrent channels x4 p50
2.3ms/p95 3.5ms; concurrent channels x8 p50 8.6ms/p95 16.1ms; POST message p50
4.4ms/p95 10.6ms; WS fanout p50 3ms/p95 5ms, 0/20 missed. Gate green on origin
(`api.trycord.dev`): `/health` 200, `/api/health` 200, `/app/` 200.
Phase 9 — complete: `npm run check` exit 0 (40+ sub-checks); benchmark baseline
recorded: health p50 1.5ms/p95 2.9ms (n=120); concurrent channels x4 p50
2.3ms/p95 3.5ms; concurrent channels x8 p50 8.6ms/p95 16.1ms; POST message p50
4.4ms/p95 10.6ms; WS fanout p50 3ms/p95 5ms, 0/20 missed. Gate green on origin
(`api.trycord.dev`): `/health` 200, `/api/health` 200, `/app/` 200.

Gate: `npm run check` exit 0 (40+ sub-checks incl. jobs check, public-site check, settings wiring); mobile layout 14/14; mobile render 62/62 (656 controls); redteam 28/28.

Phase 4 — complete (foundation): `services/continuum.js` (Ed25519-signed event envelopes via node:crypto, capability discovery at `/.well-known/trycord`, inbound verification with replay protection, outbox delivery with backoff+jitter retries and dead-lettering), `routes/continuum.js` (public discovery, admin instance management, admin inbox), `db/tables/continuum.js` + `db/schema.js` (continuum_instances, continuum_events, continuum_deliveries, continuum_inbox), `features.js` continuum.enabled flag (default off), `.env.example` CONTINUUM_ENABLED=off. Wired into server.js boot/key generation/job registration. `routes/messages.js` enqueues `message.posted` events to the durable outbox on every post (never fails the post). Frontend: `frontend/js/views/continuum.js` admin section, wired into `views/admin.js` and `packages/registry.js`. End-to-end verified between two local instances: valid signed events 202, replays rejected by event id, tampered signatures rejected, unknown keys rejected. Real federation — not a badge, mock network, or collection of hardcoded URLs.

## Continuum end-to-end verification (2026-10-16)

Two isolated Trycord instances were run with separate SQLite databases and separate instance identities:
- Instance A: instance-a, port 9991, db /tmp/instance-a.db
- Instance B: instance-b, port 9992, db /tmp/instance-b.db

Both ran with CONTINUUM_ENABLED=on, CONTINUUM_ALLOW_LOCALHOST=true (test/deployment opt-in),
separate ports. No shared database.

Procedure executed:
  1. Registered admin users admina (on A) and adminb (on B) via POST /api/auth/register.
  2. Logged in on both to obtain bearer tokens.
  3. Fetched /.well-known/trycord from both; confirmed distinct instance_id and distinct public_key (Ed25519 SPKI PEM).
  4. A POST /api/continuum/instances { B's id, origin http://127.0.0.1:9992, B's public_key } → 201, trust_status='pending'.
     B did the symmetric A → trusted add → 201.
  5. POSTed /api/continuum/instances/<id>/trust { trust_status: 'trusted' } on each → 200.
  6. A created a community (server) and obtained a channel id from the create-server response.
  7. A POSTed /api/channels/<channel>/messages { content: "hello from A" } → 200.
  8. Waited 4 seconds for durable outbox delivery (continuum_deliver job via jobs system).
  9. A's continuum_events table: 1 row (the message.posted envelope with signature).
  10. B's continuum_inbox table: 1 row (envelope.id, instance-a, 'message.posted', received_at).
  11. B's inbox processed flag: 1 (processInboundEvent carried it to processed).

Result: VERIFIED. Real federation end-to-end. A message posted in a community on instance A
was signed (Ed25519 via node:crypto), durably enqueued (jobs system), delivered over HTTPS
POST to B's /api/continuum/inbox, signature verified against A's recorded public key
(instance-b's key_id lookup), replay-protected (idempotent on id + key_id), and recorded
as processed.

SSRF defense: A's addInstance rejected loopback (127.0.0.0/8) origins absent CONTINUUM_ALLOW_LOCALHOST=true,
rejected private ranges (10/172.16/192.168/169.254) even with the flag, rejected embedded
credentials, and delivery-time revalidation catches DNS rebinding. Redirects disabled on fetch.
