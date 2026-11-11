// Time and last words, the way a phone list reads them.
//
// The Chats list shows the opening words of the newest message and how long
// ago it landed; both come from the shapes the store keeps.

import { nameOf } from '../../../packages/store.js';

/** A short human distance: now, 5m, 3h, 2d, then the date. */
export function timeAgo(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!then) return '';
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 45) return 'now';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
  if (seconds < 7 * 86400) return Math.round(seconds / 86400) + 'd';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The opening words of a conversation's newest message, from its last frame. */
export function lastWordsOf(dm) {
  const frame = dm.lastMessage || dm.last_message || dm.preview;
  if (!frame) return 'No words yet';
  const author = frame.authorDisplay || frame.author_display || frame.authorName || frame.author_name
    || nameOf(frame.author || {}) || '';
  const body = frame.content || frame.body || frame.plain || '';
  const words = String(body).replace(/\s+/g, ' ').trim();
  if (!words) return frame.attachment || frame.embeds ? 'An attachment' : 'No words yet';
  return author ? author + ': ' + words : words;
}
