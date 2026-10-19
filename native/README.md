# Trycord — native client

A native client for Trycord, for iOS and Android, written as one codebase with
React Native.

This is a separate application, not a wrapper. It has its own navigation, its
own lifecycle, its own storage and its own platform integrations. What it
shares with the web client is the *contract* — the API surface, the shape of
the data, the design tokens — not the interface. The screens here are drawn
for a phone: a bottom tab bar, a stack that slides, a composer above the
keyboard, sheets instead of menus, and a secure keystore for the session.

> **Read [`VERIFICATION.md`](./VERIFICATION.md) before trusting any of this.**
> The environment this was written in has no Xcode, no Android SDK, no Gradle,
> no CocoaPods and no Java. Nothing here has been compiled, run on a device,
> or packaged for a store. The static check that *was* run is described there,
> with its real output.

---

## Technology, and why

**React Native 0.76 (bare), in TypeScript.**

The requirement is two independent native applications that are not "the
desktop layout in a narrow viewport". React Native is the most widely
maintained way to get genuinely native views on both platforms from one
codebase: the components map to `UIView` and `android.view.View`, the
navigation is a native stack with native transitions and native swipe-back,
and the platform modules are real — Keychain, Keystore, APNs, FCM, the
Android share sheet, the iOS document picker.

The alternatives, and why they were not chosen:

| Option | Why not |
| --- | --- |
| **Capacitor** | A genuine native *application* — a native shell, native plugins, native build artefacts, store distribution — but the interface is web content in a webview. The repository already has a strong, purpose-built mobile web module at `frontend/mobile/`. Wrapping that, or wrapping a desktop client, would have produced a second skin for something that already exists rather than a second client. |
| **Kotlin Multiplatform / Compose Multiplatform** | The strongest fit for "independent native experience", and genuinely native on both. It is also a much larger surface to author correctly, with no toolchain here to check any of it: a Compose Multiplatform project with an iOS target, a shared domain module, expect/actual platform modules and a Compose navigation graph would be several times this code, with a much higher chance of shipping something that does not compile. React Native is the choice that is most likely to be correct and runnable the first time it meets a toolchain. |
| **A second web client** | Explicitly excluded by the directive, and already covered by `frontend/mobile/`. |

**The trade-off, stated plainly:** React Native renders its own view layer
through a bridge (or, from 0.76, through the New Architecture's synchronous
bridging). It is not as native as a SwiftUI or Compose application, and the
bridge costs a little performance on a long message list. In exchange, one
codebase reaches both platforms, the native modules are the real ones, and
the project is small enough to be reviewed line by line.

---

## Layout

```
native/
├── README.md              this file
├── VERIFICATION.md        what was checked, and what was not
├── scripts/
│   └── check-native.mjs   the static check: JSON parses, imports resolve
└── app/
    ├── package.json       dependencies and the scripts a developer needs
    ├── tsconfig.json      TypeScript configuration
    ├── babel.config.js    Babel, for Metro and for Jest
    ├── metro.config.js    Metro, the bundler
    ├── jest.config.js     Jest
    ├── .eslintrc.js       ESLint
    ├── index.js           the entry point, registering the app
    ├── app.json           the application name, used by both platforms
    ├── ios/               the iOS project
    │   ├── Podfile
    │   ├── Trycord.xcodeproj/
    │   └── Trycord/
    │       ├── AppDelegate.swift
    │       ├── NotificationPresenter.swift
    │       ├── Info.plist            the trycord:// scheme, background modes
    │       ├── Trycord.entitlements  push, keychain group
    │       ├── LaunchScreen.storyboard
    │       └── Images.xcassets
    ├── android/           the Android project
    │   ├── build.gradle
    │   ├── settings.gradle
    │   ├── gradle.properties
    │   └── app/
    │       ├── build.gradle
    │       ├── src/main/AndroidManifest.xml   the trycord:// intent filter
    │       ├── src/main/java/dev/trycord/app/  MainActivity, MainApplication
    │       └── src/main/res/
    └── src/
        ├── api/           the HTTP client, the endpoint contracts, normalisation
        │                  and the legal versions
        ├── design/        the design tokens
        ├── e2ee/          the server's envelope, the /api/e2ee surface, the adapter
        ├── storage/       the keystore, local storage, the draft store
        ├── deepLinks/     the link parser
        ├── notifications/ the push payload, the transport, the registration
        ├── realtime/      the websocket client
        ├── session/       the instance, the session, the provider
        ├── navigation/    the routes and the navigators
        ├── components/    the shared parts of the interface
        ├── screens/       the screens
        ├── theme/         the theme provider
        ├── util/          formatting and the platform globals
        └── App.tsx        the application root
```

