# TRYCORD MASTER ENGINEERING SPECIFICATION
## Complete Platform, Backend, Database, UI, Performance, Security, Trust & Safety, and Production Overhaul

---

# 0. PURPOSE

You are working on the existing **Trycord** repository.

Your task is to perform a complete engineering overhaul of the existing platform and bring it to a coherent, production-ready state.

This document is the authoritative implementation specification for this task.

This is **not** a request to create a mockup.

This is **not** a request to create a new unrelated application.

This is **not** permission to replace the entire repository with a different architecture.

The objective is:

> Take the existing Trycord implementation, inspect it, preserve what already works, complete missing functionality, remove architectural inconsistencies, optimize it, harden it, rebuild the required UI, and verify the complete system end-to-end.

The final result must be a functioning application.

---

# 1. SOURCE OF TRUTH

The repository itself is the primary source of truth.

Before making changes:

1. Inspect the complete repository.
2. Inspect all relevant source files.
3. Inspect imports and exports.
4. Inspect package manifests.
5. Inspect database schema.
6. Inspect migration scripts.
7. Inspect server startup.
8. Inspect REST routes.
9. Inspect services.
10. Inspect WebSocket implementation.
11. Inspect client state.
12. Inspect client routing.
13. Inspect client pages.
14. Inspect UI components.
15. Inspect Electron.
16. Inspect configuration.
17. Inspect tests/check scripts.
18. Inspect deployment-related files.

Do not assume that:

- README documentation is current.
- progress documents are current.
- comments describe the current implementation.
- an old component is still used.
- a new component is actually connected.
- a documented API exists.
- a database table exists merely because a feature is mentioned.
- a UI button works merely because it exists.

Verify.

---

# 2. NO-HALLUCINATION CONTRACT

This section is mandatory.

## 2.1 Never invent existing functionality

Do not say that a feature exists unless the repository contains a functioning implementation.

## 2.2 Never create fake functionality

Do not create:

- fake API responses
- fake database data
- placeholder backend implementations
- buttons that do nothing
- settings that only change local appearance when they imply server behavior
- fake moderation actions
- fake reports
- fake bans
- fake realtime
- hardcoded user lists
- hardcoded community lists
- hardcoded message history

## 2.3 Existing partial implementations

If functionality partially exists:

1. identify the existing implementation
2. preserve compatible parts
3. extend it
4. remove obsolete duplication only after verifying it is no longer used

Do not create a parallel implementation.

## 2.4 Ambiguous requirements

If this specification does not define a behavior:

1. inspect the existing implementation
2. follow existing architecture and conventions
3. choose the smallest reasonable behavior
4. document the decision in the final report

Do not invent an elaborate product behavior merely because it is technically possible.

## 2.5 Missing dependencies

Do not introduce a new infrastructure dependency merely because it makes implementation easier.

Prefer existing:

- Node.js
- Express
- MySQL
- SQLite
- WebSocket
- browser APIs
- Electron

unless a measured requirement proves another dependency necessary.

---

# 3. IMPLEMENTATION PRIORITY

When requirements conflict, use this priority:

1. Security
2. Data integrity
3. Existing working functionality
4. Authorization correctness
5. API correctness
6. Realtime correctness
7. Performance
8. Accessibility
9. UX
10. Visual polish
11. Architectural elegance

Never sacrifice security or data integrity for visual or performance improvements.

---

# 4. ARCHITECTURE

Trycord consists of three primary application areas.

```text
TRYCORD
│
├── trycord-server
│   ├── REST API
│   ├── WebSocket gateway
│   ├── authentication
│   ├── authorization
│   ├── database
│   ├── communities
│   ├── channels
│   ├── messages
│   ├── roles
│   ├── permissions
│   ├── DMs
│   ├── friends
│   ├── notifications
│   ├── discovery
│   ├── invites
│   ├── attachments
│   └── Trust & Safety
│
├── trycord-client
│   └── browser access point
│
└── trycord-desktop
    └── Electron access point
```

## 4.1 Client responsibility

The web client:

- renders UI
- manages client-side state
- communicates with the server
- handles realtime events
- stores permitted local preferences

The web client must not become the authority for:

- permissions
- bans
- memberships
- roles
- moderation
- authentication validity
- private data access

## 4.2 Desktop responsibility

Electron is an access point.

Do not create a second Trycord backend inside Electron.

Do not create a separate database.

Reuse the web/client business logic wherever practical.

Desktop presentation may differ from mobile presentation.

---

# 5. CURRENT PRODUCTION MODEL

The intended official public origin is:

```text
https://trycord.dev
```

The intended WebSocket origin is:

```text
wss://trycord.dev
```

The backend may internally listen on:

```text
0.0.0.0:9971
```

The public architecture is conceptually:

```text
Browser
   │
   ├── HTTPS
   └── WSS
       │
       ▼
Cloudflare
       │
       ▼
nginx / reverse proxy
       │
       ▼
Trycord server :9971
       │
       ▼
MySQL
```

Do not expose internal database credentials or internal database endpoints to clients.

---

# 6. DATA MODEL CONTRACT

Before implementing new functionality, compare the current schema against the following conceptual model.

Do not blindly recreate existing tables.

Extend existing structures when appropriate.

---

# 7. USER

A User represents a Trycord account.

Required conceptual properties:

```text
id
username
display_name
password_hash
email
email_verified_at
created_at
updated_at
terms_version
privacy_version
terms_accepted_at
privacy_accepted_at
password_changed_at
sessions_invalidated_at
```

The exact field names must follow the existing schema unless there is a compelling migration reason to change them.

Passwords must never be stored in plaintext.

---

# 8. SESSION

A session represents authenticated access.

Sessions must support:

- authentication
- invalidation
- expiration where applicable
- account-wide invalidation after security-sensitive actions

A banned or suspended account must not retain active unauthorized access.

---

# 9. SERVER / COMMUNITY

A Server is a community.

Conceptual properties:

```text
id
name
description
owner_id
join_code
public/discoverable state
created_at
updated_at
```

A server has:

- members
- roles
- categories
- channels
- invites
- moderation state
- discovery metadata

