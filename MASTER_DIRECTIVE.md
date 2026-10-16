# TRYCORD MASTER DIRECTIVE

TRYCORD: TOTAL PRODUCT REWORK AND IN-HOUSE SYSTEMS MASTER DIRECTIVE

Complete Product Audit, Native Systems Engineering, Configuration Overhaul, CPU Parallelism, Community Continuum, and Verified Implementation

Directive type: Authoritative product and engineering mandate
Execution mode: Repository-first, full implementation, phased execution, durable progress tracking, automated testing, and evidence-based verification
Scope: Entire Trycord platform, including desktop and mobile frontends, backend services, native application systems, administration, configuration, authentication, messaging, community management, Community Continuum, performance, deployment, and documentation.

⸻

## 0. THE NON-NEGOTIABLE OBJECTIVE

Rework Trycord into a cohesive, independently operable, open-source, self-hostable communication platform.

The AI must implement the actual systems inside the Trycord codebase. It must not merely design interfaces, write plans, install unrelated products, or connect external services as substitutes for implementing core functionality.

For every major capability, inspect the existing implementation, identify what is missing, design an appropriate native implementation, integrate it into the real application, and verify the complete execution path.

Examples of the intended engineering standard:

* A settings dropdown must change a validated configuration value and produce the correct runtime behavior.
* A job queue must persist or recover work according to its documented durability requirements.
* A search interface must query a real search implementation.
* A notification system must generate, deliver, and track real notifications.
* A federation feature must exchange authorized events with compatible instances.
* A CPU worker pool must execute suitable work and demonstrate its behavior under tests.
* A local-storage option must actually use the configured local storage implementation.
* A backup option must perform a real backup workflow with verification and restoration procedures.
* An administration control must have real authorization, persistence, auditability, and operational effects.

A feature is not complete because its button exists.

Do not create dummy APIs, fake status indicators, hardcoded successful responses, placeholder settings, or mock implementations presented as production functionality.

⸻

## PART I. REPOSITORY-FIRST DISCOVERY

### 1. Inspect before changing

Inspect the real repository and map:

* All frontend entry points, routes, layouts, and modules.
* Desktop and mobile presentation boundaries.
* Backend services, runtime, APIs, and internal modules.
* Database schema, migrations, indexes, and transaction behavior.
* Authentication, authorization, roles, and permissions.
* Messaging, communities, channels, reactions, mentions, and notifications.
* Realtime transport and event processing.
* File uploads and storage.
* Background tasks, job queues, scheduled tasks, and CPU execution.
* Existing administration and configuration interfaces.
* Community Continuum and federation-related code.
* Logging, monitoring, health checks, backups, and deployment scripts.
* Dependencies on external services and third-party APIs.
* Tests, CI pipelines, architecture documentation, and design-system documentation.

Read existing ARCHITECTURE.md, DESIGN_SYSTEM.md, and other relevant documents where present. Compare documentation with actual code.

Classify every major feature as:

1. Verified and working.
2. Working but insufficiently tested.
3. Partially implemented.
4. UI-only or nonfunctional.
5. Missing.
6. Broken.
7. Insecure.
8. Duplicated or unnecessarily dependent on an external service.
9. Intentionally unsupported.

Do not remove working functionality without understanding its dependencies and migration implications.

### 2. Create a complete implementation ledger

Maintain:

* IMPLEMENTATION_PLAN.md
* IMPLEMENTATION_STATUS.md
* ARCHITECTURE.md
* DESIGN_SYSTEM.md
* SECURITY_REVIEW.md
* DEPENDENCY_AUDIT.md
* MIGRATIONS.md, where applicable
* Relevant system-specific technical documentation.

Preserve useful existing content instead of blindly replacing it.

Every task must record its scope, dependencies, changed files, migrations, tests, results, limitations, and next action.

After context compaction, reread the progress ledger and inspect the repository before continuing. Resume unfinished work rather than restarting the project.

⸻

## PART II. IN-HOUSE SYSTEMS POLICY

### 3. Build native systems for core functionality

Implement core Trycord functionality in-house, within the existing application architecture.

This includes, where applicable:

