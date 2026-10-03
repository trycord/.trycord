# The launcher

What happens between clicking Trycord and the application being usable.

## The sequence

```
Trycord.exe
    │
    ▼
Launcher window          check the installed version against the update source
    │
    ├── nothing newer ────────────┐
    │                             │
    └── newer version             │
            │                     │
            ▼                     │
        download (real progress)  │
            ▼                     │
        downloaded, waiting       │
            │                     │
            ▼                     │
        [ Continue ] or restart    │
            │                     │
            └─────────────────────┘
                          │
                          ▼
                   Trycord window → WAC
```

The app window is **not created** until the launcher opens it. Nothing behind it
is initialised, loaded or painted — the launcher is a real startup layer, not a
screen shown after the app is already running.

## States

Every state on screen corresponds to something the updater reported. There is no
staged sequence and no invented percentage.

| State | Shown when |
|---|---|
| Starting Trycord | the launcher is up, nothing asked of the updater yet |
| Checking for updates | a real check is in flight |
| Trycord is up to date | the check succeeded and found nothing newer |
| Update available | a newer version exists, downloading on its own |
| …bar | `electron-updater` reporting real bytes and percentage |
| Update information unavailable | the release carries no `latest.yml` |
| Can't reach the update service | DNS or connection failure |
| Couldn't check for updates | anything else |

**Progress is never invented.** When the updater gives a percentage the bar is
determinate. When it gives none, the bar becomes an indeterminate sweep, which
means "working, size unknown" rather than a number that is not true. Downloaded
size is shown when the updater reports it and omitted when it does not.

## Failure is not fatal

Every error state offers **Continue to Trycord**. An update server being
unreachable, offline, or a release with no update metadata all lead to a working
application, because none of those are reasons a person cannot talk to their
community.

The three error kinds are worded differently on purpose. "No update available"
and "couldn't check" are different states and the interface does not blur them.

A downloaded update is **not** installed automatically. `quitAndInstall()` kills
the process the launcher is standing in, so installation happens after the app
opens, or on quit when auto-install is enabled.

## Restart and recovery

If the update fails to download or install, the installed version is untouched —
`electron-updater` writes the new build alongside it and only swaps on install. A
failed update leaves a launcher on a Retry button, not an unusable machine.

There is no update loop. If the newly installed version fails to start, the next
launch is a normal launch; nothing re-applies the same broken update.

## Development

`npm run dev` never shows the launcher and never contacts an update server. The
condition is `app.isPackaged`, so an unpackaged run cannot update itself from the
production channel. The smoke test skips it for the same reason.

## Single instance

One session per machine. A second launch hands focus to the running window and
the second process exits — two copies would mean two WebSockets, two
notification handlers and two updaters against one profile, fighting over
localStorage.

## Accessibility

- One `aria-live` region announces state changes as sentences.
- The animated dots are `aria-hidden`; what is heard is the state, never the
  decoration.
- Every state is readable as text, so `prefers-reduced-motion` removes the
  motion and loses nothing.
- Escape continues to Trycord, because a dialog-shaped failure with only a mouse
  affordance strands keyboard users.
- `forced-colors` is honoured: borders, indicator and progress bar all switch to
  system colours.

## Files

| | |
|---|---|
| `launcher.js` | the window and the updater-event state machine (main process) |
| `launcher.html` | markup, one section per state |
| `launcher.css` | ember on near-black, same tokens as the WAC |
| `launcher-renderer.js` | renders state, asks for nothing else |
| `launcher-preload.js` | three calls and one subscription |

The renderer has no filesystem, no network and no updater. It cannot install
anything; it can only ask the main process to, and the main process decides.

## Platforms

| | Check | Download | Install |
|---|---|---|---|
| Windows | yes | yes | yes |
| macOS | yes | yes | needs a signed app; none published |
| Linux | yes | **no** | **no** |

Electron's auto-updater has no working Linux path. The AppImage is published for
download and updates come from however the user installed it. The launcher says
"up to date" there because there is genuinely nothing it can install, and
pretending otherwise would be a claim the product cannot honour.