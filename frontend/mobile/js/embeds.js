// Link previews, on a phone.
//
// The Mobile module's own preview card. It answers the same questions the desk
// does - an image, a video, a page, and a preview that failed - in the shapes a
// phone can carry: a card that can be tapped, and a sheet that opens the image
// large.
//
// A preview is a request on behalf of every reader who opens the channel, so
// the only things the phone fetches are the image and the video the server
// already vetted. The favicon is never fetched: the site's first letter stands
// in for it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { attachLongPress, sheet } from './ui.js';

const MAX_DESCRIPTION = 240;

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

export function siteOf(card) {
  const name = card && card.siteName ? String(card.siteName).trim() : '';
  if (name) return name;
  return hostOf(urlOf(card)) || 'Link';
}

export function tileLetter(card) {
  const letter = siteOf(card).trim().charAt(0).toUpperCase();
  return letter || '#';
}

export function altOf(card) {
  const title = card && card.title ? String(card.title).trim() : '';
  if (title) return title;
  const description = card && card.description ? String(card.description).trim() : '';
  if (description) return description.slice(0, 120);
  return urlOf(card) || 'Image';
}

// The kind of card, decided from what the card carries rather than from the
// kind the server labelled it with.
export function kindOf(card) {
  if (!card || card.status !== 'ok') return 'plain';
  if (videoOf(card)) return 'video';
  if (imageOf(card)) return 'image';
  return 'link';
}

// -- the lightbox ------------------------------------------------------------
//
// The image opened from a message, read large in a sheet. The other images of
// the message are a tap away, and the sheet keeps the phone's focus trap.

export function openImageSheet(images, startIndex) {
  const list = (images || []).filter((entry) => entry && entry.url);
  if (!list.length) return null;
  let index = Math.max(0, Math.min(list.length - 1, startIndex || 0));

  const picture = el('img', { class: 'm-lightbox__image', alt: '' });
  const caption = el('p', { class: 'm-lightbox__caption' });
  const counter = el('span', { class: 'm-lightbox__count' });

  // The picture is read two ways: fitted to the phone, and at its own size
  // so the detail in it can be read. The frame scrolls when the picture is
  // bigger than the phone, so nothing is cut off.
  const frame = el('div', { class: 'm-lightbox__frame' });
  let zoomed = false;
  const setZoom = (on) => {
    zoomed = !!on;
    frame.classList.toggle('is-zoomed', zoomed);
    zoomButton.setAttribute('aria-label', zoomed
      ? 'Fit the picture to the screen'
      : 'Read the picture at its own size');
    zoomButton.setAttribute('aria-pressed', String(zoomed));
  };
  const zoomButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
    'aria-label': 'Read the picture at its own size',
    'aria-pressed': 'false',
    onClick: () => setZoom(!zoomed),
  }, icon('maximize', { size: 16 }));

  frame.appendChild(picture);
  const body = el('div', { class: 'm-lightbox' },
    frame,
    el('div', { class: 'm-lightbox__bar' },
      caption,
      counter,
      zoomButton,
      list.length > 1 ? el('div', { class: 'm-lightbox__nav' },
        el('button', {
          class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
          'aria-label': 'The previous image',
          onClick: () => step(-1),
        }, icon('chevron-left', { size: 18 })),
        el('button', {
          class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
          'aria-label': 'The next image',
          onClick: () => step(1),
        }, icon('chevron-right', { size: 18 }))) : null));

  function paint() {
    const entry = list[index];
    picture.setAttribute('src', entry.url);
    picture.setAttribute('alt', entry.alt || 'Image');
    caption.textContent = entry.caption || '';
    counter.textContent = list.length > 1 ? (index + 1) + ' of ' + list.length : '';
  }

  function step(delta) {
    if (list.length < 2) return;
    index = (index + delta + list.length) % list.length;
    paint();
  }

  paint();
  return sheet({ title: 'Image', body });
}

// -- the card -----------------------------------------------------------------