---

# 10. MEMBERSHIP

A membership connects a User to a Server.

A membership must contain enough information to determine:

- whether the user belongs to the server
- their roles
- owner status
- moderation state where applicable
- membership timestamps

A user cannot access private server resources without valid membership or another explicit authorization path.

---

# 11. ROLE

A role belongs to a server.

Roles must support:

- name
- hierarchy/position
- permissions
- assignment
- editing
- deletion where allowed

Role hierarchy must prevent users from managing roles above their authority.

The server owner must retain appropriate owner authority.

---

# 12. PERMISSIONS

The permission system must remain server-authoritative.

Existing permissions must be audited before adding new ones.

Existing conceptual permissions include:

```text
MANAGE_SERVER
MANAGE_CHANNELS
MANAGE_ROLES
MANAGE_INVITES
KICK_MEMBERS
MANAGE_MESSAGES
SEND_MESSAGES
```

Do not rename or silently change the semantics of existing permissions without auditing all callers.

If additional permissions are required, define them explicitly.

Example categories:

```text
VIEW_CHANNEL
SEND_MESSAGES
MANAGE_MESSAGES
ADD_REACTIONS
CREATE_THREADS
MANAGE_THREADS
MENTION_EVERYONE
MANAGE_CHANNELS
MANAGE_SERVER
MANAGE_ROLES
MANAGE_INVITES
KICK_MEMBERS
BAN_MEMBERS
MODERATE_MEMBERS
```

Only implement new permissions that are actually required.

---

# 13. CHANNEL

A channel belongs to a server.

Channels must support:

- name
- type
- category
- ordering
- visibility
- permissions
- creation
- editing
- deletion

At minimum, preserve the existing text-channel functionality.

Do not change channel identifiers during ordinary UI work.

---

# 14. CATEGORY

Categories group channels.

A category must support:

- name
- ordering
- server ownership
- channel association

Category ordering must be deterministic.

---

# 15. CHANNEL PERMISSION OVERRIDES

Channel-specific permissions must be evaluated after server-level permissions according to the defined authorization model.

Do not implement permission behavior only in the UI.

Every protected API action must independently validate:

1. authentication
2. membership
3. role/permission state
4. channel visibility
5. action permission

---

# 16. MESSAGE

A message belongs to a channel or DM conversation.

Conceptual properties:

```text
id
author_id
channel_id or conversation_id
content
created_at
updated_at
deleted_at where applicable
```

Messages must support, where implemented:

- creation
- editing
- deletion
- pagination
- attachments
- replies
- reactions
- mentions
- realtime updates

Author-only edit/delete rules must remain enforced server-side unless a moderator permission explicitly allows otherwise.

---

# 17. MESSAGE PAGINATION

Never load unlimited message history.

The API must support bounded retrieval.

Pagination must behave correctly when:

- messages are deleted
- messages are edited
- new messages arrive
- multiple clients are connected
- users reconnect

The client must not duplicate messages across pagination boundaries.

---

# 18. ATTACHMENT

Attachments must remain permission-protected.

The existing attachment pipeline must be audited.

Required concepts:

```text
id
uploader_id
message_id
filename
mime_type
size
storage identifier
created_at
```

Attachments must be:

- validated
- size-limited
- type-validated
- authorization-checked
- cleaned up when abandoned

Do not expose arbitrary filesystem paths.

Do not allow path traversal.

Do not trust client-provided MIME types alone.

---

# 19. REACTIONS

If reactions are implemented, define them as persistent message state.

Required behavior:

- one user may apply a specific reaction once
- duplicate reactions are rejected or idempotent
- removing a reaction removes the user's reaction
- deleting the message removes associated reactions
- authorized clients receive realtime updates

Conceptual endpoints:

```text
POST /api/messages/:messageId/reactions
DELETE /api/messages/:messageId/reactions/:reaction
```

Required authorization:

- authenticated
- able to view the message/channel
- allowed to interact

Expected errors:

```text
401 unauthenticated
403 unauthorized
404 inaccessible/not found
409 duplicate reaction where non-idempotent behavior is used
429 rate limited
```

---

# 20. REPLIES AND THREADS

If threads/replies are added, they must be real persisted relationships.

A reply must identify its parent message.

A thread must have:

- parent message
- participating messages
- permissions
- unread state where applicable
- notifications
- realtime updates

Do not simulate threads entirely through frontend state.

---

# 21. DIRECT MESSAGES

DM conversations must remain isolated.

Users must only access conversations where they are members.

Existing DM functionality must be preserved.

Support where already implemented:

- creation
- message retrieval
- sending
- editing
- deletion
- read state
- realtime events

Do not leak DM data through discovery, server APIs, member APIs, or notifications.

---

# 22. FRIENDS

Friends/friend requests must remain separate from server membership.

Support:

- request
- accept
- reject
- cancellation where applicable
- friendship
- removal
- relevant notifications

Do not expose private friendship state unnecessarily.

---

# 23. NOTIFICATIONS

Notifications are persistent user-specific events.

Each notification must have:

- recipient
- type
- relevant target/reference
- creation timestamp
- read/unread state

Notifications must be created only for events that require them.

Do not create duplicate notifications for the same event.

Unread counts must not require expensive full-history queries on every UI update.

---

# 24. INVITES

Invites must support:

- creation
- validation
- expiration
- usage limits
- revocation
- joining
- invalid invite handling

Invite access must respect server visibility and membership rules.

---

# 25. DISCOVERY

Public discovery must only expose information intentionally marked public.

Discovery results must be:

- paginated
- bounded
- searchable where appropriate
- efficiently queried

Private communities must not appear through accidental API leakage.

---

# 26. AUTHENTICATION

Authentication must include:

## Registration

- validate input
- hash password
- create account
- record required legal acceptance
- return appropriate authentication state

## Login

- locate account
- verify password
- enforce account status
- issue authenticated session/token
- return only permitted account information

## Logout

- invalidate the relevant authenticated state where the existing architecture requires it

## Password changes

- require authentication
- verify current credentials where appropriate
- invalidate appropriate sessions if required

## Password reset