* Authentication and session management.
* Authorization and permission evaluation.
* Messaging and realtime event handling.
* Community and channel management.
* Search and indexing.
* Notifications and unread state.
* File and attachment management.
* Background jobs and scheduled work.
* Configuration management.
* Audit logging.
* Health and readiness checks.
* Data export and import.
* Backup and restore workflows.
* CPU-bound parallel execution.
* Community Continuum and federation.
* Community customization.
* Community Memory.
* Administration and operational diagnostics.
* Instance discovery and optional instance selection.
* Rate limiting and abuse protection.
* Retention and deletion workflows.

Audit existing implementations first. Extend or repair valid native systems instead of creating duplicate subsystems unnecessarily.

The objective is a cohesive in-house platform, not a collection of disconnected implementations.

### 4. Define what "in-house" means

A native Trycord system must own its application-level behavior, interfaces, data model, security rules, configuration, integration, and operational lifecycle.

For example:

* Trycord owns the job lifecycle even if it uses a proven library internally.
* Trycord owns search permissions and result semantics even if it uses a database index.
* Trycord owns its federation protocol and trust policy even if it uses an established cryptographic library.
* Trycord owns authentication behavior even if it uses a carefully selected password-hashing library.
* Trycord owns its file authorization, metadata, and retention rules even if storage uses a local filesystem or S3-compatible backend.

Use third-party libraries when they provide established, well-maintained primitives. Do not reinvent cryptography, password hashing, TLS, or other security-critical foundations merely to avoid dependencies.

In-house does not mean reimplementing the entire internet from scratch. It means Trycord owns the actual product system rather than outsourcing its core behavior to an unrelated hosted product.

### 5. Dependency audit and replacement strategy

Audit external services and packages by function.

Classify each dependency as:

* Essential security or infrastructure primitive.
* General-purpose library.
* Optional provider integration.
* Hosted service dependency.
* Replaceable core system.
* Unused or redundant dependency.

For each replaceable core system, decide whether an in-house implementation is justified.

Prioritize replacing external services that are mandatory for basic product operation when a safe, maintainable native implementation is practical.

Do not indiscriminately remove dependencies or rewrite mature security primitives.

When replacing a service:

1. Identify every caller.
2. Define the internal interface.
3. Implement the native replacement.
4. Migrate configuration and stored data where necessary.
5. Update documentation.
6. Add tests.
7. Verify the old service is no longer required for the intended core workflow.
8. Remove obsolete dependencies only after proving they are unused.

Optional external integrations may remain available, but the core product must not pretend they exist when they are unconfigured or unavailable.

⸻

## PART III. CONFIGURATION AND DROPDOWN OVERHAUL

### 6. Create a coherent configuration system

Audit all settings pages and configuration schemas.

Replace unsuitable free-text fields with dropdowns, segmented controls, checkboxes, or other constrained inputs when the setting has a finite set of valid values.

The example selection "Rhein party, local" must be treated as a discovery requirement: locate the corresponding setting, configuration source, or intended option set if it exists. Do not invent its meaning, silently rename it, or assume what "Rhein" refers to.

Inspect the existing repository and configuration data to establish the actual option labels and semantics.

If the option cannot be grounded in the repository, document the unresolved requirement rather than fabricating a configuration.

### 7. Establish configuration categories

Where relevant, organize settings into clear categories:

* Instance.
* API and backend.
* Backend roles and failover.
* Authentication and security.
* Storage.
* CPU and concurrency.
* Realtime and messaging.
* Notifications.
* Search.
* Community Continuum.
* Community customization.
* Community Memory.
* Moderation.
* Privacy and retention.
* Performance.
* Logging and diagnostics.
* Backup and recovery.
* Frontend presentation.
* Optional integrations.

Use the existing administration interface and architecture. Do not create a separate administration server or port.

### 8. Every dropdown must be real

For each selectable setting, implement the complete lifecycle:

1. Define the setting's canonical name and schema.
2. Define allowed values and defaults.
3. Provide readable labels and descriptions.
4. Validate the selected value on the server.
5. Persist the configuration in the correct location.
6. Apply it to the relevant subsystem.
7. Return the authoritative effective configuration.
8. Reflect changes in the UI.
9. Handle invalid values and runtime failures.
10. Add tests for each supported behavior.

A frontend-only selection is insufficient.

Do not store sensitive settings in user preferences. Do not expose secrets through normal configuration responses.

