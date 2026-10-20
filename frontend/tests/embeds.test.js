// The link preview.
//
// The card is the thing a reader sees when somebody posts a link, so it has to
// be right in all four of its shapes: an image, a video, a page, and a preview
// the server could not describe.
//
// Two things are checked here that are easy to get wrong and invisible when
// they are: the favicon is never fetched, and a preview that failed is the
// plain link rather than an empty card.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { embedCard, imagesOf, kindOf, siteOf, tileLetter, altOf } = await import('../js/ui/embeds.js');
const { embedCard: mobileEmbedCard, imagesOf: mobileImagesOf, kindOf: mobileKindOf } =
  await import('../mobile/js/embeds.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

const IMAGE_CARD = {
  url: 'https://example.com/post',
  siteName: 'Example',
  title: 'A post about pictures',
  description: 'The words that came with the picture.',
  imageUrl: 'https://example.com/picture.png',
  kind: 'image',
  status: 'ok',
};

const VIDEO_CARD = {
  url: 'https://example.com/clip',
  siteName: 'Example',
  title: 'A short clip',
  videoUrl: 'https://example.com/clip.mp4',
  kind: 'video',
  status: 'ok',
};

const LINK_CARD = {
  url: 'https://example.org/article',
  siteName: 'The Example Journal',
  title: 'An article worth reading',
  description: 'The first line of the article, and a little more of it.',
  kind: 'link',
  status: 'ok',
};

const FAILED_CARD = {
  url: 'https://unreachable.example/thing',
  title: null,
  kind: 'link',
  status: 'unavailable',
};

test('an image preview is a card with the picture, a link and the alt text', () => {
  const node = embedCard(IMAGE_CARD, { images: [] });
  assert.equal(node.getAttribute('class'), 'embed-card embed-card--image');

  const picture = find(node, (n) => n.tagName === 'IMG');
  assert.equal(picture.length, 1, 'the card carries no picture');
  assert.equal(picture[0].getAttribute('src'), IMAGE_CARD.imageUrl);
  assert.equal(picture[0].getAttribute('loading'), 'lazy');
  assert.equal(picture[0].getAttribute('alt'), IMAGE_CARD.title);

  // The card links to the original.
  const links = find(node, (n) => n.tagName === 'A');
  assert.ok(links.some((a) => a.getAttribute('href') === IMAGE_CARD.url),
    'the card does not link to the original');

  // The picture opens large rather than navigating away.
  const opener = find(node, (n) => n.tagName === 'BUTTON');
  assert.equal(opener.length, 1, 'the picture is not a control');
  assert.ok(opener[0].getAttribute('aria-label'), 'the control has no name');
});

test('a video preview is a player that does not fetch until it is asked to', () => {
  const node = embedCard(VIDEO_CARD, { images: [] });
  const video = find(node, (n) => n.tagName === 'VIDEO');
  assert.equal(video.length, 1, 'the card carries no player');
  assert.equal(video[0].getAttribute('src'), VIDEO_CARD.videoUrl);
  assert.equal(video[0].getAttribute('controls'), '');
  assert.equal(video[0].getAttribute('preload'), 'none');
  assert.equal(video[0].getAttribute('playsinline'), '');
  assert.ok(video[0].getAttribute('aria-label'), 'the player has no name');
});

test('a link preview names the site, the title, the description and the host', () => {
  const node = embedCard(LINK_CARD, { images: [] });
  const text = node.textContent || '';
  assert.match(text, /The Example Journal/, 'the site name is missing');
  assert.match(text, /An article worth reading/, 'the title is missing');
  assert.match(text, /The first line of the article/, 'the description is missing');
  assert.match(text, /example\.org/, 'the host is missing');
});

test('the site is named by a tile of its first letter, and no favicon is fetched', () => {
  const node = embedCard(LINK_CARD, { images: [] });
  const tiles = find(node, (n) => n.getAttribute && n.getAttribute('class') === 'embed-tile');
  assert.equal(tiles.length, 1, 'the card has no site tile');
  assert.equal(tiles[0].textContent, 'T');

  // Nothing on the card may point at a favicon: that is a request to an
  // arbitrary host on behalf of every reader who opens the channel.
  const images = find(node, (n) => n.tagName === 'IMG');
  for (const image of images) {
    assert.ok(!/favicon|icon/i.test(image.getAttribute('src') || ''),
      'the card fetches a favicon');
  }
  assert.equal(tileLetter(LINK_CARD), 'T');
  assert.equal(siteOf({ siteName: null, url: 'https://www.example.org/x' }), 'example.org');
});

test('a preview that failed is the plain link and nothing else', () => {
  const node = embedCard(FAILED_CARD, { images: [] });
  assert.equal(node.tagName, 'A');
  assert.equal(node.getAttribute('href'), FAILED_CARD.url);
  assert.equal(node.getAttribute('class'), 'embed-plain');
  assert.ok(!/embed-card/.test(node.getAttribute('class') || ''), 'a broken card was drawn');
  assert.equal(kindOf(FAILED_CARD), 'plain');
});

test('the card says which kind it is from what it carries', () => {
  assert.equal(kindOf(IMAGE_CARD), 'image');
  assert.equal(kindOf(VIDEO_CARD), 'video');
  assert.equal(kindOf(LINK_CARD), 'link');
  assert.equal(kindOf(FAILED_CARD), 'plain');
});

test('the alt text of a picture is the words of the page itself', () => {
  assert.equal(altOf(IMAGE_CARD), IMAGE_CARD.title);
  assert.equal(altOf({ title: null, description: 'Only a description.' }), 'Only a description.');
  assert.equal(altOf({ title: null, description: null, url: 'https://example.com/x' }), 'https://example.com/x');
});

test('the images of a message are collected in the order the cards are drawn', () => {
  const images = imagesOf([LINK_CARD, IMAGE_CARD, VIDEO_CARD]);
  assert.equal(images.length, 1, 'only the picture is an image');
  assert.equal(images[0].url, IMAGE_CARD.imageUrl);
  assert.equal(images[0].alt, IMAGE_CARD.title);
});

test('the mobile module draws its own preview card', () => {
  const node = mobileEmbedCard(IMAGE_CARD, { images: [] });
  const picture = find(node, (n) => n.tagName === 'IMG');
  assert.equal(picture.length, 1, 'the phone card carries no picture');
  assert.equal(picture[0].getAttribute('loading'), 'lazy');

  const video = find(mobileEmbedCard(VIDEO_CARD, { images: [] }), (n) => n.tagName === 'VIDEO');
  assert.equal(video.length, 1, 'the phone card carries no player');
  assert.equal(video[0].getAttribute('preload'), 'none');

  const plain = mobileEmbedCard(FAILED_CARD, { images: [] });
  assert.equal(plain.tagName, 'A');
  assert.equal(mobileKindOf(FAILED_CARD), 'plain');

  assert.equal(mobileImagesOf([IMAGE_CARD]).length, 1);
});