- use single-use reset tokens
- enforce expiration
- never reveal whether arbitrary accounts exist through unsafe responses

---

# 27. ACCOUNT VERIFICATION

If email verification exists:

- verification tokens must expire
- tokens must be single-use
- verification state must be server-authoritative
- repeated verification must be handled safely

Do not store verification tokens as plaintext if the existing security architecture permits secure hashing.

---

# 28. TRUST & SAFETY PLATFORM MODEL

Trust & Safety is separate from server moderation.

Define:

```text
Platform Administrator
        │
        ├── User enforcement
        ├── Server enforcement
        ├── Reports
        ├── Appeals
        └── Platform audit logs
```

versus:

```text
Server Administrator / Moderator
        │
        └── Specific server only
```

A server moderator must not gain platform-wide authority.

---

# 29. REPORT

A Report represents a user-submitted or system-generated Trust & Safety case.

Conceptual properties:

```text
id
reporter_id
target_type
target_id
reason
description
status
assigned_admin_id
created_at
updated_at
resolved_at
resolution
```

Statuses:

```text
OPEN
INVESTIGATING
RESOLVED
DISMISSED
```

Do not expose internal reports to ordinary users.

---

# 30. MODERATION ACTION

A moderation action records platform enforcement.

Possible action types:

```text
WARNING
SUSPENSION
ACCOUNT_BAN
SERVER_SUSPENSION
SERVER_REMOVAL
```

If IP enforcement is implemented, treat IP data as security-sensitive.

Every enforcement action must record:

- actor
- target
- type
- reason
- timestamp
- expiration where applicable
- relevant case/report

---

# 31. ACCOUNT ENFORCEMENT

When an account is suspended or banned:

1. Update authoritative account state.
2. Invalidate unauthorized sessions.
3. Disconnect active WebSocket sessions.
4. Prevent new authentication.
5. Prevent protected API access.
6. Record the action.
7. Preserve relevant audit information.

Do not rely only on client-side logout.

---

# 32. SERVER ENFORCEMENT

When a community is suspended:

- prevent normal access according to enforcement state
- prevent new membership where appropriate
- preserve administrative case data
- inform affected users appropriately
- audit the action

Do not physically delete data when suspension is sufficient.

Deletion is a separate destructive operation.

---

# 33. APPEALS

Appeals must be persistent.

Conceptual properties:

```text
id
user_id
action_id
reason
status
created_at
updated_at
reviewer_id
decision
```

Statuses:

```text
OPEN
UNDER_REVIEW
APPROVED
DENIED
```

Only authorized administrators may review appeals.

---

# 34. ADMIN AUDIT LOG

Every high-impact Trust & Safety action must produce an audit record.

At minimum:

```text
actor
action
target
reason
timestamp
```

Audit records must not be editable by ordinary administrators.

---

# 35. ADMIN DASHBOARD

The dashboard must have actual backend integration.

Required sections:

```text
Overview
Reports
Users
Servers
Enforcement
Appeals
Audit Logs
```

## Overview

Display useful aggregate information from actual data.

Do not create fake metrics.

## Users

Allow authorized administrators to:

- search
- inspect account state
- inspect enforcement
- issue warnings
- suspend
- ban where authorized

## Servers

Allow authorized administrators to:

- search
- inspect
- suspend
- remove where authorized

## Reports

Allow:

- filtering
- sorting
- opening a report
- assignment
- resolution
- dismissal

---

# 36. ADMIN SECURITY

Every administrative endpoint must verify platform administrator authority server-side.

Do not trust:

```text
isAdmin=true
```

from the client.

Do not rely on hidden UI buttons.

Do not expose administrative API responses to ordinary users.

Destructive operations require:

- explicit confirmation
- authorization
- audit record
- reason

---

# 37. PERFORMANCE SPECIFICATION

Use:

```text
Measure
→ identify bottleneck
→ understand cause
→ optimize
→ benchmark
→ verify correctness
→ measure again
```

Do not claim performance improvements without measurement.

---

# 38. DATABASE PERFORMANCE

Audit:

- indexes
- joins
- transactions
- query counts
- connection pools
- repeated queries
- N+1 queries
- full-table scans
- unnecessary writes

Prioritize high-frequency paths:

```text
authentication
server loading
channel loading
message loading
message sending
DM loading
notifications
membership
permissions
WebSockets
discovery
```

---

# 39. INDEX RULE

Every index must have a reason.

Common high-value access patterns include:

```text
messages by channel + time
DM messages by conversation + time
members by server
roles by server
member roles by member/server
notifications by recipient + unread/time
friend requests by recipient/status
invites by server/code
attachments by message
```

Use actual query analysis before adding indexes.

---

# 40. N+1 RULE

Search explicitly for:

- database queries inside loops
- permission queries per member
- role queries per user
- message queries per message
- notification queries per item

Replace repeated queries with:

- joins
- batching
- preloading
- bounded caching

only where this preserves correctness.

---

# 41. DATABASE CONNECTION MANAGEMENT

Ensure:

- bounded pools
- proper release
- transaction cleanup
- no per-request pool creation
- no leaked connections
- predictable startup

MySQL production must remain supported.

SQLite development must remain supported where the current architecture requires it.

---

# 42. API RESPONSE EFFICIENCY

Do not return:

- unused private fields
- passwords
- password hashes
- private tokens
- internal database details
- unnecessary nested objects

Avoid oversized response payloads.

---

# 43. WEBSOCKET CONTRACT

The WebSocket gateway must:

- authenticate connections
- reject invalid credentials
- use the existing short-lived ticket mechanism where present
- enforce payload limits
- enforce socket limits
- enforce rate limits
- heartbeat connections
- remove dead sockets
- scope events correctly

Do not put long-lived JWTs into WebSocket URLs.

Do not reintroduce insecure legacy token query parameters if the current implementation intentionally removed them.

---

# 44. WEBSOCKET EVENT FORMAT

Realtime events must be structured consistently.

Conceptually:

```json
{
  "type": "event.name",
  "data": {}
}
```

Every event must define:

- event name
- payload
- audience
- authorization requirement
- source
- client behavior

