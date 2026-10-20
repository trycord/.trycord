// The measurement behind docs/audit/PERFORMANCE.md.
//
// It boots an instance the way the verification suite does, seeds it with a
// community, a channel and a body of messages, and then measures the paths
// the product is busy on: reading history, searching, posting, and listing
// the reader's communities.
//
// Two numbers are taken for each path: how long it took, and how many
// database statements it made. The second one is what tells you whether a
// slow path is slow because of the work or because of the round trips.
//
//   node docs/audit/measure.js [messages]
//
// The instance is SQLite on the machine this runs on, which is not a
// production profile: the numbers are a floor, not a ceiling. To measure the
// production profile instead, point it at a MySQL server:
//
//   TRYCORD_MEASURE_DB=mysql TRYCORD_MEASURE_DB_HOST=127.0.0.1 \
//   TRYCORD_MEASURE_DB_PORT=3306 TRYCORD_MEASURE_DB_NAME=trycord_perf \
//   TRYCORD_MEASURE_DB_USER=perf TRYCORD_MEASURE_DB_PASSWORD=perf \
//   node docs/audit/measure.js 300

'use strict';

const path = require('path');
const { startRouted, registerUser, createCommunity, postMessage } = require(
  path.join(__dirname, '..', '..', 'backend', 'tests', 'support', 'harness')
);

const MESSAGES = Number(process.argv[2] || 300);

// The database the measurement runs against. SQLite by default; MySQL when
// the environment says so.
function databaseEnv() {
  if (String(process.env.TRYCORD_MEASURE_DB || '').toLowerCase() !== 'mysql') return {};
  return {
    DB_CLIENT: 'mysql',
    DB_HOST: process.env.TRYCORD_MEASURE_DB_HOST || '127.0.0.1',
    DB_PORT: process.env.TRYCORD_MEASURE_DB_PORT || '3306',
    DB_NAME: process.env.TRYCORD_MEASURE_DB_NAME || 'trycord_perf',
    DB_USER: process.env.TRYCORD_MEASURE_DB_USER || 'perf',
    DB_PASSWORD: process.env.TRYCORD_MEASURE_DB_PASSWORD || '',
  };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Count the statements a request makes.
function countStatements(db) {
  const counters = { get: 0, all: 0, run: 0 };
  const originals = {};
  for (const name of ['get', 'all', 'run']) {
    originals[name] = db[name];
    db[name] = function counted(...args) {
      counters[name] += 1;
      return originals[name].apply(db, args);
    };
  }
  return {
    counters,
    stop() {
      for (const name of ['get', 'all', 'run']) db[name] = originals[name];
    },
  };
}

async function measure(label, runs, fn) {
  const times = [];
  let statements = null;
  for (let i = 0; i < runs; i += 1) {
    const db = require(path.join(__dirname, '..', '..', 'backend', 'src', 'db'));
    const counter = countStatements(db);
    const started = process.hrtime.bigint();
    await fn();
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    counter.stop();
    times.push(elapsed);
    if (i === 0) statements = counter.counters;
  }
  const total = statements ? statements.get + statements.all + statements.run : 0;
  console.log(
    label.padEnd(34)
    + ' median ' + median(times).toFixed(2).padStart(7) + ' ms'
    + '   min ' + Math.min(...times).toFixed(2).padStart(7) + ' ms'
    + '   statements ' + String(total).padStart(3)
    + (statements ? ' (get ' + statements.get + ', all ' + statements.all + ', run ' + statements.run + ')' : '')
  );
  return { median: median(times), statements: total };
}

(async () => {
  const env = databaseEnv();
  const ws = await startRouted({ jobs: false, env });
  console.log('database: ' + (env.DB_CLIENT || 'sqlite'));
  const owner = await registerUser(ws, 'owner');
  const community = await createCommunity(ws, owner, 'Bench');
  const channelId = community.channelId;

  console.log('seeding ' + MESSAGES + ' messages...');
  // Seeded straight into the database, and through the same indexer the
  // write path uses, so the body of messages is real without asking the
  // rate limiter for three hundred posts.
  const index = require(path.join(__dirname, '..', '..', 'backend', 'src', 'services', 'search-index'));
  const { uuid } = require(path.join(__dirname, '..', '..', 'backend', 'src', 'clock'));
  for (let i = 0; i < MESSAGES; i += 1) {
    const id = uuid();
    const createdAt = new Date(Date.now() - (MESSAGES - i) * 1000).toISOString();
    await ws.db.run(
      'INSERT INTO messages (id, channel_id, author_id, content, created_at, seq)'
      + ' VALUES (?, ?, ?, ?, ?, ?)',
      [id, channelId, owner.user.id, 'benchmark message number ' + i + ' about releases and notes',
        createdAt, i + 1]
    );
    await index.indexMessage({
      id,
      channelId,
      authorId: owner.user.id,
      content: 'benchmark message number ' + i + ' about releases and notes',
      createdAt,
      serverId: community.serverId,
    });
  }

  const rows = await ws.db.all('SELECT COUNT(*) AS n FROM message_search_words');
  console.log('indexed words: ' + rows[0].n);
  console.log('');

  await measure('GET channel history (50)', 20, async () => {
    await owner.get('/api/channels/' + channelId + '/messages?limit=50');
  });
  await measure('GET search (2 words)', 20, async () => {
    await owner.get('/api/search?q=release notes');
  });
  await measure('GET search (from: filter)', 20, async () => {
    await owner.get('/api/search?q=release notes from:owner');
  });
  await measure('POST a message', 20, async () => {
    await postMessage(owner, channelId, 'one more benchmark message about releases');
  });
  await measure('GET the reader\'s communities', 20, async () => {
    await owner.get('/api/servers');
  });
  await measure('GET the reader\'s notifications', 20, async () => {
    await owner.get('/api/notifications');
  });
  await measure('GET the locale answer', 20, async () => {
    await owner.get('/api/localisation');
  });
  await measure('GET the search history', 20, async () => {
    await owner.get('/api/search/history');
  });

  await ws.stop();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
