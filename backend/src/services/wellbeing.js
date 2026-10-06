// Do not disturb, quiet hours, and reduced motion.
//
// Reduced motion is a class on <html> that the stylesheet honours, and is separate
// from the operating system's preference: a reader can ask for less motion without
// changing a system setting.
//
// DND and quiet hours gate delivery rather than describing it. suppressesNow() is the
// decision, and services/notifications.js is the only caller - it holds a realtime
// push back and still records the row, so nothing is lost, you are simply not
// interrupted for something you will read in the morning anyway.

const db = require('../db');
const { now } = require('../util');

const newRef = (column) =>
  db.dialect === 'mysql' ? `VALUES(${column})` : `excluded.${column}`;

const boolInt = (v) => (v ? 1 : 0);
const intBool = (v) => !!v;

const DEFAULT_WELLBEING = {
  dndEnabled: false,
  quietHoursOn: false,
  quietStart: 22 * 60,
  quietEnd: 8 * 60,
  reducedMotion: false,
};

async function getWellbeing(userId, conn = db) {
  const row = await conn.get('SELECT * FROM wellbeing_settings WHERE user_id = ?', [userId]);
  if (!row) return { ...DEFAULT_WELLBEING };
  return {
    dndEnabled: intBool(row.dnd_enabled),
    quietHoursOn: intBool(row.quiet_hours_on),
    quietStart: Number.isInteger(row.quiet_start) ? row.quiet_start : DEFAULT_WELLBEING.quietStart,
    quietEnd: Number.isInteger(row.quiet_end) ? row.quiet_end : DEFAULT_WELLBEING.quietEnd,
    reducedMotion: intBool(row.reduced_motion),
  };
}

// Times are minutes from local midnight. Clamped rather than rejected, because a
// slider can legitimately land one past the end and refusing the whole save is
// worse than adjusting the value.
const clampMinute = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(24 * 60 - 1, Math.round(n)));
};

async function setWellbeing(userId, patch) {
  const current = await getWellbeing(userId);
  const next = {
    dndEnabled: patch.dndEnabled === undefined ? current.dndEnabled : !!patch.dndEnabled,
    quietHoursOn: patch.quietHoursOn === undefined ? current.quietHoursOn : !!patch.quietHoursOn,
    quietStart: clampMinute(patch.quietStart, current.quietStart),
    quietEnd: clampMinute(patch.quietEnd, current.quietEnd),
    reducedMotion: patch.reducedMotion === undefined ? current.reducedMotion : !!patch.reducedMotion,
  };
  const ts = now();
  await db.upsert(
    'wellbeing_settings',
    ['user_id', 'dnd_enabled', 'quiet_hours_on', 'quiet_start', 'quiet_end',
      'reduced_motion', 'updated_at'],
    [userId, boolInt(next.dndEnabled), boolInt(next.quietHoursOn), next.quietStart,
      next.quietEnd, boolInt(next.reducedMotion), ts],
    ['user_id'],
    {
      dnd_enabled: newRef('dnd_enabled'),
      quiet_hours_on: newRef('quiet_hours_on'),
      quiet_start: newRef('quiet_start'),
      quiet_end: newRef('quiet_end'),
      reduced_motion: newRef('reduced_motion'),
      updated_at: newRef('updated_at'),
    }
  );
  return next;
}

function suppressesNow(wellbeing, category, minutesFromMidnight, nowDate = new Date()) {
  if (!wellbeing) return false;
  if (wellbeing.dndEnabled) return true;
  if (wellbeing.quietHoursOn) {
    const start = wellbeing.quietStart;
    const end = wellbeing.quietEnd;
    const now = typeof minutesFromMidnight === 'number'
      ? minutesFromMidnight
      : nowDate.getHours() * 60 + nowDate.getMinutes();
    const wraps = start > end;
    const inside = wraps ? (now >= start || now < end) : (now >= start && now < end);
    if (inside) return true;
  }
  return false;
}

/**
 * Whether to hold a realtime push for this account right now.
 *
 * The one place the answer is needed. A held notification is still recorded, so it is
 * waiting next time the reader opens the app - quiet hours are about not being
 * interrupted, not about not being told.
 *
 * A failure to read the setting delivers anyway. Getting a notification someone did not
 * want is recoverable; silently losing one because a lookup failed is not, and the
 * reader has no way to tell the difference.
 */
async function holds(userId, category) {
  let settings;
  try {
    settings = await getWellbeing(userId);
  } catch {
    return false;
  }
  return suppressesNow(settings, category);
}

module.exports = {
  getWellbeing,
  setWellbeing,
  suppressesNow,
  holds,
};
