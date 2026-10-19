# Verification

The artifact a reviewer reads. It says what was checked, how, and what the
check actually said — and it says plainly what was **not** checked, because
the environment this was written in cannot check it.

**Summary:** the native client is source-complete and internally consistent.
It has never been compiled, never run, and never been on a device. The
verification below is entirely static.

---

## The environment this was written in

Probed on the day it was written:

```
$ node --version
v22.23.3

$ npm --version
10.9.9

$ which java javac gradle adb pod xcodebuild ruby
(no output — every one of them is absent)

$ uname -a
Linux trycord-dev 6.18.50+rpt-rpi-2712 aarch64 GNU/Linux
```

So: no Java, no Gradle, no Android SDK, no `adb`, no CocoaPods, no
`xcodebuild`, no Ruby, and no macOS. There is no way to build a native
binary here, and no way to run one. The iOS target cannot even be *parsed*
by a tool here, let alone compiled.

`npm install` was **not** run either, on purpose: other agents were running
npm operations in the same checkout concurrently, and a concurrent install
against the same cache can corrupt it. The manifest in `native/app/package.json`
was written by hand. **The versions in it have not been confirmed against the
npm registry** — see "Not verified" below.

---

## What was verified

### 1. Every JSON file parses

Run, over every `.json` file under `native/`:

```bash
cd native
for f in $(find . -name "*.json" -not -path "*/node_modules/*"); do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('ok  $f')"
done
```

Real output:

```
ok  native/app/app.json
ok  native/app/ios/Trycord/Images.xcassets/AppIcon.appiconset/Contents.json
ok  native/app/ios/Trycord/Images.xcassets/Contents.json
ok  native/app/ios/Trycord/Images.xcassets/LaunchImage.imageset/Contents.json
ok  native/app/package.json
ok  native/app/tsconfig.json
```

Six files, six parses, no failures. (This is also what
`scripts/check-native.mjs` does, as part of its run.)

### 2. Every relative import resolves, and every name imported is exported

