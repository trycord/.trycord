# Contributing to Trycord

Thanks for stopping by. Trycord is open source, and contributions are welcome. A few notes before you open an issue or pull request.

## Ground rules

- **Keep changes small and focused.** One concern per pull request. Don't bundle unrelated changes.
- **Don't break what works.** If you're unsure whether a refactor is safe, discuss it in an issue first or keep the change minimal.
- **No fabricated content.** Don't add fake contributors, metrics, testimonials, history, or other misleading project information. Commit messages should describe real changes.
- **Match the existing style.** The client is plain ES modules with no build step and no framework — it is served to the browser as written. The server is straightforward Express with CommonJS. Don't introduce a new framework, build system, or abstraction layer without discussing it first.
- **Don't add unnecessary dependencies.** If something can be implemented cleanly using the existing stack, prefer that over introducing another package.
- **A control that does nothing is worse than no control.** If a button, a setting or an endpoint is offered, it has to do the thing it says. A feature that is not implemented should be absent or plainly marked as not implemented — not a placeholder that reports success.
- **Write the test that would have caught the defect.** A fix without one will be broken again, and the next person will not know what it was.

## The shape of the repository

Three trees, and the boundaries between them are the first thing to learn.

| Tree | What it is | The rule |
|---|---|---|
| `backend/` | The API, the realtime gateway, the WebSocket server, the public site server | CommonJS, Express, one database module (`src/db/index.js`) that is the only place that speaks SQL dialect |
| `frontend/` | The web client, in three modules | `frontend/packages/` is the shared platform and imports nothing from the other two. `frontend/js/` is the desktop module and `frontend/mobile/` is the mobile module; neither imports the other. The test asserts all of it |
| `public/` | The public website and the legal documents | Plain HTML and CSS with no build step, apart from the generated stylesheet |

The backend's subsystems are one directory each under `backend/src/services/`, and
`backend/src/db/tables/` holds the data model — one module per concern. A new
table is a new module, and it is added to the list in
`backend/src/db/tables/index.js` **in dependency order**: MySQL checks a
referenced table when the referencing one is created, so a table that points at
one declared later cannot be created. There is a test for this.

`docs/services.md` is the map of where every subsystem lives and what boundary
it has. `docs/architecture.md` is the reference for the parts that are easy to
get wrong.

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

The repository uses these branches:

- `main` contains the complete project and is what a pull request targets.
- `release/*` carries a release line while it is being prepared.

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
cd backend
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

### The client

The client has no build step. It is plain ES modules served to the browser as
written, and the server serves it. Change a file and reload the page.

The stylesheets are **generated**. Edit the source layer under `frontend/css/`
or `frontend/mobile/css/` and run:

```bat
cd backend
npm run css
```

Never hand-edit `frontend/css/app.css` or `frontend/mobile/css/app.css` —
they are build output, and the next build will overwrite you.

### The native client

The native client is a separate project under `native/`, with its own
toolchain and its own build. It is **not** part of the server's `npm install`
and it does not share a build with the web client. `native/README.md` says
what it needs.

## Tests

```bat
cd backend
npm test
```

That runs everything: the unit tests, the integration tests, the journey
tests and the protocol tests. It takes about half a minute and it never
touches the instance you are serving — the database is a temporary file, the
port is free, and the signing secret is the run's own.

The other two suites:

```bat
cd .. && node --test frontend/tests/    # the client
cd .. && node --test public/tests/      # the public website
```

Two things to know about the runner. It is Node's own, so there is no
dependency to install and no configuration file to learn. And on Node 22 a
**directory** given to it is treated as a file to run, not as a directory to
search — which is why `node --test tests/` fails and
`node --test "tests/**/*.test.js"` is the form that works. The directories
that have an `index.js` beside them (the client's, the public site's) also
work as `node --test <dir>`.

**A test has to assert behaviour, not the presence of code.** "The route
exists" is not a test; "the route refuses somebody who is not a member" is.

## Before opening a pull request

Make sure:

- [ ] The change is focused on one purpose.
- [ ] The affected application starts successfully.
- [ ] The changed functionality has been exercised against a running instance, and
      `docs/verification-matrix.md` says how.
- [ ] There is a test for the new behaviour, and for the defect if this is a fix.
- [ ] The changed functionality works as expected.
- [ ] You haven't introduced unnecessary dependencies.
- [ ] You haven't added unrelated formatting or refactoring.
- [ ] If you changed the schema, the change is in `db/tables/` and the tables are
      declared after every table they point at.
- [ ] If you changed the environment, the variable is in `backend/.env.example`
      and `tests/integration/environment-template.test.js` is green.
- [ ] Commit messages describe the actual changes.
- [ ] The pull request explains what changed and what was tested.

## Documentation

Documentation is part of the change, not a follow-up. The documents that
matter most, and what each is for:

| Document | What it is |
|---|---|
| `docs/architecture.md` | The reference: where things live, the decisions that are easy to get wrong, and how to verify |
| `docs/services.md` | The service map: what runs in the API process, what runs separately, what is optional |
| `docs/selfhosting.md` | What an operator has to configure, and what breaks when they do not |
| `docs/continuum.md` | The federation protocol, the relay rules, and what does not cross |
| `docs/dashboard.md` | The two dashboard deployment modes and the contract between them |
| `docs/extensions.md` | The extension model, the capability grants, and what the sandbox does and does not do |
| `docs/api/` | The developer platform: the versioned surface, the scopes, the events |
| `docs/audit/` | The security, licensing and performance reviews, each finding marked verified or read |
| `docs/release/3.0/` | The 3.0 release records: the capability inventory, the plan, the state, the test log, the decisions, the migration notes |

## Deployment

The Cloudflare deployment lives in a separate repository,
`trycord/.trycord-cloudflare`, so the static site build is not entangled with
the product. The official website and the API are two deployments of the same
software, which is also why nothing in the client hardcodes the official
domain — a self-hosted instance serves its own client from its own origin.

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
