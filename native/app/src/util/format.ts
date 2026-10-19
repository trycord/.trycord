/**
 * Formatting.
 *
 * The dates and numbers a person reads, written the way the web client writes
 * them so the two do not disagree about what "5m" means.
 */

/** The time of day, in the reader's locale. */
export function timeOfDay(value: string | null): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
}

/** The full timestamp, for a screen reader and for a details line. */
export function fullTimestamp(value: string | null): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleString();
}

/** "Today", "Yesterday", or the date. */
export function dayLabel(value: string | null): string {
  const date = toDate(value);
  if (!date) return '';
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, {weekday: 'long'});
  return date.toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
}

/** A relative age, for a conversation list. */
export function relativeTime(value: string | null): string {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'now';
  if (seconds < 90) return '1m';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
}

/** A file size, in the largest unit that keeps it readable. */
export function fileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value = value / 1024;
    index = index + 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

/** The name a person is shown by. */
export function displayName(user: {nickname?: string | null; displayName?: string | null; username?: string | null} | null): string {
  if (!user) return 'Unknown';
  return user.nickname || user.displayName || user.username || 'Unknown';
}

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The last few words of a message, for a conversation list preview. */
export function preview(content: string, length: number = 90): string {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}