### The parts that carry the contract

- **`src/api/`** — one `request()` and everything goes through it, so
  authorisation, the error envelope, the timeout and the base address are
  decided in one place. `endpoints.ts` names every path, method and body the
  client uses against an instance; `normalize.ts` turns the server's two
  spellings (camelCase from `/api/users/me`, snake_case from the member
  roster) into one shape, so no screen has to know which it is holding;
  `legal.ts` holds the rule that the accepted Terms and Privacy Policy
  versions come from the instance and are never guessed.
- **`src/design/`** — the token values, copied from
  `frontend/assets/trycord-assets/tokens/trycord.css` and
  `frontend/css/tokens.css`. Flame orange `#FF4D24`, the charcoal ground, the
  three steps of text, the spacing scale, the radii, Manrope, the 24-point
  icon grid, the 44-point touch target.
- **`src/e2ee/`** — the versioned envelope and the adapter. **Not
  implemented on purpose**: see the section below.

---

## What is in the app

### Screens

| Screen | What it does |
| --- | --- |
| `SignInScreen` | Username and password, the instance named at the top, an error that says what the server said. |
| `RegisterScreen` | Creates an account. Reads the Terms and Privacy Policy versions from the instance, shows them, and sends the versions it showed — the server refuses a registration whose accepted versions do not match. |
| `TwoFactorScreen` | Two situations: a sign-in that stopped at the second factor (a code from the authenticator), and an instance that asks every account for one (set one up, then the recovery codes). |
| `ForgotPasswordScreen` | Asks the instance for a reset message. The answer is the same whether or not the account exists. |
| `ResetPasswordScreen` | Sets a new password from a reset token. When the account has a second factor the answer is a challenge, not a session: control of the mailbox is not control of the authenticator. |
| `InstancePickerScreen` | The instance is chosen at runtime. An address typed by hand is checked against the instance before it is accepted; the public listing and the recently used addresses are offered. |
| `ConversationsScreen` | The direct conversations, refreshed on focus and when a message arrives on the socket. |
| `ConversationScreen` | One screen for a channel and a direct message: grouped messages, a composer above the keyboard, older messages on scroll, and a catch-up when the connection comes back. |
| `CommunitiesScreen` | The communities the reader belongs to. |
| `CommunityChannelsScreen` | The channels of a community, grouped the way the instance groups them. |
| `MemberListScreen` | The members, searched on the server. |
| `ProfileScreen` | A person: their name, handle, status and biography. |
| `SettingsScreen` | The four groups — account, security, notifications, privacy — and the sign-out. |
| `AccountSettingsScreen` | Display name, status, biography; the address and its verification. |
| `SecuritySettingsScreen` | The password, the second factor, and the account's own list of signed-in devices. |
| `NotificationSettingsScreen` | What the app is told about, quiet hours, and the push switch for this device. |
| `PrivacySettingsScreen` | Who may reach the account, and what it shows. |

### The native integrations

- **Secure credentials.** The session token is written to the platform
  keystore through `react-native-keychain` — the iOS Keychain, and on Android
  the Keystore-backed encrypted preferences. It is filed under the *origin of
  the instance that issued it*, so switching instances can never present one
  instance's token to another, and it is never written to `AsyncStorage`, a
  file, or a URL. `src/storage/secureStore.ts` holds the rules;
  `src/storage/keychain.ts` is the only file that imports the native module.
- **Offline drafts.** What is typed in a composer is written to the local
  store as it is typed, per conversation and per instance, and read back when
  the conversation opens. The draft is removed only when the message reaches
  the server, so a message written with no signal is not lost.
- **Deep links.** The `trycord://` scheme is registered on both platforms
  (the iOS URL type, the Android intent filter) and the parser also reads the
  addresses the web client serves, so a link copied from a browser opens the
  same place. A link to a community, a channel, a message, a conversation or a
  person is understood; a link to a message scrolls the conversation to it.
