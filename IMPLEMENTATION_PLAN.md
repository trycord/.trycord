# Trycord Implementation Plan

Ledger for `MASTER_DIRECTIVE.md`. This file is the *plan* (phases, task IDs,
acceptance criteria, dependencies). Progress against it lives in
`IMPLEMENTATION_STATUS.md`. Both are repository-backed so a later session can
resume from verified state instead of assuming.

Rules that govern every task here:

* **Repository truth first.** No task is complete because a route, table, worker
  or button exists. It is complete when the whole chain is verified: interaction
  → state → validated API request → server-side authorization → business logic →
  persistence → realtime/state update → user-visible result.
* **No fake functionality, no invented numbers.** Benchmarks carry real
  measurements or say they are outstanding. Deployments are not claimed without
  evidence.
* **Preserve working functionality.** Audit before replacing. Migrations over
  destructive schema changes. Repair duplicates only after reading callers.
* **A phase is done only when its acceptance criteria pass, or the remaining
  blockers are written down here.**

## Documentation reconciliation

The directive names a set of documents; the repository already had equivalents
under different names. "Maintain or reconcile using existing conventions" is read
as: keep one home per subject, point each directive name at it, and do not fork a
second copy that then drifts.

| Directive name        | Lives at                      | Notes |
| --------------------- | ----------------------------- | ----- |
| `MASTER_DIRECTIVE.md` | `MASTER_DIRECTIVE.md`         | Verbatim mandate. |
| `IMPLEMENTATION_PLAN.md`  | `IMPLEMENTATION_PLAN.md`  | This file. |
| `IMPLEMENTATION_STATUS.md`| `IMPLEMENTATION_STATUS.md`| State + evidence. |
| `ARCHITECTURE.md`     | `docs/architecture.md`        | Existing; kept as the single architecture doc. |
| `DESIGN_SYSTEM.md`    | `docs/theming.md` + `docs/desktop.md` | Design tokens/theme are documented there; the shared token library is `frontend/css/tokens.css`. A single `DESIGN_SYSTEM.md` is a candidate if those two drift. |
| `SECURITY_REVIEW.md`  | `SECURITY.md` + `REDTEAM-FINDINGS.md` + `tests/redteam/` | Existing separate homes; `SECURITY_REVIEW.md` would duplicate them. |
| `MIGRATIONS.md`       | `docs/architecture.md` (schema section) + `backend/src/db/` | Create a dedicated file only if migrations exist that warrant it (see T0.4). |
| Continuum/concurrency/deployment docs | `docs/community-channel-audit.md`, `docs/production-readiness.md`, `docs/selfhosting.md` | Existing. |

`IMPLEMENTATION_STATE.md` predates this ledger. It is **not deleted** (it is
prior work); its live content is folded into `IMPLEMENTATION_STATUS.md`, and the
file is left in place until every section has a new home, then removed in one
documented step (T0.5).

## Phase 0 — Repository reconnaissance (in progress)

| ID   | Task | Acceptance |
| ---- | ---- | ---------- |
| T0.1 | Map backend runtime, process model, DB, auth, realtime, services, routes. | Written into STATUS with file:line evidence. |
| T0.2 | Map frontend modules, entry points, routing, config, build. | Written into STATUS. |
| T0.3 | Inventory checks, CI, docs, deployment, env. | Written into STATUS. |
| T0.4 | Verify schema/migration reality (engines, migration mechanism). | Recorded; `MIGRATIONS.md` decision made. |
| T0.5 | Establish the test baseline (run everything, record real numbers). | Numbers in STATUS. |
| T0.6 | Verify live deployment topology and the `api.trycord.dev` question. | Recorded with evidence. |
| T0.7 | Reconcile the ledger docs and retire `IMPLEMENTATION_STATE.md`. | This file + STATUS agree; state doc retired. |

## Phase 1 — P0 reliability and security

Seeded by the recon findings; each task cites the defect it fixes.

| ID   | Task | Acceptance |
| ---- | ---- | ---------- |
| T1.1 | Triage `REDTEAM-FINDINGS.md` against `tests/redteam/regression.mjs`; make the suite runnable and green. | Suite runs on an isolated SQLite instance; every confirmed finding has a passing assertion. |
| T1.2 | Audit authz on every mutating route (privilege escalation, IDOR, background-job authz). | Findings fixed or written up; hidden-UI-only checks replaced with server checks. |
| T1.3 | Audit uploads (type, size, path traversal, storage provider). | Unsafe cases closed or documented. |
| T1.4 | Audit secret handling (env, logs, responses, bundles). | No secret reaches a response, log or bundle; asserted by a check. |
| T1.5 | Startup/config validation fails safely. | Invalid config refuses to start with a clear message; check covers it. |

## Phase 2 — Core product functionality

Messaging/realtime, communities/channels, roles/permissions, reactions/mentions/
notifications, search. Task IDs are added as recon classifies each as
working-and-verified / working-untested / partial / decorative / missing / broken.

## Phase 3 — CPU multithreading and performance

| ID   | Task | Acceptance |
| ---- | ---- | ---------- |
| T3.1 | Establish the pre-change baseline with `tests/bench/bench.mjs` (throughput, p50/p95/p99, event-loop delay, under low/typical/high concurrency). | Real numbers recorded in STATUS. |
| T3.2 | Identify CPU-bound work from the baseline, not assumption. | List with evidence. |
| T3.3 | Implement bounded concurrency only where the baseline justifies it, with configurable limits, backpressure, health checks, graceful shutdown, metrics. | Bounded pool; no worker-per-request; API stays responsive under saturation. |
| T3.4 | Re-run the identical benchmark; compare. | Before/after table in STATUS. |

Constraint recorded up front: the runtime is currently **single-process, fork
mode, 1 instance** (pm2), so there is no parallelism at all today. Phase 3 must
not become "turn on cluster mode and hope"; it must be driven by T3.1.

## Phase 4 — Community Continuum

Real federation (identity, discovery, trust, durable delivery, permissions,
portability, admin, protocol tests). Opt-in; a local-only instance stays fully
functional. No mock network.

## Phase 5 — Frontend architecture and experience

Owns the desktop/mobile split, mobile viewport/safe-area repair, and the
backend-agnostic contract. Recent verified work (pre-ledger) is listed in STATUS.

## Phase 6 — Instance selection, administration, deployment

Optional instance selection at auth, validated API config, primary/backup backend
behaviour, constrained admin dropdowns (backend role), deployment verification.

## Phase 7 — Community customization and Community Memory

## Phase 8 — Public routes, legal pages, documentation, onboarding

Root-level legal routes (`/terms` canonical, not `/app/terms`), missing pages,
selfhosting/CPU/federation docs, onboarding.

## Phase 9 — Integration and release verification

Regression, migrations, benchmarks, deployment assumptions, factual delivery
report with a feature-by-feature matrix.
