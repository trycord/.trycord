// Timezone names.
//
// An event carries the instant it happens at (in UTC) and the timezone it was
// written in. The instant is what decides when the event is; the timezone is
// what decides how it reads for the people who will see it. Keeping both is
// what makes "7pm in their own time" and "7pm in the author's time" two
// different, correct statements about one event.
const { fail } = require('./common');

// The zones the runtime knows about. Read once: the list is a constant for
// the life of the process, and building it on every validation would make
// every event write pay for it.
const SUPPORTED = new Set(Intl.supportedValuesOf('timeZone'));

// Whether a name is a timezone this runtime can render in.
//
// The supported list is the authority, and it is asked first. The runtime is
// asked as well because the list is not the whole set the formatter accepts -
// 'UTC' is the obvious omission in current ICU builds, and it is the
// canonical name for a UTC event.
function isValidTimeZone(name) {
  const tz = String(name || '').trim();
  if (!tz) return false;
  if (SUPPORTED.has(tz)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The name an event carries, or a refusal.
function assertTimeZone(name, field) {
  const tz = String(name || '').trim();
  if (!tz) fail('VALIDATION_ERROR', `${field} is required`);
  if (!isValidTimeZone(tz)) fail('VALIDATION_ERROR', `${field} must be an IANA timezone name, such as Europe/Berlin`);
  return tz;
}

// The same instant, written in the event's own timezone.
//
// Used for the rendered copy of an event. The stored instant stays UTC: the
// rendering is a presentation of it, never a second copy of it.
function formatInZone(iso, timezone) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso || '');
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

module.exports = { isValidTimeZone, assertTimeZone, formatInZone };
