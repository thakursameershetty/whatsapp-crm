// Sending email: account emails (confirm address, reset password, invites).
// Uses Resend (https://resend.com) when RESEND_API_KEY is set; otherwise the email is written
// to the server log, so every flow still works while email isn't set up yet.
//   RESEND_API_KEY  the API key from resend.com
//   MAIL_FROM       e.g. "WhatsApp Sender <hello@spotmies.com>" (the domain must be verified in Resend)
//   APP_URL         public address used in links, e.g. https://app.spotmies.com (else taken from the request)

const FROM = () => process.env.MAIL_FROM || 'WhatsApp Sender <onboarding@resend.dev>';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One simple, email-client-safe layout: a heading, a paragraph, a button and a fine-print line.
function layout({ heading, body, button, url, footer }) {
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#eceff1;font-family:-apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif;color:#1d2730">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:15px;font-weight:600;padding-bottom:22px">WhatsApp Sender</td></tr>
<tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.02em;padding-bottom:10px">${esc(heading)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#4a5560;padding-bottom:24px">${body}</td></tr>
${url ? `<tr><td style="padding-bottom:24px"><a href="${esc(url)}" style="display:inline-block;background:#14181c;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${esc(button)}</a></td></tr>` : ''}
<tr><td style="font-size:12.5px;line-height:1.5;color:#8a949c">${footer}${url ? `<br>Or open this link: <a href="${esc(url)}" style="color:#8a949c">${esc(url)}</a>` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

async function send({ to, subject, heading, body, button = '', url = '', footer = '', text }) {
  const html = layout({ heading, body, button, url, footer });
  const plain = text || `${heading}\n\n${body.replace(/<[^>]+>/g, '')}\n${url ? `\n${button}: ${url}\n` : ''}`;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[email not sent: RESEND_API_KEY is not set] To: ${to} · ${subject}\n  ${url}`);
    return { logged: true };
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html, text: plain }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`Email failed (${r.status}): ${j.message || j.name || 'unknown error'}`);
  }
  return { sent: true };
}

// Fire and forget: an email problem shouldn't break signing up or inviting.
const quietly = (p) => p.catch((e) => console.error(e.message));

const baseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

module.exports = {
  enabled: () => Boolean(process.env.RESEND_API_KEY),
  baseUrl,

  // A 6-digit code to confirm an email address (at sign-up, or when the app asks for it).
  code: (to, code) => quietly(send({
    to, subject: `${code} is your WhatsApp Sender code`,
    heading: 'Your confirmation code',
    body: `Enter this code to confirm your email:<br><span style="display:inline-block;margin-top:14px;font-size:30px;font-weight:700;letter-spacing:8px;color:#14181c;font-family:ui-monospace,Menlo,monospace">${esc(code)}</span><br><br>It works for 10 minutes.`,
    footer: "If you didn't ask for this, you can ignore this email.",
  })),

  verify: (to, name, url) => quietly(send({
    to, subject: 'Confirm your email',
    heading: `Confirm your email${name ? `, ${name.split(' ')[0]}` : ''}`,
    body: 'Confirm this address so we can reach you about your account, like resetting your password.',
    button: 'Confirm email', url,
    footer: "If you didn't create an account, you can ignore this email.",
  })),

  reset: (to, url) => quietly(send({
    to, subject: 'Reset your password',
    heading: 'Reset your password',
    body: 'Someone (hopefully you) asked to reset the password for this account. The link works for 1 hour.',
    button: 'Choose a new password', url,
    footer: "If you didn't ask for this, ignore this email. Your password stays the same.",
  })),

  emailChanged: (to, newEmail, url) => quietly(send({
    to, subject: 'Your email was changed',
    heading: 'Your account email was changed',
    body: `The email for your WhatsApp Sender account was changed to <b>${esc(newEmail)}</b>. If this was you, there's nothing to do.`,
    button: 'Sign in', url,
    footer: "If you didn't make this change, sign in and change your password, or reply to this email.",
  })),

  invite: (to, inviter, workspace, url) => quietly(send({
    to, subject: `${inviter} invited you to ${workspace}`,
    heading: `Join ${workspace} on WhatsApp Sender`,
    body: `<b>${esc(inviter)}</b> invited you to the <b>${esc(workspace)}</b> workspace: campaigns, a shared WhatsApp inbox and an AI assistant. The invite works for 7 days.`,
    button: 'Accept invite', url,
    footer: "If you weren't expecting this, you can ignore it.",
  })),
};
