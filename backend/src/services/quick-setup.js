// The guided first-run setup.
//
// One pass that sets the handful of things an instance cannot run without, in
// the order an operator thinks about them. Off by default: the toggle lives in
// the configuration centre as instance.quickSetup, and with it off the boot
// sequence says nothing.

const db = require('../db');
const { now, uuid } = require('../util');
const settings = require('./settings');

// What a fresh install actually needs. Not every setting, only the ones a member
// notices immediately.
const ESSENTIALS = [
  { key: 'instance.name', label: 'what this instance is called' },
  { key: 'instance.publicUrl', label: 'the address people reach it at' },
  { key: 'registration.enabled', label: 'whether anyone may create an account' },
  { key: 'mail.smtpHost', label: 'where to send verification and recovery mail' },
];

// Current state of each one, so the UI can show what is left rather than making
// an operator open every category to find out.
function essentials() {
  return ESSENTIALS.map((e) => {
    const value = settings.get(e.key);
    return {
      key: e.key,
      label: e.label,
      value,
      done: value !== '' && value !== null && value !== undefined,
    };
  });
}

// Applies a batch in one transaction, so a half-finished setup is not a state
// anyone can end up in.
//
// The same validation and the same audit trail as the ordinary save path. This
// is a convenience over the settings service, not a second way to write config
// that could skip a rule.
async function apply(values, adminId) {
  await settings.load();
  const allowed = new Set(ESSENTIALS.map((e) => e.key));
  const entries = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!allowed.has(key)) continue;
    entries[key] = value;
  }
  if (!Object.keys(entries).length) {
    return { ok: false, problems: ['nothing to set'] };
  }
  const result = await settings.save(entries, adminId);
  if (!result.ok) return result;
  return { ok: true, changed: result.changed, essentials: essentials() };
}

// A test mail, backed by the real sender. Returns what actually happened rather
// than whether the call returned.
async function testMail(to) {
  const mail = require('../auth/mail');
  const address = String(to || '').trim();
  if (!address) return { ok: false, error: 'an address is required' };
  try {
    const described = mail.describe();
    if (described.mode !== 'smtp') {
      return { ok: false, error: 'mail is in ' + described.mode + ' mode; set an SMTP host first' };
    }
    await mail.sendMail({
      to: address,
      subject: 'Trycord test message',
      text: 'This instance can deliver mail. If you are reading it, the configuration works.',
    });
    return { ok: true, mode: described.mode };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { essentials, apply, testMail };