### 9. Model setting types correctly

Use suitable controls for different configuration types.

Setting type | Appropriate control
---|---
Finite operating mode | Dropdown
Enabled or disabled feature | Checkbox or switch
Mutually exclusive presentation choices | Segmented control or radio group
Numeric limits | Validated numeric input or slider where appropriate
Free-form text | Text input or textarea
Secret credentials | Masked input and secure server-side storage
Complex policy | Structured editor or dedicated configuration screen
Read-only operational status | Informational display, not an editable dropdown

Do not use dropdowns merely for visual uniformity.

### 10. Configuration scope and precedence

Explicitly distinguish:

* Deployment configuration.
* Instance configuration.
* Backend-specific operational configuration.
* Community configuration.
* User preferences.
* Temporary UI state.
* Secret values.

Define which layer owns each setting and how conflicts are resolved.

Community settings must not override instance security policy.

User preferences must not change global backend behavior.

A frontend preference must not masquerade as an authoritative backend setting.

Validate settings at startup and when changed at runtime. For settings requiring restart or coordinated transition, communicate this clearly and implement the necessary lifecycle.

### 11. Configuration auditability

For security-sensitive or operational changes, record appropriate audit events.

Where applicable, record the actor, setting, time, and safe before/after values.

Do not log passwords, tokens, secrets, or sensitive private data.

Protect administrative configuration routes with server-side permissions.

⸻

## PART IV. FRONTEND AND DEPLOYMENT ARCHITECTURE

### 12. Separate desktop and mobile frontend modules

Desktop and mobile must be separate presentation modules, not a single UI compressed with responsive CSS.

Each should have its own appropriate:

* Application shell.
* Navigation and route presentation.
* Layouts.
* Presentation components.
* Interaction patterns.
* Styling boundaries.
* Entry points.
* Build and test boundaries consistent with the repository.

Shared nonvisual packages may contain API clients, schemas, authentication primitives, business logic, permission contracts, realtime protocols, and utilities.

Do not import desktop presentation components into mobile or vice versa.

Preserve desktop functionality and redesign mobile presentation deliberately for touch interaction, safe areas, virtual keyboards, and constrained viewports.

### 13. Backend-agnostic frontend

Authoritative deployment assumptions:

* trycord.dev is the canonical frontend web application hosted through Cloudflare.
* The API is a separate backend service.
* Backend A is primary.
* Backend B is backup.
* Both currently use the same database.
* Shared S3-compatible storage is planned.

Use a centralized, validated API configuration boundary.

Do not scatter backend addresses throughout frontend components.

Inspect the actual use of api.trycord.dev and determine whether it is an intentional alias, redirect, or deployment error.

Verify the real DNS, Cloudflare, frontend build, runtime configuration, authentication, cookies, CORS, and WebSocket behavior before proposing changes.

Do not perform destructive external configuration changes without authorization.

### 14. Backend A and Backend B

Preserve the two-backend topology.

* Backend A: primary.
* Backend B: backup.
* No third backend.
* Both belong to the same logical Trycord instance.
* Both use the same database.
* Shared S3-compatible storage is planned.

Audit health checks, routing, failover, recovery, sessions, realtime reconnection, local files, caches, background jobs, and scheduled tasks.

Prevent duplicate singleton work.

Do not assume that sharing a database automatically provides high availability.

Do not fail over on ordinary 401, 403, or 429 responses. Do not blindly retry non-idempotent mutations after ambiguous failures.

Backend selection must remain independent of the end-user instance selector.

### 15. Mobile layout repair

Repair:

* Oversized branding.
* Home-screen composition.
* Community list readability.
* Bottom navigation overlap.
* Safe-area behavior.
* Dynamic browser viewport behavior.
* Scrolling and virtual keyboard interactions.
* Long text and narrow-screen overflow.
* Public routes and authentication.

Use Trycord-assets as the mandatory source for all asset references.

Test relevant viewport widths from 320 through 1024 pixels, portrait and landscape, and iOS Safari/WebKit where available.

⸻

## PART V. NATIVE BACKEND SYSTEMS

### 16. Native messaging and realtime

Implement or repair the actual messaging pipeline:

