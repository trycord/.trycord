// Link previews, drawn.
//
// The server describes a link and hands back a card: a site name, a title, a
// description, sometimes an image, sometimes a video, and a status. This module
// decides what that card looks like - and, just as importantly, what it must not
// do.
//
// A preview is a request on behalf of every reader who opens the channel. The
// image and the video come from the host the server already vetted, and they are
// the only things the browser is asked to fetch. The favicon is never fetched:
// the site's own first letter stands in for it, because a favicon request would
// be a request to an arbitrary host on every message that carried a link.
//
// A preview that failed is not a broken card. The server says so with
// `status: 'unavailable'`, and the answer is the plain link and nothing else.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { attachContextMenu, openDialog } from './overlays.js';
import { copyText } from './clipboard.js';

const MAX_DESCRIPTION = 300;

// The card as the server sends it, read through the names it may use.
export function imageOf(card) {
  return (card && (card.imageUrl || card.image_url || card.image)) || null;
}

export function videoOf(card) {
  return (card && (card.videoUrl || card.video_url || card.video)) || null;
}

export function urlOf(card) {
  return (card && card.url) || '';
}

export function hostOf(url) {
  try { return url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { return ''; }
}

// The name of the site the card came from, and the letter that stands for it.
export function siteOf(card) {
  const name = card && card.siteName ? String(card.siteName).trim() : '';
  if (name) return name;
  const host = hostOf(urlOf(card));
  return host || 'Link';
}

export function tileLetter(card) {
  const site = siteOf(card);
  const letter = site.trim().charAt(0).toUpperCase();
  return letter || '#';
}

// The text a screen reader reads for the picture. The page's own title is the
// best description of it; the description is the next best thing.
export function altOf(card) {
  const title = card && card.title ? String(card.title).trim() : '';
  if (title) return title;
  const description = card && card.description ? String(card.description).trim() : '';
  if (description) return description.slice(0, 120);
  return urlOf(card) || 'Image';
}

// The kind of card, decided from what the card actually carries rather than
// from the kind the server labelled it with.
export function kindOf(card) {
  if (!card || card.status !== 'ok') return 'plain';
  if (videoOf(card)) return 'video';
  if (imageOf(card)) return 'image';
  return 'link';
}

// -- the lightbox ------------------------------------------------------------
//
// An image opened from a message is read large, with the rest of the message's
// images a keypress away. The dialog underneath owns Escape and the focus
// trap; the arrows are this module's business.

export function openLightbox(images, startIndex) {
  const list = (images || []).filter((entry) => entry && entry.url);
  if (!list.length) return null;
  let index = Math.max(0, Math.min(list.length - 1, startIndex || 0));

  const picture = el('img', { class: 'lightbox-image', alt: '' });
  const caption = el('p', { class: 'lightbox-caption' });
  const counter = el('span', { class: 'lightbox-count' });

  const previous = el('button', {
    class: 'lightbox-nav lightbox-nav--prev', type: 'button', 'aria-label': 'The previous image',
    onClick: () => step(-1),
  }, icon('chevron-left', { size: 24 }));

  const next = el('button', {
    class: 'lightbox-nav lightbox-nav--next', type: 'button', 'aria-label': 'The next image',
    onClick: () => step(1),
  }, icon('chevron-right', { size: 24 }));

  const body = el('div', { class: 'lightbox' },
    picture,
    el('div', { class: 'lightbox-bar' },
      caption,
      counter,
      el('button', {
        class: 'lightbox-close', type: 'button', 'aria-label': 'Close the image',
        onClick: () => dialog.close(),
      }, icon('x', { size: 20 }))));

  const dialog = openDialog({
    title: 'Image',
    head: false,
    dismissable: true,
    class: 'dialog--lightbox',
    body,
  });

  function paint() {
    const entry = list[index];
    picture.setAttribute('src', entry.url);
    picture.setAttribute('alt', entry.alt || 'Image');
    caption.textContent = entry.caption || '';
    counter.textContent = list.length > 1 ? (index + 1) + ' of ' + list.length : '';
    previous.hidden = list.length < 2;
    next.hidden = list.length < 2;
  }

  function step(delta) {
    if (list.length < 2) return;
    index = (index + delta + list.length) % list.length;
    paint();
  }

  body.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  });

  paint();
  return dialog;
}

// -- the card -----------------------------------------------------------------

function siteLine(card) {
  return el('p', { class: 'embed-site' },
    el('span', { class: 'embed-tile', 'aria-hidden': 'true' }, tileLetter(card)),
    el('span', { class: 'embed-site-name' }, siteOf(card)));
}