Do not invent event names arbitrarily when an existing event already represents the behavior.

---

# 45. REALTIME EVENT CATEGORIES

Distinguish:

## Durable events

Events representing persistent state:

- message created
- message edited
- message deleted
- reaction changed
- membership changed
- role changed
- channel changed

## Ephemeral events

Events such as:

- typing
- presence
- temporary UI state

Do not persist ephemeral events unnecessarily.

---

# 46. RECONNECT

On reconnect:

1. authenticate
2. restore valid subscriptions
3. synchronize necessary durable state
4. prevent duplicate events
5. restore relevant unread state
6. stop retrying after appropriate failure conditions

Use backoff.

Do not reconnect in a tight loop.

---

# 47. CLIENT STATE

Inspect the existing state architecture.

Maintain clear separation between:

- authentication state
- instance configuration
- server state
- channel state
- message state
- DM state
- notification state
- UI state
- theme state
- navigation state

Do not place server-authoritative state permanently into unrelated UI components.

---

# 48. NAVIGATION MODEL

Trycord navigation has two modes.

## Dynamic

Compact contextual navigation.

## Full

Complete navigation hierarchy.

Dynamic is the default compact state on mobile.

Full reveals the broader navigation tree.

---

# 49. MOBILE NAVIGATION

Mobile must preserve the existing functional structure.

Required bottom navigation destinations may include:

```text
Home
DMs
Browse
You
```

depending on the current implementation.

Do not remove currently functional destinations merely to simplify the redesign.

---

# 50. FULL NAVIGATION

Full mobile navigation must support:

```text
Navigate
    Home
    DMs
    Discover
    Friends

Communities
    community list
    New Server

Current Community
    Invite
    Add Channel
    Settings
    channel list
```

Only display items that are actually applicable.

Do not show administrative actions to unauthorized users.

---

# 51. MOBILE GESTURES

Full navigation:

### Open

Allowed triggers:

- edge swipe toward the navigation panel
- explicit menu control
- explicit expand control

### Close

Allowed triggers:

- swipe away
- tap outside
- backdrop tap
- back action
- close control

Incomplete gestures must restore the previous state.

---

# 52. NAVIGATION THRESHOLDS

Use configurable constants:

```text
OPEN_THRESHOLD
CLOSE_THRESHOLD
VELOCITY_THRESHOLD
MAX_DRAG_DISTANCE
```

Do not scatter magic numbers throughout gesture handlers.

---

# 53. NAVIGATION PRIORITY

Use:

```text
active gesture
↓
explicit user action
↓
back action
↓
route change
↓
responsive change
```

Do not automatically switch navigation modes repeatedly during window resizing.

---

# 54. DEEP LINKS

Deep links should:

- resolve to the requested destination
- establish the correct context
- avoid unnecessary navigation animations
- not trigger navigation loops
- respect authentication
- respect permissions

---

# 55. DESKTOP ARCHITECTURE

Desktop is not simply the mobile UI enlarged.

The intended desktop structure is:

```text
Presence Spine
        │
        ▼
Atrium / Conversation
```

The desktop should not be a generic Discord clone.

Avoid a default:

```text
tiny icon rail
+
generic sidebar
+
generic centered chat
```

unless the existing design specifically requires an element.

---

# 56. PRESENCE SPINE

The Presence Spine communicates:

- identity
- Home
- DMs
- Activity
- community presence
- current context

It should visually connect the user to the current location.

---

# 57. ATRIUM

The Atrium is the main content area.

It contains the current:

- home experience
- conversation
- channel
- community view
- settings/content surface

It should use available viewport space efficiently.

---

# 58. DESKTOP VISUAL DIRECTION

Use the established visual direction:

```text
charcoal depth
amber/orange ambient energy
liquid-glass surfaces
refined gradients
restrained shadows
excellent typography
subtle glow
layered depth
```

Target feel:

```text
blur: controlled
glass: strong
shadows: restrained
gradients: expressive
glow: restrained
motion: fluid
```

Do not turn the interface into a neon dashboard.

---

# 59. LIQUID GLASS RULES

Liquid Glass means:

- translucent layers
- controlled blur
- depth
- specular highlights
- subtle internal gradients
- rounded geometry
- restrained borders
- ambient color interaction

It does **not** mean:

- every element is transparent
- every element glows
- every button has a gradient
- excessive blur
- unreadable low-contrast text

Use glass to communicate hierarchy.

---

# 60. DESIGN TOKENS

Do not scatter visual constants throughout components.

Centralize tokens for:

- colors
- spacing
- radius
- typography
- shadows
- blur
- opacity
- transitions
- motion
- z-index
- breakpoints

Themes must override tokens rather than requiring component rewrites.

---

# 61. THEMES

The intended theme ecosystem includes:

```text
Trycord
Orthocord
Midnight
Ember
Light
High Contrast
Custom
```

A theme is a visual configuration.

It is not a separate application.

Theme switching must actually modify the UI.

---

# 62. HIGH CONTRAST

High Contrast must prioritize readability.

Do not simply invert colors.

Ensure:

- readable text
- visible controls
- visible focus
- visible active states
- visible borders
- usable disabled states

---

# 63. ACCESSIBILITY

All interactive UI must support:

- keyboard navigation
- visible focus
- semantic controls
- accessible labels
- reduced motion
- sufficient contrast
- appropriate touch targets
- accessible dialogs
- correct focus restoration

---

# 64. REDUCED MOTION

When reduced-motion preferences are enabled:

- reduce or remove large transitions
- remove unnecessary parallax
- reduce spring movement
- preserve functional state changes

Do not make the application unusable.

---

# 65. MESSAGE UI

The message interface must clearly distinguish:

- author
- timestamp
- message content
- edited state
- attachments
- replies
- reactions
- system events

Actions should appear contextually.

Do not force every action into permanent visual clutter.

---

# 66. MESSAGE EDITING

Editing must:

1. verify author or permission server-side
2. update the persistent message
3. return/update the changed message
4. notify relevant realtime clients
5. update only the affected UI element

Do not reload the entire channel.

---

# 67. MESSAGE DELETION

Deletion must:

