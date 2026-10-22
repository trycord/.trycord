'use strict';

// The public pages, as a search engine and a chat client see them.
//
// The pages are static files, so the metadata a crawler reads has to be
// added when the page is served - the address a page is canonical at is the
// address it was asked for, and a self-hosted instance must not claim that
// its pages belong to somebody else's site.
//
// The check covers the tags that carry the page's name, its description and
// its address, and the structured data that says what the site is.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance } = require('../helpers/instance');

async function page(instance, path) {
  const answer = await fetch(instance.baseUrl + path, { redirect: 'manual' });
  return { status: answer.status, type: answer.headers.get('content-type') || '', body: await answer.text() };
}

test('a public page carries its own name, description and address', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  for (const path of ['/', '/features', '/developers', '/terms']) {
    const answer = await page(instance, path);
    assert.equal(answer.status, 200, path + ' did not answer');
    assert.match(answer.type, /text\/html/, path + ' was not a page');

    const title = /<title>([^<]+)<\/title>/.exec(answer.body);
    assert.ok(title, path + ' has no title');
    assert.ok(title[1].trim().length > 5, path + ' has a title that says nothing');

    const description = /<meta name="description" content="([^"]+)"/.exec(answer.body);
    assert.ok(description, path + ' has no description');
    assert.ok(description[1].trim().length > 20, path + ' has a description that says nothing');

    // The canonical address is the one the page was asked for, on the
    // instance's own host. An instance that has its own domain must not be
    // told that its pages live somewhere else.
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(answer.body);
    assert.ok(canonical, path + ' has no canonical address');
    assert.ok(canonical[1].startsWith(instance.baseUrl), path + ' points its canonical at '
      + canonical[1] + ' rather than at itself');

    const og = /<meta property="og:title" content="([^"]+)"/.exec(answer.body);
    assert.ok(og, path + ' has no link preview title');
    assert.equal(og[1], title[1].trim(), path + ' has a different name in its preview');

    const image = /<meta property="og:image" content="([^"]+)"/.exec(answer.body);
    assert.ok(image, path + ' has no link preview image');
    assert.ok(image[1].startsWith(instance.baseUrl), path + ' points its preview image at '
      + image[1] + ' rather than at itself');

    const card = /<meta name="twitter:card" content="([^"]+)"/.exec(answer.body);
    assert.ok(card, path + ' has no card type for the preview');
  }
});

test('the pages that are not for search engines say so', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  // The application's own pages are behind a sign-in and are not the public
  // site's business. The robots file says where the public site ends.
  const robots = await page(instance, '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.body, /Disallow: \/app\//, 'the application is not kept out of the index');
  assert.match(robots.body, /Sitemap: /, 'the robots file does not point at the sitemap');

  const sitemap = await page(instance, '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.body, /<urlset/, 'the sitemap is not a url set');
  assert.match(sitemap.body, /<loc>[^<]*\/<\/loc>/, 'the sitemap does not list the homepage');
  assert.equal(/<loc>[^<]*\/app\//.test(sitemap.body), false,
    'the sitemap lists the application, which is not for search engines');
});