* Message creation, editing, and deletion.
* Persistence and pagination.
* Reactions and mentions.
* Attachments.
* Read and unread state.
* Search.
* Notifications.
* Realtime synchronization.
* Reconnection and missed-event recovery.
* Authorization.
* Rate limiting.
* Error handling.

Preserve ordering where required and prevent duplicate operations.

Realtime events must be authorized, scoped, and recoverable.

Do not silently lose messages during disconnections.

### 17. Native background job system

Implement a cohesive internal job system where the current architecture lacks one.

Depending on the actual requirements, support:

* Job registration and execution.
* Durable storage for jobs that must survive process restarts.
* Bounded concurrency.
* Retry policies.
* Backoff and jitter.
* Timeouts.
* Idempotency.
* Job cancellation where feasible.
* Job status.
* Failure records.
* Dead-letter handling.
* Graceful shutdown.
* Recovery after restart.
* Operational metrics.

Do not make every operation asynchronous merely to claim the system has a queue.

Do not run singleton scheduled jobs independently on both backends without coordination.

### 18. Native notifications

Own the notification model, persistence, delivery state, preferences, and authorization.

Support the relevant notification types, including mentions, community events, messaging events, and supported Continuum events.

Prevent duplicates, respect mute preferences, and protect private content in previews.

External push providers may be optional integrations, but core in-app notification functionality must work without requiring a hosted third-party notification platform.

### 19. Native search

Implement a real search system appropriate to the existing database and scale.

* Index supported content.
* Enforce authorization before returning results.
* Support pagination and relevant filters.
* Provide safe previews.
* Handle edits and deletions.
* Include thread and community context where relevant.
* Document indexing and recovery.
* Prevent private-content leakage through counts and snippets.

Prefer a maintainable database-backed implementation initially if it meets requirements. Add specialized infrastructure only when measurements justify it.

### 20. Native storage abstraction

Implement a consistent storage interface that supports the configured providers.

Where practical, support:

* Local filesystem storage.
* S3-compatible object storage.
* Validated storage configuration.
* Upload and download authorization.
* File metadata.
* Size and type validation.
* Safe filenames and object keys.
* Retention and deletion.
* Integrity checks.
* Storage health diagnostics.
* Migration or copy procedures where required.

Keep storage-specific behavior behind a defined internal interface.

Do not claim local and S3-compatible storage are interchangeable unless their relevant behavior has been tested.

### 21. Native backup and recovery

Implement a real backup and restoration workflow appropriate to the actual database and storage configuration.

Include:

* Backup creation.
* Backup metadata.
* Integrity verification.
* Failure reporting.
* Retention policies.
* Protected backup access.
* Restore procedures.
* Documentation.
* Tests using disposable environments.

Account for database consistency and file/object-storage references.

Do not claim that a backup is valid merely because a file was created.

Do not overwrite production data during tests.

### 22. Native rate limiting and abuse protection

Implement rate limiting appropriate to the existing architecture.

Support relevant controls for authentication, API requests, messaging, uploads, federation, and expensive background tasks.

Where both backend nodes serve the same logical instance, evaluate whether limits must be coordinated across nodes.

Do not assume process-local counters provide global enforcement.

Protect expensive endpoints from unbounded concurrency and resource exhaustion.

### 23. Native audit logging and diagnostics

Implement structured operational logs, audit events for relevant privileged actions, health checks, readiness checks, and diagnostics.

* Redact secrets.
* Avoid leaking private content.
* Distinguish liveness from readiness.
* Report degraded dependencies accurately.
* Provide enough information to investigate failures.
* Avoid exposing sensitive internal details to unauthorized clients.

⸻

## PART VI. CPU MULTITHREADING AND PERFORMANCE

### 24. Profile the actual runtime

Identify the runtime and execution model before choosing a parallelism strategy.

For Node.js, evaluate event-loop blocking, worker_threads, child processes, process supervision, asynchronous I/O, database pools, and existing background jobs.

Profile CPU-intensive parsing, compression, cryptographic verification, indexing, transformations, and other candidate workloads.

Distinguish CPU-bound work from I/O-bound work.

### 25. Implement bounded parallel execution

Where profiling demonstrates a benefit, implement an appropriate worker pool or parallel execution mechanism.

Support:

