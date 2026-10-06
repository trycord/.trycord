# Theming

Trycord has several complete themes and a **Custom** one you can build yourself
with guided controls and, optionally, your own CSS.

Themes are stored per browser, not per account. Signing in on another device
gives you that device's theme. This is deliberate — a shared account across
devices should not mean two people arguing about colour.

- Where it lives: **Settings → Appearance**
- Code: `frontend/js/theme.js`, styles in `frontend/css/app.css`

## The built-in themes

| Theme | Character |
|---|---|
| System | follows your OS light/dark setting |
| Trycord | charcoal depth with amber ambient energy — the default |
| Orthocord | cool steel hues on neutral charcoal |
| Midnight | deep indigo-blue, dim and focused |
| Ember | hotter, saturated amber foreground |
| Light | warm pale surfaces with dark text |
| High contrast | maximum readability: near-black, bright text, bold focus |

Plus **Custom**, below. Switching applies immediately and persists.

System resolves to Ember when the OS asks for dark and Light when it asks for
light, so it tracks the preference rather than a fixed choice.

## Custom: the guided controls

Two inputs derive the base, and five derive the rest.

| Input | Options | What it changes |
|---|---|---|
| Accent color | any colour | the accent used for active states, links, and the composer |
| Base tone | Dark / Light | whether surfaces are dark or light |
| Contrast | standard / high | text and border strength against the surface |
| Corner style | soft / sharp / round | border radius across every surface |
| Density | comfortable / compact / roomy | row height and spacing throughout |
| Motion | full / reduced | whether transitions animate |
| Ambient glow | balanced / subtle / vivid | the light bloom behind the shell |

**Density and Motion are not token values.** They set `data-density` and
`data-motion` on `<html>`, and the stylesheet consumes those attributes. This
is deliberate: a media query always reflects the real viewport, whereas an
attribute set by script is only correct once JavaScript has run.

Semantic colours — success, warning, danger — come from the base palette and
are not themeable individually. A "success" that has been recoloured is no
longer readable as success.

## Custom: advanced CSS

Advanced CSS lets you restyle anything visual. It does **not** let you break the
application, and that is enforced rather than promised.

### What is rejected

Validation runs on **Validate**, and again on **Apply and save**. It is a real
parser, not a warning banner — `frontend/js/theme.js` splits rules,
checks each selector and each declaration, and reports what it refused and
why.

**Structural properties are refused outright.** `display`, `position`, `float`,
`visibility`, `overflow`, every sizing property, every margin and padding
property, `gap`, `inset` and each side, `z-index`, and the flex properties.
These decide layout, and layout is not yours to break.

**Protected surfaces.** Selectors that match navigation, the shell, the view
region, the member panel, the context header, modals, toasts and the connection
banner get a narrower allow-list. `color`, `background-color`, `border-color`,
`outline-color`, `box-shadow`, `text-shadow`, `font-*`, `letter-spacing`,
`line-height`, `text-transform`, `text-decoration-color` and `accent-color` —
and nothing else. A border colour on the rail is fine; hiding the rail is not.

**Other refusals:**

| Refused | Why |
|---|---|
| `*` | a universal selector is a blunt instrument that always escapes its intent |
| `!important` | it defeats the specificity model the safety check relies on |
| `url()` | custom CSS must not be able to make the client fetch anything |
| `javascript:`, `expression()` | scripts, not styling |
| `<`, `>`, `@` in a value | markup breakout attempts |
| more than 10 selectors per rule | |
| more than 60 declarations per rule | |
| more than 200 rules, or 20000 characters | |

### What happens when CSS is refused

Nothing partial. The theme is not applied, **Ember is restored**, and the panel
lists the reasons. You cannot end up in a half-styled state.

There is also a safety pass **after** a successful apply. It measures the
rendered result rather than trusting the text: if the shell or the view region
is missing, hidden, or under 200px, or the rail has collapsed below a usable
width, the theme is treated as a failure and Ember comes back. This catches the
CSS that passes the allow-lists but is still wrong.

### Reset to Ember

Restores Ember and un-applies your stylesheet. **Your custom CSS text is kept**,
so a reset is not destructive and switching back to Custom brings it back.

## Persistence

| Key | Holds |
|---|---|
| `trycord.theme` | which theme is selected |
| `trycord.customPalette` | accent and base tone |
| `trycord.customThemeTokens` | the five guided tokens |
| `trycord.customCss` | your advanced CSS text |

Applied at boot, so there is no flash of the wrong theme on load. Everything is
per-browser and survives a refresh, a sign-out and a sign-in. Storage being
unavailable is caught rather than thrown — a private window with storage
blocked degrades to an unsaved theme instead of a broken client.

## Export and import

**Export** writes a JSON file with the accent, tone and all five tokens.

**Import** validates before applying. A file that is not JSON, or that has no
theme object in it, is rejected outright and your current theme is untouched.
Any token the file omits keeps its default rather than becoming undefined, so a
partial export still produces a usable theme. CSS carried in an import goes
through exactly the same validation as CSS you typed.

The format carries no identity and no server state, which means it is safe to
share — a theme is presentation, and presentation is not personal data.

## A note on why custom CSS is fenced in

The reasoning is short. Custom CSS runs as the person using the client, in
their own browser, and could not reach anyone else. So the limits are not
there to protect you from an attacker — they are there so that a person who
pastes a stylesheet from the internet cannot lock themselves out of their own
account, and so that a theme someone shares is never able to remove the
confirmation on a destructive action or hide a moderation notice.

Visual customisation is genuinely encouraged. Breaking the application is not.