The check is `native/scripts/check-native.mjs`. It parses every JSON file,
walks every TypeScript and JavaScript source file, resolves every relative
specifier the way a bundler would (the file, then each known extension, then
the directory's `index`), and asserts that the target exists and exports the
names that are asked of it. It follows `export * from` chains rather than
assuming them.

The command, and its real output:

```bash
$ node native/scripts/check-native.mjs
trycord native check
  root: /home/ultim/trycord/.trycord/native
  json files parsed: 6
  source files scanned: 91
  relative imports resolved: 290
  problems: 0
  result: ok
```

Exit code `0`.

**The check was proved to fail when it should.** A probe file with an
unresolvable import and a missing export was written, the check was run, and
the probe was removed:

```
$ node native/scripts/check-native.mjs
trycord native check
  ...
  problems: 2
    - app/src/util/__probe.ts: imports "./does-not-exist", which does not resolve to a file
    - app/src/util/__probe.ts: imports "notThere" from "./runtime", which does not export it
exit=1
```

The check also found a real defect while this work was in progress:
`RegistrationPayload` was imported from `src/api` by two files, but
`src/api/index.ts` did not export it. It does now.

### 3. Source-level review, by reading

Everything below was checked by reading the source, against the repository's
own contracts. This is a real check, but it is a human (or model) reading
code, not a compiler.

| Claim | How it was checked | Where |
| --- | --- | --- |
| The register request sends the legal versions the server demands | Read `backend/src/routes/auth/register.js` (it compares `termsVersion`/`privacyVersion` with `TERMS_VERSION`/`PRIVACY_VERSION` and refuses a mismatch) and `backend/src/legal.js`; the client reads the versions from `GET /api/legal` and sends the ones it showed, and refuses to send a registration at all when the instance has not said which versions are in force — the rule the web client holds in `frontend/packages/legal.js` | `src/api/legal.ts`, `src/screens/RegisterScreen.tsx`, `src/api/endpoints.ts` |
| The sign-in flow matches the server's | Read `backend/src/routes/auth/login.js`: a correct password with a second factor outstanding answers `{mfaRequired, challengeToken, expiresInSeconds}` and mints no session; `POST /api/auth/2fa/verify` takes the challenge and the code | `src/api/endpoints.ts`, `src/screens/SignInScreen.tsx`, `src/screens/TwoFactorScreen.tsx` |
| The password reset matches the server's | Read `backend/src/routes/auth/recovery.js`: `POST /api/auth/forgot-password` answers the same way whether or not the account exists; `POST /api/auth/reset-password` returns a session, or — on an account with a second factor — a challenge, because control of the mailbox is not control of the authenticator | `src/api/endpoints.ts`, `src/screens/ForgotPasswordScreen.tsx`, `src/screens/ResetPasswordScreen.tsx` |
| The error envelope is read the way the server writes it | Read `backend/src/errors.js`: `{ error: { code, message, details } }` with the status from the code table | `src/api/client.ts` |
| The socket handshake is right | Read `backend/src/routes/auth/ticket.js` (a one-use ticket from `POST /api/auth/ws/ticket`, spent as `?ticket=` on the socket) and `frontend/packages/realtime.js` (the join frames and the event names) | `src/realtime/socket.ts`, `src/session/instance.ts` |
| The endpoint paths are the server's | Every path was compared with `frontend/packages/api.js` and with the route mounts in `backend/src/server.js` | `src/api/endpoints.ts` |
| The normalisers cover the server's two spellings | Read `frontend/packages/store.js`'s `normalizeUser` and `frontend/mobile/js/views/messages.js`'s `normalizeMessage`, which handle camelCase and snake_case separately | `src/api/normalize.ts` |
| The token values are the repository's | Copied from `frontend/assets/trycord-assets/tokens/trycord.css` and `frontend/css/tokens.css`, and compared value by value | `src/design/tokens.ts` |
| The icon shapes are the repository's | The path data was copied from `frontend/packages/icons.js` | `src/components/Icon.tsx` |
| The deep links match the web client's routes | Read `frontend/packages/registry.js` for the route shapes (`/server/:id/channel/:id`, `/dms/:id`, `/users/:id`, `/reset-password/:token`) | `src/deepLinks/parser.ts` |
| The E2EE envelope is the server's | Read `backend/src/services/e2ee/envelope.js` (the required fields, the version check, the counter check, the base64url lengths), `protocol.js` (the version and the labels) and `primitives.js` (the byte lengths: 32, 12, 16); the native envelope carries the same thirteen fields and applies the same checks | `src/e2ee/envelope.ts` |
| The E2EE API surface is the server's | Read `backend/src/routes/e2ee.js` route by route; the native module names the same twenty-one routes with the same bodies | `src/e2ee/api.ts` |
| The instance rules match the web client's | Read `frontend/packages/config.js` (`plausibleUrl`, the origin-scoped token key) and `frontend/mobile/js/views/instances.js` (the probe, and forgetting the previous instance's token) | `src/session/instance.ts`, `src/session/sessionManager.ts` |
| No unused imports | A script walked every source file and matched each imported name against the rest of the file; the six it found were removed | the whole of `src/` |

### 4. Tests written

Ten test files, 1,333 lines, under `src/**/__tests__/`. They cover the parts
that can be tested without a device:

| File | What it holds to |
| --- | --- |
| `src/api/__tests__/client.test.ts` | The bearer token travels with the request and not with the public endpoints; the body is JSON; the server's error envelope becomes an `ApiError` with the code, message, status and details; `retry-after` is read; a body that is not an envelope falls back to `HTTP_<status>`; 204 answers null; the query string is built in a stable order; a request that never answers is abandoned as `TIMEOUT`; one that never left the device is `NETWORK` |
| `src/api/__tests__/tokenScope.test.ts` | The token is filed under the origin of the instance that issued it; only that instance's token is presented to it; switching instances forgets the one being left; a 401 ends the session but a network failure does not |
| `src/api/__tests__/legal.test.ts` | The versions come from the instance and are never guessed; a body without them stays without them; a refusal because the documents moved on is told apart from any other validation failure — the same three rules the web client's `frontend/tests/legal.test.js` holds |
| `src/storage/__tests__/drafts.test.ts` | A draft survives and is read back; a channel draft and a conversation draft stay apart; a draft is replaced, not duplicated; a sent draft is removed; two instances' drafts stay apart; a corrupt index loses a draft rather than the app |
| `src/storage/__tests__/secureStore.test.ts` | A value is written and read; a value that is not there reads as nothing; two keys never share an entry; the service name is one the platform accepts and is different for every key |
| `src/deepLinks/__tests__/parser.test.ts` | Every accepted shape; the web client's addresses; the refusal of a foreign scheme, an unknown shape and a channel with no community; a round trip through `buildDeepLink` |
| `src/notifications/__tests__/payload.test.ts` | The payload carries only identifiers and a kind; it does not carry the message content; a payload with a forbidden key is refused; a payload carrying the text it was built from is refused; the title says nothing about the message |
| `src/design/__tests__/tokens.test.ts` | The flame orange, the charcoal ground, the daylight palette, the state colours, Manrope, the spacing scale, the radii, the type scale, the 24-point icon grid, the 44-point touch target, the two themes |
| `src/e2ee/__tests__/envelope.test.ts` | The envelope is read and an unknown version is refused; a missing field, a counter that is not a counter, a field of the wrong length and a field that is not base64url are each refused — the same rules the server's `envelope.js` applies; a base64url string is measured |
| `src/e2ee/__tests__/adapter.test.ts` | The unimplemented adapter says it cannot seal or open a message, and leaves an ordinary message alone |