* Configurable concurrency.
* Bounded queues.
* Backpressure.
* Error handling.
* Timeouts where appropriate.
* Worker lifecycle management.
* Graceful shutdown.
* Resource cleanup.
* Metrics.
* Failure recovery.

Do not create a new worker for every request.

Do not offload every operation into a worker.

Do not invent custom cryptographic implementations.

### 26. CPU-aware configuration

Account for actual available CPU capacity, container limits, memory constraints, and other workloads.

Provide safe defaults and validated settings.

Avoid starving the main API process or exhausting small self-hosted machines.

### 27. Benchmark real results

Establish a baseline and compare optimized behavior under comparable workloads.

Measure throughput, p50/p95/p99 latency where practical, event-loop lag where relevant, CPU and memory use, queue depth, worker failures, and error rates.

Test low, typical, and high concurrency, overload, shutdown, and recovery.

Do not claim performance improvements without measurements.

⸻

## PART VII. COMMUNITY CONTINUUM

### 28. Implement real opt-in federation

Community Continuum must allow compatible Trycord instances to exchange explicitly authorized information and support community continuity and portability.

A local-only instance must remain fully functional when Continuum is disabled.

Do not substitute a public directory or fake remote-instance interface for federation.

### 29. Identity and discovery

Distinguish logical instance identity from physical backend nodes.

Implement documented capability discovery with versioned protocol information and safe public metadata.

Validate remote origins and requests. Protect against SSRF, unsafe redirects, DNS rebinding, and malicious payloads.

### 30. Trust and integrity

Define remote identity verification, trust relationships, revocation, blocking, and authorization.

Use established cryptographic protocols and maintained libraries.

Where signatures are needed, implement canonical event serialization, signature verification, key rotation, and replay protection.

HTTPS alone does not establish trust.

### 31. Durable delivery

Implement persistent inbox/outbox processing where required, with stable identifiers, idempotency, retries, deduplication, failure records, and recovery.

Ensure backend failover and worker crashes do not silently lose or duplicate durable events.

### 32. Privacy and community portability

Private messages must not be federated by default.

Respect local permissions, community policies, user consent, blocks, and moderation.

Support appropriate community metadata, permitted content exchange, provenance, export/import, and migration workflows.

Define conflicts and revocation behavior.

Do not permit remote instances to override local permissions or gain local administrator privileges.

### 33. Continuum controls

Integrate federation settings into the existing administration interface.

Support appropriate configuration, remote-instance management, delivery diagnostics, revocation, and audit records.

Test isolated instances, invalid signatures, duplicate events, network failures, revoked trust, private-content access, and recovery.

⸻

## PART VIII. COMMUNITY CUSTOMIZATION AND COMMUNITY MEMORY

### 34. Community customization

Audit and complete settings for community identity, appearance, categories, channels, onboarding, membership, roles, moderation, guidelines, discovery, and supported notification preferences.

All settings must have real persistence, validation, authorization, and runtime effects.

Use Trycord-assets for all asset references.

Community settings must never override instance security policy.

### 35. Community Memory

Implement a permission-aware knowledge system supporting creation, editing, organization, search, provenance, source references, revisions, retention, and deletion.

Do not automatically turn every private message into permanent knowledge.

Use external AI services only when explicitly configured and supported. The core product must not fake AI functionality when no integration exists.

⸻

## PART IX. AUTHENTICATION AND INSTANCE SELECTION

### 36. Authentication

Audit registration, login, logout, sessions, account recovery, password handling, verification where supported, session revocation, CSRF, cookie security, rate limits, and authorization.

Preserve valid existing behavior.

### 37. Optional instance selection

Keep the current instance as the default.

Allow users to optionally select another supported logical Trycord instance where appropriate.

Validate origins, require HTTPS in production, discover supported capabilities, isolate credentials and private state, and handle unavailable or incompatible instances safely.

Do not require a central instance directory.

Do not confuse choosing another instance with switching between Backend A and Backend B.

⸻

## PART X. ADMINISTRATION AND CONFIGURATION COMPLETION

### 38. Existing administration interface only

Do not create a separate administration server or port.

Integrate all new system controls into the existing administration architecture.

Every setting must have:

* A canonical schema.
* Valid values.
* A documented default.
* Authorization.
* Persistence.
* Runtime behavior.
* Safe error handling.
* Tests.
* Documentation.

