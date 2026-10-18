# Theming

Trycord's appearance is chosen in **Settings → Appearance** on a page run by one
engine: `frontend/packages/theme.js`, drawing from the tokens in
`frontend/css/tokens.css`. Whatever that page offers, the stylesheet can do — a
choice that names a theme that does not exist cannot be made, and a palette that
would take the interface with it cannot be installed.

Themes are stored per browser, not per account. Signing in on another device
gives you that device's theme. This is deliberate — a shared account across
devices should not mean two people arguing about colour.

## The themes

| Theme | Summary |
|---|---|
| Ember | charcoal surfaces with the ember accent — the default |
| Midnight | deep blue-black with cool accents |
| Daylight | paper and ink |
| Match system | follows the operating system's light or dark setting |
| Custom | your own four colours, installed deliberately |

The chosen theme is written to `<html data-theme>` immediately and kept in the
browser. **Match system** watches the OS preference and follows it without a
reload: light resolves to Daylight and dark to Ember.

## Custom: a palette, not a canvas

The custom theme is four colours — accent, background, surface, and text — set
on input controls with a live preview. Saving them writes
`trycord.theme.tokens`; applying them to the document sets inline custom
properties (`--c-accent` and friends) that the token sheet reads over its
defaults.

**Installation is measured, not assumed.** *Install this palette* checks that
the shell still lays out with the new colours; if it does not, the palette is
refused and the built-in theme stays. A rejected palette never leaves the
interface half-applied, and *Reset* takes the document back to the built-in
ember while keeping the preview inputs honest.

## Two studio readings this build offers instead of deeper restyling

- **Density** — compact, cozy or comfortable row height and spacing. It sets
  `data-density` on `<html>` and the token block consumes the attribute: a
  measurement change across every surface, not a per-page traversal.
- **Less motion** — the reduced-motion switch sets `data-motion="reduced"` on
  the document; the stylesheet turns the duration tokens down. It reads the
  system's `prefers-reduced-motion` first, so a reader who has already asked
  their OS for less motion starts reduced.

There is no custom-CSS surface in this build. Restyling beyond these controls
is a change to `frontend/css/`, made in the repository, reviewed like any other
code — a file-drop restyle is not offered, and no page claims otherwise.

## Persistence

| Key | Holds |
|---|---|
| `trycord.theme` | which theme is selected (absent means default) |
| `trycord.theme.tokens` | the four custom colours |
| `trycord.workspace` | density, remembered column widths and inspector state |
| `trycord-motion` | the reduced-motion switch |

Applied at boot, so there is no flash of the wrong theme on load. Everything is
per-browser and survives a refresh, a sign-out and a sign-in. Storage being
unavailable is caught rather than thrown — a private window with storage
blocked degrades to an unsaved theme instead of a broken client.

## Why the limits are where they are

Truthfulness is the rule the page enforces rather than a fence it pretends to
maintain: every named choice resolves to a theme the stylesheet knows, every
token the custom palette writes has a declared consumer, and an install that
cannot be survived is refused before it is remembered. A reader who wants more
customisation than the studio offers is not lied to — the repository is where
deeper styles belong.
