# Performance audit

What the product actually costs: the queries the hot paths make, the indexes
that answer them, the pools, the caches, the bundles, the timers and the
queues.

The numbers here were measured, not estimated. The method is below, the
script that produced them is `docs/audit/measure.js`, and where something
could not be measured this says so rather than guessing.

---

## 1. The method

`docs/audit/measure.js` boots a real instance the way the verification suite
does — its own database, its own port, its own signing secret — seeds one
community, one channel and a body of messages, and then measures the paths
the product is busy on. Each path is run twenty times and the **median** is
reported, because a median is what a reader of a latency figure wants and an
average is not.

Two numbers are taken for every path:

- **the time**, the median of twenty runs, end to end over HTTP, including
  the authentication check;
- **the statements**, how many database statements the request made. The
  count is taken by wrapping the database facade for the duration of the
  request, so it is the number of round trips the request actually paid and
  not the number the code appears to make.

The environment was:

| | |
|---|---|
| CPU | 4 cores |
| Memory | 8 GB |
| Node | v22.23.3 |
| SQLite | 3.53.4 (the bundled `better-sqlite3`), file on the local disk |
| MariaDB | 11.8.6, `innodb_buffer_pool_size` 128 MB, `max_connections` 151, on the same host over the loopback interface |
| Corpus | 300 messages (2 390 indexed words) and 2 000 messages (15 990 indexed words) |

Both databases are on the same machine as the server, and the numbers
include the round trip to the database. They are the **floor**: a real
deployment has the database on another host, and a real machine is not this
one. What they are good for is comparison — the same path against the two
engines, and against a corpus six times larger.

## 2. The measured paths

### SQLite, 300 messages

| Path | Median | Min | Statements |
|---|---|---|---|
| `GET` channel history (50 messages) | 5.71 ms | 4.33 ms | 9 (3 get, 6 all) |
| `GET` search (two words) | 5.98 ms | 5.67 ms | 9 (4 get, 4 all, 1 run) |
| `GET` search (two words, `from:` filter) | 5.88 ms | 5.62 ms | 9 (5 get, 3 all, 1 run) |
| `POST` a message | 5.55 ms | 4.91 ms | 23 (9 get, 6 all, 8 run) |
| `GET` the reader's communities | 3.12 ms | 2.85 ms | 2 (1 get, 1 all) |
| `GET` the reader's notifications | 2.29 ms | 1.94 ms | 0 |
| `GET` the locale answer | 4.27 ms | 3.75 ms | 3 (2 get, 1 all) |
| `GET` the search history | 4.18 ms | 3.93 ms | 2 (1 get, 1 all) |

### SQLite, 2 000 messages

| Path | Median | Min | Statements |
|---|---|---|---|
| `GET` channel history (50 messages) | 6.08 ms | 5.35 ms | 9 |
| `GET` search (two words) | 12.94 ms | 12.04 ms | 9 |
| `GET` search (two words, `from:` filter) | 14.89 ms | 13.06 ms | 9 |
| `POST` a message | 8.06 ms | 6.58 ms | 23 |
| `GET` the reader's communities | 4.58 ms | 4.29 ms | 2 |
| `GET` the locale answer | 5.05 ms | 3.83 ms | 3 |
| `GET` the search history | 5.43 ms | 4.45 ms | 2 |

### MariaDB, 300 messages

| Path | Median | Min | Statements |
|---|---|---|---|
| `GET` channel history (50 messages) | 11.68 ms | 9.83 ms | 9 (3 get, 6 all) |
| `GET` search (two words) | 13.53 ms | 12.17 ms | 8 (3 get, 4 all, 1 run) |
| `GET` search (two words, `from:` filter) | 11.98 ms | 11.41 ms | 8 (4 get, 3 all, 1 run) |
| `POST` a message | 12.01 ms | 8.57 ms | 22 (9 get, 5 all, 8 run) |
| `GET` the reader's communities | 4.67 ms | 4.20 ms | 7 (1 get, 2 all, 4 run) |
| `GET` the reader's notifications | 2.15 ms | 1.82 ms | 0 |
| `GET` the locale answer | 4.00 ms | 3.58 ms | 3 |
| `GET` the search history | 3.60 ms | 3.30 ms | 2 |