1. verify authorization
2. modify persistent state
3. notify relevant clients
4. update only affected UI

Do not expose deleted content to newly authorized clients unless the product explicitly requires retained moderation visibility.

---

# 68. SCROLLING

When loading older messages:

- preserve scroll position
- avoid jumps
- do not reload all messages
- avoid duplicate DOM nodes

When a new message arrives:

- if the user is at the bottom, keep them at the bottom
- if they are reading older content, do not forcibly scroll them

---

# 69. ATTACHMENT UI

Attachments must show appropriate:

- filename
- type
- size
- loading state
- error state
- preview where supported
- download/open action

The UI must not expose internal storage paths.

---

# 70. FILE UPLOAD LIMITS

Preserve server-side validation.

Do not trust frontend restrictions.

The server must independently enforce:

- file size
- allowed types
- upload ownership
- message association
- channel authorization

---

# 71. DATABASE MIGRATIONS

Perform an explicit comparison between:

```text
schema
migration script
initialization
check script
seed script
production database requirements
```

Any persistent feature added during this overhaul must be represented in migration logic.

Do not leave tables only in initialization while migration paths remain unaware of them.

---

# 72. MIGRATION RULES

Migrations must:

- be deterministic
- be ordered
- be testable
- preserve existing data
- fail clearly
- not silently skip required changes

Test:

```text
fresh database
existing database
upgraded database
```

---

# 73. LEGAL DOCUMENT SYSTEM

The client must display actual legal documents.

At minimum:

```text
Terms of Service
Privacy Policy
```

Version metadata must be separate from document content.

The current legal version must be consistently used by:

- registration UI
- acceptance storage
- server validation

Do not invent a legal company identity.

Do not invent:

- company number
- physical address
- legal representative
- support address
- registered entity

unless explicitly supplied.

---

# 74. SECURITY HEADERS

Review:

- CSP
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
- frame protections
- HSTS where appropriate

CSP must permit legitimate:

- API connections
- WebSocket connections
- assets
- Electron behavior where applicable

Do not disable CSP simply because something is inconvenient.

---

# 75. CORS

CORS must use an explicit allowlist.

Production should allow the actual public client origin.

Do not use unrestricted:

```text
*
```

for authenticated production requests unless there is a demonstrated safe reason.

---

# 76. PROXY TRUST

If Express or equivalent middleware uses forwarded headers:

- configure trusted proxies deliberately
- do not blindly trust arbitrary client-provided forwarded headers
- ensure rate limiting sees appropriate client identity
- ensure HTTPS detection is correct

---

# 77. CLOUDflare / NGINX

Production must support:

```text
Cloudflare
    ↓
nginx
    ↓
Trycord :9971
```

nginx must:

- serve the configured Trycord site
- proxy normal HTTP traffic
- proxy WebSocket upgrades
- preserve host information
- preserve forwarding information
- use appropriate timeouts

The nginx default page must not remain the production site.

---

# 78. PRODUCTION URL CONSISTENCY

All production configuration must agree on:

```text
https://trycord.dev
```

Audit:

- TRYCORD_PUBLIC_URL
- PUBLIC_URL
- CLIENT_ORIGIN
- WebSocket construction
- API construction
- runtime configuration
- legal links
- email links
- redirects
- Electron configuration

Do not leave old official-domain references active.

---

# 79. ERROR MODEL

API errors must use a consistent structure.

Do not expose:

- stack traces
- SQL queries
- database credentials
- filesystem paths
- internal secrets

Errors should contain enough information for the client to handle them correctly.

---

# 80. RATE LIMITING

Rate-limit expensive and abuse-prone actions.

At minimum audit:

- registration
- login
- password reset
- messages
- uploads
- friend requests
- invites
- reports
- discovery/search
- WebSocket events
- administrative actions

Do not rate-limit ordinary usage so aggressively that the application becomes frustrating.

---

# 81. RESOURCE LIMITS

Audit:

- JSON body size
- WebSocket payload size
- attachment size
- attachments per message
- sockets per user
- request concurrency
- pagination limits
- discovery result limits

Limits must be enforced server-side.

---

# 82. MEMORY SAFETY

Search for:

- unbounded arrays
- unbounded Maps
- unbounded Sets
- cached request results
- stale event handlers
- abandoned timers
- abandoned sockets
- detached DOM trees

Navigation between pages must not continually increase memory usage.

---

# 83. CLIENT NETWORK BEHAVIOR

The client must avoid:

- duplicate requests
- request storms
- reconnect storms
- repeated full-state downloads
- unnecessary polling
- redundant configuration requests

Use REST for durable state.

Use WebSockets for realtime events.

Do not refetch entire application state after every realtime event.

---

# 84. PERFORMANCE ACCEPTANCE

Before and after optimization, measure where practical:

```text
startup
authentication
server loading
channel loading
message loading
message sending
DM loading
discovery
notification loading
WebSocket connection
WebSocket events
reconnect
attachment upload
client rendering
memory
CPU
```

Record meaningful improvements.

---

# 85. LOAD TESTING

Test realistic scenarios:

### Scenario A
Many users connected.

### Scenario B
Many users in one active channel.

### Scenario C
High message volume.

### Scenario D
Mass reconnect.

### Scenario E
Many simultaneous logins.

### Scenario F
Attachment uploads.

### Scenario G
Discovery traffic.

### Scenario H
DM traffic.

Observe:

- latency
- CPU
- memory
- DB connections
- event throughput
- errors

---

# 86. FAILURE TESTING

Test:

- database unavailable
- database slow
- WebSocket disconnect
- upload failure
- malformed requests
- expired token
- banned account
- deleted server
- deleted channel
- invalid invite
- invalid attachment
- client reconnect
- nginx restart
- backend restart

The application must fail predictably.

---

# 87. ELECTRON

Electron must:

- start reliably
- load the correct client
- communicate with the correct backend
- avoid duplicating server logic
- handle navigation
- handle authentication
- handle updater behavior
- clean up windows/listeners

Do not create an Electron-only feature that should belong to the core client unless explicitly justified.

---

# 88. MOBILE REGRESSION

After desktop/UI work, explicitly test:

