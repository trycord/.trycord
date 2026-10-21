// The pictures of a person and of a community.
//
// One place, so the phone and the desk do the same thing and a picture is
// chosen, checked, previewed, uploaded and drawn in one way wherever it is
// chosen.
//
// The rules are short:
//
//   - a picture is an image the browser can show;
//   - it is checked before it is sent, so a refusal is a sentence and not a
//     stack trace;
//   - it is uploaded the moment it is chosen, because a picture is not a
//     draft - the words beside it are the part that waits to be saved;
//   - the face that was there is released from the media cache, so the new
//     one is not drawn over a picture of the old one;
//   - a failed upload leaves the old picture exactly where it was.

import Api from './api.js';
import { clearMediaCache } from './media.js';

// The formats the server accepts. It sniffs the bytes rather than trusting
// the name, so this is a first check and not the last one.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// The ceiling. The server has the real one - it is a setting an operator can
// change - so this is only used to refuse a file that is plainly too large
// before it is sent.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Whether a file can be a picture.
 *
 * @param {File} file
 * @param {number} [maxBytes]
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkImage(file, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_BYTES;
  if (!file) return { ok: false, reason: 'No file was chosen.' };
  const type = String(file.type || '').toLowerCase();
  if (type && IMAGE_TYPES.indexOf(type) === -1) {
    return { ok: false, reason: 'That is not a PNG, JPEG, GIF or WebP image.' };
  }
  if (!type) {
    // Some browsers hand over a file with no type at all. The server sniffs
    // the bytes, so the file is allowed through and the server decides.
  }
  if (file.size > limit) {
    return {
      ok: false,
      reason: 'That picture is ' + Math.round(file.size / 1024) + ' KB, and the limit is '
        + Math.round(limit / 1024) + ' KB.',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * A preview of a chosen file, before it is uploaded.
 *
 * The object URL is the browser's own copy of the file, so it is free and
 * it is the very picture that will be uploaded - not a guess at it.
 *
 * @param {File} file
 * @returns {{ url: string, release: function }}
 */
export function previewOf(file) {
  const url = URL.createObjectURL(file);
  return { url, release: () => { URL.revokeObjectURL(url); } };
}

/**
 * The picture the reader chose, drawn small and square.
 *
 * A photograph of a holiday is several megabytes, and a face is drawn in
 * thirty-eight pixels. The browser can do the work: the picture is drawn
 * into a canvas, cropped to a square the way every face is cropped, and
 * handed back as a small file. What is uploaded is then the picture the
 * reader chose, at a size a face can be drawn from, and not the camera
 * roll's original.
 *
 * The crop is the middle of the picture. A reader who wants a different
 * part of it has the whole picture in the editor they cropped it in.
 *
 * @param {File} file
 * @param {object} [options]
 * @param {number} [options.size] The longest side, in pixels.
 * @param {'square'|'wide'|'none'} [options.shape] What the picture is cut
 *   to. A face is square; a cover is wide; a community's picture is
 *   whatever the community drew, so it is not cut at all.
 * @returns {Promise<Blob|null>} The picture, or null when the browser
 *   cannot draw it - in which case the original file is uploaded as it is.
 */
export async function prepareImage(file, options = {}) {
  const size = Number(options.size) > 0 ? Number(options.size) : 512;
  const shape = options.shape || 'square';
  if (!file || typeof createImageBitmap !== 'function') return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A browser that cannot read the file cannot draw it either, and the
    // server sniffs the bytes anyway.
    return null;
  }
  try {
    // The part of the picture that is kept.
    let width = bitmap.width;
    let height = bitmap.height;
    if (shape === 'square') {
      width = height = Math.min(bitmap.width, bitmap.height);
    } else if (shape === 'wide') {
      // A cover is a wide picture: it is cut to a wide shape and never to a
      // square one, because half a banner is not a banner.
      const wanted = 16 / 9;
      if (bitmap.width / bitmap.height > wanted) {
        width = Math.round(bitmap.height * wanted);
      } else {
        height = Math.round(bitmap.width / wanted);
      }
    }
    const scale = Math.min(1, size / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(
      bitmap,
      Math.round((bitmap.width - width) / 2),
      Math.round((bitmap.height - height) / 2),
      width,
      height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob || null;
  } catch {
    return null;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * Upload a person's picture or cover.
 *
 * The server answers with the whole person, so the caller can put the new
 * reference in the state without asking again.
 *
 * @param {'avatar'|'banner'} kind
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function uploadProfilePicture(kind, file) {
  const user = await Api.uploadProfileImage(kind, file);
  // The face that was there is released, so nothing draws the old picture
  // over the new one.
  clearMediaCache();
  return user;
}

/**
 * Take a person's picture or cover away.
 *
 * @param {'avatar'|'banner'} kind
 * @returns {Promise<object>}
 */
export async function removeProfilePicture(kind) {
  const user = await Api.removeProfileImage(kind);
  clearMediaCache();
  return user;
}

/**
 * Upload a community's icon or cover.
 *
 * @param {string} serverId
 * @param {'icon'|'banner'} kind
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function uploadCommunityPicture(serverId, kind, file) {
  const out = await Api.setServerImage(serverId, kind, file);
  clearMediaCache();
  return out;
}

/**
 * Take a community's icon or cover away.
 *
 * @param {string} serverId
 * @param {'icon'|'banner'} kind
 * @returns {Promise<object>}
 */
export async function removeCommunityPicture(serverId, kind) {
  const out = await Api.removeServerImage(serverId, kind);
  clearMediaCache();
  return out;
}

export default {
  checkImage, previewOf, prepareImage,
  uploadProfilePicture, removeProfilePicture,
  uploadCommunityPicture, removeCommunityPicture,
};