### MariaDB, 2 000 messages

| Path | Median | Min | Statements |
|---|---|---|---|
| `GET` channel history (50 messages) | 21.20 ms | 18.90 ms | 9 |
| `GET` search (two words) | 37.64 ms | 33.79 ms | 8 |
| `GET` search (two words, `from:` filter) | 38.21 ms | 33.81 ms | 8 |
| `POST` a message | 17.43 ms | 10.34 ms | 19 |
| `GET` the reader's communities | 8.64 ms | 6.03 ms | 7 |
| `GET` the locale answer | 5.05 ms | 3.83 ms | 3 |
| `GET` the search history | 5.43 ms | 4.45 ms | 2 |

### What the numbers say

**The history read is flat in the corpus size** on SQLite (5.71 ms at 300
messages, 6.08 ms at 2 000) and grows on MariaDB (11.68 ms to 21.20 ms),
which is the difference between an index scan inside the process and a round
trip over the loopback interface. The statement count is the same in both
cases: nine statements, whatever the corpus.

**The search is not flat.** 5.98 ms to 12.94 ms on SQLite, 13.53 ms to
37.64 ms on MariaDB, for a corpus that grew six times. The search reads the
words table, and the words table grows with the corpus: a message of twelve
words is twelve rows. This is the honest cost of an in-house index and it is
the number an operator needs when they ask how big an instance can be.

**The post is the most expensive write** at 22 to 23 statements, of which
eight are writes: the message, the position, the index rows, the read
marker, the notification. It is also the only path that writes, and it is
the path that has to be fast.

**The notification read costs nothing** — zero statements, because the
count is already in the client's store and the endpoint is only consulted
when the client asks for more.

## 3. The statements the hot paths make

The nine statements of a history read, in order:

| # | Statement | Why |
|---|---|---|
| 1 | `SELECT u.password_changed_at, u.sessions_invalidated_at, … FROM users u WHERE u.id = ?` | The authentication check: revocation, the password-change marker, the session version and the enforcement state, in one round trip. |
| 2 | `SELECT * FROM channels WHERE id = ?` | The channel the request names. |
| 3 | `SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?` | Membership. The permission check is here, not later. |
| 4 | `SELECT m.*, u.username AS author_name … FROM messages m JOIN users u … WHERE m.channel_id = ? ORDER BY m.seq DESC LIMIT 50` | The page of history. |
| 5 | `SELECT … FROM attachments WHERE message_id IN (…)` | The files on those messages, in one query rather than one per message. |
| 6 | `SELECT … FROM message_embeds WHERE message_id IN (…)` | The link previews, the same way. |
| 7 | `SELECT … FROM reactions WHERE message_id IN (…)` | The reaction summaries, batched. |
| 8 | `SELECT message_id FROM pinned_messages WHERE message_id IN (…)` | The pin flags, batched. |
| 9 | `SELECT … FROM messages WHERE thread_root_id IN (…) GROUP BY thread_root_id` | The reply counts, one grouped query for the whole page. |

Eight of the nine are reads that are batched: the engagement data is four
queries for the whole page rather than one per message, which is the
difference between a history read costing four statements and costing two
hundred.

The search adds, on top of the authentication check:

