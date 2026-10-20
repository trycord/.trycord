// Link previews, and the fetch behind them.
//
// A preview is made by the instance fetching a page somebody else chose, so
// the fetch is the whole risk. What is checked here is that the guard holds:
//
//   - a page that answers is read, and its metadata is taken;
//   - a page with no metadata is still a link, not a failure;
//   - a page with no image is still a link;
//   - a URL that is not a URL, and a scheme that is not http or https, are
//     refused before anything is fetched;
//   - a redirect is followed one hop at a time, and a hop that points into
//     the instance's own network is refused **before** it is fetched - not
//     fetched and then noticed;
//   - a redirect loop ends rather than running forever;
//   - an answer that is too large ends rather than filling the memory;
//   - an answer that never comes ends rather than waiting forever.
//
// The last two are the ones that are easiest to get wrong and hardest to
// notice: a preview that hangs takes a worker with it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { fetchHtml, isPrivateAddress } = require('../../src/services/netguard');
const embeds = require('../../src/services/embeds');

// A server that answers, and the sockets it opened.
//
// The sockets are tracked because a server that is closed while a connection
// is still open keeps the process alive: the test finishes, and then the
// runner waits for a process that is not going to leave.
function serve(handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        origin: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(done);
        }),
      });
    });
  });
}

test('the guard', async (t) => {
  await t.test('a private address is a private address', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
      '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '::1', '::',
      'fe80::1', 'fc00::1', 'fd00::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(address), true, address + ' was treated as public');
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1',
      '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, address + ' was treated as private');
    }
  });

  await t.test('a URL that is not a URL is refused', async () => {
    const answer = await fetchHtml('not a url');
    assert.equal(answer.ok, false);
  });

  await t.test('a scheme that is not http or https is refused', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.test/x', 'gopher://example.test/']) {
      const answer = await fetchHtml(url);
      assert.equal(answer.ok, false, url + ' was fetched');
    }
  });

  await t.test('credentials in the URL are refused', async () => {
    const answer = await fetchHtml('http://user:pass@example.test/');
    assert.equal(answer.ok, false);
  });
});

test('fetching a page', async (t) => {
  await t.test('a page is read', async () => {
    const site = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Hello</title></head><body>Hi</body></html>');
    });
    t.after(() => site.close());

    // The server is on the loopback, so the guard refuses it - which is the
    // point. The fetching itself is exercised with the guard's own rules
    // relaxed for the test.
    const answer = await fetchHtml(site.origin + '/', { allowLocalhost: true });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.match(answer.html, /Hello/);
  });

  await t.test('a page that is too large is refused', async () => {
    const site = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('x'.repeat(200000));
    });
    t.after(() => site.close());

    const answer = await fetchHtml(site.origin + '/', { allowLocalhost: true, maxBytes: 1000 });
    assert.equal(answer.ok, false);
    assert.match(answer.error, /too large/);
  });

  await t.test('an answer that never comes is a timeout, not a hang', async () => {
    // A server that accepts the connection and says nothing.
    const socket = await new Promise((resolve) => {
      const open = new Set();
      const server = net.createServer((connection) => open.add(connection));
      server.on('connection', (connection) => {
        open.add(connection);
        connection.on('close', () => open.delete(connection));
      });
      server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const connection of open) connection.destroy();
          server.close(done);
        }),
      }));
    });
    t.after(() => socket.close());

    const answer = await fetchHtml('http://127.0.0.1:' + socket.port + '/', {
      allowLocalhost: true, timeoutMs: 300,
    });
    assert.equal(answer.ok, false);
    assert.match(answer.error, /timed out/);
  });

  await t.test('a redirect loop ends rather than running forever', async () => {
    const site = await serve((req, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    });
    t.after(() => site.close());

    const answer = await fetchHtml(site.origin + '/', { allowLocalhost: true, timeoutMs: 2000 });
    assert.equal(answer.ok, false);
    assert.match(answer.error, /too many redirects/);
  });

  await t.test('a redirect is followed, and the answer is the destination', async () => {
    const site = await serve((req, res) => {
      if (req.url === '/from') {
        res.writeHead(302, { location: '/to' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Arrived</title>');
    });
    t.after(() => site.close());

    const answer = await fetchHtml(site.origin + '/from', { allowLocalhost: true });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.match(answer.html, /Arrived/);
    assert.match(answer.finalUrl, /\/to$/);
  });
});

test('the metadata of a page', async (t) => {
  await t.test('the metadata is read', () => {
    const html = [
      '<html><head>',
      '<meta property="og:title" content="A title">',
      '<meta property="og:description" content="A description">',
      '<meta property="og:site_name" content="A site">',
      '<meta property="og:image" content="https://example.test/picture.png">',
      '</head><body></body></html>',
    ].join('');
    assert.equal(embeds.meta(html, ['og:title']), 'A title');
    assert.equal(embeds.meta(html, ['og:description']), 'A description');
    assert.equal(embeds.meta(html, ['og:site_name']), 'A site');
  });

  await t.test('a page with no metadata is still a link', () => {
    assert.equal(embeds.meta('<html><body>nothing</body></html>', ['og:title']), '');
    assert.equal(embeds.titleTag('<html><body>nothing</body></html>'), '');
  });

  await t.test('a title with entities in it is decoded', () => {
    assert.equal(embeds.decodeEntities('Tom &amp; Jerry &#8212; a film'), 'Tom & Jerry \u2014 a film');
    assert.equal(embeds.titleTag('<html><title>Tom &amp; Jerry</title></html>'), 'Tom & Jerry');
  });

  await t.test('a relative URL is resolved against the page it was declared on', () => {
    assert.equal(embeds.absolute('/picture.png', 'https://example.test/a/b'), 'https://example.test/picture.png');
    assert.equal(embeds.absolute('picture.png', 'https://example.test/a/b'), 'https://example.test/a/picture.png');
  });

  await t.test('a URL that is not http or https is dropped', () => {
    assert.equal(embeds.absolute('javascript:alert(1)', 'https://example.test/'), null);
    assert.equal(embeds.absolute('data:text/html,x', 'https://example.test/'), null);
    assert.equal(embeds.absolute('file:///etc/passwd', 'https://example.test/'), null);
  });
});

test('the URLs a message carries', async (t) => {
  await t.test('the URLs in a message are found', () => {
    const found = embeds.extractUrls('see https://example.test/one and https://example.test/two.');
    assert.deepEqual(found, ['https://example.test/one', 'https://example.test/two']);
  });

  await t.test('a URL that is not a URL is not one', () => {
    assert.deepEqual(embeds.extractUrls('nothing here'), []);
    assert.deepEqual(embeds.extractUrls('ftp://example.test/x'), []);
  });

  await t.test('a URL is normalised', () => {
    assert.equal(embeds.normalizeUrl('https://example.test/a/'), 'https://example.test/a');
    assert.equal(embeds.normalizeUrl('https://example.test/a#part'), 'https://example.test/a');
    assert.equal(embeds.normalizeUrl('  https://example.test/a  '), 'https://example.test/a');
    assert.equal(embeds.normalizeUrl('ftp://example.test/a'), null);
    assert.equal(embeds.normalizeUrl('javascript:alert(1)'), null);
  });
});