function titleLine(card) {
  const title = card.title || urlOf(card) || 'Link';
  return el('a', {
    class: 'embed-title', href: urlOf(card) || null,
    target: '_blank', rel: 'noreferrer noopener',
  }, title);
}

function descriptionLine(card) {
  if (!card.description) return null;
  return el('p', { class: 'embed-text' }, String(card.description).slice(0, MAX_DESCRIPTION));
}

function hostLine(card) {
  const host = hostOf(urlOf(card));
  if (!host) return null;
  return el('p', { class: 'embed-host' }, host);
}

// The menu a preview offers. Every entry performs: a preview can be opened,
// its address copied, and its text taken.
export function embedMenuItems(card, options) {
  const opts = options || {};
  const items = [];
  const url = urlOf(card);
  if (url) {
    items.push({
      label: 'Open the link', icon: 'external',
      onSelect: () => { window.open(url, '_blank', 'noopener,noreferrer'); },
    });
    items.push({ label: 'Copy the link', icon: 'link', onSelect: () => copyText(url, 'Link') });
  }
  if (kindOf(card) === 'image') {
    const image = imageOf(card);
    items.push({
      label: 'Open the image', icon: 'image',
      onSelect: () => { window.open(image, '_blank', 'noopener,noreferrer'); },
    });
    items.push({ label: 'Copy the image address', icon: 'copy', onSelect: () => copyText(image, 'Image address') });
  }
  const text = [card.title, card.description].filter(Boolean).join('\n');
  if (text) items.push({ label: 'Copy the text', icon: 'copy', onSelect: () => copyText(text, 'Preview text') });
  if (opts.onRemove) {
    items.push({ separator: true });
    items.push({ label: 'Hide this preview', icon: 'x', onSelect: opts.onRemove });
  }
  return items;
}

/**
 * One preview, drawn.
 *
 * `options.images` is the list of images in the same message, so the lightbox
 * can move between them; `options.index` says which of them this card is.
 */
export function embedCard(card, options) {
  const opts = options || {};
  const kind = kindOf(card);

  // A preview the server could not describe is the link and nothing else.
  if (kind === 'plain') {
    const url = urlOf(card);
    const plain = el('a', {
      class: 'embed-plain', href: url || null,
      target: '_blank', rel: 'noreferrer noopener',
    }, url || 'Link');
    attachContextMenu(plain, () => embedMenuItems(card, opts));
    return plain;
  }

  const node = el('article', { class: 'embed-card embed-card--' + kind });

  if (kind === 'image') {
    const image = imageOf(card);
    const button = el('button', {
      class: 'embed-media', type: 'button',
      'aria-label': 'Open the image from ' + siteOf(card),
      onClick: () => openLightbox(opts.images || [{ url: image, alt: altOf(card) }], opts.index || 0),
    }, el('img', {
      class: 'embed-image', src: image, alt: altOf(card), loading: 'lazy',
    }));
    node.appendChild(button);
    node.appendChild(el('div', { class: 'embed-body' },
      siteLine(card),
      titleLine(card),
      el('a', {
        class: 'embed-original', href: urlOf(card) || null,
        target: '_blank', rel: 'noreferrer noopener',
      }, 'Open the original')));
  } else if (kind === 'video') {
    node.appendChild(el('video', {
      class: 'embed-video', src: videoOf(card),
      controls: true, preload: 'none', playsinline: true,
      'aria-label': 'Video from ' + siteOf(card),
    }));
    node.appendChild(el('div', { class: 'embed-body' },
      siteLine(card),
      titleLine(card),
      hostLine(card)));
  } else {
    node.appendChild(el('div', { class: 'embed-body' },
      siteLine(card),
      titleLine(card),
      descriptionLine(card),
      hostLine(card)));
  }

  attachContextMenu(node, () => embedMenuItems(card, opts));
  return node;
}

// The images of a message, in the order the cards are drawn. The lightbox
// moves between these and no others.
export function imagesOf(cards) {
  const out = [];
  for (const card of cards || []) {
    if (kindOf(card) !== 'image') continue;
    out.push({
      url: imageOf(card),
      alt: altOf(card),
      caption: [card.title, siteOf(card)].filter(Boolean).join(' - '),
    });
  }
  return out;
}

export default {
  embedCard, embedMenuItems, imagesOf, openLightbox,
  kindOf, siteOf, tileLetter, altOf, imageOf, videoOf, urlOf, hostOf,
};