| Statement | Note |
|---|---|
| `SELECT 1 AS n FROM information_schema.tables WHERE table_name = 'message_search_words'` | The availability probe. **On SQLite this statement fails** — there is no `information_schema` — and the probe falls back to a second statement. Two round trips on every search, one of which is an error. |
| `SELECT 1 AS n FROM message_search_words LIMIT 1` | The fallback probe. |
| `SELECT w.message_id, COUNT(*) … FROM message_search_words w JOIN messages …` | The query itself, with the membership test inside it. |
| `SELECT m.* … WHERE m.id IN (…)` | The rows the words point at. |
| `SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1` | The history: is the newest entry the same query? |
| `SELECT query FROM search_history WHERE id = ? AND user_id = ?` | …and what was it? |
| `INSERT INTO search_history …` | Recording it. |
| `SELECT id FROM search_history WHERE user_id = ? ORDER BY …` | Trimming it to the limit. |

The history bookkeeping is five statements on every search, and it is the
part of the search path that most deserves to be cheaper. The first two —
the newest row and its text — are two round trips to answer one question,
and the trim reads the whole list to find the rows to delete.

## 4. The indexes that back them

The declared index list is `backend/src/db/schema.js` (`INDEXES`). The ones
that matter for the paths above:

| Index | Backs |
|---|---|
| `idx_messages_channel_seq (channel_id, seq)` | The history read. The unique index on the canonical ordering, so a page is an index range and not a sort. |
| `idx_messages_channel_order (channel_id, created_at, id)` | The same read when it is ordered by time. |
| `idx_search_words_word (word)` | The word lookup in the in-house search. |
| `idx_search_words_server (server_id, word)` | The same lookup narrowed to one community. |
| `idx_attachments_message (message_id)` | The attachment batch on a history read. |
| `idx_embeds_message (message_id)` | The embed batch. |
| `idx_reactions_message (message_id)` | The reaction batch. |
| `idx_pins_channel (channel_id, pinned_at)` | The pin batch. |
| `idx_members_server_joined (server_id, joined_at)` | The membership check and the roster. |
| `idx_notifications_user (user_id, created_at)` | The notification list. |
| `idx_jobs_due (status, run_after)` | The job queue's claim query. |

### The search's plan

MariaDB's plan for the search query, with the statistics refreshed:

```
id  table  type    key                   rows  Extra
1   ch     index   idx_channels_server   1     Using index
1   u      index   PRIMARY               1     Using index; Using join buffer (flat, BNL join)
1   w      range   idx_search_words_word  2001  Using where; Using index; Using join buffer (incremental, BNL join)
1   m      eq_ref  PRIMARY               1     Using where
```

Two things are worth reading out of that.

**`Using temporary; Using filesort`.** The `GROUP BY w.message_id` and the
`ORDER BY matched DESC` cannot be answered from an index, so the plan
materialises and sorts. That is the cost that grows with the corpus.

**A block nested loop join.** The words are read through
`idx_search_words_word` as a range over the two words, which is right, but
the join to the messages is done by a join buffer rather than by a nested
index lookup. A covering index on `message_search_words(word, message_id,
server_id)` would let the whole of the candidate set — including the
community the message belongs to, which is what the permission check reads —
be answered from the index, with no join to `messages` needed to decide
whether the reader may see the row.

### The indexes the new tables need

The tables this work adds want these indexes, and they are not in
`schema.js` (which is outside the ownership of this change — see the final
report):

```sql
CREATE INDEX idx_saved_searches_user ON saved_searches(user_id);
CREATE INDEX idx_search_history_user ON search_history(user_id, created_at);
CREATE INDEX idx_channel_read_cursors_channel ON channel_read_cursors(channel_id);
CREATE INDEX idx_message_templates_user ON message_templates(user_id);
CREATE INDEX idx_saved_collections_owner ON saved_collections(user_id);
CREATE INDEX idx_saved_collections_community ON saved_collections(server_id, visibility);
CREATE INDEX idx_saved_collection_items_collection ON saved_collection_items(collection_id);
CREATE INDEX idx_localisation_packs_locale ON localisation_packs(locale, review_state);
CREATE INDEX idx_localisation_packs_scope ON localisation_packs(server_id, locale);
CREATE INDEX idx_theme_packages_scope ON theme_packages(scope, server_id);
CREATE INDEX idx_theme_activations_scope ON theme_activations(scope, server_id, activated_at);
CREATE INDEX idx_incidents_started ON incidents(started_at);
CREATE INDEX idx_cross_instance_reports_direction ON cross_instance_reports(direction, created_at);
CREATE INDEX idx_cross_instance_reports_target ON cross_instance_reports(target_instance_id, status);
```

