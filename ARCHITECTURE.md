# Trycord Architecture Contract

> **AI / CODING-AGENT INSTRUCTION FILE**
>
> Read this file **before changing Trycord**. Treat it as the architecture contract and functional-preservation specification.
>
> **Core rule: REDESIGN THE UI, DO NOT DOWNGRADE THE APPLICATION.**

## 1. Source of truth

The functional source of truth is the original `trycord-main 4.zip` application surface plus the current working repository.

When changing Trycord:

- Preserve existing functionality unless the user explicitly asks to remove it.
- Preserve existing server APIs, database behavior, authentication, permissions, realtime behavior, desktop behavior, public pages, settings, profile controls, and moderation/admin capabilities.
- Prefer extending existing routes and modules over inventing parallel systems.
- Do not delete a file simply because the new UI does not import it.
- Do not replace working functionality with mock data, placeholder routes, fake members, fake roles, or fake API responses.
- Do not invent database fields, API fields, permissions, Prisma models, or relations.
- If a feature is broken, diagnose the actual cause and repair it before changing unrelated functionality.

### Required workflow for an AI agent

1. Inspect the existing implementation.
2. Map the relevant route, API, state, and renderer.
3. Make the smallest functional change required.
4. Redesign presentation independently where possible.
5. Validate imports/exports and route contracts.
6. Run syntax/static checks.
7. Exercise the affected runtime path.
8. Re-check the feature after the UI change.
9. Never report a fix as complete without verification.

---

## 2. Product identity

Trycord is a **chat/community application**.

It is **not** a dashboard, analytics product, admin panel, or card-grid application.

The primary experience is communication:

**communities → channels → conversations → members**

Administrative and account surfaces are secondary destinations.

---

## 3. UI architecture

### Desktop

The primary workspace is a four-part communication layout:

```text
┌────────┬────────────────┬────────────────────────────┬──────────────┐
│ Server │ Channel /      │                            │ Members      │
│ Rail   │ Context Rail   │ Chat / Conversation        │ / Roles      │
│        │                │                            │              │
│  🟧    │ Categories     │ Messages                   │ OWNER        │
│  🟧    │ # channels     │ Messages                   │ ADMIN        │
│  🟧    │                │ Composer                   │ MODERATOR    │
└────────┴────────────────┴────────────────────────────┴──────────────┘
```

Rules:

- The chat surface is the visual priority.
- The server/community rail is compact.
- The channel rail is contextual to the selected community.
- The desktop member rail is visible and uses real member/role data.
- Members are grouped by visible roles where role information is available.
- Community actions live in the contextual community UI, not in a dashboard.

### Mobile

Mobile is **not** a scaled desktop grid.

Use a purpose-built navigation drawer/surface:

- Global navigation: Home, DMs, Discover, Friends, and eligible Admin entry.
- Community list: real communities from application state.
- Community context: channels, categories, invite, members, roles, settings, and permitted management actions.
- Chat remains the primary surface after navigation closes.
- Member browsing is a separate mobile surface/drawer.
- Do not render the desktop member rail inside the navigation drawer.
- Do not keep a giant persistent desktop-style sidebar on mobile.
- Respect iOS safe areas.
- Do not use a persistent bottom navigation bar unless explicitly requested.

### Authentication

Login, registration, recovery, and other authentication pages have **no application navigation bar**.

They are focused auth surfaces.

---

## 4. Routing contract

The client uses hash routing for browser/desktop compatibility unless the repository explicitly migrates away from it.

Preserve existing routes and aliases.

Community routes include, where supported by the existing application:

```text
/server/:id
/server/:id/channel/:channelId
/server/:id/channels/new
/server/:id/members
/server/:id/roles
/server/:id/categories
/server/:id/invites
/server/:id/settings
```

Account/profile/settings routes must remain reachable.

Admin routes must remain reachable for authorized administrators.

Public routes must remain reachable independently of authentication.

Do not create a frontend route that implies backend functionality that does not exist.

If a requested route is missing, inspect the server route table first. Add backend support only when the capability is genuinely required and can be implemented without breaking the existing API contract.

---

## 5. Community system

The community system should provide a familiar Discord-like information architecture without copying proprietary branding/assets.

### Community rail

Show:

- community icon/avatar
- active community state
- community switching
- create community
- discover communities

### Channel rail

Show:

- community name
- community menu
- invite
- categories
- text channels
- other channel types supported by the existing application
- create channel when permitted
- active channel
- collapsed/expanded category state

### Community management

Expose existing functionality for:

- members
- roles
- role assignment
- categories
- channels
- invites
- community settings
- member nicknames
- kick/leave flows
- permissions

Use real API/state data.

### Members

Desktop:

- persistent right-side member list
- grouped by visible role
- role labels/pills
- presence/status where available

Mobile:

- dedicated member surface
- do not cram the member list into the channel drawer

Never fabricate member counts, names, roles, or permissions.

---

## 6. Account and settings preservation

The existing account/settings implementation is functional product surface and must not be removed during UI redesign.

Preserve, where present in the source implementation:

- profile editing
- username/display name controls
- bio/status controls
- avatar upload/remove
- banner upload/remove
- password changes
- session management
- sign-out-all-sessions behavior
- email/recovery controls
- email verification/resend behavior
- appearance settings
- theme selector
- custom theme/palette controls
- update controls
- desktop-specific settings

The settings UI may be completely redesigned, but the underlying capabilities remain.

---