**These tests have not been run.** `npm install` was not run, so `jest` is
not on disk. The assertions were written against the implementation and
reviewed by reading; they are expected to pass, but "expected" is not
"verified". A reviewer with a toolchain should run `npm install && npm test`
first.

### 5. What the check script does **not** cover

- It does not type-check. `tsc --noEmit` has not been run.
- It does not lint.
- It does not know about packages. An import of `react-native` is accepted
  without checking that the package is there or that the name exists in it.
- Its export check is a regex over the source. It reads `export const`,
  `export function`, `export class`, `export interface`, `export type`,
  `export enum`, `export {…}`, `export type {…}` and `export * as …`, and it
  follows `export * from './local'`. It does not understand a computed or
  generated export.
- It does not check the `android/` and `ios/` trees at all: the Gradle files,
  the manifest, the plist, the entitlements and the Xcode project are
  unverified by any tool.

---

## What was NOT verified

Stated plainly, item by item.

### Compilation — not verified

- **The TypeScript does not compile as far as anyone knows.** `tsc --noEmit`
  has never been run. Type errors are likely to exist, particularly at the
  seams with React Navigation's generics and with `react-native-svg`.
- **The JavaScript does not bundle.** Metro has not run. The Babel
  configuration, the Metro configuration and the `react-native.config.js`
  are unexercised.
- **The iOS project does not open and build.** `project.pbxproj` was written
  by hand against the React Native 0.76 template's shape. The identifiers,
  the build phases and the settings are plausible and internally consistent,
  but Xcode has never parsed it. `pod install` has never run, so the CocoaPods
  integration is unverified. `AppDelegate.swift` and
  `NotificationPresenter.swift` have never been compiled by `swiftc`.
- **The Android project does not build.** The Gradle files have never been
  evaluated by Gradle. `MainActivity.kt` and `MainApplication.kt` have never
  been compiled by `kotlinc`. The `react { }` block's `root`,
  `reactNativeDir`, `codegenDir` and `cliFile` paths are the ones the 0.76
  template uses, but they are unverified.
- **The Gradle and CocoaPods dependency versions are unconfirmed.** The
  `android/build.gradle` and the `Podfile` reference versions that are right
  for React Native 0.76 as far as can be determined without a registry, but
  they have not been resolved.

### Runtime — not verified

- The app has never been started. No screen has ever rendered.
- The Metro bundler has never served a bundle.
- The Metro dev server on `localhost:8081` has never been reached from a
  simulator or a device.
- No API request has ever been made by this client. The endpoint contracts
  were checked by reading the server's routes, not by calling them.
- The WebSocket handshake, the reconnection back-off, the join and leave
  frames and the catch-up on reconnect have never run.
- The draft store has never been written on a device. Its behaviour is
  covered by unit tests over an in-memory store, not by the real
  `AsyncStorage`.
- The keystore has never been written on a device. `react-native-keychain`
  has never been called.

### On-device — not verified

- **Nothing has been on a phone or a simulator.** Not iOS, not Android.
- The secure storage is *intended* to be the iOS Keychain and the Android
  Keystore-backed encrypted preferences, via `react-native-keychain`. That
  intent is unverified: the library is named in the manifest and adapted in
  `src/storage/keychain.ts`, but the native side has never run.
- The push transport has never run. `notifee` is named in the manifest and
  used in `src/notifications/notifeeTransport.ts`, but the native module has
  never been loaded. The token acquisition path is the least certain part:
  `notifee.getToken()` returns the APNs token on iOS; on Android it depends
  on a Firebase project being configured, and the path could not be checked
  without one. The code returns `null` rather than failing if the token
  cannot be read.