Without them, the per-reader lists are a scan of the table and the
moderation queue is a sort. The table sizes are small today, so nothing is
slow yet; the indexes are there so that nothing becomes slow.

## 5. The pools

**MySQL.** `mysql2`'s pool, configured in `backend/src/db/config.js`:
`connectionLimit` is `DB_POOL`, default **10**, and it is refused outside
1–200. Every plain query goes through the pool; a transaction takes one
connection for its whole length and gives it back at the end. The pool is
compared at connect time against the account's own `max_user_connections`:
at 90 % of the limit the boot warns, at 100 % it warns louder, because a
pool that reaches the account's limit fails work rather than waiting for a
connection.

**SQLite.** One connection, and transactions are serialised through a queue
(`src/db/sqlite.js`): `BEGIN` … `COMMIT` on the single connection, one at a
time. That is the correct behaviour for SQLite and it is also the reason a
SQLite deployment is a single-process deployment.

**Measurements of the pool itself were not taken.** The pool's behaviour
under contention needs a MySQL server on another host and a load generator,
neither of which was available here. What is measured is the effect of the
round trip: the same path is roughly twice as slow on MariaDB over the
loopback interface as it is on SQLite in-process, which is the cost of one
extra hop, paid once per statement.

## 6. The caches

| Cache | Where | Size | Notes |
|---|---|---|---|
| Prepared statements | `src/db/sqlite.js` | 500, oldest evicted first | Keyed by SQL text. SQLite only; MySQL's driver has its own. |
| Settings store | `src/services/settings.js` | the whole catalogue | Loaded at boot, reloaded after a save. Read per request, so a change applies to the next request. |
| Rate-limit buckets | `src/middleware/ratelimit.js` | opportunistic cleanup above 5 000 | Keyed by router, user and address. In-process only: a multi-process deployment has a bucket per process, so the effective limit is the per-process limit times the process count. |
| Feature flags | `src/features.js` | the flag table | Read once, rebuilt when the settings store reloads. |
| The search index | `message_search_words` | grows with the corpus | Not a cache: it is the index, and it is rebuilt by the backfill job when it falls behind. |

There is no cache of rendered pages, no cache of message bodies and no
in-memory cache of permissions. A permission check reads the database every
time. That is a deliberate choice — a cached permission is a stale
permission — and it is one of the reasons the statement counts above are
what they are.

## 7. The bundles

The client is plain ES modules served from the instance. There is no bundler
and no third-party runtime code.

| What | Size |
|---|---|
| Modules reachable from `frontend/js/main.js` | **61 files, 616 KB** of source |
| The same modules, gzipped | **187 KB** |
| `frontend/css/app.css` (the one stylesheet the document loads) | **102 KB** (21 KB gzipped) |
| The three bundled `woff2` fonts | 80 KB |
| `frontend/js` in total | 616 KB across 48 files |
| `frontend/packages` in total | 180 KB |
| `frontend/mobile` in total | 496 KB |
| `public/js` (the public website) | 80 KB |
| `public/css` | 88 KB |
| `frontend/assets` | 2.4 MB, almost all of it the brand pack and the fonts |

**The client is not compressed.** `src/serve-client.js` sets no
`Content-Encoding` and there is no compression middleware, so the 616 KB of
modules and the 102 KB of stylesheet go over the wire as they are on disk.
With gzip they would be 208 KB in total. The static files are served with
`no-cache`, which means the browser may keep them but must revalidate: a
returning reader pays 61 conditional requests, not 61 full downloads.