- **Push notifications, with no content in the payload.** The payload carries
  a version, a kind, the identifiers of where it happened, and an opaque
  reference. There is no field a message could be written into, and the rule
  is executable: `assertPrivacySafe` refuses a payload that carries a
  forbidden key or that carries the text it was built from. The banner is
  generic ("New message"), and the message itself is fetched from the server
  once the app is open and signed in.
- **Realtime.** The socket authenticates with the server's one-use ticket,
  rejoins the room it was in, and backs off when it is dropped. The
  conversation screen catches up on what it missed rather than asking the
  reader to reload.
- **The instance.** A session belongs to an instance. The reader chooses one
  at runtime, the choice is remembered, and moving to another instance
  forgets the session of the one being left.

### Accessibility

- Every control has a role, a label and a state: `accessibilityRole`,
  `accessibilityLabel`, `accessibilityHint`, `accessibilityState`. Icon-only
  buttons carry the name of what they do; the icon itself is decorative and
  hidden from the screen reader.
- Text is a real label bound to its input, so a field announces what it is
  for. Errors are `role="alert"` and live regions, so they are announced
  when they appear.
- Dynamic type is allowed: the type scale scales with the system setting, up
  to 1.8× for body text and 1.6× for inputs, which is where a two-word
  button would stop fitting.
- Touch targets are at least 44 points, with `hitSlop` on the icon-only
  controls.
- The message list groups consecutive messages from one person, and a
  message is one accessible element — author, time and text read together.

---

## Prerequisites

These are React Native 0.76's real requirements. Nothing here was installed or
run in the environment this was written in.

**Both platforms**

- **Node.js 18.18 or newer** (the `engines` field in `package.json` says so;
  Node 20 LTS is the comfortable choice)
- **npm 9 or newer** (or Yarn 1.22+)
- **Watchman** on macOS, recommended by Metro

**iOS (macOS only)**

- **macOS 13 or newer**
- **Xcode 15.1 or newer** — React Native 0.76's minimum deployment target
  is iOS 15.1
- **CocoaPods 1.13 or newer** (`sudo gem install cocoapods`), and the Ruby
  that ships with Xcode or a Homebrew Ruby 2.6+
- A **free or paid Apple developer account** for a device build; a simulator
  build needs only Xcode
- For push notifications: an **APNs key** (.p8) uploaded to the instance's
  app record, and the `aps-environment` entitlement already present in
  `ios/Trycord/Trycord.entitlements`

**Android**

- **JDK 17** — React Native 0.76 requires it
- **Android Studio** (2024.2.1 "Ladybug" or newer)
- **Android SDK Platform 35**, **Build-Tools 35.0.0**, and
  **NDK 27.1.12297006** (the versions in `android/build.gradle`)
- **CMake 3.22.1** from the SDK Manager, for the New Architecture's native
  code
- For push notifications: a **Firebase project** with `google-services.json`
  in `android/app/`. The Gradle build applies the Google Services plugin only
  when that file is present, so the app builds and runs without one — push is
  simply unavailable.

---

## Running it

```bash
cd native/app
npm install                 # no lockfile is committed; this resolves it
```

**iOS** (macOS only)

```bash
cd ios && pod install && cd ..
npm start                   # in one terminal, the Metro bundler
npm run ios                 # in another
```

**Android**

```bash
npm start
npm run android
```

**The checks**

```bash
npm run typecheck   # tsc --noEmit
npm run test        # jest
npm run lint        # eslint
npm run check       # the static import and JSON check (../scripts/check-native.mjs)
```

`npm run check` needs nothing but Node, and it is the one command in this
repository that was actually run while this was written. See
[`VERIFICATION.md`](./VERIFICATION.md).

### Talking to an instance

The app opens on the sign-in screen for `https://api.trycord.dev`. The
instance is chosen at runtime: **Use another instance** on the sign-in
screen, or the instance list on that screen. A development backend on the
developer's own machine is reached by typing its address, for example
`http://localhost:9971`. The iOS release build refuses plain HTTP except for
`localhost`; the Android debug build allows it for the Metro server.

### Signing

Both projects are set up to build unsigned:

