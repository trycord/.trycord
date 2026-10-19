# Deprecation policy

What "deprecated" means here, how long a version lives, and what happens to
the routes that are not versioned.

## The rules

1. **A version is removed only after it has been deprecated for at least six
   months**, and only after a migration path has existed for the whole of that
   time.
2. **A deprecated version still answers.** It is refused nothing that a
   current version accepts, apart from the routes that have been withdrawn.
   A deprecated version is a promise about time, not a warning.
3. **Every removal is announced in the release notes of the build that
   removes it**, naming the version, the date it stopped being supported and
   what to move to.
4. **A removal never changes the shape of a route that still exists.** A
   response body is not reshaped under a client that did not ask for it; a
   change of shape is a new version.
5. **The unversioned routes under `/api` are not part of this policy.** They
   are the interface's API, they are not versioned, and they are not covered
   by anything written here. See the note at the end.

## The life of a version

| Phase | What it means | How long |
| --- | --- | --- |
| current | the version new integrations should use | until the next one ships |
| supported | still correct, still tested, still documented | at least six months after the next version ships |
| deprecated | still answered, no longer changed, documented as deprecated | at least six months |
| withdrawn | the mount point answers 404 | - |

A version becomes `supported` when the next one ships, and `deprecated` when
the one after that ships. It is withdrawn six months after that.

## What "deprecated" looks like in practice

- The OpenAPI document of a deprecated version says so, in `info.description`
  and in a `deprecated: true` flag on the operations that are going away.
- The version's index route (`GET /api/v1`) says which version is current and
  which one this is.
- The release notes of the build that deprecated it name the replacement.

## What is not versioned

The routes under `/api` - the ones the interface uses - are not versioned and
are not covered by this policy. They change when the interface needs them to
change, and an integration that depends on them should move to `/api/v1`.

That is the whole of the deprecation story for them: they are the interface's
API, they are not a contract with a third party, and the versioned surface is
the contract with a third party. An integration built on the versioned
surface can rely on the six-month rule; an integration built on the
unversioned routes cannot.

## Adding a version

A new version is a new mount point with its own definitions, its own document
and its own deprecation date. The old one is not edited: it keeps answering
the way it answered, and it is marked deprecated rather than changed.

Adding a route to a current version is allowed. Changing the meaning of a
route, removing one, or changing the shape of a response is not: that is a new
version.