- home
- DMs
- browse
- friends
- account
- communities
- channels
- messages
- attachments
- navigation
- gestures
- back behavior
- theme switching

Desktop work must not silently destroy mobile behavior.

---

# 89. DESKTOP REGRESSION

Explicitly test:

- Presence Spine
- Atrium
- communities
- channels
- messages
- DMs
- settings
- account
- attachments
- navigation
- keyboard controls
- resizing
- realtime

---

# 90. STALE CODE AUDIT

Search for:

- old UI imports
- deleted component references
- duplicate component systems
- stale routes
- obsolete API helpers
- unused services
- unused styles
- dead files
- old domain references
- old backend URLs
- old WebSocket URLs

Do not delete a file merely because its name looks obsolete.

Verify references first.

---

# 91. NO DUPLICATE ARCHITECTURES

At the end there must not be competing systems for:

- state
- routing
- API access
- WebSockets
- themes
- navigation
- message rendering
- authentication

unless the separation is intentional and documented.

---

# 92. TESTING CONTRACT

Test each feature at three levels where practical:

```text
backend correctness
API/realtime behavior
UI behavior
```

A UI feature is not complete if the backend does not support it.

A backend feature is not complete if the user-facing workflow is broken.

---

# 93. ACCEPTANCE TEST: AUTHENTICATION

Verify:

1. Register.
2. Legal versions are accepted.
3. Account is created.
4. Login succeeds.
5. Authenticated requests succeed.
6. Logout behaves correctly.
7. Session invalidation works.
8. Password changes work.
9. Reset flow works if configured.
10. Suspended/banned accounts cannot authenticate normally.

---

# 94. ACCEPTANCE TEST: COMMUNITY

Verify:

1. Create server.
2. Owner membership exists.
3. Default role exists.
4. Default category exists.
5. Default channel exists.
6. Invite works.
7. Another account joins.
8. Member list updates.
9. Roles work.
10. Permissions work.
11. Channel visibility works.
12. Leaving works where allowed.
13. Owner cannot improperly leave/destroy ownership state.

---

# 95. ACCEPTANCE TEST: MESSAGING

Verify:

1. Open channel.
2. Load paginated messages.
3. Send message.
4. Other client receives realtime event.
5. Edit message.
6. Other client receives update.
7. Delete message.
8. Other client receives deletion.
9. Attach file.
10. Verify authorization.
11. Load older messages.
12. Scroll position remains stable.

---

# 96. ACCEPTANCE TEST: DMs

Verify:

1. Create/open DM.
2. Send message.
3. Recipient receives realtime message.
4. Read state updates.
5. Edit/delete according to permission.
6. Unauthorized users cannot access the conversation.

---

# 97. ACCEPTANCE TEST: TRUST & SAFETY

Verify:

1. Ordinary user cannot access admin dashboard.
2. Community moderator cannot access platform administration.
3. Authorized administrator can view reports.
4. Administrator can resolve a report.
5. Warning is persisted.
6. Suspension is persisted.
7. Account sessions are invalidated.
8. WebSocket sessions are disconnected.
9. Ban prevents new authentication.
10. Audit record is created.
11. Appeal can be submitted where applicable.
12. Unauthorized administrators cannot exceed their permissions.

---

# 98. ACCEPTANCE TEST: NAVIGATION

Verify:

### Dynamic

- default state is correct
- contextual navigation works

### Full

- opens through explicit control
- opens through edge swipe
- closes through swipe
- closes through outside tap
- closes through back
- closes through close control

### Edge cases

- incomplete swipe
- canceled gesture
- route change
- deep link
- reconnect
- responsive resize

No navigation loop may occur.

---

# 99. ACCEPTANCE TEST: THEMES

Verify each available theme actually changes:

- surfaces
- text
- accents
- controls
- navigation
- messages
- backgrounds

Verify:

- persistence
- switching
- accessibility
- high contrast

---

# 100. ACCEPTANCE TEST: PRODUCTION

Verify:

```text
https://trycord.dev
```

loads the actual Trycord application.

Verify:

```text
/api/health
```

works.

Verify:

```text
wss://trycord.dev
```

can establish the intended realtime connection.

Verify nginx is not serving its default page.

Verify Cloudflare/proxy behavior.

Verify the application does not generate mixed-content HTTP requests.

---

# 101. FINAL SECURITY CHECK

Before completion, search the repository for accidentally exposed:

```text
JWT_SECRET
DB_PASSWORD
SMTP_PASSWORD
API keys
private tokens
test credentials
hardcoded passwords
```

Remove secrets from source control.

Use environment variables.

Never print secrets in logs.

---

# 102. FINAL DOMAIN CHECK

Search the repository for obsolete production origins.

Find and review:

```text
trycord.wispbyte.app
trycord.wisp.uno
http://
ws://
localhost
127.0.0.1
```

Do not blindly replace development references.

Determine whether each reference is:

- development-only
- production
- documentation
- test
- obsolete

Production must use the intended secure origin.

---

# 103. FINAL DATABASE CHECK

Compare:

```text
schema
migrations
checks
services
routes
```

Every persistent feature must be represented consistently.

No service should depend on a table that fresh installation cannot create.

No migration should omit a table required by production.

---

# 104. FINAL UI CHECK

Search for:

- dead buttons
- fake settings
- broken links
- missing loading states
- missing error states
- inaccessible controls
- broken mobile layouts
- broken desktop layouts
- overflowing content
- navigation traps
- duplicate navigation
- obsolete UI components

Every visible control must have an intentional behavior.

---

# 105. FINAL PERFORMANCE CHECK

After implementation:

1. Repeat the original baseline.
2. Compare results.
3. Identify regressions.
4. Fix regressions.
5. Repeat the measurements.

Do not declare success merely because the application starts.

---

# 106. FINAL REPOSITORY CLEANUP

Remove only verified obsolete:

- code
- imports
- components
- styles
- routes
- utilities
- experiments
- debugging statements

Do not delete files based solely on filenames.

---

# 107. FINAL REPORT

At completion, provide a factual implementation report.

Use exactly these sections:

