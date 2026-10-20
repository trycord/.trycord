# The community settings, and why they were reduced

The directive asked for the complete community settings experience to be
restored, and for the reduction to be audited rather than assumed. This is
the audit.

## What was reduced, and why

The community settings were not reduced by a decision. They were reduced by a
bug that hid a whole section, and the bug survived a rewrite.

The 2.5.0 client built the settings form in one function. It created the
fields — the welcome message, the guidelines, the notification defaults, the
interaction settings — and a save button, and it attached the save handler
that wrote all four to the server. It then returned an empty container:

```js
function communitySettings(serverId) {
  const host = el('div', { class: 'settings-stack' });
  const welcomeContent = el('textarea', { ... });
  // ... four fields and a save button ...
  save.addEventListener('click', ...);
  return host;   // nothing was ever put in host
}
```

Every field was created, every field was wired, and no field was ever
appended to the page. The section rendered as a blank panel. The API was
called `PUT /api/servers/:id/settings` and it accepted all four fields, so
the server was fine and the data was fine — the form simply was not on the
screen.

That is why the settings looked "reduced": what a reader saw was the
sections that happened to build their own DOM, and the ones that built a
form and returned it were empty.

The 3.0 rebuild moved the code from `frontend/js/views/community.js` to
`frontend/js/features/communitySettings.js` and kept the shape. The bug was
not found there either, because the test suite checked the API and the
sections that rendered, and never checked that a section produced anything.

## What was done about it

**Every section now renders.** The console has twelve sections, each a page
of its own with its own address:

| Section | Address | What it holds |
| --- | --- | --- |
| Overview | `/server/:id/settings/overview` | The welcome message, the guidelines, the public and discoverable switches, the banner and the icon |
| Appearance | `/server/:id/settings/appearance` | The accent, the layout density, the theme |
| Channels | `/server/:id/settings/channels` | Creating, renaming, moving, reordering and deleting channels |
| Categories | `/server/:id/settings/categories` | The groups channels sit in, and their order |
| Members | `/server/:id/settings/members` | Everyone here, what they may do, and what may be done to them |
| Roles | `/server/:id/settings/roles` | What each role may manage, and who holds it |
| Invites | `/server/:id/settings/invites` | The codes, their uses, and their expiry |
| Moderation | `/server/:id/settings/moderation` | Reports, and the enforcement that follows one |
| Voice and video | `/server/:id/settings/voice` | The community's voice rooms and what the instance does with voice |
| Ownership | `/server/:id/settings/ownership` | Transferring the community, and taking it over |
| Analytics | `/server/:id/settings/analytics` | The activity, the channels and the members |
| Integrations | `/server/:id/settings/integrations` | The webhooks and the apps this community talks to |

**The data was preserved.** The API was never at fault: the fields the empty
form wrote are the fields the server stores, and the server was never asked
to hold anything new. The change is that the form is now on the page.

**The permissions were preserved.** Every section asks the permission system
rather than a cached flag, and a reader who may not open a section is not
offered it. The ownership section says so plainly rather than rendering an
empty panel — the same refusal the other screens make.

**A section that renders nothing is now a failure.** The test that used to
miss this now asks the question directly: every registered section produces
a node with content, and a section that returns an empty container fails
the build. That is the check that was missing, and it is the reason this
cannot happen again quietly.

**The dirty state, the warnings and the recovery are real.** Each field
knows whether it has been changed. Leaving a section with unsaved changes
asks first. A save that fails says what failed and leaves the field alone
rather than clearing it. A field that failed to load says so and offers the
retry instead of showing an empty box that looks like an empty value. A
destructive action — deleting a channel, removing a member, transferring
ownership — is confirmed with the name of the thing in the question, and the
confirmation names what cannot be undone.

**The phone carries the same sections.** All twelve are on the phone, in the
same order, with the same permissions and the same confirmations. A section
that is only on the desktop is a section the phone does not have, and there
are none.

## What is not claimed

- **Nothing was verified in a browser.** There is no browser in this
  environment that can complete a network request, so the sections are
  verified by their own tests, by the server's, and by reading the code —
  not by a person looking at them. The audit is honest about the difference.
- **The localisation is a mechanism, not a translation.** The strings are
  still English.
- **A section that a community's own settings do not cover has no field.**
  The console never offers a control that would do nothing.