- The `trycord://` scheme has never been registered on a device. The iOS
  `CFBundleURLTypes` entry and the Android intent filter are unverified.
- The `POST_NOTIFICATIONS` runtime prompt has never been shown.
- The deep link handler has never received a real link.
- The accessibility work has never been checked with VoiceOver or TalkBack.
  The roles, labels, states and live regions are in the source; whether they
  read well is a judgement that needs a device and, ideally, a screen reader
  user.

### Packaging — not verified

- No `.ipa` and no `.apk` has been produced.
- No code signing has been configured or exercised. The iOS team and bundle
  identifier are placeholders; the Android release keystore is not in the
  repository.
- The App Store and Play Store listings, the privacy manifests, the data
  safety forms and the store screenshots do not exist and are not
  fabricated anywhere.
- The app icon is a vector drawable, not the set of PNGs a store requires.
- The Manrope font files are not in the repository, so the app falls back to
  the platform's typeface until they are added.

### The npm manifest — not confirmed against the registry

`npm install` was not run. The versions in `native/app/package.json` were
written from knowledge of the React Native 0.76 release, and they are
**unverified against the npm registry**. A reviewer should run
`npm view react-native@0.76.9 version` and the same for the other pinned
versions before trusting them, and expect to adjust the carets. The pins
that matter most:

- `react-native: 0.76.9` with `react: 18.3.1` and
  `@react-native/babel-preset: 0.76.9` (the four must agree)
- `@react-native-community/cli: 15.0.1`, which is the CLI that 0.76 expects
- `@react-navigation/*: ^7.x` with `react-native-screens: ^4.x` and
  `react-native-safe-area-context: ^5.x`
- `react-native-keychain: ^9.2.2`, `react-native-svg: ^15.8.0`,
  `@react-native-async-storage/async-storage: ^2.1.0`,
  `@notifee/react-native: ^9.1.8`

### The end-to-end encryption — the envelope and the API are the server's; the cryptography is not written

`src/e2ee/envelope.ts` is the server's envelope, field for field, and
`src/e2ee/api.ts` is the server's `/api/e2ee` surface. Both were written by
reading `backend/src/services/e2ee/envelope.js`, `protocol.js`,
`primitives.js` and `routes/e2ee.js` on the day this was written.

`src/e2ee/adapter.ts` defines the seam and **nothing more**. The adapter
that is wired in refuses every call. No message is encrypted by this client,
and none is pretended to be.

What is still to be written, precisely:

1. A crypto library providing X25519, Ed25519, HKDF-SHA256 and AES-256-GCM,
   and a random source.
2. The X3DH handshake and the Double Ratchet, with the server's exact labels
   and its skipped-key cap.
3. The associated data, byte for byte with the server's
   `envelope.associatedData` — a length-prefixed canonical byte string. If
   these bytes differ, every tag fails.
4. A device key store, in the platform keystore.
5. The message pipeline: an envelope body is decrypted, a plain body is
   rendered as text, and neither is ever sent in the other's place.
6. The realtime events `e2ee:device`, `e2ee:key-change` and
   `e2ee:safety-number`.

The server's message routes do not yet carry envelopes, so there is nothing
for the pipeline to open until they do. The client is written to the
protocol that exists, not to one that is hoped for.

### The server's push registration endpoint — not implemented

`POST /api/me/push-devices` does not exist on the server. The client calls
it, the call answers `unsupported`, and the app says "This instance does not
accept push registrations yet" rather than pretending the device is
registered.

### The design tokens — values copied, not audited for drift

The token values in `src/design/tokens.ts` were copied from
`frontend/assets/trycord-assets/tokens/trycord.css` and
`frontend/css/tokens.css` and compared value by value. They are not
generated from those files, so if the stylesheets change, the native client
must be changed by hand. There is no build step that keeps them in step.

---

## What a reviewer should do first

```bash
cd native/app
npm install
npm run typecheck        # expect real errors on the first run
npm test
npm run lint
npm run check            # the static check; expected to pass
```

Then, with a toolchain:

```bash
cd ios && pod install && cd ..   # macOS only
npm start
npm run ios
```

```bash
npm start
npm run android
```

And then: sign in, register an account, choose another instance, send a
message, turn the network off and type a message, turn the network back on,
open a `trycord://` link, and read the app with VoiceOver and with TalkBack.
None of that has been done.
