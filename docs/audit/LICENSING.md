# Licensing audit

What licence governs what, and what each one obliges the people who
redistribute this project.

The audit was run against the checkout at `/home/ultim/trycord/.trycord` on
2026-10-20. Every licence named below was read out of the package itself
(`package.json` of the installed package, or the registry record for the
packages that are not installed in this checkout), not from memory.

---

## 1. The software

| What | Licence | Where |
|---|---|---|
| The server, the web client, the public website, the desktop shell | **MIT** | `LICENSE` |
| The native clients | **MIT** | `native/app/package.json` → `SEE LICENSE IN ../../LICENSE` |

The MIT licence obliges the copyright notice and the permission notice to
travel with every copy or substantial portion of the software. It carries no
warranty and no liability. It places no condition on how the software is
used, so an operator who runs it commercially, modifies it, or sublicenses it
is within the licence.

## 2. The server's direct dependencies

`backend/package.json` is the manifest. The versions are the ones installed
in `backend/node_modules`, and the licences are the ones those packages
declare.

| Package | Version | Licence | What it obliges |
|---|---|---|---|
| `bcrypt` | 6.0.0 | MIT | Keep the copyright and permission notice in copies. |
| `better-sqlite3` | 13.0.3 | MIT | Keep the notice. The SQLite library it binds is public domain (the SQLite authors place it in the public domain and dedicated it to the public). |
| `cors` | 2.8.6 | MIT | Keep the notice. |
| `dotenv` | 17.4.2 | BSD-2-Clause | Keep the notice; do not use the authors' names or the project name to endorse a derived product. |
| `express` | 5.2.1 | MIT | Keep the notice. |
| `jsonwebtoken` | 9.0.3 | MIT | Keep the notice. |
| `multer` | 2.4.0 | MIT | Keep the notice. It depends on `busboy`, which declares no `license` field but ships an MIT licence in its own `LICENSE` file. |
| `mysql2` | 3.24.4 | MIT | Keep the notice. |
| `nodemailer` | 10.0.10 | MIT-0 | No attribution condition: the licence is the MIT text with the copyright notice requirement removed. |
| `ws` | 8.21.3 | MIT | Keep the notice. It depends on `bufferutil` and `utf-8-validate` only as optional native accelerators, which are not installed and not required. |
| `jsdom` (development only) | 30.1.2 | MIT | Keep the notice. It pulls in `whatwg-url`, `ws`, `parse5`, `saxes` and `tough-cookie`, all MIT. |

### The transitive set

138 packages are installed under `backend/node_modules`, including the
transitive dependencies. Their declared licences are:

| Licence | Packages |
|---|---|
| MIT | 117 |
| ISC | 6 |
| BSD-3-Clause | 4 |
| BSD-2-Clause | 3 |
| MIT-0 | 3 |
| Apache-2.0 | 3 |
| BlueOak-1.0.0 | 1 |
| CC0-1.0 | 1 |

The three Apache-2.0 packages are `ecdsa-sig-formatter`, `long` and
`xml-name-validator`, all reached through `jsonwebtoken`'s dependency on
`jws`. Apache-2.0 obliges the recipient to keep the licence, to mark
modified files as modified, and to keep any `NOTICE` file the upstream
project ships; it also grants a patent licence that terminates if the
recipient initiates patent litigation against the contributors. The
BlueOak-1.0.0 package is `lru-cache`, and the CC0-1.0 package is
`mdn-data`, which is a public-domain dedication.

There is no copyleft, source-available or non-commercial licence anywhere in
the tree. Nothing in the server obliges a deployment to publish its source
code.

## 3. The web client

`frontend/package.json` declares **no dependencies at all**. The client is
plain ES modules served to the browser, and the only package it carries is
`jsdom`, in the development dependencies, for the client test suite. The
public website (`public/`) is the same: hand-written HTML, CSS and
JavaScript, with no third-party script, no CDN link and no remotely loaded
asset.

