import Api from '../api.js';
import { el } from '../ui.js';
import { peerPresence } from '../state.js';

// Images behind authentication, and everything that draws an identity.
//
// The URL for an avatar on a private community is not the URL a browser could
// fetch, so it is fetched with the session and handed out as an object URL. One
// cache, one in-flight promise per path, and evicted on invalidation - a page that
// changed its banner should not keep showing the old one.

// Fallback marks for accounts with no avatar. The hash still decides which one -
// the same person is always the same colour, which is the part that helps - but
// every entry is a dark, low-saturation warm tone, so a screen full of accounts
// without pictures reads as one product instead of as a bag of sweets.
//
// The previous ten were blue, violet, magenta and mint at full strength. On a
// near-black warm surface they were the loudest thing on the page, and Ember
// stopped being the only saturated colour in the interface, which is the one thing
// it cannot be if it is going to mean anything.
const AVATAR_COLORS = [
  '#4a3f36', '#3f463c', '#4d4438', '#453a3a', '#3a4046',
  '#524a3f', '#414839', '#4a3f42', '#3e4540', '#514535',
];

// A stable colour for an account with no avatar, so the same person is always the
// same tone. Every entry is a dark, low-saturation warm tone, so a screen full of
// them reads as one product rather than as a bag of sweets.
export function hashColor(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initialOf(name) {
  const s = String(name || '?').trim();
  return (s[0] || '?').toUpperCase();
}

export function avatarUrlOf(user) {
  if (!user) return null;
  return user.avatarUrl || user.avatar_url || null;
}

export function bannerUrlOf(user) {
  if (!user) return null;
  return user.bannerUrl || user.banner_url || null;
}

// path -> Promise<string|null>. One cache, one in-flight promise per path, so opening
// the same conversation twice does not request the same avatar twice.
const mediaUrls = new Map();
const MEDIA_CACHE_MAX = 300;

function cacheMedia(path, promise) {
  mediaUrls.set(path, promise);
  while (mediaUrls.size > MEDIA_CACHE_MAX) {
    const oldest = mediaUrls.keys().next().value;
    if (oldest === undefined) break;
    evictMedia(oldest);
  }
  return promise;
}

function evictMedia(path) {
  const p = mediaUrls.get(path);
  if (p === undefined) return;
  mediaUrls.delete(path);
  if (p) p.then((u) => { if (u) URL.revokeObjectURL(u); }).catch(() => {});
}

export function loadAuthedImage(path) {
  if (!path) return Promise.resolve(null);
  const hit = mediaUrls.get(path);
  if (hit) return hit;
  const p = (async () => {
    try {
      // authenticated path, get bytes". One loader and one cache for both,
      const res = await Api.fetchAuthedImage(path);
      let mime = 'application/octet-stream';
      try {
        const h = res.headers && res.headers.get ? res.headers.get('content-type') : null;
        if (h) mime = h;
      } catch { /* keep declared mime */ }
      return URL.createObjectURL(new Blob([res.buffer], { type: mime }));
    } catch { return null; }
  })();
  return cacheMedia(path, p);
}

export function invalidateAuthedImage(path) {
  if (!path) return;
  evictMedia(path);
}

export function avatar(user, { size = 'sm', withPresence = true } = {}) {
  const name = (user && (user.displayName || user.display_name || user.username)) || '?';
  const a = el('span', {
    class: 'avatar ' + size,
    style: { background: hashColor(name) },
    title: name,
    'aria-hidden': 'true',
  }, initialOf(name));
  // Bearer-authenticated route, so a bare <img src> would 401; fetch with
  // the real session and swap in a blob URL.
  const src = avatarUrlOf(user);
  if (src) {
    loadAuthedImage(src).then((url) => {
      if (!url || !a.isConnected) return;
      a.classList.add('has-img');
      a.textContent = '';
      a.appendChild(el('img', { class: 'avatar-img', src: url, alt: '', loading: 'lazy' }));
    });
  }
  if (withPresence && user && user.id) {
    const dot = el('span', { class: 'presence-dot ' + (peerPresence(user.id) === 'online' ? 'online' : '') });
    a.appendChild(dot);
  }
  return a;
}

// The bytes are behind the authenticated media route, so the upgrade path is
// the same fetch-with-session-then-blob-URL as an avatar.
export function communityIconUrl(server) {
  if (!server) return null;
  return server.iconUrl || server.icon_url || null;
}

export function communityBannerUrl(server) {
  if (!server) return null;
  return server.bannerUrl || server.banner_url || null;
}

export function communityMark(name, { size = '', server = null } = {}) {
  const mark = el('span', {
    class: 'community-mark' + (size ? ' ' + size : ''),
    style: { background: hashColor(name) },
    'aria-hidden': 'true',
  }, initialOf(name));
  const src = communityIconUrl(server || (name && typeof name === 'object' ? name : null));
  if (src) {
    loadAuthedImage(src).then((url) => {
      if (!url || !mark.isConnected) return;
      mark.classList.add('has-img');
      mark.textContent = '';
      mark.appendChild(el('img', { class: 'community-mark__img', src: url, alt: '', loading: 'lazy' }));
    });
  }
  return mark;
}
