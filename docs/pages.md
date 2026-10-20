# Pages

The static pages an instance serves - Terms, Privacy, Trust & Safety,
Support - and the editor that writes them.

A page body is a list of typed blocks, not HTML. That is the whole design:
an administrator cannot inject a script tag into a legal page, because there
is no place to put one. The renderer decides what each block becomes, and
every string that reaches the output is escaped on the way. A page is
therefore a document with a shape, not a blob of markup that the server
trusts.

This document is reference. It describes the vocabulary, what the validator
accepts, what the renderer emits, how the history works, and what a reusable
block is.

## The vocabulary

Eleven block types. Anything else is refused on save rather than dropped
silently, so an editor bug shows up as a validation error instead of an
operator discovering a missing paragraph in production.

| Type | Shape | What it is |
|---|---|---|
| `heading` | `{ level: 2 \| 3, text }` | A section heading. |
| `paragraph` | `{ text }` | A paragraph. |
| `lead` | `{ text }` | The standfirst under the title. Also the page's description. |
| `list` | `{ ordered: bool, items: [string] }` | A bulleted or numbered list. |
| `note` | `{ text, kind: 'info' \| 'warn' }` | An aside. Literal text: it is not formatted. |
| `link` | `{ text, href }` | A link on its own line. |
| `rule` | `{}` | A horizontal rule. |
| `image` | `{ src, alt, width? }` | A picture. |
| `quote` | `{ text, attribution? }` | A block quotation. |
| `code` | `{ text, language? }` | A code block. |
| `table` | `{ headers: [string], rows: [[string]], caption? }` | A table. |

A block's text may carry BBCode, which is the notation operators already type
and the one a page can be lifted out into. The renderer parses it against an
allowlist rather than escaping it whole, so `[b]bold[/b]` is bold and
`[code]x[/code]` is shown, while anything it does not recognise stays literal
text. A `note` is the exception: it is literal, because a note is the
operator's own words about the page rather than prose in it.

## The rules

### Addresses

A `href` may be `http:`, `https:`, `mailto:`, a path into this instance
(`/support`), or a fragment (`#section`). Nothing else. `javascript:` and
`data:` cannot reach the renderer at all, so a stored XSS through a link is
not reachable rather than filtered out later.

An image `src` may be `http:` or `https:`, or a path on this instance. A path
that begins with two slashes (`//host/x.png`) is an address to another host
and is refused, and so is a `data:` source - a picture is a picture, not a
document.

### The limits

| Thing | Limit |
|---|---|
| Blocks in a page | 400 |
| Heading text | 200 characters |
| Paragraph, note text | 8000 characters |
| Lead text | 600 characters |
| Link label | 200 characters |
| List items | 60 items, 500 characters each |
| Image source | 1000 characters |
| Image alt text | 300 characters |
| Image width | 1 to 2400, in pixels |
| Quotation text | 4000 characters |
| Attribution | 200 characters |
| Code text | 20000 characters |
| Code language | 32 characters, letters, digits and `+ # . _ -` |
| Table columns | 12 |
| Table rows | 200 |
| Table cell | 500 characters |
| Table caption | 200 characters |
| Page description | 255 characters |

A table's rows must have exactly as many cells as the table has columns. A
ragged table is refused rather than padded, because a table that means two
different things in two renderers is a table nobody can rely on.

### What the renderer emits

| Block | HTML |
|---|---|
| `heading` | `<h2>` or `<h3>` |
| `paragraph` | `<p>` |
| `lead` | `<p class="lede">` |
| `list` | `<ul>` or `<ol>` of `<li>` |
| `note` | `<div class="draft-note" role="note">` |
| `link` | `<p><a href="…">` |
| `rule` | `<hr>` |
| `image` | `<figure class="page-image"><img src alt width loading="lazy" decoding="async" referrerpolicy="no-referrer">` |
| `quote` | `<blockquote class="page-quote"><p>…</p><footer class="page-quote-source">…</footer>` |
| `code` | `<pre class="page-code"><code class="language-…">` |
| `table` | `<table class="page-table"><caption><thead><tr><th scope="col"><tbody><tr><td>` |

Every attribute in that table is written by the renderer. No block carries an
attribute an editor supplied: there is no event handler to strip, no inline
style, and no class name that came from a document. The text of a code block
is escaped whole, so it cannot close the element it is in.

## The page and its metadata

A page has a route, a title, a description, a status and its outstanding
operator fields. The description is the standfirst - the `lead` block of the
body in force - read from the body rather than stored beside it, so the
metadata and the page cannot disagree about what the page says. While a page
is published, the description follows the published body; a draft that
changes the standfirst does not change what the page is described as until
it is published.

`outstandingFields` are the `OPERATOR:` markers still in the body: the parts
of a shipped template that an operator has not filled in yet. They are read
out of the stored body, so the console can show an operator which parts of
their policy are still a template without them having to remember.

