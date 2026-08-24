/* ============================================================================
   POST /api/add-member
   An admin registers a player (or another admin) into their league.

   Body: { tenantId, email, team, displayName, role, accessCode, competitionIds }

   This replaces the old "pick your team from a list" sign-in, where identity
   was self-asserted and anyone who opened the app could select someone else's
   team and read their data. Membership is now granted by an admin against a
   specific email address, and the team is bound to that account.

   Creating an auth account needs the service_role key, so this has to run
   server-side. The caller's own token is checked first - a player cannot call
   this to promote themselves.
   ========================================================================= */

import {
  requireMember, getTenant, findUserByEmail, createUser,
  findMembership, insertMembership
} from './_lib/supabase.js';
import { sendMail, playerWelcome } from './_lib/mailer.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    tenantId, email, team, displayName, phone,
    role = 'player', accessCode, competitionIds = []
  } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

  const caller = await requireMember(req, tenantId);
  if (!caller) return res.status(401).json({ error: 'Sign in as an admin of this league' });
  if (caller.role === 'player') {
    return res.status(403).json({ error: 'Only admins can register members' });
  }
  // Only an owner may mint another admin.
  if (role !== 'player' && !caller.isOwner) {
    return res.status(403).json({ error: 'Only the league owner can add administrators' });
  }

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const code = String(accessCode || '').trim();
  if (code.length < 6) {
    return res.status(400).json({ error: 'Access code must be at least 6 characters' });
  }

  try {
    const tenant = await getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'League not found' });

    // Someone already on the platform (a player in another league) keeps their
    // existing account and password; we only add the new membership. Resetting
    // their password here would break their access to the other league.
    let user = await findUserByEmail(cleanEmail);
    let isNewAccount = false;

    if (!user) {
      user = await createUser(cleanEmail, code);
      isNewAccount = true;
    }

    const existing = await findMembership(user.id, tenantId);
    if (existing) {
      return res.status(409).json({ error: 'That email is already a member of this league' });
    }

    const membership = await insertMembership({
      user_id:         user.id,
      tenant_id:       tenantId,
      role,
      team:            team || null,
      display_name:    displayName || null,
      email:           cleanEmail,
      phone:           phone || null,
      competition_ids: competitionIds,
      added_by:        caller.user_id,
      status:          'invited'
    });

    // The account exists either way; a failed email should not roll that back.
    let emailed = false;
    let emailError = null;
    try {
      const mail = playerWelcome({
        leagueName: tenant.name,
        team, email: cleanEmail, role,
        // An existing account keeps its own password, so do not imply otherwise.
        code: isNewAccount ? code : '(your existing password)'
      });
      await sendMail({ to: cleanEmail, ...mail });
      emailed = true;
    } catch (e) {
      emailError = e.message;
    }

    return res.status(200).json({
      ok: true,
      membership,
      isNewAccount,
      emailed,
      emailError,
      // Let the console show the code when the email failed, so the admin can
      // still pass it on rather than being stuck.
      code: emailed ? undefined : (isNewAccount ? code : undefined)
    });
  } catch (err) {
    if (/duplicate key|memberships_team_unique/i.test(err.message)) {
      return res.status(409).json({ error: 'That team is already taken in this league' });
    }
    return res.status(500).json({ error: err.message });
  }
}
