# Browser checks

Photographs every surface at eight widths, in a real Chromium, by talking to the
DevTools protocol directly. No driver library, so there is no install step and it does
not care which Chromium is on the machine.

```
npm run check:shots                 # throwaway backend, every surface, writes ./shots/
node scripts/browser/shots.mjs      # against a server you already started
node scripts/browser/shots.mjs home settings   # only the named surfaces
```

`check:shots` starts its own backend on a free port with a disposable SQLite file and
stops it afterwards. It sets `DB_CLIENT` as well as `DB_FILE`, always: the repository's
`.env` sets `DB_CLIENT` twice and the last one wins, so a `DB_FILE` on its own resolves
to the live remote database. That is not theoretical.

## It will tell you it cannot run, and pass

Some environments have a Chromium that starts, attaches over CDP, evaluates
JavaScript happily - and then never completes an http request. The page sits on
`about:blank` forever. Screenshots of it are 800x600 rectangles of nothing.

On such a machine the run prints SKIPPED and exits 0. Trycord was not exercised and did
not fail. That distinction matters: a check that reports a broken product when the
machine cannot run the browser is a check people learn to ignore, and then it is worse
than no check at all.

Verify which you are getting by looking for the SKIPPED line, not for a green tick.

## Where it does run

Anywhere the browser has working networking - a CI runner, for instance, which is what
this was written for. There it photographs:

    360x740   small phone
    390x844   phone
    834x1112  tablet
    1280x720  small laptop
    1440x900  laptop
    1920x1080 desktop
    2560x1440 wide
    3440x1440 ultrawide

jsdom covers structure: that pages render, routes resolve, controls have accessible
names, navigation composes. It has no layout engine, so it cannot tell you a sidebar is
260px wide or that two things overlap. That is what this is for.

## What it asserts

Not layout correctness - it photographs, which is the point. It fails when a surface
renders an error card instead of a page, because an error card photographs tidily:
correct layout, no overflow, nothing visually wrong. A page that threw can otherwise sit
there being mistaken for a finished design.

Look at the images. That is the whole idea; the screenshots are the output and the
assertions are only there to stop a blank one passing for a designed one.