- **iOS** — set `PRODUCT_BUNDLE_IDENTIFIER` and the team on the `Trycord`
  target in Xcode, and the `keychain-access-groups` entitlement to the
  developer's own prefix.
- **Android** — a release build is signed only when
  `android/keystore.properties` exists, with `storeFile`, `storePassword`,
  `keyAlias` and `keyPassword` in it. That file is not in the repository. The
  debug build uses the keystore the Android Gradle plugin generates, so no
  key file is kept in the repository at all.

### The fonts

Manrope is the product's typeface. `Info.plist` names `Manrope-Regular.ttf`,
`Manrope-SemiBold.ttf` and `Manrope-Bold.ttf`; the font files are not in this
repository and must be added to `ios/Trycord/` and to the Android
`app/src/main/assets/fonts/` directory, or the platform's default is used
instead.

---

## The end-to-end encryption adapter

The server's protocol is in `backend/src/services/e2ee/` — Trycord E2EE,
version 1 ("TCE2E-v1"), over X3DH and the Double Ratchet on X25519,
Ed25519, HKDF-SHA256 and AES-256-GCM. The native client speaks the same
envelope; what it does not yet have is the cryptography.

- `envelope.ts` — **the server's envelope**, field for field: `v, sid, cid,
  from, to, ctr, dh, iv, ct, tag, hiv, hct, htag`. `readE2eeEnvelope` applies
  the same rules the server's `envelope.js` applies: the version is checked
  and a version this build does not know is refused, every field must be
  present, the counter must be a counter, and the base64url fields must be
  the right length. A client that meets a version it does not implement
  refuses the message; there is no fallback to plaintext.
- `api.ts` — the typed surface of `/api/e2ee`: devices, prekeys, sessions,
  conversation keys, attachments, backup, recovery and safety numbers. Every
  route is named the way the server names it.
- `adapter.ts` — the `E2eeAdapter` interface: `encrypt`, `decrypt`,
  `isEncrypted`, and the protocol version. **The adapter that is wired in
  refuses every call.** It does not encrypt, and it does not pretend to. A
  client that claims to protect a message and quietly sends it in the clear
  is worse than one that admits it cannot.

What has to be wired to it:

1. **A crypto library** that provides X25519, Ed25519, HKDF-SHA256 and
   AES-256-GCM, and a random source. Nothing in the client is implemented
   without them.
2. **The X3DH handshake** — fetch a peer's prekey bundle from
   `GET /api/e2ee/prekeys/:deviceId`, derive the shared secret with the
   server's four labels, and open a session with `POST /api/e2ee/sessions`.
3. **The Double Ratchet** — the root step, the chain step and the header
   step, with the exact labels from `protocol.js`, and the skipped-key store
   the server caps at a thousand entries.
4. **The associated data.** The server's `envelope.associatedData` is a
   length-prefixed canonical byte string over the context, the version, the
   session, the conversation, the sender, the receiver, the counter as four
   big-endian bytes, and the ratchet key. The client's bytes must match the
   server's exactly, or every tag will fail.
5. **A device key store** — the account's identity key, identity DH key,
   signed prekey, one-time prekeys and the ratchet states, in the platform
   keystore (`src/storage/secureStore.ts`).
6. **The message pipeline** — a body that is an envelope goes to `decrypt`
   and is rendered as text; a body that is not an envelope is rendered as
   text, and the difference is recorded. A message is never sent without an
   envelope when the conversation is encrypted, and never sent as plaintext
   pretending to be encrypted.
7. **The realtime events** — the server emits `e2ee:device`,
   `e2ee:key-change` and `e2ee:safety-number`. A client that ignores
   `e2ee:key-change` keeps sending with a key the conversation has moved on
   from.

The server's message routes do not yet carry envelopes, so the pipeline in
(6) has nothing to open until they do.

---

## What is not here

- The E2EE **implementation**. The envelope and the API surface are the
  server's; the cryptography is not written (above).
- The server's push registration endpoint. The client calls
  `POST /api/me/push-devices`, which the server does not expose yet; the call
  answers `unsupported` and the app says so rather than pretending.
- Store assets: the app icon is a vector, and the store listing images,
  screenshots and privacy manifests are still to be produced.
- The web client is not modified in any way by this work.
