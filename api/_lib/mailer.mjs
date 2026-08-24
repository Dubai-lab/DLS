/* ============================================================================
   Outbound email over SMTP.

   Env (set these in Vercel; they live in .env locally):
     SMTP_HOST      smtp.gmail.com
     SMTP_PORT      587
     SMTP_USER      the sending address
     SMTP_PASSWORD  an app password, not the account password
     APP_URL        public URL of the app, used in the links we send

   Gmail allows roughly 500 messages a day. That is fine for a handful of
   leagues; a league with hundreds of players being registered in one sitting
   will hit it. Swapping to a transactional provider is a change to these
   four variables and nothing else.
   ========================================================================= */

import nodemailer from 'nodemailer';

let cached = null;

function transport() {
  if (cached) return cached;

  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASSWORD || '').trim();
  // .env has trailing spaces on the port; Number() would yield NaN unhandled.
  const port = Number((process.env.SMTP_PORT || '587').trim()) || 587;

  if (!host || !user || !pass) {
    throw new Error('SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASSWORD)');
  }

  cached = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,          // 587 uses STARTTLS, negotiated below
    requireTLS: port === 587,
    auth: { user, pass }
  });
  return cached;
}

export function appUrl() {
  return (process.env.APP_URL || 'https://footballleaguehub.vercel.app').replace(/\/+$/, '');
}

export async function sendMail({ to, subject, html, text }) {
  const from = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  const info = await transport().sendMail({
    from: from.includes('<') ? from : `"Football League Hub" <${from}>`,
    to,
    subject,
    text,
    html
  });
  return info.messageId;
}

/* -------------------------------------------------------------------------
   Templates
   ---------------------------------------------------------------------- */

const shell = (title, body) => `
<!doctype html>
<html><body style="margin:0;padding:0;background:#0a0e14;font-family:'Segoe UI',Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e14;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#12171f;border:1px solid #21262d;border-radius:16px;padding:32px">
        <tr><td>
          <div style="font-size:20px;font-weight:800;color:#FFD700;margin-bottom:22px">Football League Hub</div>
          <h1 style="font-size:20px;color:#e6edf3;margin:0 0 16px;font-weight:800">${title}</h1>
          ${body}
        </td></tr>
      </table>
      <div style="color:#4a5568;font-size:12px;margin-top:18px">
        You received this because a league administrator added you.
      </div>
    </td></tr>
  </table>
</body></html>`;

/**
 * Sent when an admin registers someone. Carries the access code the admin set,
 * because the account is provisioned rather than self-registered - there is no
 * password the recipient already knows.
 */
export function playerWelcome({ leagueName, team, email, code, role }) {
  const signInUrl = `${appUrl()}/login.html`;
  const roleLine = role === 'player'
    ? (team
        ? `You have been registered with <strong style="color:#e6edf3">${escapeHtml(team)}</strong>.`
        : 'You have been registered as a player.')
    : 'You have been added as an administrator.';

  const html = shell(`You're in ${escapeHtml(leagueName)}`, `
    <p style="color:#8b949e;font-size:14px;line-height:1.6;margin:0 0 20px">${roleLine}</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#161b22;border:1px solid #30363d;border-radius:11px;padding:18px;margin-bottom:22px">
      <tr><td>
        <div style="color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">Email</div>
        <div style="color:#e6edf3;font-size:15px;margin:4px 0 14px">${escapeHtml(email)}</div>
        <div style="color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">Access code</div>
        <div style="color:#FFD700;font-size:24px;font-weight:800;letter-spacing:4px;font-family:monospace;margin-top:4px">${escapeHtml(code)}</div>
      </td></tr>
    </table>

    <a href="${signInUrl}"
       style="display:inline-block;background:#FFD700;color:#1a1400;text-decoration:none;
              padding:13px 28px;border-radius:11px;font-weight:800;font-size:14px">Sign in</a>

    <p style="color:#4a5568;font-size:12px;line-height:1.6;margin:22px 0 0">
      Keep this code private — it is what proves the account is yours.
      You can change it once you are signed in.
    </p>`);

  const text =
`You're in ${leagueName}

${team ? `Team: ${team}` : ''}
Email: ${email}
Access code: ${code}

Sign in: ${signInUrl}

Keep this code private. You can change it once signed in.`;

  return { subject: `You've been registered in ${leagueName}`, html, text };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