## The history

Revisions are append-only. Saving a draft writes one, publishing writes one,
and restoring an older revision writes one as well - it never rewrites the
old one, so the history of what was published, in what order, by whom, is
never edited after the fact.

The revision list carries the body of each revision, which is what makes two
of them comparable, and says which revision is the published one and which is
the current draft.

### Comparing two revisions

`GET /api/admin/pages/:route/revisions/compare?from=1&to=2` answers what
changed between two revisions. The answer is a report about the content, not
a rendered diff, because how two revisions are shown is the client's
decision:

```json
{
  "route": "terms",
  "from": { "revision": 1, "title": "Terms of Service", "state": "DRAFT", "authorId": "…", "createdAt": "…" },
  "to":   { "revision": 2, "title": "Terms", "state": "DRAFT", "authorId": "…", "createdAt": "…" },
  "titleChanged": true,
  "added":   [ { "index": 2, "block": { "type": "list", "ordered": false, "items": ["A new list"] } } ],
  "removed": [ { "index": 2, "block": { "type": "paragraph", "text": "The second paragraph." } } ],
  "changed": [ { "fromIndex": 1, "toIndex": 1, "before": { … }, "after": { … } } ],
  "unchanged": 1,
  "summary": { "added": 1, "removed": 1, "changed": 1, "unchanged": 1 }
}
```

Blocks are matched on their whole content, so a paragraph that moved down
the page is not a removal and an addition. What is left over is paired by
type - the first paragraph here with the first paragraph there - because that
is what an operator means by "this paragraph was rewritten".

## Reusable blocks

A reusable block is content written once and used in more than one page: the
contact details at the foot of every policy, the standard note about
moderation.

The library is on the server. A block that lives in one browser cannot be
shared with the person sitting at the next desk, and a block that cannot be
shared between two administrators of the same instance is not a shared block.

| Field | Meaning |
|---|---|
| `id` | The block's id. |
| `name` | What it is called, at most 128 characters. |
| `body` | The blocks it holds, held to the page validator. |
| `scope` | `SHARED` or `PERSONAL`. |
| `authorId` | Who wrote it. |
| `createdAt`, `updatedAt` | When. |

A **shared** block is instance content: it is in the library of every
administrator, and writing one is an administrative act. A **personal** block
belongs to its author; no other administrator can see it, change it or
delete it, and one that is not yours is reported as not found rather than as
forbidden, because the library is not an inventory of other people's work.

A block's scope is fixed when it is created. Making a block shared later is
done by creating it shared, so what enters and leaves the instance-wide
library is always an explicit act. Creating, changing and deleting a block
is audited.

### A page holds the content, not a reference

Inserting a block copies its blocks into the page. The page stores what any
page stores - blocks - and the revision records them as they were at that
moment.

This is deliberate. Resolving a block at render time would mean that editing
the block changed every page that used it, including a page that was already
published and accepted. A published page is a thing visitors have already
read; it does not move because somebody edited a library entry.

## The API

Every route below requires a session and the administrator guard.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/admin/pages` | Every editable page, with its metadata. |
| `GET` | `/api/admin/pages/:route` | One page: its draft, its published body, its metadata. |
| `PUT` | `/api/admin/pages/:route` | Save the draft. `{ preview: true }` renders instead of saving. |
| `POST` | `/api/admin/pages/:route/publish` | Publish the draft. The body must be the route, as confirmation. |
| `POST` | `/api/admin/pages/:route/unpublish` | Take the page down. |
| `GET` | `/api/admin/pages/:route/revisions` | The revision history, with the body of each revision. |
| `GET` | `/api/admin/pages/:route/revisions/compare?from=&to=` | What changed between two revisions. |
| `POST` | `/api/admin/pages/:route/revisions/:revision/restore` | Put an earlier revision back, as a new draft. |
| `GET` | `/api/admin/pages/blocks` | The reusable blocks this administrator may use. |
| `POST` | `/api/admin/pages/blocks` | Write a block. `{ name, body, scope }`. |
| `PUT` | `/api/admin/pages/blocks/:id` | Change a block's name or body. |
| `DELETE` | `/api/admin/pages/blocks/:id` | Delete a block. |

A page that has never been saved reads as an empty draft rather than as
missing, so the editor can open every page it is allowed to edit.

## Compatibility

A page published under the earlier seven-block vocabulary renders exactly as
it did, byte for byte, and a revision written before images, quotations,
code and tables existed still restores. The old blocks were not changed; they
were added to.

The BBCode export is unchanged for the old vocabulary as well. The new blocks
export as `[img]…[/img]`, `[quote=…]…[/quote]`, `[code]…[/code]` and a
`[table]` of `[tr]`/`[td]` rows, which is what a forum understands rather
than what this renderer parses.

Last verified: the page suite passes against a running instance
(`backend/tests/pages/`).
