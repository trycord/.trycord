# Trycord Architecture Template

## Canonical source
This architecture is based on the original `trycord-main 4.zip` feature surface. UI work must preserve the existing application functionality and API contracts.

## Non-negotiable rule
**REDO THE UI, DO NOT DOWNGRADE THE APP.** Existing renderers, settings, profile editing, DMs, friends, discovery, community management, roles, categories, invites, moderation, admin, uploads, realtime, email recovery and desktop update controls remain part of the product.

## Application layout
Trycord is a **chat application**, not a dashboard.

Desktop uses a Discord-like communication composition:
1. compact community/server rail
2. contextual channel rail with collapsible categories
3. chat/conversation surface
4. persistent member rail grouped by visible roles

The community channel rail exposes the real server actions the current member is permitted to use. Community menus provide members, roles, categories, invites and server settings without leaving the application shell.

Mobile uses the same route/data architecture with a purpose-built navigation drawer. The drawer must reset desktop grid styles and behave as a true mobile surface, not a squeezed desktop sidebar. Chat remains the primary surface and the drawer is contextual navigation.

Authentication has no application navbar.

## Routing
The client remains hash-routed for browser + desktop compatibility. Preserve all existing routes and aliases. Add routes only when the server already exposes the corresponding capability or the feature is explicitly implemented end-to-end.

Current community management surfaces include:
- `/server/:id`
- `/server/:id/channel/:channelId`
- `/server/:id/channels/new`
- `/server/:id/members`
- `/server/:id/roles`
- `/server/:id/categories`
- `/server/:id/invites`
- `/server/:id/settings`

## Settings
`pages-account.js` is canonical for account/profile settings. Do not remove profile editing, appearance/theme controls, password controls, session controls, email/recovery controls, or desktop update controls.

## Communities
`pages-workspace.js`, `components.js`, `state.js`, and the server membership/role/category/channel routes are canonical. The UI may be redesigned, but data and permission behavior must not be replaced with mock data.

Community capabilities already provided by the server and therefore expected in the UI include:
- channels and channel topics
- categories
- visible members
- role-grouped members
- role CRUD and assignment
- member nicknames
- invites
- community settings
- leave/kick flows
- permissions
- realtime messages

The member list must use real membership + role data. Do not fabricate roles or members.

## Admin
Admin navigation is visible when `State.me.isAdmin` is true. Server-side `/api/admin/*` authorization remains authoritative. Do not turn admin into the default product layout.

## Theme
Default theme: **Ember**.

Theme selection is global and authoritative. All application surfaces must consume semantic theme tokens. Do not introduce hard-coded background, text, border or accent colors in component CSS when an existing token can express the same value.

Supported themes include:
- Trycord
- Orthocord
- Midnight
- Ember
- Light
- High Contrast
- Custom

Custom themes derive the complete application palette from the selected accent + base tone. Switching themes must visually update navigation, communities, channels, chat, members, settings, admin, modals, inputs and public/auth surfaces.

## Public site
Preserve the existing static pages and clean routes: `/welcome`, `/features`, `/docs`, `/download`, `/about`, `/contact`, `/terms`, `/privacy`, `/security`, `/status`, `/404`.

## Email
Email is optional at registration. The client reads only a boolean SMTP capability from `/api/instance`. Credentials never reach the client. Verified recovery remains server-authoritative.

## Runtime
The server uses `better-sqlite3@13`, so the supported Node runtime is **22+**. CI and deployment documentation must not silently target Node 20.

## Validation
Before shipping a change:
- compare file manifest with the source repo
- confirm no original files disappeared unless explicitly requested
- run syntax checks across all JS
- validate imports/exports
- scan routes and local assets
- exercise startup/bootstrap
- test settings and profile routes
- test community channel/member/role/category rendering
- test mobile navigation separately from desktop layout
- test theme switching across every major surface
- test admin visibility and server authorization
- test static clean URLs
- extract the final ZIP and repeat the checks on the extracted tree

**If a UI change breaks an existing feature, restore the feature first, then continue the UI work.**
