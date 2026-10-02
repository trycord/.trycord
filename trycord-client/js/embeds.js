// Link preview cards.
//
// Shared by every surface that shows a message - channel, DM and thread - so a
// preview is drawn the same way in all of them. The card is rendered from what
// the server stored, never from a fetch the browser makes itself: a preview is
// an outbound request, and letting every reader fire one would turn opening a
// channel into a request amplifier against whatever host is linked.

import { el, icon, openLightbox } from './ui.js';

// A preview the server could not fetch still gets a card. Silently dropping it
// makes the link look like a typo rather than a page this instance could not
// reach, and the reader has no way to tell the two apart.
function unavailableCard(card) {
  const box = el('a', {
    class: 'embed-card is-unavailable',
    href: card.url,
    target: '_blank',
    rel: 'noopener noreferrer nofollow',
  });
  box.appendChild(el('span', { class: 'embed-card__site' }, hostOf(card.url) || 'link'));
  box.appendChild(el('span', { class: 'embed-card__title' }, 'Preview unavailable'));
  box.appendChild(el('span', { class: 'embed-card__desc muted small' },
    'This link could not be fetched for a preview. Opening it still works.'));
  return box;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function imageCard(card) {
  const box = el('a', {
    class: 'embed-card is-image',
    href: card.url,
    target: '_blank',
    rel: 'noopener noreferrer nofollow',
  });
  const img = el('img', { src: card.imageUrl, alt: card.title || hostOf(card.url), loading: 'lazy' });
  // A preview image is fetched by the reader's browser straight from the host,
  // so it must never be able to run script or pull the reader off-site.
  img.referrerPolicy = 'no-referrer';
  box.appendChild(img);
  if (card.title || card.siteName) {
    const foot = el('span', { class: 'embed-card__foot' });
    if (card.siteName) foot.appendChild(el('span', { class: 'embed-card__site' }, card.siteName));
    if (card.title) foot.appendChild(el('span', { class: 'embed-card__title' }, card.title));
    box.appendChild(foot);
  }
  return box;
}

// A video preview is the file itself, played in place. preload="none" is the
// point: a channel full of video links would otherwise have every reader's
// browser fetch every one of them on open, which is the request-amplifier
// problem the whole fetch-side guard exists to prevent. Nothing loads until the
// reader presses play.
function videoCard(card) {
  const box = el('div', { class: 'embed-card is-video' });
  const media = el('video', {
    src: card.videoUrl,
    controls: true,
    preload: 'none',
    playsinline: true,
    // No referrer: the host must not learn who read the message, and the file
    // must not learn which page embedded it.
    referrerPolicy: 'no-referrer',
  });
  media.setAttribute('aria-label', card.title || 'Video from ' + hostOf(card.url));
  const foot = el('div', { class: 'embed-card__foot' });
  const link = el('a', {
    href: card.url, target: '_blank', rel: 'noopener noreferrer nofollow',
  }, hostOf(card.url));
  foot.appendChild(link);
  if (card.title) foot.appendChild(el('span', { class: 'embed-card__title' }, card.title));
  box.append(media, foot);
  return box;
}

function linkCard(card) {
  const box = el('a', {
    class: 'embed-card',
    href: card.url,
    target: '_blank',
    rel: 'noopener noreferrer nofollow',
  });
  if (card.siteName) box.appendChild(el('span', { class: 'embed-card__site' }, card.siteName));
  if (card.title) box.appendChild(el('span', { class: 'embed-card__title' }, card.title));
  else box.appendChild(el('span', { class: 'embed-card__title' }, card.url));
  if (card.description) {
    box.appendChild(el('span', { class: 'embed-card__desc' }, card.description));
  }
  return box;
}

export function embedCard(card) {
  if (!card || !card.url) return null;
  if (card.status && card.status !== 'ok') return unavailableCard(card);
  if (card.kind === 'video' && card.videoUrl) return videoCard(card);
  if (card.kind === 'image' && card.imageUrl) return imageCard(card);
  return linkCard(card);
}

/**
 * Renders a message's previews into one container. Returns the container even
 * when there is nothing to show, so callers can append unconditionally and
 * patch it later when the card arrives over the socket.
 */
export function embedTray(messageId) {
  return el('div', { class: 'embed-tray', dataset: { embedFor: String(messageId) } });
}

/** Replaces the contents of a tray from a set of cards. */
export function paintEmbeds(tray, cards) {
  if (!tray) return;
  tray.textContent = '';
  for (const card of cards || []) {
    const node = embedCard(card);
    if (node) tray.appendChild(node);
  }
}

// An image preview opens in the lightbox on a plain click, the same as an
// attached image. The anchor is left in place so middle-click and "open in new
// tab" keep working.
export function wireEmbedImages(root) {
  // Images only. A video card carries its own controls and a real anchor to the
  // source, so giving it a click-to-lightbox would swallow the play button.
  for (const box of root.querySelectorAll('.embed-card.is-image')) {
    const img = box.querySelector('img');
    if (!img) continue;
    box.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      openLightbox({ url: img.src, alt: img.alt || '', name: '' });
    });
  }
}

export default { embedCard, embedTray, paintEmbeds, wireEmbedImages };