/* ============================================================================
   POST /api/reset-code
   A league admin reissues a member's access code.

   Body: { tenantId, membershipId, accessCode? }

   The self-service route (reset.html) covers someone who can reach their own
   inbox. This covers the rest: a player who has lost access to that address, or
   who simply asks their admin. Setting a password needs the service key, so it
   has to happen here rather than in the browser.
   ========================================================================= */

import { requireMember, getTenant, setUserPassword } from './_lib/supabase.js';
import { sendMail, playerWelcome } from './_lib/mailer.js';

const SUPABASE = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_KEY;

// Unambiguous alphabet: no O/0 or I/1 to misread when it is passed on verbally.
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tenantId, membershipId, accessCode } = req.body || {};
  if (!tenantId || !membershipId) {
    return res.status(400).json({ error: 'tenantId and membershipId are required' });
  }

  const caller = await requireMember(req, tenantId);
  if (!caller) return res.status(401).json({ error: 'Sign in as an admin of this league' });
  if (caller.role === 'player') {
    return res.status(403).json({ error: 'Only admins can reset access codes' });
  }

  const code = String(accessCode || '').trim() || generateCode();
  if (code.length < 6) {
    return res.status(400).json({ error: 'Access code must be at least 6 characters' });
  }

  try {
    // Scoped to the tenant, so an admin of one league cannot reset a member of
    // another by guessing an id.
    const r = await fetch(
      `${SUPABASE()}/rest/v1/memberships?id=eq.${membershipId}&tenant_id=eq.${tenantId}&select=*`,
      { headers: { apikey: KEY(), Authorization: `Bearer ${KEY()}`, Accept: 'application/json' } }
    );
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return res.status(404).json({ error: 'No such member in this league' });

    const member = rows[0];

    // An owner's password is theirs to change. Letting a manager reset it would
    // be a way to take over the league.
    if (member.role === 'owner' && !caller.isOwner) {
      return res.status(403).json({ error: 'Only the owner can reset the owner account' });
    }

    await setUserPassword(member.user_id, code);

    const tenant = await getTenant(tenantId);
    let emailed = false;
    let emailError = null;

    if (member.email) {
      try {
        const mail = playerWelcome({
          leagueName: tenant ? tenant.name : 'your league',
          team: member.team,
          email: member.email,
          role: member.role,
          code
        });
        await sendMail({
          to: member.email,
          ...mail,
          subject: `Your new access code for ${tenant ? tenant.name : 'your league'}`
        });
        emailed = true;
      } catch (e) {
        emailError = e.message;
      }
    }

    return res.status(200).json({
      ok: true,
      emailed,
      emailError,
      // Always returned. The admin chose the code when they registered this
      // member, so showing it back is not a disclosure - and hiding it would
      // leave them unable to pass it on any way except email.
      code,
      phone: member.phone || null,
      team: member.team || null,
      email: member.email || null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
