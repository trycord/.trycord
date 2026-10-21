# Changelog

All notable changes to `trycord-botjs` are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