```text
ARCHITECTURE
DATABASE
BACKEND
WEBSOCKET
PERFORMANCE
TRUST & SAFETY
COMMUNITIES
MESSAGING
DMs / FRIENDS
NAVIGATION
MOBILE
DESKTOP
THEMES / DESIGN SYSTEM
SECURITY
LEGAL
ELECTRON
DEPLOYMENT
TESTING
REMAINING ISSUES
```

For each section:

- state what was actually implemented
- state what was modified
- state what was tested
- state what remains incomplete

Never describe an unimplemented feature as completed.

---

# 108. IMPLEMENTATION CHECKPOINTS

After each major subsystem:

1. Run relevant checks.
2. Verify imports.
3. Verify server startup.
4. Verify affected API routes.
5. Verify database consistency.
6. Verify affected UI.
7. Verify mobile if UI changed.
8. Verify desktop if UI changed.
9. Fix regressions before continuing.

Do not accumulate dozens of untested changes and only test at the end.

---

# 109. STOP CONDITIONS

Do not stop simply because:

- the UI looks finished
- the server starts
- one API route works
- one screenshot looks correct
- tests compile
- a feature has a database table
- a button exists

A feature is complete only when its complete path works:

```text
database
↓
service
↓
authorization
↓
API / WebSocket
↓
client state
↓
UI
↓
user interaction
↓
persistence
↓
realtime synchronization
```

where applicable.

---

# 110. FINAL PRODUCT DEFINITION

At the end of this overhaul, Trycord should be a coherent platform with:

## Identity

- accounts
- authentication
- sessions
- verification
- account lifecycle

## Communities

- servers
- memberships
- roles
- permissions
- categories
- channels
- invites
- discovery
- onboarding

## Communication

- messages
- pagination
- editing
- deletion
- attachments
- reactions
- replies/threads where implemented
- mentions
- DMs
- friends
- notifications

## Trust & Safety

- reports
- platform administrators
- warnings
- suspensions
- bans
- server enforcement
- appeals
- audit logs

## Realtime

- authenticated WebSockets
- scoped events
- presence
- typing
- reconnect
- backpressure
- rate limiting

## Client

- mobile experience
- Dynamic navigation
- Full navigation
- desktop Presence Spine
- desktop Atrium
- themes
- Liquid Glass design system
- accessibility

## Infrastructure

- MySQL production
- SQLite development where supported
- complete migrations
- health checks
- Cloudflare compatibility
- nginx compatibility
- HTTPS
- WSS
- secure configuration

---

# 111. ABSOLUTE FINAL RULE

Do not interpret this specification as permission to invent additional product features.

Do not expand the scope merely because another feature would be interesting.

Do not replace working systems unnecessarily.

Do not fabricate missing APIs.

Do not fabricate database structures without determining whether they are actually required.

Do not claim success without testing.

Do not hide failures.

Do not leave broken partial implementations behind.

When something already exists, **inspect it first**.

When something is missing, **implement it explicitly**.

When something is ambiguous, **follow the existing architecture and document the decision**.

When something is broken, **fix the root cause rather than masking the symptom**.

When something is performance-sensitive, **measure it**.

When something is security-sensitive, **enforce it server-side**.

When something is user-visible, **make sure it actually works**.

When something is persistent, **make sure migrations support it**.

When something is realtime, **make sure authorization and synchronization are correct**.

When something is UI-only, **do not pretend it is backend functionality**.

---

# FINAL EXECUTION ORDER

Execute the entire specification in this order:

```text
1. Repository inspection
2. Architecture reconciliation
3. Baseline measurements
4. Database correctness
5. Backend correctness
6. Authentication / authorization
7. Performance optimization
8. WebSocket optimization
9. Community capabilities
10. Messaging capabilities
11. DMs / friends / notifications
12. Trust & Safety
13. Migration completion
14. Security hardening
15. Shared design system
16. Mobile navigation
17. Desktop architecture
18. Themes
19. Electron
20. Production / Cloudflare / nginx compatibility
21. Full regression testing
22. Performance re-measurement
23. Security audit
24. Repository cleanup
25. Final acceptance testing
26. Final implementation report
```

Do not reorder these phases unless a dependency in the actual repository requires it.

If a later phase requires a foundation from an earlier phase, complete the earlier phase first.

**This is one complete engineering task. Do not wait for another prompt between phases.**

The final standard is:

> **If a real user can click it, it must work. If the backend exposes it, it must be authorized. If it persists data, migrations must support it. If it is realtime, synchronization must work. If it claims to be optimized, measure it. If it claims to be complete, test it.**
# TRYCORD HOSTING MODES

Trycord must support two explicit deployment modes:

```text
SERVER_HOST_TYPE=express
SERVER_HOST_TYPE=nginx
```

The hosting mode controls how the public HTTP/HTTPS layer is provided.

It must **not** change the application's core API, authentication, database, authorization, or WebSocket architecture.

---

## 1. EXPRESS MODE

Configuration:

```env
SERVER_HOST_TYPE=express
```

In Express mode, the Trycord Node.js server is the directly exposed HTTP server.

Express is responsible for:

- REST API
- WebSocket endpoint
- authentication
- authorization
- health endpoints
- runtime configuration
- web client static files where supported by the existing implementation

Example:

```text
Internet
    ↓
Trycord Express
    ↓
API / WebSocket / Client
```

Default backend binding:

```env
HOST=0.0.0.0
PORT=9971
```

This mode must work without nginx.

This mode is intended for:

- development
- simple self-hosting
- hosting providers where nginx is unavailable
- direct-port deployments
- testing

The application must not require nginx to function in this mode.

---

# 2. NGINX MODE

Configuration:

```env
SERVER_HOST_TYPE=nginx
```

In nginx mode, nginx is the public HTTP/HTTPS reverse proxy.

Express remains the application server.

Architecture:

```text
Internet
    ↓
Cloudflare / HTTPS
    ↓
nginx :443
    ├── static client
    ├── /api → Express
    └── /ws → Express
```

Express should normally bind to:

```env
HOST=127.0.0.1
PORT=9971
```

unless the deployment explicitly requires another interface.