The backend role selector must correctly represent PRIMARY API and BACKUP API, while actual health and failover mechanisms remain separately verified.

### 39. No cosmetic configuration

If a setting cannot produce a real supported effect, do not expose it as an operational control.

If a feature is unavailable, mark it clearly as unavailable rather than displaying a misleading enabled state.

For restart-required changes, explain the requirement and apply the change through a safe lifecycle.

⸻

## PART XI. ROOT-LEVEL PUBLIC ROUTES

### 40. Canonical legal URLs

Legal and policy pages must use root-level routes, not /app/.

Required examples:

* /terms
* /privacy
* /guidelines
* /community-guidelines
* /federation-policy
* /cookies, where applicable.
* /licenses, where applicable.

/terms is the canonical Terms of Service route.

Public pages must load without authentication, survive refreshes, work through external links, and use the correct frontend origin.

Update internal links and provide safe redirects for legacy routes where appropriate.

### 41. Accurate policy content

Ensure terms, privacy, guidelines, moderation, retention, federation, and operator responsibilities match the actual implementation.

Do not invent legal compliance, certifications, or guarantees.

⸻

## PART XII. SECURITY AND QUALITY

### 42. Security audit

Review authentication, authorization, CSRF, CORS, XSS, SQL injection, SSRF, file uploads, path traversal, privilege escalation, rate-limit bypasses, secret exposure, WebSocket authorization, federation replay, caching, and dependency vulnerabilities.

Enforce permissions server-side.

Do not weaken security to make an integration easier.

### 43. Automated testing

Use the existing testing stack where possible.

Add unit, integration, authorization, migration, realtime, concurrency, worker failure, federation, configuration, frontend, and end-to-end tests.

Test core workflows across desktop and mobile.

Test overload, worker shutdown, backend failover, duplicate event handling, private-content isolation, root-level public routes, and restoration from backups.

Do not claim a test passed unless it actually ran.

### 44. Definition of done

A subsystem is complete only when:

* Its implementation exists.
* It is integrated with the real product.
* Data models and migrations are correct.
* Authorization is enforced.
* Configuration works.
* Error handling and edge cases are covered.
* Tests pass.
* Documentation matches behavior.
* External dependencies are accurately documented.
* No critical unresolved security or data-integrity defects remain in its scope.

⸻

## PART XIII. EXECUTION ORDER

Phase 0: Discovery and baseline

Inspect the repository, establish the architecture map, audit dependencies, identify bottlenecks, and create the implementation ledger.

Phase 1: Critical correctness and security

Repair critical failures and protect existing data.

Phase 2: Native core systems

Complete messaging, realtime, configuration, search, notifications, storage, permissions, and background jobs.

Phase 3: CPU parallelism

Profile, implement bounded concurrency where justified, and benchmark.

Phase 4: Community Continuum

Implement and test the actual federation protocol and operational lifecycle.

Phase 5: Frontend and mobile rework

Enforce presentation boundaries, repair navigation and viewport behavior, and verify API configuration.

Phase 6: Configuration and administration

Complete real dropdown settings, runtime configuration, role selection, and operational controls.

Phase 7: Customization and Community Memory

Complete community settings and permission-aware knowledge management.

Phase 8: Legal pages and documentation

Implement root-level routes, accurate policies, and deployment instructions.

Phase 9: Integration and release verification

Run tests, verify migrations, review security, measure performance, and document remaining blockers.

Maintain durable progress throughout.

⸻

## FINAL EXECUTION MANDATE

Start with repository discovery and continue into implementation.

Build the actual systems inside Trycord. Do not replace core product functionality with unrelated hosted services, decorative settings, placeholder APIs, or mock behavior.

Use appropriate established libraries for security-critical primitives. Build native application behavior, contracts, persistence, configuration, authorization, integration, and operations around them.

Preserve existing functionality, protect user data, avoid unnecessary rewrites, and verify every major change.

The desired result is a cohesive, configurable, independently operable Trycord platform in which every exposed setting has a real effect, core systems are implemented and maintained in-house, CPU parallelism is evidence-based, Continuum is real federation, and the product can be operated and self-hosted without depending on an unrelated hosted platform for its core functionality.