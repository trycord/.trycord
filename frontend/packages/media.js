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

export function isServerPath(url) {
  return typeof url === 'string' && url.charAt(0) === '/' && url.indexOf('//') !== 0;
}

export function mediaUrl(url) {
  if (!url) return Promise.resolve(null);
  if (!isServerPath(url)) return Promise.resolve(url);
  if (!cache.has(url)) {
    cache.set(url, fetchObjectUrl(url).catch(() => null));
  }
  return cache.get(url);
}

// A tiny marker so a caller can tell a cached load from a fresh one, and avoid
// a flash of the fallback on a face that is already in memory.
export function isCached(url) {
  return cache.has(url);
}

export function clearMediaCache() {
  for (const promise of cache.values()) {
    promise.then((objectUrl) => { if (objectUrl) URL.revokeObjectURL(objectUrl); }).catch(() => {});
  }
  cache.clear();
}

// Forget one path, without forgetting the rest.
//
// A picture that was replaced keeps its path - the address of an avatar does
// not change when the picture behind it does - so the cache would keep
// showing the old one. The faces in the rail and the member list ask for the
// same handful of paths on every render, so the whole cache is not worth
// throwing away for one of them; the one that changed is.
export function forgetMedia(path) {
  if (!path) return;
  const promise = cache.get(path);
  if (!promise) return;
  cache.delete(path);
  promise.then((objectUrl) => { if (objectUrl) URL.revokeObjectURL(objectUrl); }).catch(() => {});
}

// Set an <img> to a protected or public address, calling `fallback` when there
// is nothing to show rather than leaving a broken image icon.
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

export default { mediaUrl, applyImage, isCached, clearMediaCache, forgetMedia, isServerPath };