The backend must not require public exposure of port 9971 in nginx mode.

---

# 3. NGINX RESPONSIBILITIES

Nginx may handle:

- TLS termination
- HTTPS
- HTTP → HTTPS redirects
- static client assets
- reverse proxying
- WebSocket upgrade
- compression
- caching
- security headers where appropriate
- connection handling

Nginx must NOT become responsible for:

- authentication
- authorization
- permissions
- database operations
- messages
- communities
- moderation
- account state
- application business logic

Those remain in Trycord Express.

---

# 4. API PROXY

In nginx mode:

```text
/api/*
```

must be proxied to the Trycord Express backend.

Example conceptual flow:

```text
https://trycord.dev/api/health
        ↓
nginx
        ↓
http://127.0.0.1:9971/api/health
```

The public URL must remain:

```text
https://trycord.dev
```

The internal port must never need to appear in the browser-facing API URL.

---

# 5. WEBSOCKET PROXY

In nginx mode, the WebSocket endpoint must support proper upgrade handling.

Conceptual flow:

```text
wss://trycord.dev/ws
        ↓
nginx
        ↓
ws://127.0.0.1:9971/ws
```

Nginx must correctly forward:

```text
Upgrade
Connection
Host
X-Real-IP
X-Forwarded-For
X-Forwarded-Proto
```

WebSocket connections must remain authenticated and authorized by Trycord.

Nginx must not bypass Trycord's WebSocket authentication.

---

# 6. PUBLIC URL BEHAVIOR

The client must never construct production URLs from internal server addresses.

The application should resolve its public origin through the existing runtime configuration mechanism.

Examples:

### Express mode

```text
https://example.com:9971
```

### Nginx mode

```text
https://trycord.dev
```

The client must automatically use the configured public origin.

---

# 7. FORWARDED HEADERS

In nginx mode, the Express application must correctly handle reverse-proxy headers.

Relevant headers include:

```text
Host
X-Real-IP
X-Forwarded-For
X-Forwarded-Proto
```

Express proxy trust must be explicitly configured.

Do not blindly trust forwarded headers from arbitrary direct clients.

The configuration must prevent:

- incorrect client IP detection
- broken HTTPS detection
- incorrect rate limiting
- spoofed forwarded headers

---

# 8. SECURITY DIFFERENCES

Express mode:

```text
Internet
    ↓
Express
```

Therefore Express must provide all necessary application-level security.

Nginx mode:

```text
Internet
    ↓
nginx
    ↓
Express
```

Nginx may provide additional network-layer protections, but Express must remain secure even if nginx protections are bypassed.

Never rely on nginx alone for:

- authentication
- authorization
- permission checks
- upload validation
- rate limiting of sensitive operations
- account enforcement

---

# 9. STATIC CLIENT BEHAVIOR

If nginx mode serves the static client directly:

```text
/
    ↓
nginx
    ↓
trycord-client static files
```

then API and WebSocket requests must still be routed to Express.

The client must remain identical regardless of whether nginx or Express serves the static assets.

Do not create two different client implementations.

---

# 10. EXPRESS STATIC CLIENT BEHAVIOR

Express mode may continue serving the web client from the existing Trycord client directory.

Do not remove this capability merely because nginx mode exists.

This is necessary for simple self-hosting.

---

# 11. CONFIGURATION VALIDATION

At startup, validate:

```text
SERVER_HOST_TYPE
```

Allowed values:

```text
express
nginx
```

Any other value must produce a clear startup error.

Example:

```text
Invalid SERVER_HOST_TYPE.
Expected "express" or "nginx".
```

Do not silently fall back to an unexpected mode.

---

# 12. MODE-SPECIFIC VALIDATION

In nginx mode, warn or fail clearly if configuration is obviously inconsistent.

Examples:

- public URL uses an internal port unexpectedly
- client origin conflicts with public URL
- proxy-related configuration is invalid

In Express mode, ensure the configured public origin is reachable through the configured Express listener.

Do not make assumptions about whether TLS is handled by Express unless explicitly configured.

---

# 13. HEALTH CHECKS

The existing health endpoint must work in both modes.

Direct backend:

```text
http://127.0.0.1:9971/health
```

Public nginx deployment:

```text
https://trycord.dev/health
```

Both should ultimately report the same Trycord application health.

---

# 14. DEPLOYMENT DOCUMENTATION

Document both deployment modes.

### Simple deployment

```text
SERVER_HOST_TYPE=express
```

Requires:

- Node.js
- Trycord
- database
- exposed port

### Production reverse-proxy deployment

```text
SERVER_HOST_TYPE=nginx
```

Requires:

- Node.js
- Trycord
- database
- nginx
- TLS
- optional Cloudflare

---

# 15. NO DUPLICATE SERVER

Nginx mode must NOT create a second HTTP application server.

There remains exactly one Trycord application backend:

```text
Trycord Express
```

Nginx is only the public gateway/reverse proxy.

---

# 16. FINAL ACCEPTANCE TESTS

## Express mode

Set:

```env
SERVER_HOST_TYPE=express
```

Verify:

1. server starts
2. health works
3. client loads
4. API works
5. authentication works
6. WebSocket works
7. messages work
8. attachments work
9. DMs work

## Nginx mode

Set:

```env
SERVER_HOST_TYPE=nginx
```

Verify:

1. Express starts on its internal interface
2. nginx starts
3. public HTTPS works
4. client loads
5. `/api/*` reaches Express
6. WebSocket upgrade works
7. authentication works
8. messages work
9. attachments work
10. DMs work
11. forwarded IP behavior is correct
12. HTTPS detection is correct
13. rate limiting remains correct
14. nginx default page is not exposed

---

# 17. IMPLEMENTATION RULE

The two modes must share:

- API
- services
- database
- authentication
- authorization
- WebSocket gateway
- client
- business logic

Only the **public hosting layer** changes.

The correct abstraction is:

```text
Trycord Application
        │
        ├── Express Host Mode
        │
        └── Nginx Reverse-Proxy Mode
```

not:

```text
Trycord Express Application
        +
separate Nginx application
```

Nginx is infrastructure, not a second Trycord backend.