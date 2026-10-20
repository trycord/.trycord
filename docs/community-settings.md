# The community settings console

The settings of a community are the console of a community: what it is
called, who may read it, what a newcomer is greeted with, the rules the
members agree to, who is kept out, how other software talks to it, and the
rooms it talks in.

This is what the console is, where each part lives, and what the server
enforces.

## The sections

Twelve sections, in this order. The desk is a studio: the sections are a
rail beside the work. The phone is a screen at a time: the sections are a
strip above it. The sections themselves are the same on both.

| Section | What it holds | Where it lives |
|---|---|---|
| Overview | The name, the description, the join code, public, discoverable, federated, the welcome, the guidelines, the notification defaults, the interaction settings | `frontend/js/features/communitySettings/overview.js`, `frontend/mobile/js/views/communitySettings.js` |
| Appearance | The icon and the banner | `frontend/js/features/communitySettings.js` |
| Channels | The channels: create, rename, reorder, delete | `frontend/js/features/communitySettings.js` (the actions are `frontend/js/community/manage.js`) |
| Categories | The categories, and what each category allows | `frontend/js/features/communitySettings/access.js` |
| Members | The roster | `frontend/js/features/community.js` (composed in `access.js`) |
| Roles | The roles, the catalogue of permissions, who holds what, the order of the roles, and the channel and category overrides | `frontend/js/features/communitySettings/access.js` |
| Invites | The invite codes | `frontend/js/features/community.js` (composed in `access.js`) |
| Moderation | The bans, the timeouts, the removal, the names members go by | `frontend/js/features/communitySettings/moderation.js` |
| Voice | The voice channels, what the instance does with voice, and where the provider is set | `frontend/js/features/communitySettings/voice.js`, `frontend/mobile/js/views/communityVoice.js` |
| Ownership | Handing the community over, and ending it | `frontend/js/features/communitySettings.js` |
| Analytics | What happened here | `frontend/js/features/communitySettings.js` |
| Integrations | The webhooks, the bot applications, their commands, and the secrets they hold | `frontend/js/features/communitySettings/integrations.js` |

The catalogue the two clients share is `frontend/packages/communitySettings.js`.
It names the sections, the routes that configure a community, and the calls
the platform's API module does not carry.

## The routes, and the parity hole

The audit that found the settings incomplete compared the backend's routes
with the client's API methods and found them equal. A method nobody calls
looks exactly like a method somebody calls, so the check could not tell the
difference between a route the console offers and a route the server only
offers to itself.

The parity check in `frontend/tests/community-settings/parity.test.js` asks
the question one level deeper. It reads the routes the server really has -
out of the server's own mounts, so a router the check does not know about
fails the build - and asks whether each one is reachable from the console:

- the console's catalogue names it,
- the call that performs it exists,
- the console's own source refers to that call,
- and some section offers it.

A route added to the server and not to the console fails that check. So does
a route whose call was written but never wired up.

Three kinds of route are deliberately outside it, and the check says why:
the community's lifecycle (creating, joining, leaving), its content (pins),
and the operator's copy of it (the export). The workspace and the community
memory are features of their own, mounted under a community but not settings
of one.

## The federation flag

A community may withdraw from federation while staying public. It is still
readable and it is still listed on Discover, but:

- it produces no outbound event of any kind, and
- it is not listed in the discovery document, so other instances are not
  offered it.

The column is `servers.federated`, and it defaults to one. **A community
that existed before the column was added is federated**, so an operator gains
a control without having to change anything: the column is added with a
default of one and every row that was there before gets it.

The decision is made in one place: `backend/src/services/continuum/rules.js`,
in `communityMayFederate()`. Every publication path asks that question, so
there is no second answer to it anywhere - the relay, the discovery document
and the return direction all go through it.

Two things follow from the rules, and both are the ledger's standing rule
rather than new ones:

- a message written while the community was withdrawn is not federated later,
  exactly as a message written in a private community is not;
- the flag is deliberately **not** part of the fingerprint of a published
  community (`backend/src/services/continuum/relay.js`). A row the rules
  refused is withheld for good, so a flag inside the fingerprint would make
  the first withdrawal permanent: the community could never be published
  again, not even after the operator turned federation back on.

## The voice of a community

The community's part of voice is the channels it has and who may be in them.
The instance's part is the media provider that carries the audio - the mesh,
or something else - and that is not a community's to set. So the voice
section says what the community has, what the instance is doing with voice
right now (including why it cannot be joined when voice is off), and where
the provider is configured: the instance's own configuration screen. There is
no second voice configuration anywhere in the community settings.

## Secrets

A webhook's signing secret and a bot's token are handed out once by the
server and cannot be read back. So the console:

- shows the one copy when it arrives, in a dialog (a sheet on the phone),
  with a way to copy it;
- afterwards shows a mask and the fact that there is a secret;
- offers the actions the server has - a replacement, and a clearing - and
  each of them says what it does before it does it.

Nothing keeps a copy: the client does not store it and the section does not
show it again.

## The behaviour the console keeps

- **Dirty state.** A section knows whether it has unsaved changes and which
  fields are the unsaved ones. The shared bookkeeping is
  `createFormState()` in `frontend/packages/communitySettings.js`.
- **The unsaved-changes warning.** Leaving a section with something typed
  into it asks first: the rail's links ask on the desk, and the strip asks
  on the phone.
- **Loading states.** A section says it is working rather than showing an
  empty form.
- **Error recovery.** A save that fails keeps what was typed and says what
  failed. A read that fails closes the fields that would write over what
  nobody was shown.
- **Confirmation.** A delete, a ban, a removal, a rotation and a clearing
  all ask first, and say what they do.
- **No rewriting of existing content.** The settings are read back and
  shown. A document that does not parse is shown exactly as it is stored,
  with a note about what is wrong and the way out of it; it is never dropped
  and never overwritten. An unchanged box is never written.

## What the server enforces

The console is not the boundary; the server is. A control the reader may
not use is not offered, and the server refuses it as well:

| Action | Permission |
|---|---|
| The identity, the reach, the federation flag | `MANAGE_SERVER` |
| The welcome, the guidelines, the defaults | `MANAGE_SERVER` |
| The channels and the categories | `MANAGE_CHANNELS` |
| The overrides of a channel or a category | `MANAGE_CHANNELS` |
| The roles, their assignment and their order | `MANAGE_ROLES` |
| The invites | `MANAGE_INVITES` |
| The bans and the timeouts | `BAN_MEMBERS` |
| Removing a member | `KICK_MEMBERS` |
| The webhooks, the applications and their commands | `MANAGE_SERVER` |

The checks in `backend/tests/community-settings/` prove the refusals.

## The checks

```
cd frontend && node --test tests/community-settings/
cd backend && node --test "tests/community-settings/*.test.js"
```