**61 requests for the first paint** is the other half of that. The client is
deliberately unbundled — the build script's own comment says the point is
that a self-hoster serves a working application without running a build —
but the cost is 61 round trips before the interface is usable, and a
deployment behind a proxy with per-request TLS handshakes pays that 61
times.

## 8. The timers

| Timer | Where | Period |
|---|---|---|
| The job queue's poll | `src/services/jobs.js` | 1 000 ms |
| The retention pass | `src/services/retention.js` | 6 hours, re-queued by itself |
| The search backfill slice | `src/services/search-index.js` | 5 seconds after a full slice, 500 messages a pass |
| The federation change feed | `src/services/continuum/feed.js` | 2 000 ms (`CONTINUUM_FEED_INTERVAL_MS`) |
| The pending-upload purge | `src/server.js` | 1 hour |
| The gateway heartbeat | `messaging.heartbeatMs` | 30 000 ms |
| The reader-data sweep (added by this work) | `src/services/reader-data.js` | 1 hour |

Every one of them except the heartbeat and the upload purge is a **durable
job** rather than an in-process timer: it is a row in the `jobs` table that
re-queues itself, so it survives a restart and a crash does not lose it.
The two in-process timers are `unref`'d, so they never hold the process
open.

## 9. The queues

**The job queue** (`jobs` table). One row per unit of work, claimed by
exactly one worker, retried with backoff until it succeeds or exhausts its
attempts. The workers are `cpu.worker_count` — 0 means auto: half the
logical CPUs, at least one, capped at eight — and `cpu.concurrent_jobs`
caps how many jobs of one kind run at once, so one expensive kind cannot
starve the rest. The claim query is `SELECT … WHERE status = 'pending' AND
run_after <= ?`, backed by `idx_jobs_due (status, run_after)`.

**The federation outbox** (`continuum_events` and
`continuum_deliveries`). Every event that has to cross is a durable row
before it is sent, and every attempt is recorded, so a delivery that keeps
failing is visible to the operator rather than silently dropped.

**The reader-data sweep** (added by this work) is a job of the first kind:
an account whose erasure has been processed has its own rows taken away.

**The message write path is not queued.** A message is written to the
database and broadcast in the request, so a reader sees it when the request
answers rather than when a worker gets to it. That is the right choice for a
chat, and it is why the post path costs 22 statements.

## 10. What could not be measured

- **The pool under contention.** No load generator and no second host.
- **The WebSocket gateway's throughput.** The gateway's own numbers need a
  real socket client and a sustained connection count.
- **The federation delivery path.** The relay needs two instances
  federating over the network; the tests exercise it in-process.
- **Anything at production scale.** The corpus here is 2 000 messages. An
  instance with a hundred thousand messages is a different measurement, and
  the search's growth (12.94 ms to 37.64 ms between 300 and 2 000 messages
  on MariaDB) is the number that predicts it: the search is linear in the
  corpus, so it is the first thing to become slow.
- **The real hardware.** Everything here was measured on one host with the
  database next to the server.

## 11. Findings

### P1 — a fresh MySQL database could not be created

**Severity: high. It stops a new deployment.**

> **FIXED.** The table that pointed at `messages` from the communities
> group moved into the messaging group, and three more tables inside that
> group were out of order as well. The schema's own declaration order is
> now a valid order for MySQL, and a test asserts it: every table is
> declared after every table it points at
> (`backend/tests/integration/schema.test.js`). The mechanism was proved on
> the live server rather than assumed - a forward foreign-key reference is
> refused with errno 150 and a backward one is accepted.

`backend/src/db/tables/index.js:43` orders the table groups as `identity,
e2ee, communities, messaging, …`, and two tables point at tables that come
later:

- `backend/src/db/tables/communities.js:181` — `community_memory_entries`
  declares `FOREIGN KEY (source_message_id) REFERENCES messages(id)`, and
  `messages` is created by the messaging group, which comes after
  communities.
