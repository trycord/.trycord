# Contributing to Trycord

Thanks for stopping by. Trycord is open source, and contributions are welcome. A few notes before you open an issue or pull request.

## Ground rules

- **Keep changes small and focused.** One concern per pull request. Don't bundle unrelated changes.
- **Don't break what works.** If you're unsure whether a refactor is safe, discuss it in an issue first or keep the change minimal.
- **No fabricated content.** Don't add fake contributors, metrics, testimonials, history, or other misleading project information. Commit messages should describe real changes.
- **Match the existing style.** Trycord currently uses plain JavaScript, IIFEs and `window.*` namespaces in the client, and straightforward Express in the server. Don't introduce new frameworks, build systems, or abstraction layers without discussing them first.
- **Don't add unnecessary dependencies.** If something can be implemented cleanly using the existing stack, prefer that over introducing another package.

## Workflow

1. Fork the repository and create a branch from `main`, for example:
   - `fix/chat-scroll`
   - `add/invite-expiry`
   - `improve/reconnect-handling`
2. Make your change and keep the diff reviewable.
3. Verify your change locally. At minimum, make sure the affected application starts and the functionality you changed works.
4. Open a pull request against `main` using the provided template.
5. Explain what you changed, why you changed it, and what you tested.

### Repository branches

The repository currently uses these branches:

- `main` contains the complete project.
- `server` contains the backend.
- `client` contains the web client and desktop client.

When contributing, branch from `main` unless a different base branch is explicitly requested.

## Commit messages

Keep commit messages short, lowercase, and written in the present tense.

Good examples:

```text
fix chat layout on smaller screens
add server discovery endpoint
improve reconnect handling
update community permissions
```

Keep one logical change per commit.

Don't rewrite public history or force-push branches that other contributors are actively using.

## Development setup

### Server

```bat
cd trycord-server
npm install
copy .env.example .env
```

Fill in `JWT_SECRET` and the database configuration as described in `.env.example` and the README.

Then:

```bat
npm run seed
npm start
```

The development server runs at:

```text
http://localhost:9971
```

### Desktop client

Desktop development happens in `trycord-desktop/`:

```bat
cd trycord-desktop
npm install
npm start
```

To create a local Windows installer:

```bat
npm run build:win
```

This creates a local installer without publishing a release.

`npm run release` is for maintainers only and requires `GH_TOKEN`.

## Before opening a pull request

Make sure:

- [ ] The change is focused on one purpose.
- [ ] The affected application starts successfully.
- [ ] The changed functionality works as expected.
- [ ] You haven't introduced unnecessary dependencies.
- [ ] You haven't added unrelated formatting or refactoring.
- [ ] Commit messages describe the actual changes.
- [ ] The pull request explains what changed and what was tested.

## Reporting bugs

Use the bug report template when reporting a bug.

Include:

- What you did
- What you expected to happen
- What happened instead
- Operating system
- Trycord version or commit
- Whether you're using the official instance or a self-hosted instance
- Relevant console or server errors

Console and server logs are especially helpful when diagnosing problems.

## Security issues

Please don't open public issues for sensitive security vulnerabilities.

See [SECURITY.md](SECURITY.md) for information about reporting security issues privately.