function siteLine(card) {
  return el('div', { class: 'm-embed__site' },
    el('span', { class: 'm-embed__tile', 'aria-hidden': 'true' }, tileLetter(card)),
    el('span', { class: 'truncate' }, siteOf(card)));
}

function titleLine(card) {
  return el('a', {
    class: 'm-embed__title', href: urlOf(card) || null,
    target: '_blank', rel: 'noopener noreferrer',
  }, card.title || urlOf(card) || 'Link');
}

// The menu a preview offers. Every entry performs.
export function embedMenuItems(card, options) {
  const opts = options || {};
  const items = [];
  const url = urlOf(card);
  if (url) {
    items.push({
      label: 'Open the link', icon: 'external',
      onSelect: () => { window.open(url, '_blank', 'noopener,noreferrer'); },
    });
    items.push({ label: 'Copy the link', icon: 'link', onSelect: () => opts.onCopy && opts.onCopy(url, 'Link') });
  }
  if (kindOf(card) === 'image') {
    items.push({
      label: 'Open the image', icon: 'image',
      onSelect: () => { window.open(imageOf(card), '_blank', 'noopener,noreferrer'); },
    });
  }
  const text = [card.title, card.description].filter(Boolean).join('\n');
  if (text) items.push({ label: 'Copy the text', icon: 'copy', onSelect: () => opts.onCopy && opts.onCopy(text, 'Preview text') });
  return items;
}

/**
 * One preview, drawn on a phone.
 *
 * `options.images` is the list of images in the same message, so the sheet can
 * move between them.
 */
export function embedCard(card, options) {
  const opts = options || {};
  const kind = kindOf(card);

  // A preview the server could not describe is the link and nothing else.
  if (kind === 'plain') {
    const plain = el('a', {
      class: 'm-embed m-embed--plain', href: urlOf(card) || null,
      target: '_blank', rel: 'noopener noreferrer',
    }, urlOf(card) || 'Link');
    attachLongPress(plain, () => embedMenuItems(card, opts), { title: 'Link' });
    return plain;
  }

  const node = el('div', { class: 'm-embed m-embed--' + kind });

  if (kind === 'image') {
    const image = imageOf(card);
    const button = el('button', {
      class: 'm-embed__media', type: 'button',
      'aria-label': 'Open the image from ' + siteOf(card),
      onClick: () => openImageSheet(opts.images || [{ url: image, alt: altOf(card) }], opts.index || 0),
    }, el('img', { class: 'm-embed__image', src: image, alt: altOf(card), loading: 'lazy' }));
    node.appendChild(button);
    node.appendChild(el('div', { class: 'm-embed__body' },
      siteLine(card),
      titleLine(card),
      el('a', {
        class: 'm-embed__original', href: urlOf(card) || null,
        target: '_blank', rel: 'noopener noreferrer',
      }, 'Open the original')));
  } else if (kind === 'video') {
    node.appendChild(el('video', {
      class: 'm-embed__video', src: videoOf(card),
      controls: true, preload: 'none', playsinline: true,
      'aria-label': 'Video from ' + siteOf(card),
    }));
    node.appendChild(el('div', { class: 'm-embed__body' },
      siteLine(card),
      titleLine(card),
      hostOf(urlOf(card)) ? el('div', { class: 'm-embed__host' }, hostOf(urlOf(card))) : null));
  } else {
    node.appendChild(el('div', { class: 'm-embed__body' },
      siteLine(card),
      titleLine(card),
      card.description ? el('p', { class: 'm-embed__text' }, String(card.description).slice(0, MAX_DESCRIPTION)) : null,
      hostOf(urlOf(card)) ? el('div', { class: 'm-embed__host' }, hostOf(urlOf(card))) : null));
  }

  attachLongPress(node, () => embedMenuItems(card, opts), { title: siteOf(card) });
  return node;
}

// The images of a message, in the order the cards are drawn.
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
  embedCard, embedMenuItems, imagesOf, openImageSheet,
  kindOf, siteOf, tileLetter, altOf, imageOf, videoOf, urlOf, hostOf,
};