## 7. Theme architecture

### Default theme

**Ember** is the default Trycord theme.

Ember is warm charcoal + brown + ember-orange, not generic blue SaaS styling and not pure black.

### Supported themes

Preserve the application's supported themes, including where present:

- Trycord
- Orthocord
- Midnight
- Ember
- Light
- High Contrast
- Custom

### Theme contract

Theme tokens are authoritative.

Major surfaces must consume semantic tokens for:

- app background
- surface
- elevated surface
- hover/active surface
- border
- primary text
- muted text
- accent
- accent hover
- success
- danger
- channel active state
- role/member styling
- shadows/glows

Do not hard-code a color in component CSS when a semantic theme token exists.

Changing the theme must affect the complete active application UI, including:

- server rail
- channel rail
- chat
- member list
- composer
- settings
- admin
- modals
- forms
- mobile navigation
- auth pages
- public pages

Custom themes must not only recolor one panel. They must override the complete token layer.

---

## 8. Admin architecture

Admin is a privileged application surface, not the default product layout.

Frontend visibility may use the authenticated user's admin state, but **server authorization remains authoritative**.

Never trust a client-side admin flag for authorization.

Preserve existing `/api/admin/*` protections.

Do not expose admin controls to ordinary users merely because a route exists.

---

## 9. Email and recovery

Email is optional at registration.

The browser may read a boolean capability such as SMTP availability from the instance configuration endpoint.

Never expose SMTP credentials to the client.

Verification and password recovery remain server-authoritative.

Registration legal links must point to the current public Terms and Privacy routes, not obsolete legacy legal routes.

---

## 10. Public site

Preserve the public/static site and keep it synchronized with application changes.

Expected clean routes include:

```text
/welcome
/features
/docs
/download
/about
/contact
/security
/status
/terms
/privacy
/404
```

Public pages must:

- use the active design system
- use valid local asset references
- remain usable without authentication
- not import the authenticated chat shell unnecessarily

---

## 11. Backend/API rules

Before adding a backend route:

1. Search the existing route table.
2. Search the existing service/controller implementation.
3. Search the client for existing calls.
4. Reuse an existing capability if it already exists.
5. Add a new endpoint only when there is no suitable existing contract.

Never create duplicate endpoints merely because the UI was redesigned.

Never change a database schema just to make a UI mock easier.

Never invent fields that are not in the existing data model.

---

## 12. Realtime

Preserve the existing realtime/WebSocket architecture.

The UI may change how realtime events are displayed, but it must not silently replace realtime behavior with polling or local-only state.

When adding a new realtime surface:

- identify the existing event/channel contract
- subscribe through the existing realtime layer
- update application state through the established state path
- avoid duplicate listeners

---

## 13. Desktop compatibility

The browser and desktop client share the application route/data architecture unless the repository explicitly requires a platform-specific implementation.

Do not make a browser-only route that breaks the desktop client.

Do not assume `window.location` behavior is identical in browser and desktop contexts.

---

## 14. File preservation rule

When creating a new build from an existing Trycord repository:

- Do not delete original files solely because they are not currently imported.
- Do not silently remove legacy functionality.
- Compare the original file manifest with the output manifest.
- Report intentional additions and deletions explicitly.
- If a file is truly obsolete, prove that no active feature depends on it before removal.

A UI redesign should normally change **presentation**, not shrink the application.

---

## 15. Validation gate

A change is not complete until the affected layers have been checked.

### Static checks

- [ ] JS syntax across client
- [ ] JS syntax across server
- [ ] JS syntax across desktop
- [ ] JSON/config validation
- [ ] import/export consistency
- [ ] duplicate declaration scan
- [ ] stale route scan
- [ ] missing local asset scan

### Functional checks

- [ ] application bootstrap renders
- [ ] auth renders
- [ ] registration renders
- [ ] profile/settings renders
- [ ] theme switching works
- [ ] custom theme applies globally
- [ ] community switching works
- [ ] channel navigation works
- [ ] message/chat surface renders
- [ ] member list renders from real data
- [ ] role display works
- [ ] community management routes work
- [ ] admin visibility works
- [ ] public pages work
- [ ] mobile navigation works independently of desktop
- [ ] desktop layout works independently of mobile

### Packaging checks

After creating a ZIP:

1. Extract the ZIP into a fresh directory.
2. Run the same validation against the extracted directory.
3. Compare its file manifest with the source.
4. Confirm no unexpected files disappeared.
5. Confirm the active entry points reference the files actually included in the archive.

**Never declare a ZIP deploy-ready based only on the pre-packaging working tree.**

---

## 16. Failure-handling rule

If something breaks during a redesign:

**STOP expanding the redesign.**

First:

1. reproduce the failure
2. identify the actual error
3. trace the dependency/route/state path
4. fix the regression
5. rerun the affected checks
6. only then continue with visual work

A blank screen is a failed build, even if the CSS looks perfect.

A beautiful UI with missing functionality is a failed build.

A functioning backend with a broken mobile presentation is also a failed build.

The target is **feature-complete + route-complete + responsive + theme-complete**, not merely visually impressive.

---

## 17. Final instruction to coding agents

Before modifying Trycord, read:

1. `ARCHITECTURE.md`
2. `DESIGN_SYSTEM.md`
3. `README.md`
4. the relevant existing source files

Then follow this rule:

> **Preserve what Trycord can do. Redesign how Trycord does it. Do not downgrade the application to make the redesign easier.**