This matters more than it might look: a client that pulls its dependencies
from a CDN at run time would be sending every reader's address to a third
party and would be executing code the operator did not ship. This one does
not.

## 4. The native clients

`native/app/package.json` is the manifest. The packages are not installed in
this checkout, so their licences were read from the registry records for the
exact versions the manifest pins.

| Package | Version | Licence |
|---|---|---|
| `@notifee/react-native` | 9.1.8 | Apache-2.0 |
| `@react-native-async-storage/async-storage` | 2.1.0 | MIT |
| `@react-navigation/bottom-tabs` | 7.2.0 | MIT |
| `@react-navigation/native` | 7.0.14 | MIT |
| `@react-navigation/native-stack` | 7.2.0 | MIT |
| `react` | 18.3.1 | MIT |
| `react-native` | 0.76.9 | MIT |
| `react-native-keychain` | 9.2.2 | MIT |
| `react-native-safe-area-context` | 5.1.0 | MIT |
| `react-native-screens` | 4.5.0 | MIT |
| `react-native-svg` | 15.8.0 | MIT |

`@notifee/react-native` is Apache-2.0: it carries the notice, the
modification marking and the patent grant. Everything else is MIT.

## 5. The fonts

Two families are bundled as `woff2` files and served from the instance
itself, not from a font service:

| Family | Files | Licence | Copyright holder |
|---|---|---|---|
| Manrope | `frontend/assets/fonts/manrope-latin-wght-normal.woff2`, `manrope-latin-ext-wght-normal.woff2` | SIL Open Font License 1.1 | The Manrope Project Authors (2019) |
| JetBrains Mono | `frontend/assets/fonts/jetbrains-mono-latin-wght-normal.woff2` | SIL Open Font License 1.1 | The JetBrains Mono Project Authors |

The OFL 1.1 permits use, embedding, redistribution and commercial use of
the fonts, including selling them as part of a software product. It
obliges three things: the copyright notice and the licence must accompany
the font files wherever they are redistributed; the fonts may not be sold on
their own; and the fonts may not be distributed under any other licence. It
also reserves the family names, so a modified font may not be called
"Manrope" or "JetBrains Mono".

The licence text that ships with the fonts is
`frontend/assets/fonts/OFL.txt`, and `public/fonts/OFL.txt` is a byte-for-byte
copy of it, so the public site and the application ship the same notice.

### Finding L1 — the bundled font notice covers only one of the two families

`frontend/assets/fonts/OFL.txt` opens with:

> Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope)

and nowhere in its 93 lines does the word "JetBrains" appear. The
JetBrains Mono file is bundled in the same directory, is served from the
same origin, and is redistributed with the software, but the notice that
travels with it names a different copyright holder.

The OFL's condition is that the copyright notice and the licence "shall be
included with all copies of the Font Software". As bundled, one of the two
families is redistributed without its notice. The fix is a second notice
block, or the JetBrains Mono `OFL.txt` alongside the file, in both
`frontend/assets/fonts/` and `public/fonts/`.

The published page repeats the gap: `public/licenses.html` says "The
licence text for the Manrope files is included with them in
public/fonts/OFL.txt" and never mentions that a second family is bundled.

## 6. The artwork and the icons

**The interface icons** are not a third-party icon package. Every glyph is
drawn as path data in `frontend/packages/icons.js`, which is part of this
project and is covered by the MIT licence. The SVG assets in
`frontend/assets/trycord-assets/icons/` are described by that pack's own
README as "original simple outline implementations drawn for this pack,
inspired by conventional interface iconography. They are not copies of a
bundled third-party icon package."

**The brand artwork** — the flame mark, the wordmark, the community
fallbacks, the status symbols — is original to the project and is covered by
the MIT licence, as `public/licenses.html` states: "The flame mark and the
other artwork in this repository are part of the project and are covered by
the MIT licence."

