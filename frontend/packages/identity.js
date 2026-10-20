// Identity.
//
// Who somebody is, and where their picture lives.
//
// The API is not consistent about the names it uses for the same thing: a
// profile comes back as `avatarUrl`, a member as `avatar_url`, a message
// author as `author_avatar`, a community as `icon_url`. Each of those was
// read at the call site, and each call site was a place where the picture
// silently did not appear when the name did not match.
//
// So the name is resolved here, once, and every surface asks this module.
// The value it returns is the *reference* - a path or an absolute address -
// and the bytes behind it are fetched by packages/media.js.
//
// The three things about a person are kept apart on purpose: the display
// name is what a person chose and can change, the username is their address
// and does not change, and the id is the account. Collapsing them is how a
// rename ends up renaming an account.

/** The picture of a person, from whichever name the answer used. */
export function avatarUrlOf(user) {
  if (!user) return null;
  const value = user.avatarUrl !== undefined ? user.avatarUrl
    : user.avatar_url !== undefined ? user.avatar_url
      : user.authorAvatar !== undefined ? user.authorAvatar
        : user.author_avatar !== undefined ? user.author_avatar
          : user.avatar;
  return normaliseReference(value);
}

/** The banner of a person, from whichever name the answer used. */
export function bannerUrlOf(user) {
  if (!user) return null;
  const value = user.bannerUrl !== undefined ? user.bannerUrl
    : user.banner_url !== undefined ? user.banner_url
      : user.banner;
  return normaliseReference(value);
}

/** The picture of a community, from whichever name the answer used. */
export function serverIconOf(server) {
  if (!server) return null;
  const value = server.iconUrl !== undefined ? server.iconUrl
    : server.icon_url !== undefined ? server.icon_url
      : server.icon;
  return normaliseReference(value);
}

/** The cover of a community, from whichever name the answer used. */
export function serverBannerOf(server) {
  if (!server) return null;
  const value = server.bannerUrl !== undefined ? server.bannerUrl
    : server.banner_url !== undefined ? server.banner_url
      : server.banner;
  return normaliseReference(value);
}

/**
 * A media reference, in one shape.
 *
 * An absolute address is left alone. A path on this instance is left alone -
 * packages/media.js knows how to fetch it with the session. Anything else is
 * dropped: a reference that is neither is a broken image waiting to happen,
 * and a picture that is not there is better shown as initials.
 */
function normaliseReference(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.indexOf('//') === 0) return text;                 // protocol-relative
  if (/^https?:\/\//i.test(text)) return text;                // absolute
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;          // a scheme we do not serve
  if (text.charAt(0) === '/') return text;                    // a path on this instance
  return null;
}

/** The name a person is shown by. */
export function displayNameOf(user) {
  if (!user) return '';
  return String(user.displayName || user.display_name || user.nickname || user.username || '');
}

/** The address a person is known by. */
export function usernameOf(user) {
  if (!user) return '';
  return String(user.username || '');
}

export default {
  avatarUrlOf,
  bannerUrlOf,
  serverIconOf,
  serverBannerOf,
  displayNameOf,
  usernameOf,
};