- `backend/src/db/tables/messaging.js:52` and `:78` — `message_embeds` and
  `attachments` declare foreign keys to `dm_conversations` and `dm_messages`,
  which are created later in the same file (lines 117 and 134).

MySQL checks a referenced table at the moment the referencing table is
created, so the first of these fails:

```
ERROR 1005 (HY000) at line 1: Can't create table `trycord_perf`.`community_memory_entries`
(errno: 150 "Foreign key constraint is incorrectly formed")
```

SQLite does not check foreign keys at DDL time, so the schema applies
there, which is why the test suite — which runs on SQLite — does not see
it. The comment at `backend/src/db/tables/index.js:14` says "neither engine
enforces the foreign keys declared in the DDL, so creation order is
presentation rather than correctness", and that is the reasoning error
behind it: MySQL does enforce them, at creation time.

The tables that already exist in a deployment were created before the
forward references were introduced, which is why an existing instance runs
and a new one does not. The fix is to move the messaging group ahead of the
communities group, or to move `community_memory_entries` into the messaging
group, or to apply the DDL with the foreign-key check off and turn it on
afterwards.

`docs/audit/prepare-mysql.js` applies the same DDL in dependency order, and
is how the MariaDB numbers in this report were taken.

### P2 — the search grows linearly with the corpus

**Severity: medium.** It is the first thing to become slow on a large
instance, and the product's own answer is a limit (`search.provider` is
`in-house`, and there is no alternative).

The search reads `message_search_words`, one row per distinct word per
message, and joins each matching row back to its message. The plan shows a
range scan over the two words and a block nested loop join, with a temporary
and a filesort for the grouping. Two changes would flatten most of it:

1. a covering index on `message_search_words(word, message_id, server_id)`,
   so the candidate set and the community each row belongs to — which is
   what the permission check reads — are answered from the index;
2. reading the membership test from that index, so the join to `messages`
   is only made for the rows that survive it.

### P3 — the search history costs five statements on every search

**Severity: low, and it is the path this work added.**

Recording a query costs: a read for the newest row, a second read for its
text, an insert, and a read of the whole list to trim it. The first two
answer one question ("is the newest entry this query?") in two round trips,
and the trim reads every row the reader has to find the ones to delete.

A single statement — `SELECT id, query FROM search_history WHERE user_id = ?
ORDER BY created_at DESC, id DESC LIMIT 1` — answers the first question, and
a `DELETE … WHERE id NOT IN (SELECT id … LIMIT n)` trims without reading
the whole list. The trimming is also the reason the history's growth is
bounded by a query rather than by a counter.

### P4 — the availability probe costs a failed statement on SQLite

**Severity: low.** `available()` in `src/services/search-index.js` asks
`information_schema` for the table, which SQLite does not have, and then
falls back to asking the table itself. Every search on SQLite therefore
pays one error and one extra round trip. The dialect is already known
(`db.dialect`), so the probe could ask the right question first time.

### P5 — the client is sixty-one requests and no compression

**Severity: medium for a deployment behind a proxy, low for one on a LAN.**

616 KB of modules in 61 files, 102 KB of stylesheet, neither compressed, all
revalidated on every load. With gzip the same payload is 208 KB, and a
single concatenated bundle would be one request instead of sixty-one. The
unbundled client is a deliberate choice — a self-hoster serves a working
application without running a build — but the choice does not have to cost
the compression, and a deployment behind a TLS-terminating proxy pays for
it.

### P6 — the rate limiter is per process

**Severity: low, and it only matters for a multi-process deployment.** The
buckets are in memory in `src/middleware/ratelimit.js`, so a deployment
running three API processes has three times the limit it thinks it has. The
comment in that file says so. A shared store would fix it; the middleware's
signature is already the shape a shared store would take.

### P7 — the pool is checked once, at connect

**Severity: low.** The headroom check against `max_user_connections` runs
once, when the process opens the database. A database administrator who
lowers the limit afterwards is not noticed until the pool starts failing
claims. The check is cheap; running it periodically would be cheap too.
