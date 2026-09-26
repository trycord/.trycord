// Transactional email templates: one home for every user-facing email.
// Each builder returns { subject, text, html } — HTML for clients that
// render it, plain text as the universal fallback. Templates carry no
// secrets and no deployment addresses; links are passed in by callers.
//
// To add a template (security notice, appeal update, ...): add a builder
// here and call it through mail.sendMail — never inline HTML in routes.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell({ heading, intro, actionUrl, actionLabel, note }) {
  const a = esc(actionUrl);
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">` +
    `<p style="font-size:20px;font-weight:bold;margin:0 0 4px;">Trycord</p>` +
    `<h1 style="font-size:18px;margin:0 0 12px;">${esc(heading)}</h1>` +
    `<p>${esc(intro)}</p>` +
    `<p><a href="${a}" style="display:inline-block;padding:10px 18px;background:#ff7a18;color:#111;text-decoration:none;border-radius:6px;font-weight:bold;">${esc(actionLabel)}</a></p>` +
    `<p style="color:#555;word-break:break-all;">${a}</p>` +
    (note ? `<p style="color:#555;">${esc(note)}</p>` : '') +
    `</div>`;
}

function verification({ link, hours }) {
  const intro = 'Confirm this address for your Trycord account.';
  const note = `The link is valid ${hours} hours and single use. If that wasn't you, ignore this email.`;
  return {
    subject: 'Verify your Trycord email',
    text:
      `${intro}\n\n${link}\n\n${note}`,
    html: shell({ heading: 'Verify your email', intro, actionUrl: link, actionLabel: 'Verify email', note }),
  };
}

function passwordReset({ link, minutes }) {
  const intro = 'Someone requested a password reset for this Trycord account.';
  const note = `Reset it with the button below (valid ${minutes} minutes, single use). If that wasn't you, ignore this email — your password is unchanged.`;
  return {
    subject: 'Reset your Trycord password',
    text:
      `${intro}\n\nReset it here:\n${link}\n\n${note}`,
    html: shell({ heading: 'Reset your password', intro, actionUrl: link, actionLabel: 'Reset password', note }),
  };
}

module.exports = { verification, passwordReset };