### Finding L2 — the brand asset pack leaves its own licence open

`frontend/assets/trycord-assets/README.md` closes with:

> Original assets in this package are provided as a Trycord-specific starter
> design; choose and add an explicit project license before distribution.

and

> No font files are included.

The second sentence is true of the pack but not of the repository: the
repository does bundle font files, one directory up. The first sentence is a
licence choice the pack asks for and that the repository makes elsewhere
(the root `LICENSE` and `public/licenses.html`); a reader who takes the
pack on its own, without the repository, has no licence at all. The pack
should either name the MIT licence or carry a copy of it.

## 7. What is compatible with MIT

Every licence in this tree is compatible with the project's MIT licence, and
every one of them may be combined with it in a distributed work:

| Licence | Compatible with MIT? | Condition |
|---|---|---|
| MIT | Yes | Keep the notice. |
| MIT-0 | Yes | No condition. |
| ISC | Yes | Keep the notice. |
| BSD-2-Clause / BSD-3-Clause | Yes | Keep the notice; no endorsement; (3-clause) do not use the contributors' names. |
| Apache-2.0 | Yes | Keep the licence, mark modified files, keep any `NOTICE`, observe the patent grant. |
| BlueOak-1.0.0 | Yes | Keep the notice; observe the patent grant. |
| CC0-1.0 | Yes | No condition (public-domain dedication). |
| SIL OFL 1.1 | Yes, for the font files | Keep the notice with the fonts; do not sell the fonts alone; do not rename a modified font. |

**Not compatible with MIT, and not present:** GPL, AGPL, LGPL, SSPL, any
non-commercial or source-available licence, and any licence that requires
the whole of a combined work to be published under itself. None of the
direct dependencies, none of the transitive set, neither font and no
bundled asset is under such a licence, so nothing in this project forces a
deployment to open-source its own code, and nothing in it forbids
commercial use.

## 8. Finding L3 — the published attribution for the server's dependencies is not there

`public/licenses.html` says:

> Each dependency carries its own licence, and those licences are listed in
> the package manifests in the repository, together with the versions
> actually installed.

The manifests (`backend/package.json`, `native/app/package.json`) list the
**names and the versions** of the dependencies. They do not list their
**licences**: `package.json` has no field for it, and the manifests are the
only place the published page points at. So a reader who wants to know what
`ws` or `nodemailer` is licensed under is told to look somewhere that does
not answer the question. The audit above is that answer; it should be
published next to the licences page, or the page should point at a
`THIRD-PARTY-NOTICES` file that carries the notices themselves.

The same applies to redistribution in practice: the MIT, BSD, ISC and
Apache-2.0 licences all require the notice to travel with the software. A
deployment that copies `backend/node_modules` into a container image
without the upstream notice files is not carrying those notices. A
`THIRD-PARTY-NOTICES` file that gathers the notices would make compliance a
matter of copying one file.

## 9. Summary

| Area | Licences present | Compatible with MIT | Action needed |
|---|---|---|---|
| The software | MIT | — | None. |
| The server's direct dependencies | MIT, MIT-0, BSD-2-Clause | All | Publish the notices (L3). |
| The server's transitive dependencies | MIT, ISC, BSD-2/3, MIT-0, Apache-2.0, BlueOak-1.0.0, CC0-1.0 | All | Same as L3. |
| The web client | None (no dependencies) | — | None. |
| The native clients | MIT, Apache-2.0 | All | Keep the Apache-2.0 notice. |
| Manrope | OFL 1.1 | Yes, with conditions | None — the notice ships. |
| JetBrains Mono | OFL 1.1 | Yes, with conditions | **L1: the notice does not ship with the file.** |
| The icons and the artwork | MIT (project's own) | Yes | **L2: the asset pack leaves its licence open.** |

Three findings. None of them is a licence that forbids the use this project
makes of the work; two are attribution defects, which are the kind that are
cheap to fix and expensive to argue about later.
