# Changelog

All notable changes to `trycord-botjs` are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Added

- A CommonJS build. `require('trycord-botjs')` works, and the package's
  `exports` map points at it; the ESM build is unchanged.
- `client.membersPage()` and `client.messagesPage()`, which return the page
  and the way to the next one: the total, whether another page exists, and
  the cursor for the messages before the ones read.
- `client.community()`, `client.channel()` and `client.roles()`, which read
  the routes the API actually has.

### Fixed

- The resource helpers used the wrong paths. `client.community()` asked for
  `/communities/:id` and read the answer as if it were the community itself,
  while the server answers `{ "community": { ... } }` - so every one of them
  returned undefined fields. `client.commands()` and `client.health()` asked
  for `/applications/:id/...`, which is not a route; the commands and the
  health of an application live under its community.
- The gateway said it was subscribed to whatever it asked for. The server
  answers with the list of events it accepted, and a bot that did not wait for
  that answer could believe it was hearing something it was not. It waits now,
  and it reports what the server accepted.

## 0.1.0

### Added

- The `Client`: one object that holds the token, the REST layer and the
  gateway, and where the events are handled.
- The `REST` layer: the versioned developer API, with typed errors, a
  timeout, a retry policy that does not repeat a write, and a debug hook
  that is given nothing secret.
- The `Gateway`: the application socket, with the ticket handshake, the
  subscription, the heartbeat and a bounded reconnect.
- The core objects — `UserObject`, `MessageObject`, `ChannelObject`,
  `CommunityObject` — and the helpers that read the server's two spellings
  of one field.
- The `Events` names, taken from the ones the server sends.
- `client.registerCommand` and `client.removeCommand`, for the commands a
  community's bot answers.
