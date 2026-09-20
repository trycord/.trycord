# Contributing to Trycord

Thanks for stopping by. A few notes before you open anything.

## Ground rules

- **Small, focused changes.** One concern per pull request. Don't bundle
  unrelated drive-bys.
- **Don't break what works.** If you're unsure an refactor is safe, ask in
  the issue first or keep the change minimal.
- **No fake anything.** No fabricated contributors, metrics, testimonials,
  or history. Commit messages describe real changes you actually made.
- **Match the existing style.** Plain JavaScript, IIFEs and `window.*`
  namespaces in the client, straightforward Express in the server. Don't
  introduce frameworks, build steps, or abstraction layers without
  discussing them first.

## Workflow

1. Fork, branch off `main` (`fix/chat-scroll`, `add/invite-expiry`).
2. Make the change. Keep diffs reviewable.
3. Verify it: server boots, client loads, the thing you changed works.
   Say what you tested in the PR description.
4. Open the PR against `main` using the template.

Branches, for reference: `main` has everything, `server` has only the
backend, `client` has the web client + desktop.

## Commit messages

Short, lowercase, present-tense descriptions of the change:

```text
fix chat layout on smaller screens
add server discovery endpoint
improve reconnect handling
```

One logical change per commit. Don't rewrite public history.

## Development setup

```bat
cd trycord-server
npm install
copy .env.example .env
```

Fill in `JWT_SECRET` and the database profile (see `.env.example`
and the README), then:

```bat
npm run seed
npm start
```

The server serves the client at `http://localhost:9971`.

Desktop work happens in `trycord-desktop/`:

```bat
cd trycord-desktop
npm install
npm start
```

`npm run build:win` produces a local installer without publishing
anything. `npm run release` is for maintainers only (needs `GH_TOKEN`).

## Reporting bugs

Use the bug report template: what you did, what you expected, what
happened instead, and your environment (OS, app version or commit,
self-hosted or official instance). Console errors help enormously.

## Security issues

Don't open public issues for sensitive vulnerabilities — see
[SECURITY.md](SECURITY.md).
