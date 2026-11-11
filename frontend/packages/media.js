// Identity media.
//
// Avatars, banners, community icons and attachment bytes all live behind the
// same Bearer-authenticated download route, so an <img src> pointing at one
// cannot work: the browser sends no Authorization header and gets a 401. The
// bytes are fetched with the session instead and shown from an object URL, which
// is cached per path because the rail and the member list ask for the same
// handful of faces on every render.

import { fetchObjectUrl } from './api.js';

const cache = new Map();

function remember(url, fetch) {
  // A failed read is not remembered: the file may be there next time.
  const guarded = fetch.then((objectUrl) => {
    if (objectUrl === null || objectUrl === undefined) cache.delete(url);
    return objectUrl;
  }, () => {
    cache.delete(url);
    return null;
  });
  cache.set(url, guarded);
  return guarded;
}

export function mediaUrl(url) {
  if (!url) return Promise.resolve(null);
  if (!isServerPath(url)) return Promise.resolve(url);
  if (!cache.has(url)) remember(url, fetchObjectUrl(url));
  return cache.get(url);
}

// Forget one path after its file changed, without throwing away anybody
// else's picture or revoking blobs that drawn images still show.
export function evictMedia(url) {
  if (!url || !cache.has(url)) return;
  cache.delete(url);
}

// For signing out.
export function clearMediaCache() {
  for (const promise of cache.values()) {
    promise.then((objectUrl) => { if (objectUrl) URL.revokeObjectURL(objectUrl); }).catch(() => {});
  }
  cache.clear();
}

export function isCached(url) {
  return cache.has(url);
}

export function isServerPath(url) {
  return typeof url === 'string' && url.charAt(0) === '/' && url.indexOf('//') !== 0;
}

export function applyImage(img, url, fallback) {
  if (!url) {
    if (fallback) fallback();
    return;
  }
  mediaUrl(url).then((resolved) => {
    if (resolved) img.src = resolved;
    else if (fallback) fallback();
  }).catch(() => { if (fallback) fallback(); });
}

export default { mediaUrl, applyImage, isCached, clearMediaCache, evictMedia, isServerPath };
